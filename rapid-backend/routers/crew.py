"""
Crew Router
Handles ambulance crew dispatch via Firebase Firestore real-time sync.

POST /api/crew/dispatch  — dispatcher sends an assignment to a crew unit
GET  /api/incident/{id}  — fetch full incident by ID (for crew view)
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from services import firestore_client

logger = logging.getLogger(__name__)
router = APIRouter()


# ── Request schemas ────────────────────────────────────────────────────────────

class CrewDispatchRequest(BaseModel):
    unit_id:           str
    incident_id:       str
    hospital_name:     str
    hospital_lat:      float
    hospital_lon:      float
    incident_lat:      Optional[float] = None   # incident scene coordinates
    incident_lon:      Optional[float] = None   # incident scene coordinates
    eta_minutes:       Optional[float] = None
    patients_assigned: int
    severity:          str
    injury_type:       Optional[str]   = None
    reason:            str             = ""
    available_icu:     Optional[int]   = None
    trauma_centre:     bool            = False
    specialties:       list[str]       = []
    phone:             Optional[str]   = None
    area:              Optional[str]   = None
    fcm_token:         Optional[str]   = None   # device FCM token (optional)


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.post("/crew/dispatch")
async def dispatch_to_crew(payload: CrewDispatchRequest):
    """
    Dispatcher pushes an assignment to a specific ambulance unit.
    Writes to Firestore crew_assignments/{unit_id} — the crew's phone is
    subscribed to this document via Firebase JS SDK onSnapshot().
    Optionally sends an FCM push notification if fcm_token is provided.
    """
    data = payload.model_dump(exclude={"fcm_token"})
    await firestore_client.save_crew_assignment(payload.unit_id, data)

    if payload.fcm_token:
        eta_str = f"{payload.eta_minutes:.0f} min" if payload.eta_minutes else "unknown ETA"
        await firestore_client.send_crew_fcm(
            fcm_token=payload.fcm_token,
            title=f"RAPID Dispatch — {payload.hospital_name}",
            body=f"{payload.patients_assigned} {payload.severity} patients · {eta_str}",
        )

    logger.info(
        "Crew dispatch: unit=%s hospital=%s patients=%d severity=%s",
        payload.unit_id, payload.hospital_name,
        payload.patients_assigned, payload.severity,
    )
    return {"status": "dispatched", "unit": payload.unit_id}


@router.get("/incident/{incident_id}")
async def get_incident_by_id(incident_id: str):
    """
    Fetch a single incident by ID.
    Used by the crew view to load full incident details from a shared link.
    """
    doc = await firestore_client.get_incident(incident_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Incident not found")
    return doc
