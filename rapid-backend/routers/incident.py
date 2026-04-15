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
import json
import logging
import time
import uuid
from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import StreamingResponse

from models.schemas import IncidentRequest, IncidentResponse
from services.location_engine import discover_hospitals_adaptive, discover_agencies
from services.aggregator import fetch_hospital_data
from services.scorer import score_all
from services import gemini_router, groq_router, fallback_router
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

    # ── Layer 1: hospital + agency discovery (parallel) ──────────────────────
    discovery, agencies = await asyncio.gather(
        discover_hospitals_adaptive(payload.lat, payload.lon),
        discover_agencies(payload.lat, payload.lon),
    )
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

    # Merge real ETAs and data source back into the hospitals list for the frontend
    enriched_hospitals = [
        {
            **h,
            "eta_minutes": hospital_data.get(h["name"], {}).get("eta_minutes", h.get("eta_minutes")),
            "distance_km": hospital_data.get(h["name"], {}).get("distance_km") or h.get("distance_km"),
            "eta_source":  hospital_data.get(h["name"], {}).get("eta_source", "simulated"),
        }
        for h in hospitals
    ]

    response = IncidentResponse(
        incident_id=incident_id,
        decision_path=routing["decision_path"],
        hospitals=enriched_hospitals,
        scores=scores,
        assignments=routing["assignments"],
        warnings=routing.get("warnings", []),
        reasoning=routing.get("reasoning", ""),
        elapsed_s=elapsed,
        agencies=agencies,
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
            "hospitals":     enriched_hospitals,
            "scores":        scores,
        },
    )

    return response


@router.get("/incidents")
async def list_incidents(limit: int = 10):
    """Return the most recent incidents from Firestore (newest first)."""
    incidents = await firestore_client.get_recent_incidents(limit=min(limit, 50))
    return {"incidents": incidents, "count": len(incidents)}


