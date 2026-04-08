"""
Incident Router
POST /incident — orchestrates all pipeline layers in sequence:

  Layer 1   location_engine   →  discover nearby hospitals
  Layer 2   aggregator        →  fetch ETA, blood, capacity in parallel
  Layer 3   scorer            →  rank hospitals 0–100
  Layer 4a  gemini_router     →  AI routing with clinical reasoning (primary)
  Layer 4b  fallback_router   →  score-based assignment if AI fails (secondary)

GET /incidents — return recent incidents from Firestore

The response schema is identical regardless of which routing path is used.
"""

import asyncio
import logging
import time
import uuid
from fastapi import APIRouter, BackgroundTasks, HTTPException

from models.schemas import IncidentRequest, IncidentResponse
from services.location_engine import discover_hospitals_adaptive
from services.aggregator import fetch_hospital_data
from services.scorer import score_all
from services import gemini_router, fallback_router
from services import firestore_client

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/incident", response_model=IncidentResponse)
async def handle_incident(
    payload: IncidentRequest,
    background_tasks: BackgroundTasks,
) -> IncidentResponse:
    """
    Receive an incident report and return patient routing decisions.

    Routing path:
      1. Gemini AI attempted first (8-second timeout), unless force_fallback=True.
      2. If Gemini times out, raises an API error, or returns invalid JSON →
         fallback_router takes over deterministically in <1 second.

    The response always includes which path was used via decision_path.
    """
    start       = time.perf_counter()
    incident_id = str(uuid.uuid4())

    # ── Layer 1: hospital discovery ───────────────────────────────────────────
    discovery = await discover_hospitals_adaptive(payload.lat, payload.lon)
    hospitals = discovery["hospitals"]

    if not hospitals:
        raise HTTPException(
            status_code=422,
            detail="No hospitals found within search radius. Expand radius or verify coordinates.",
        )

    # ── Layer 2: parallel data fetch ──────────────────────────────────────────
    hospital_data = await fetch_hospital_data(payload.lat, payload.lon, hospitals)

    # ── Layer 3: score all hospitals ──────────────────────────────────────────
    scores = score_all(hospital_data)

    # ── Layer 4: routing — AI primary, scoring fallback secondary ─────────────
    patient_groups = [pg.model_dump() for pg in payload.patients]
    routing = await _route(scores, patient_groups, hospital_data, payload.force_fallback)

    elapsed = round(time.perf_counter() - start, 2)
    logger.info(
        "Incident %s routed in %.2fs via %s (%d hospitals, %d patient groups)",
        incident_id,
        elapsed,
        routing["decision_path"],
        len(hospitals),
        len(patient_groups),
    )

    response = IncidentResponse(
        incident_id=incident_id,
        decision_path=routing["decision_path"],
        hospitals=hospitals,
        scores=scores,
        assignments=routing["assignments"],
        warnings=routing.get("warnings", []),
        reasoning=routing.get("reasoning", ""),
        elapsed_s=elapsed,
    )

    # Persist to Firestore asynchronously (does not block response)
    background_tasks.add_task(
        firestore_client.save_incident,
        incident_id,
        {
            "lat":           payload.lat,
            "lon":           payload.lon,
            "decision_path": routing["decision_path"],
            "patient_groups": patient_groups,
            "patient_count": sum(pg["count"] for pg in patient_groups),
            "assignments":   routing["assignments"],
            "warnings":      routing.get("warnings", []),
            "reasoning":     routing.get("reasoning", ""),
            "elapsed_s":     elapsed,
        },
    )

    return response


@router.get("/incidents")
async def list_incidents(limit: int = 10):
    """Return the most recent incidents from Firestore (newest first)."""
    incidents = await firestore_client.get_recent_incidents(limit=min(limit, 50))
    return {"incidents": incidents, "count": len(incidents)}


# ── Routing helper ─────────────────────────────────────────────────────────────

async def _route(
    scores: list[dict],
    patient_groups: list[dict],
    hospital_data: dict,
    force_fallback: bool = False,
) -> dict:
    """
    Try Gemini first. On any failure (or force_fallback=True), use fallback.
    """
    if not force_fallback:
        try:
            return await gemini_router.route_patients(scores, patient_groups, hospital_data)
        except asyncio.TimeoutError:
            logger.warning("Gemini timed out after %.1fs — switching to fallback router.",
                           gemini_router._AI_TIMEOUT_SECONDS)
        except Exception as exc:
            logger.warning("Gemini unavailable (%s: %s) — switching to fallback router.",
                           type(exc).__name__, exc)
    else:
        logger.info("force_fallback=True — skipping Gemini.")

    return fallback_router.route_patients(scores, patient_groups, hospital_data)
