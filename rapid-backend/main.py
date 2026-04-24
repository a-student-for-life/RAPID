from dotenv import load_dotenv
load_dotenv()  # must run before any other import that calls os.getenv at module level

from contextlib import asynccontextmanager
import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers import bystander, crew, incident, prepositioning, transcribe

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)

# gRPC's AuthMetadataPlugin callback logs SSL/network failures at ERROR level from
# background threads. The actual errors are already caught by our try/except blocks
# in firestore_client.py, so suppress this logger to avoid console spam.
logging.getLogger("grpc._plugin_wrapping").setLevel(logging.CRITICAL)
logging.getLogger("grpc").setLevel(logging.WARNING)


async def _check_google_reachable() -> bool:
    """Quick TLS probe to oauth2.googleapis.com — used to decide whether to keep
    the Firestore gRPC client alive. Returns False on any SSL/network error."""
    try:
        import httpx
        async with httpx.AsyncClient(timeout=4) as client:
            r = await client.get("https://oauth2.googleapis.com/")
            return r.status_code < 600   # any HTTP response means TLS worked
    except Exception as exc:
        logger.warning("Google OAuth2 endpoint unreachable (%s: %s).", type(exc).__name__, exc)
        return False


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── AI routing chain ──────────────────────────────────────────────────────
    groq_key = os.getenv("GROQ_API_KEY", "")
    if groq_key:
        logger.info("RAPID — PRIMARY AI: Groq Llama-3.3-70b (Tier 1 routing).")
    else:
        logger.warning("GROQ_API_KEY not set — Groq routing disabled.")

    gemini_key = os.getenv("GEMINI_API_KEY", "")
    if gemini_key:
        from services import gemini_router as _gr
        logger.info("RAPID — FALLBACK AI: Gemini %s routing, gemini-2.0-flash Vision.", _gr._MODEL)
    else:
        logger.warning("GEMINI_API_KEY not set — Gemini fallback disabled.")

    if not groq_key and not gemini_key:
        logger.warning("No AI keys set — RAPID will run in deterministic-only mode.")

    # ── Google Maps Platform (Financial Circuit Breaker) ──────────────────────
    maps_key = os.getenv("GOOGLE_MAPS_API_KEY", "")
    if maps_key:
        logger.info(
            "GOOGLE_MAPS_API_KEY loaded — Google Routes (ETA), "
            "Places (address search) active. OSS fallback on quota errors."
        )
    else:
        logger.warning(
            "GOOGLE_MAPS_API_KEY not set — using OSS stack: "
            "ORS (ETAs), Nominatim (address), Leaflet (map)."
        )

    # ── ETA routing ───────────────────────────────────────────────────────────
    ors_key = os.getenv("ORS_API_KEY", "")
    if ors_key:
        logger.info("ORS_API_KEY loaded — Tier 2 ETA fallback ready.")
    else:
        logger.warning("ORS_API_KEY not set — Tier 2 ETA will use haversine simulation.")

    # Probe Google's auth endpoint. If TLS fails (firewall / antivirus / proxy),
    # disable Firestore immediately so gRPC never spawns retrying auth threads.
    if os.getenv("GOOGLE_CLOUD_PROJECT"):
        if await _check_google_reachable():
            logger.info("Google connectivity OK — Firestore enabled.")
            # Seed crew_assignments on startup (no-op if docs already exist).
            try:
                from services import firestore_client as _fc
                await _fc.seed_crew_assignments_if_empty()
            except Exception as _seed_exc:
                logger.warning("Startup crew seed failed (non-fatal): %s", _seed_exc)
        else:
            logger.warning(
                "Cannot reach oauth2.googleapis.com — Firestore disabled. "
                "RAPID will run without incident history or crew sync. "
                "Check firewall/antivirus/VPN settings if you need Firestore."
            )
            from services import firestore_client
            firestore_client.disable()

    yield


app = FastAPI(
    title="RAPID",
    description="Real-time AI Patient Incident Dispatcher",
    version="4.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(incident.router,   prefix="/api")
app.include_router(transcribe.router, prefix="/api")
app.include_router(crew.router,       prefix="/api")
app.include_router(bystander.router,  prefix="/api")
app.include_router(prepositioning.router, prefix="/api")


@app.get("/health")
async def health():
    return {"status": "ok", "version": "4.0.0"}
