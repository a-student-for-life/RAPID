from dotenv import load_dotenv
load_dotenv()  # must run before any other import that calls os.getenv at module level

from contextlib import asynccontextmanager
import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers import incident

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    api_key = os.getenv("GEMINI_API_KEY", "")
    if not api_key:
        logger.warning(
            "GEMINI_API_KEY not set — Gemini routing disabled; "
            "RAPID will operate in FALLBACK-only mode."
        )
    else:
        from services import gemini_router as _gr
        logger.info("RAPID starting with Gemini API key configured (model: %s).", _gr._MODEL)
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

app.include_router(incident.router, prefix="/api")


@app.get("/health")
async def health():
    return {"status": "ok", "version": "4.0.0"}
