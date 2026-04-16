"""
Incident Router

POST /incident              -> dispatch a new incident
POST /incidents/{id}/reroute -> re-run routing for an existing incident
POST /scene-assess          -> crew scene photo assessment
GET  /scene-assessments/{id} -> aggregated scene reports
GET  /incidents            -> recent incidents
GET  /system-status        -> current provider state
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import Field

from models.schemas import IncidentRequest, IncidentResponse
from services import fallback_router, firestore_client, gemini_router, groq_router
from services.aggregator import fetch_hospital_data
from services.location_engine import discover_agencies, discover_hospitals_adaptive
from services.quota_tracker import quota_tracker
from services.scene_consensus import build_scene_consensus
from services.scorer import score_all

logger = logging.getLogger(__name__)
router = APIRouter()


class RerouteRequest(IncidentRequest):
    confirm_consensus: bool = Field(
        ...,
        description="Explicit dispatcher confirmation before replacing prior routing with scene intel.",
    )
    source: str = Field("scene_consensus")
    reason: str = Field("")
    report_count: Optional[int] = None


@router.post("/incident", response_model=IncidentResponse)
async def handle_incident(
    payload: IncidentRequest,
    background_tasks: BackgroundTasks,
) -> IncidentResponse:
    """Receive an incident report and return patient routing decisions."""
    incident_id = str(uuid.uuid4())
    response, incident_doc = await _execute_incident(payload, incident_id=incident_id)
    background_tasks.add_task(firestore_client.save_incident, incident_id, incident_doc)
    return response


@router.get("/incidents")
async def list_incidents(limit: int = 10):
    """Return the most recent incidents from Firestore (newest first)."""
    incidents = await firestore_client.get_recent_incidents(limit=min(limit, 50))
    return {"incidents": incidents, "count": len(incidents)}


@router.get("/system-status")
async def system_status():
    """
    Return current API provider state for the Financial Circuit Breaker.
    Frontend reads this on mount to decide which map/search component to render.
    """
    return quota_tracker.get_status()


@router.post("/scene-assess")
async def scene_assess(
    image: UploadFile = File(...),
    unit_id: Optional[str] = Form(None),
    incident_id: Optional[str] = Form(None),
):
    """
    AI vision scene assessment powered by Groq vision models.
    """
    import base64
    import json as jsonlib
    import os
    import re

    import httpx

    api_key = os.getenv("GROQ_API_KEY", "")
    if not api_key:
        raise HTTPException(status_code=503, detail="GROQ_API_KEY not configured")

    raw = await image.read()
    if len(raw) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image too large (max 10 MB)")

    mime_type = image.content_type or "image/jpeg"
    data_url = f"data:{mime_type};base64,{base64.b64encode(raw).decode()}"

    prompt = (
        "You are an emergency medical triage AI analysing an incident scene photo. "
        "Return ONLY valid JSON - no markdown, no preamble:\n"
        "{\n"
        '  "estimated_casualties": <integer or null if no people visible>,\n'
        '  "severity_distribution": "<e.g. 2 critical, 5 moderate, 8 minor> or null",\n'
        '  "patient_groups": [\n'
        '    {"severity": "critical", "count": <int>, "injury_type": "<burns|trauma|neuro|null>"},\n'
        '    {"severity": "moderate", "count": <int>, "injury_type": null},\n'
        '    {"severity": "minor",    "count": <int>, "injury_type": null}\n'
        "  ],\n"
        '  "hazard_flags": ["<hazard1>", "<hazard2>"],\n'
        '  "triage_notes": "<1-2 sentence clinical summary for the arriving crew>"\n'
        "}\n"
        "Always include all three severity levels in patient_groups even if count is 0. "
        "If no people are visible set estimated_casualties to null and all counts to 0."
    )

    models = [
        "meta-llama/llama-4-scout-17b-16e-instruct",
        "llama-3.2-11b-vision-preview",
    ]

    body = {
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": data_url}},
                {"type": "text", "text": prompt},
            ],
        }],
        "temperature": 0.1,
        "max_tokens": 700,
        "response_format": {"type": "json_object"},
    }

    last_exc = None
    for model in models:
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                resp = await client.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json={**body, "model": model},
                )
            if resp.status_code == 200:
                raw_text = resp.json()["choices"][0]["message"]["content"]
                cleaned = re.sub(r"```.*?\n|```", "", raw_text, flags=re.DOTALL).strip()
                result = jsonlib.loads(cleaned)
                result["_model"] = model

                if incident_id and unit_id:
                    asyncio.create_task(
                        firestore_client.save_scene_assessment(incident_id, unit_id, {**result})
                    )

                aggregated = None
                if incident_id:
                    try:
                        existing = await firestore_client.get_scene_assessments(incident_id)
                        this_report = {**result, "unit_id": unit_id or "unknown"}
                        all_reports = [r for r in existing if r.get("unit_id") != unit_id] + [this_report]
                        aggregated = build_scene_consensus(all_reports)
                    except Exception as agg_exc:
                        logger.warning("Scene aggregation failed: %s", agg_exc)

                result["aggregated"] = aggregated
                logger.info("Scene assessment via %s succeeded.", model)
                return result

            logger.warning("Scene assess model %s returned HTTP %d - trying next.", model, resp.status_code)
            last_exc = f"HTTP {resp.status_code}: {resp.text[:200]}"
        except Exception as exc:
            logger.warning("Scene assess model %s failed: %s", model, exc)
            last_exc = str(exc)

    logger.error("All vision models failed. Last error: %s", last_exc)
    raise HTTPException(status_code=502, detail=f"Vision assessment failed: {last_exc}")


@router.get("/scene-assessments/{incident_id}")
async def get_scene_assessments_endpoint(incident_id: str):
    """
    Return all scene assessment reports for an incident plus an aggregated summary.
    Used by DispatcherPanel as a REST fallback when Firestore JS SDK is unavailable.
    """
    reports = await firestore_client.get_scene_assessments(incident_id)
    aggregated = build_scene_consensus(reports)
    return {"incident_id": incident_id, "aggregated": aggregated, "raw_reports": aggregated["raw_reports"]}


@router.post("/incidents/{incident_id}/reroute", response_model=IncidentResponse)
async def reroute_incident(incident_id: str, payload: RerouteRequest) -> IncidentResponse:
    """Re-run routing for an existing incident using dispatcher-confirmed inputs."""
    if not payload.confirm_consensus:
        raise HTTPException(status_code=400, detail="Dispatcher confirmation is required before rerouting.")

    request = IncidentRequest(
        lat=payload.lat,
        lon=payload.lon,
        patients=payload.patients,
        force_fallback=payload.force_fallback,
    )
    response, incident_doc = await _execute_incident(request, incident_id=incident_id)
    await firestore_client.record_incident_reroute(
        incident_id,
        {
            "source": payload.source,
            "reason": payload.reason,
            "report_count": payload.report_count,
            "patient_groups": [group.model_dump() for group in payload.patients],
        },
        incident_doc,
    )
    return response


@router.post("/incident/stream")
async def stream_incident(payload: IncidentRequest) -> StreamingResponse:
    """
    Streaming dispatch endpoint. It mirrors /incident but emits SSE progress events.
    """

    async def generate():
        start = time.perf_counter()
        incident_id = str(uuid.uuid4())

        def evt(data: dict) -> str:
            return f"data: {json.dumps(data)}\n\n"

        try:
            yield evt({
                "type": "step",
                "step": 1,
                "done": False,
                "msg": "Scanning hospitals and agencies within 15 km radius...",
            })

            discovery, agencies = await asyncio.gather(
                discover_hospitals_adaptive(payload.lat, payload.lon),
                discover_agencies(payload.lat, payload.lon),
            )
            hospitals = discovery["hospitals"]

            if not hospitals:
                yield evt({"type": "error", "msg": "No hospitals found within search radius."})
                return

            yield evt({
                "type": "step",
                "step": 1,
                "done": True,
                "msg": f"Found {len(hospitals)} hospitals and {len(agencies)} agencies nearby.",
            })

            yield evt({
                "type": "step",
                "step": 2,
                "done": False,
                "msg": "Computing ETAs and operational capacity...",
            })
            hospital_data = await fetch_hospital_data(payload.lat, payload.lon, hospitals)
            eta_sources = sorted({value.get("eta_source", "simulated") for value in hospital_data.values()})
            yield evt({
                "type": "step",
                "step": 2,
                "done": True,
                "msg": f"ETA and capacity fetched ({', '.join(eta_sources)}).",
            })

            yield evt({
                "type": "step",
                "step": 3,
                "done": False,
                "msg": "Scoring hospitals by ETA, capacity, trauma, and blood readiness...",
            })
            scores = score_all(hospital_data)
            top = scores[0] if scores else None
            yield evt({
                "type": "step",
                "step": 3,
                "done": True,
                "msg": (
                    f"Ranked {len(scores)} hospitals. #1: {top['name']} - {top['composite_score']}/100."
                    if top else "Scoring complete."
                ),
            })

            patient_groups = [pg.model_dump() for pg in payload.patients]
            total_patients = sum(pg["count"] for pg in patient_groups)
            ai_label = "deterministic scoring engine" if payload.force_fallback else "Groq Llama-3.3"

            yield evt({
                "type": "step",
                "step": 4,
                "done": False,
                "msg": f"Routing {total_patients} patients via {ai_label}...",
            })
            routing = await _route(scores, patient_groups, hospital_data, payload.force_fallback)
            elapsed = round(time.perf_counter() - start, 2)
            yield evt({
                "type": "step",
                "step": 4,
                "done": True,
                "msg": f"Routing complete via {routing['decision_path']} - {total_patients} patients dispatched in {elapsed}s.",
            })

            enriched_hospitals = _enrich_hospitals(hospitals, hospital_data)
            response_obj = _build_incident_response(
                incident_id=incident_id,
                routing=routing,
                enriched_hospitals=enriched_hospitals,
                scores=scores,
                agencies=agencies,
                elapsed=elapsed,
            )
            incident_doc = _build_incident_document(
                payload=payload,
                routing=routing,
                patient_groups=patient_groups,
                elapsed=elapsed,
                enriched_hospitals=enriched_hospitals,
                scores=scores,
            )

            asyncio.create_task(firestore_client.save_incident(incident_id, incident_doc))
            yield evt({"type": "complete", "result": response_obj.model_dump()})
        except Exception as exc:
            logger.error("SSE stream error: %s", exc, exc_info=True)
            yield evt({"type": "error", "msg": str(exc)})

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def _execute_incident(
    payload: IncidentRequest,
    *,
    incident_id: str,
) -> tuple[IncidentResponse, dict]:
    start = time.perf_counter()

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

    hospital_data = await fetch_hospital_data(payload.lat, payload.lon, hospitals)
    scores = score_all(hospital_data)
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

    enriched_hospitals = _enrich_hospitals(hospitals, hospital_data)
    response = _build_incident_response(
        incident_id=incident_id,
        routing=routing,
        enriched_hospitals=enriched_hospitals,
        scores=scores,
        agencies=agencies,
        elapsed=elapsed,
    )
    incident_doc = _build_incident_document(
        payload=payload,
        routing=routing,
        patient_groups=patient_groups,
        elapsed=elapsed,
        enriched_hospitals=enriched_hospitals,
        scores=scores,
    )
    return response, incident_doc


def _enrich_hospitals(hospitals: list[dict], hospital_data: dict[str, dict]) -> list[dict]:
    enriched = []
    for hospital in hospitals:
        info = hospital_data.get(hospital["name"], {})
        capacity = info.get("capacity", {})
        blood = info.get("blood", {})
        enriched.append({
            **hospital,
            "distance_km": info.get("distance_km") or hospital.get("distance_km"),
            "eta_minutes": info.get("eta_minutes", hospital.get("eta_minutes")),
            "eta_source": info.get("eta_source", "simulated"),
            "capacity": capacity,
            "blood": blood,
            "trauma_centre": capacity.get("trauma_centre", False),
            "specialties": capacity.get("specialties", []),
            "source_summary": {
                "location": hospital.get("data_source", "unknown"),
                "eta": info.get("eta_source", "simulated"),
                "capacity": capacity.get("data_source", "unknown"),
                "blood": blood.get("data_source", "unknown"),
            },
        })
    return enriched


def _build_incident_response(
    *,
    incident_id: str,
    routing: dict,
    enriched_hospitals: list[dict],
    scores: list[dict],
    agencies: list[dict],
    elapsed: float,
) -> IncidentResponse:
    return IncidentResponse(
        incident_id=incident_id,
        decision_path=routing["decision_path"],
        status="new",
        hospitals=enriched_hospitals,
        scores=scores,
        assignments=routing["assignments"],
        warnings=routing.get("warnings", []),
        reasoning=routing.get("reasoning", ""),
        elapsed_s=elapsed,
        agencies=agencies,
    )


def _build_incident_document(
    *,
    payload: IncidentRequest,
    routing: dict,
    patient_groups: list[dict],
    elapsed: float,
    enriched_hospitals: list[dict],
    scores: list[dict],
) -> dict:
    return {
        "lat": payload.lat,
        "lon": payload.lon,
        "decision_path": routing["decision_path"],
        "patient_groups": patient_groups,
        "patient_count": sum(pg["count"] for pg in patient_groups),
        "assignments": routing["assignments"],
        "warnings": routing.get("warnings", []),
        "reasoning": routing.get("reasoning", ""),
        "elapsed_s": elapsed,
        "hospitals": enriched_hospitals,
        "scores": scores,
        "status": "new",
    }


async def _route(
    scores: list[dict],
    patient_groups: list[dict],
    hospital_data: dict,
    force_fallback: bool = False,
) -> dict:
    """
    Routing chain: Groq (primary) -> Gemini (fallback) -> deterministic.
    """
    if not force_fallback:
        try:
            result = await groq_router.route_patients(scores, patient_groups, hospital_data)
            logger.info("Groq routing succeeded (primary).")
            return result
        except asyncio.TimeoutError:
            logger.warning("Groq timed out - trying Gemini fallback.")
        except Exception as exc:
            logger.warning("Groq unavailable (%s: %s) - trying Gemini fallback.", type(exc).__name__, exc)

        try:
            result = await gemini_router.route_patients(scores, patient_groups, hospital_data)
            logger.info("Gemini fallback routing succeeded.")
            return result
        except asyncio.TimeoutError:
            logger.warning("Gemini timed out - switching to deterministic fallback.")
        except Exception as exc:
            logger.warning("Gemini unavailable (%s: %s) - switching to deterministic fallback.", type(exc).__name__, exc)
    else:
        logger.info("force_fallback=True - skipping AI tiers.")

    return fallback_router.route_patients(scores, patient_groups, hospital_data)
