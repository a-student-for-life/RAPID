"""
Bystander Reports Router (F2)

Public endpoints that let ordinary citizens submit a photo + coordinates and
kick off an AI triage. The dispatcher sees these in an inbox and chooses to
promote into a full incident or dismiss as noise.

POST /bystander/report            - submit an image + geolocation (public)
GET  /bystander/reports           - dispatcher inbox (status filter)
POST /bystander/reports/{id}/promote  - promote to a full incident
POST /bystander/reports/{id}/dismiss  - mark as dismissed

The vision call reuses the same Groq Llama-4-scout prompt as /scene-assess so
both signals populate patient_groups in a consistent shape.
"""

from __future__ import annotations

import base64
import json as jsonlib
import logging
import os
import re
import uuid
from typing import Literal, Optional

import httpx
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from services import firestore_client, image_store

logger = logging.getLogger(__name__)
router = APIRouter()

ReportStatus = Literal["new", "promoted", "dismissed"]

VISION_MODELS = [
    "llama-3.2-11b-vision-preview",
]

VISION_PROMPT = (
    "You are an emergency medical triage AI analysing a photo submitted by an "
    "untrained bystander at an incident scene. Return ONLY valid JSON:\n"
    "{\n"
    '  "estimated_casualties": <int or null>,\n'
    '  "patient_groups": [\n'
    '    {"severity": "critical", "count": <int>, "injury_type": "<burns|trauma|neuro|null>"},\n'
    '    {"severity": "moderate", "count": <int>, "injury_type": null},\n'
    '    {"severity": "minor",    "count": <int>, "injury_type": null}\n'
    "  ],\n"
    '  "hazard_flags": ["<hazard1>", "<hazard2>"],\n'
    '  "triage_notes": "<1 sentence clinical summary for dispatcher>",\n'
    '  "confidence": "<low|medium|high>"\n'
    "}\n"
    "Include all three severity levels with count 0 if not seen. "
    "Be conservative — bystanders often overestimate, photos may be shaky."
)


async def _run_vision(data_url: str) -> dict:
    api_key = os.getenv("GROQ_API_KEY", "")
    if not api_key:
        raise HTTPException(status_code=503, detail="GROQ_API_KEY not configured")

    body = {
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": data_url}},
                {"type": "text", "text": VISION_PROMPT},
            ],
        }],
        "temperature": 0.1,
        "max_tokens": 700,
        "response_format": {"type": "json_object"},
    }

    last_exc: str | None = None
    for model in VISION_MODELS:
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                resp = await client.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json={**body, "model": model},
                )
            if resp.status_code == 200:
                raw = resp.json()["choices"][0]["message"]["content"]
                cleaned = re.sub(r"```.*?\n|```", "", raw, flags=re.DOTALL).strip()
                data = jsonlib.loads(cleaned)
                data["_model"] = model
                return data
            last_exc = f"HTTP {resp.status_code}: {resp.text[:200]}"
        except Exception as exc:
            last_exc = str(exc)
            logger.warning("Bystander vision via %s failed: %s", model, exc)

    raise HTTPException(status_code=502, detail=f"Vision failed: {last_exc}")


@router.post("/bystander/report")
async def submit_bystander_report(
    image:   UploadFile = File(...),
    lat:     float      = Form(...),
    lon:     float      = Form(...),
    contact: Optional[str] = Form(None),
    notes:   Optional[str] = Form(None),
):
    """
    Public submission endpoint. No auth — the dispatcher decides whether a
    report is real. Runs vision triage synchronously so the bystander gets
    instant feedback.
    """
    raw = await image.read()
    if len(raw) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image too large (max 10 MB).")

    mime = image.content_type or "image/jpeg"
    image_id = image_store.save(raw, mime)
    data_url = f"data:{mime};base64,{base64.b64encode(raw).decode()}"

    triage = await _run_vision(data_url)

    report_id = str(uuid.uuid4())
    doc = {
        "report_id":  report_id,
        "lat":        lat,
        "lon":        lon,
        "contact":    (contact or "").strip() or None,
        "notes":      (notes or "").strip() or None,
        "triage":     triage,
        "image_id":   image_id,
        "status":     "new",
        "source":     "bystander_web",
    }

    await firestore_client.save_bystander_report(report_id, doc)

    logger.info(
        "Bystander report %s: casualties=%s hazards=%s",
        report_id,
        triage.get("estimated_casualties"),
        triage.get("hazard_flags"),
    )
    return {"report_id": report_id, "triage": triage}


@router.get("/bystander/reports")
async def list_bystander_reports(status: str = "new", limit: int = 20):
    """Dispatcher-side inbox. Filters by status (new | promoted | dismissed)."""
    reports = await firestore_client.list_bystander_reports(
        status=status if status in {"new", "promoted", "dismissed"} else None,
        limit=min(max(1, limit), 100),
    )
    return {"reports": reports, "count": len(reports)}


@router.post("/bystander/reports/dismiss-all")
async def dismiss_all_reports(reason: str = "session_ended"):
    """Dismiss all pending 'new' bystander reports. Called when a dispatcher session ends."""
    count = await firestore_client.dismiss_all_bystander_reports(reason)
    return {"dismissed": count, "reason": reason}


class BystanderPromoteRequest(BaseModel):
    incident_id: str


@router.post("/bystander/reports/{report_id}/promote")
async def promote_bystander_report(report_id: str, payload: BystanderPromoteRequest):
    """Mark a report as promoted. Caller is expected to have created an incident."""
    ok = await firestore_client.update_bystander_report(report_id, {
        "status":      "promoted",
        "incident_id": payload.incident_id,
    })
    if not ok:
        raise HTTPException(status_code=404, detail="Report not found or Firestore unavailable.")
    return {"status": "promoted", "report_id": report_id, "incident_id": payload.incident_id}


@router.post("/bystander/reports/{report_id}/dismiss")
async def dismiss_bystander_report(report_id: str, reason: str = ""):
    """Dismiss a bystander report as noise or duplicate."""
    ok = await firestore_client.update_bystander_report(report_id, {
        "status":           "dismissed",
        "dismiss_reason":   reason,
    })
    if not ok:
        raise HTTPException(status_code=404, detail="Report not found or Firestore unavailable.")
    return {"status": "dismissed", "report_id": report_id}
