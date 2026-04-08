from contextlib import asynccontextmanager
import logging
import os

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers import incident

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    project = os.getenv("GOOGLE_CLOUD_PROJECT", "")
    if not project:
        logger.warning(
            "GOOGLE_CLOUD_PROJECT not set — Gemini routing disabled; "
            "RAPID will operate in FALLBACK-only mode."
        )
    else:
        logger.info("RAPID starting with Google Cloud project: %s", project)
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
