"""
Incident Router
POST /incident — orchestrates all pipeline layers in sequence:

  Layer 1   location_engine   →  discover nearby hospitals
  Layer 2   aggregator        →  fetch ETA, blood, capacity in parallel
  Layer 3   scorer            →  rank hospitals 0–100
  Layer 4a  groq_router       →  AI routing with clinical reasoning (PRIMARY)
  Layer 4b  gemini_router     →  AI routing fallback if Groq unavailable
  Layer 4c  fallback_router   →  deterministic score-based assignment (final fallback)

GET /incidents    — return recent incidents from Firestore
GET /system-status — return current API provider state (circuit breaker status)

The response schema is identical regardless of which routing path is used.
"""

import asyncio
import json
import logging
import time
import uuid
from fastapi import APIRouter, BackgroundTasks, Form, HTTPException, UploadFile, File
from typing import Optional
from fastapi.responses import StreamingResponse

from models.schemas import IncidentRequest, IncidentResponse
from services.location_engine import discover_hospitals_adaptive, discover_agencies
from services.aggregator import fetch_hospital_data
from services.scorer import score_all
from services import gemini_router, groq_router, fallback_router
from services import firestore_client
from services.quota_tracker import quota_tracker

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
      1. Groq Llama-3.3-70b attempted first (primary AI — large free tier).
      2. If Groq fails → Gemini 1.5 Flash (fallback AI).
      3. If both AI tiers fail → deterministic score-based fallback (<1s).
      force_fallback=True skips both AI tiers.

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


@router.get("/system-status")
async def system_status():
    """
    Return current API provider state for the Financial Circuit Breaker.
    Frontend reads this on mount to decide which map/search component to render:
      map_provider:     "google" | "oss"
      eta_provider:     "google" | "ors"
      address_provider: "google" | "nominatim"
    """
    return quota_tracker.get_status()


def _aggregate_reports(reports: list[dict]) -> dict:
    """Aggregate multiple scene assessment reports into a single summary."""
    patient_totals: dict[str, int] = {"critical": 0, "moderate": 0, "minor": 0}
    all_hazards: set[str] = set()
    casualty_estimates: list[int] = []

    for r in reports:
        for pg in r.get("patient_groups", []):
            sev = pg.get("severity", "")
            if sev in patient_totals:
                patient_totals[sev] += pg.get("count", 0)
        all_hazards.update(r.get("hazard_flags", []))
        if r.get("estimated_casualties") is not None:
            try:
                casualty_estimates.append(int(r["estimated_casualties"]))
            except (TypeError, ValueError):
                pass

    n = len(reports)
    confidence = "HIGH" if n >= 3 else "MEDIUM" if n == 2 else "LOW"
    return {
        "report_count":    n,
        "confidence":      confidence,
        "patient_groups":  [
            {"severity": k, "count": v, "injury_type": None}
            for k, v in patient_totals.items()
            if v > 0
        ],
        "total_estimated": round(sum(casualty_estimates) / len(casualty_estimates))
                           if casualty_estimates else None,
        "hazard_flags":    sorted(all_hazards),
        "reports":         reports,
    }