@router.post("/incident/stream")
async def stream_incident(payload: IncidentRequest) -> StreamingResponse:
    """
    Streaming dispatch endpoint — identical pipeline as /incident but emits
    SSE progress events after each layer so the UI can show a live log.

    Events:  { type: "step",     step: int, done: bool, msg: str }
             { type: "complete", result: {...} }
             { type: "error",    msg: str }
    """
    async def generate():
        start       = time.perf_counter()
        incident_id = str(uuid.uuid4())

        def evt(data: dict) -> str:
            return f"data: {json.dumps(data)}\n\n"

        try:
            # ── Layer 1: discovery ────────────────────────────────────────────
            yield evt({"type": "step", "step": 1, "done": False,
                       "msg": "Scanning hospitals & agencies within 15 km radius..."})

            discovery, agencies = await asyncio.gather(
                discover_hospitals_adaptive(payload.lat, payload.lon),
                discover_agencies(payload.lat, payload.lon),
            )
            hospitals = discovery["hospitals"]

            if not hospitals:
                yield evt({"type": "error",
                           "msg": "No hospitals found within search radius."})
                return

            yield evt({"type": "step", "step": 1, "done": True,
                       "msg": f"Found {len(hospitals)} hospitals & {len(agencies)} agencies nearby."})

            # ── Layer 2: ETA + data fetch ─────────────────────────────────────
            yield evt({"type": "step", "step": 2, "done": False,
                       "msg": "Computing real road-network ETAs via OpenRouteService..."})

            hospital_data = await fetch_hospital_data(payload.lat, payload.lon, hospitals)
            eta_sources   = sorted({v.get("eta_source", "sim") for v in hospital_data.values()})

            yield evt({"type": "step", "step": 2, "done": True,
                       "msg": f"ETA & capacity fetched ({', '.join(eta_sources)})."})

            # ── Layer 3: scoring ──────────────────────────────────────────────
            yield evt({"type": "step", "step": 3, "done": False,
                       "msg": "Scoring hospitals — ETA · capacity · trauma · blood stock..."})

            scores = score_all(hospital_data)
            top    = scores[0] if scores else None

            yield evt({"type": "step", "step": 3, "done": True,
                       "msg": (f"Ranked {len(scores)} hospitals. "
                               f"#1: {top['name']} — {top['composite_score']}/100.")
                               if top else "Scoring complete."})

            # ── Layer 4: AI routing ───────────────────────────────────────────
            patient_groups  = [pg.model_dump() for pg in payload.patients]
            total_patients  = sum(pg["count"] for pg in patient_groups)
            ai_label        = ("deterministic scoring engine"
                               if payload.force_fallback else "Gemini AI (clinical reasoning)")

            yield evt({"type": "step", "step": 4, "done": False,
                       "msg": f"Routing {total_patients} patients via {ai_label}..."})

            routing = await _route(scores, patient_groups, hospital_data, payload.force_fallback)
            elapsed = round(time.perf_counter() - start, 2)

            yield evt({"type": "step", "step": 4, "done": True,
                       "msg": (f"Routing complete via {routing['decision_path']} — "
                               f"{total_patients} patients dispatched in {elapsed}s.")})

            # ── Build & emit result ───────────────────────────────────────────
            enriched_hospitals = [
                {
                    **h,
                    "eta_minutes": hospital_data.get(h["name"], {}).get("eta_minutes", h.get("eta_minutes")),
                    "distance_km": hospital_data.get(h["name"], {}).get("distance_km") or h.get("distance_km"),
                    "eta_source":  hospital_data.get(h["name"], {}).get("eta_source", "simulated"),
                }
                for h in hospitals
            ]

            response_obj = IncidentResponse(
                incident_id=incident_id,
                decision_path=routing["decision_path"],
                hospitals=enriched_hospitals,
                scores=scores,
                assignments=routing["assignments"],
                warnings=routing.get("warnings", []),
                reasoning=routing.get("reasoning", ""),
                elapsed_s=elapsed,
                agencies=agencies,
            )

            # Persist to Firestore (non-blocking — fire and forget)
            asyncio.create_task(
                firestore_client.save_incident(
                    incident_id,
                    {
                        "lat":            payload.lat,
                        "lon":            payload.lon,
                        "decision_path":  routing["decision_path"],
                        "patient_groups": patient_groups,
                        "patient_count":  total_patients,
                        "assignments":    routing["assignments"],
                        "warnings":       routing.get("warnings", []),
                        "reasoning":      routing.get("reasoning", ""),
                        "elapsed_s":      elapsed,
                        "hospitals":      enriched_hospitals,
                        "scores":         scores,
                    },
                )
            )

            yield evt({"type": "complete", "result": response_obj.model_dump()})

        except Exception as exc:
            logger.error("SSE stream error: %s", exc, exc_info=True)
            yield evt({"type": "error", "msg": str(exc)})

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":    "no-cache",
            "Connection":       "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ── Routing helper ─────────────────────────────────────────────────────────────

async def _route(
    scores: list[dict],
    patient_groups: list[dict],
    hospital_data: dict,
    force_fallback: bool = False,
) -> dict:
    """
    Routing chain: Gemini → Groq → deterministic fallback.
    Each tier is tried in order; any failure moves to the next.
    force_fallback=True skips both AI tiers.
    """
    if not force_fallback:
        # ── Tier 1: Gemini ────────────────────────────────────────────────────
        try:
            return await gemini_router.route_patients(scores, patient_groups, hospital_data)
        except asyncio.TimeoutError:
            logger.warning("Gemini timed out — trying Groq.")
        except Exception as exc:
            logger.warning("Gemini unavailable (%s: %s) — trying Groq.", type(exc).__name__, exc)

        # ── Tier 2: Groq ──────────────────────────────────────────────────────
        try:
            result = await groq_router.route_patients(scores, patient_groups, hospital_data)
            logger.info("Groq routing succeeded.")
            return result
        except asyncio.TimeoutError:
            logger.warning("Groq timed out — switching to deterministic fallback.")
        except Exception as exc:
            logger.warning("Groq unavailable (%s: %s) — switching to deterministic fallback.",
                           type(exc).__name__, exc)
    else:
        logger.info("force_fallback=True — skipping AI tiers.")

    # ── Tier 3: deterministic fallback ────────────────────────────────────────
    return fallback_router.route_patients(scores, patient_groups, hospital_data)
