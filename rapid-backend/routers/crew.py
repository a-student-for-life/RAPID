"""
Crew Router
Handles crew dispatch, status updates, and hospital pre-alert tracking.

POST  /api/crew/dispatch              - dispatcher sends an assignment to a crew unit
PATCH /api/crew/{unit_id}/status      - crew posts lifecycle transitions
POST  /api/hospitals/{id}/prealert    - dispatcher records a hospital pre-alert
GET   /api/incident/{id}              - fetch full incident by ID (for crew view)
"""

from __future__ import annotations

import logging
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services import firestore_client

logger = logging.getLogger(__name__)
router = APIRouter()

CrewStatus = Literal["dispatched", "en_route", "on_scene", "transporting", "closed", "standby"]


class CrewDispatchRequest(BaseModel):
    unit_id:           str
    incident_id:       str
    hospital_name:     str
    hospital_lat:      float
    hospital_lon:      float
    incident_lat:      Optional[float] = None
    incident_lon:      Optional[float] = None
    eta_minutes:       Optional[float] = None
    patients_assigned: int
    severity:          str
    injury_type:       Optional[str]   = None
    reason:            str             = ""
    available_icu:     Optional[int]   = None
    trauma_centre:     bool            = False
    specialties:       list[str]       = Field(default_factory=list)
    phone:             Optional[str]   = None
    area:              Optional[str]   = None
    fcm_token:         Optional[str]   = None


class CrewStatusRequest(BaseModel):
    incident_id: str
    status: CrewStatus
    notes: str = ""
    timestamp: Optional[str] = None


class HospitalPrealertRequest(BaseModel):
    incident_id:       str
    hospital_name:     str
    unit_id:           Optional[str] = None
    eta_minutes:       Optional[float] = None
    severity:          Optional[str] = None
    patients_assigned: Optional[int] = None
    note:              str = ""


@router.post("/crew/dispatch")
async def dispatch_to_crew(payload: CrewDispatchRequest):
    """
    Dispatcher pushes an assignment to a specific ambulance unit.
    Writes to Firestore crew_assignments/{unit_id}; crew devices subscribe in real-time.
    """
    data = payload.model_dump(exclude={"fcm_token"})
    await firestore_client.save_crew_assignment(payload.unit_id, data)
    await firestore_client.record_incident_dispatch(payload.incident_id, payload.unit_id, data)

    if payload.fcm_token:
        eta_str = f"{payload.eta_minutes:.0f} min" if payload.eta_minutes else "unknown ETA"
        await firestore_client.send_crew_fcm(
            fcm_token=payload.fcm_token,
            title=f"RAPID Dispatch - {payload.hospital_name}",
            body=f"{payload.patients_assigned} {payload.severity} patients · {eta_str}",
        )

    logger.info(
        "Crew dispatch: unit=%s hospital=%s patients=%d severity=%s",
        payload.unit_id,
        payload.hospital_name,
        payload.patients_assigned,
        payload.severity,
    )
    return {"status": "dispatched", "unit": payload.unit_id}


@router.patch("/crew/{unit_id}/status")
async def update_crew_status(unit_id: str, payload: CrewStatusRequest):
    """Persist an explicit crew lifecycle transition."""
    patch = {
        "status": payload.status,
        "updated_at": payload.timestamp,
    }

    if payload.status == "en_route":
        patch["acknowledged_at"] = payload.timestamp
    elif payload.status == "on_scene":
        patch["on_scene_at"] = payload.timestamp
    elif payload.status == "transporting":
        patch["transporting_at"] = payload.timestamp
    elif payload.status == "closed":
        patch["closed_at"] = payload.timestamp

    await firestore_client.update_crew_assignment(unit_id, patch)
    await firestore_client.record_crew_status(
        payload.incident_id,
        unit_id,
        payload.status,
        notes=payload.notes,
        timestamp=payload.timestamp,
    )

    logger.info("Crew status update: unit=%s status=%s", unit_id, payload.status)
    return {"status": "updated", "unit": unit_id, "crew_status": payload.status}


@router.post("/hospitals/{hospital_id}/prealert")
async def prealert_hospital(hospital_id: str, payload: HospitalPrealertRequest):
    """Record that the dispatcher pre-alerted a destination hospital."""
    prealert = payload.model_dump()
    await firestore_client.record_hospital_prealert(payload.incident_id, hospital_id, prealert)
    logger.info(
        "Hospital pre-alert: incident=%s hospital=%s patients=%s",
        payload.incident_id,
        payload.hospital_name,
        payload.patients_assigned,
    )
    return {"status": "recorded", "hospital_id": hospital_id}


@router.get("/incident/{incident_id}")
async def get_incident_by_id(incident_id: str):
    """Fetch a single incident by ID for crew and dispatcher views."""
    doc = await firestore_client.get_incident(incident_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Incident not found")
    return doc
