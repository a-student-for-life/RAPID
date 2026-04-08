"""
Incident Router
POST /incident — orchestrates all pipeline layers in sequence:

  Layer 1   location_engine   →  discover nearby hospitals
  Layer 2   aggregator        →  fetch ETA, blood, capacity in parallel
  Layer 3   scorer            →  rank hospitals 0–100
  Layer 4a  gemini_router     →  AI routing with clinical reasoning (primary)
  Layer 4b  fallback_router   →  score-based assignment if AI fails (secondary)

The response schema is identical regardless of which routing path is used.
"""

import asyncio
import logging
import time
from fastapi import APIRouter, HTTPException

from models.schemas import IncidentRequest, IncidentResponse
from services.location_engine import discover_hospitals_adaptive
from services.aggregator import fetch_hospital_data
from services.scorer import score_all
from services import gemini_router, fallback_router

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/incident", response_model=IncidentResponse)
async def handle_incident(payload: IncidentRequest) -> IncidentResponse:
    """
    Receive an incident report and return patient routing decisions.

    Routing path:
      1. Gemini AI attempted first (8-second timeout).
      2. If Gemini times out, raises an API error, or returns invalid JSON →
         fallback_router takes over deterministically in <1 second.

    The response always includes which path was used via decision_path.
    """
    start = time.perf_counter()

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
    routing = await _route(scores, patient_groups, hospital_data)

    elapsed = round(time.perf_counter() - start, 2)
    logger.info(
        "Incident routed in %.2fs via %s (%d hospitals, %d patient groups)",
        elapsed,
        routing["decision_path"],
        len(hospitals),
        len(patient_groups),
    )

    return IncidentResponse(
        decision_path=routing["decision_path"],
        hospitals=hospitals,
        scores=scores,
        assignments=routing["assignments"],
        warnings=routing.get("warnings", []),
        reasoning=routing.get("reasoning", ""),
    )


# ── Routing helper ─────────────────────────────────────────────────────────────

async def _route(
    scores: list[dict],
    patient_groups: list[dict],
    hospital_data: dict,
) -> dict:
    """
    Try Gemini first. On any failure, log the reason and return fallback result.
    Swapping the AI path for a different model requires changing only this function.
    """
    try:
        return await gemini_router.route_patients(scores, patient_groups, hospital_data)

    except asyncio.TimeoutError:
        logger.warning("Gemini timed out after 8s — using fallback router.")

    except Exception as exc:
        logger.warning("Gemini unavailable (%s: %s) — using fallback router.", type(exc).__name__, exc)

    return fallback_router.route_patients(scores, patient_groups, hospital_data)