@router.post("/scene-assess")
async def scene_assess(
    image:       UploadFile    = File(...),
    unit_id:     Optional[str] = Form(None),
    incident_id: Optional[str] = Form(None),
):
    """
    AI Vision Scene Assessment powered by Groq Llama 4 Scout (free tier).
    Crew uploads a photo of the incident scene; the model analyses it and
    returns a triage estimate: casualty count, severity split, hazard flags,
    and structured patient_groups in RAPID format.

    If unit_id + incident_id are provided the report is saved to Firestore and
    an aggregated cross-crew summary is returned alongside the individual result.
    """
    import base64
    import json
    import os
    import re
    import httpx

    api_key = os.getenv("GROQ_API_KEY", "")
    if not api_key:
        raise HTTPException(status_code=503, detail="GROQ_API_KEY not configured")

    # Read & encode image
    raw = await image.read()
    if len(raw) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image too large (max 10 MB)")

    mime_type = image.content_type or "image/jpeg"
    data_url  = f"data:{mime_type};base64,{base64.b64encode(raw).decode()}"

    prompt = (
        "You are an emergency medical triage AI analysing an incident scene photo. "
        "Return ONLY valid JSON — no markdown, no preamble:\n"
        "{\n"
        '  "estimated_casualties": <integer or null if no people visible>,\n'
        '  "severity_distribution": "<e.g. 2 critical, 5 moderate, 8 minor> or null",\n'
        '  "patient_groups": [\n'
        '    {"severity": "critical", "count": <int>, "injury_type": "<burns|trauma|neuro|null>"},\n'
        '    {"severity": "moderate", "count": <int>, "injury_type": null},\n'
        '    {"severity": "minor",    "count": <int>, "injury_type": null}\n'
        '  ],\n'
        '  "hazard_flags": ["<hazard1>", "<hazard2>"],\n'
        '  "triage_notes": "<1-2 sentence clinical summary for the arriving crew>"\n'
        "}\n"
        "Always include all three severity levels in patient_groups even if count is 0. "
        "If no people are visible set estimated_casualties to null and all counts to 0."
    )

    # Try Llama 4 Scout first (best vision), fall back to Llama 3.2 11B Vision
    models = [
        "meta-llama/llama-4-scout-17b-16e-instruct",
        "llama-3.2-11b-vision-preview",
    ]

    body = {
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": data_url}},
                {"type": "text",      "text": prompt},
            ],
        }],
        "temperature":     0.1,
        "max_tokens":      700,
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
                cleaned  = re.sub(r"```.*?\n|```", "", raw_text, flags=re.DOTALL).strip()
                result   = json.loads(cleaned)
                result["_model"] = model

                # ── Save to Firestore (background, non-blocking) ──────────────
                if incident_id and unit_id:
                    asyncio.create_task(
                        firestore_client.save_scene_assessment(
                            incident_id, unit_id, {**result}
                        )
                    )

                # ── Build aggregated cross-crew summary ───────────────────────
                aggregated = None
                if incident_id:
                    try:
                        existing = await firestore_client.get_scene_assessments(incident_id)
                        # Merge this report (not yet committed) with existing ones
                        this_report = {**result, "unit_id": unit_id or "unknown"}
                        all_reports = (
                            [r for r in existing if r.get("unit_id") != unit_id]
                            + [this_report]
                        )
                        aggregated = _aggregate_reports(all_reports)
                    except Exception as agg_exc:
                        logger.warning("Scene aggregation failed: %s", agg_exc)

                result["aggregated"] = aggregated
                logger.info("Scene assessment via %s succeeded.", model)
                return result

            logger.warning("Scene assess model %s returned HTTP %d — trying next.", model, resp.status_code)
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
    return {"incident_id": incident_id, "aggregated": _aggregate_reports(reports)}


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
                               if payload.force_fallback else "Groq Llama-3.3 (clinical reasoning)")

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
    Routing chain: Groq (PRIMARY) → Gemini 1.5 Flash (FALLBACK) → deterministic.

    Groq is primary because its free tier (~500K tokens/day) far exceeds
    Gemini's (~1.5K req/day), eliminating rate-limit risk during live demos.
    Gemini is preserved as a strong AI fallback and for Vision features.
    force_fallback=True skips both AI tiers (used by "Simulate AI Failure" toggle).
    """
    if not force_fallback:
        # ── Tier 1: Groq (Llama-3.3-70b) — primary AI ────────────────────────
        try:
            result = await groq_router.route_patients(scores, patient_groups, hospital_data)
            logger.info("Groq routing succeeded (primary).")
            return result
        except asyncio.TimeoutError:
            logger.warning("Groq timed out — trying Gemini fallback.")
        except Exception as exc:
            logger.warning("Groq unavailable (%s: %s) — trying Gemini fallback.",
                           type(exc).__name__, exc)

        # ── Tier 2: Gemini 1.5 Flash — AI fallback ───────────────────────────
        try:
            result = await gemini_router.route_patients(scores, patient_groups, hospital_data)
            logger.info("Gemini fallback routing succeeded.")
            return result
        except asyncio.TimeoutError:
            logger.warning("Gemini timed out — switching to deterministic fallback.")
        except Exception as exc:
            logger.warning("Gemini unavailable (%s: %s) — switching to deterministic fallback.",
                           type(exc).__name__, exc)
    else:
        logger.info("force_fallback=True — skipping AI tiers.")

    # ── Tier 3: deterministic fallback ────────────────────────────────────────
    return fallback_router.route_patients(scores, patient_groups, hospital_data)
