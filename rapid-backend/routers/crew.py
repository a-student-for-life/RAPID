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
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services import firestore_client

logger = logging.getLogger(__name__)
router = APIRouter()

CrewStatus = Literal["dispatched", "en_route", "on_scene", "transporting", "closed", "standby"]
PrealertStatus = Literal["accepted", "diverted", "auto_accepted"]

PREALERT_EXPIRY_SECONDS = 90  # hospitals have 90s to respond before auto-accept


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


class PrealertResponseRequest(BaseModel):
    status:    PrealertStatus
    note:      str = ""
    responder: Optional[str] = None


def _safe_hospital_key(hospital_id: str) -> str:
    """Firestore-safe key for hospital name (no slashes)."""
    return hospital_id.replace("/", "_").replace(".", "_").strip()


@router.post("/hospitals/{hospital_id}/prealert")
async def prealert_hospital(hospital_id: str, payload: HospitalPrealertRequest):
    """
    Record that the dispatcher pre-alerted a destination hospital AND drop a
    pointer doc into `hospital_prealerts/{prealert_id}` so the kiosk can
    subscribe by hospital id and respond with accept/divert.
    """
    now = datetime.now(timezone.utc)
    prealert_id = str(uuid.uuid4())
    expires_at = (now + timedelta(seconds=PREALERT_EXPIRY_SECONDS)).isoformat()

    prealert = {
        **payload.model_dump(),
        "prealert_id": prealert_id,
        "timestamp":   now.isoformat(),
        "expires_at":  expires_at,
        "status":      "pending",
    }

    await firestore_client.record_hospital_prealert(payload.incident_id, hospital_id, prealert)

    # Kiosk URL uses the human-readable name (#hospital?name=...), so hospital_id
    # must be derived from hospital_name — NOT the URL param (which can be an OSM ID).
    kiosk_hospital_key = _safe_hospital_key(payload.hospital_name or hospital_id)
    kiosk_doc = {
        "prealert_id":       prealert_id,
        "incident_id":       payload.incident_id,
        "hospital_id":       kiosk_hospital_key,
        "hospital_name":     payload.hospital_name,
        "severity":          payload.severity,
        "patients_assigned": payload.patients_assigned,
        "eta_minutes":       payload.eta_minutes,
        "unit_id":           payload.unit_id,
        "note":              payload.note,
        "created_at":        now.isoformat(),
        "expires_at":        expires_at,
        "status":            "pending",
    }
    await firestore_client.save_kiosk_prealert(prealert_id, kiosk_doc)

    logger.info(
        "Hospital pre-alert: incident=%s hospital=%s patients=%s prealert=%s",
        payload.incident_id,
        payload.hospital_name,
        payload.patients_assigned,
        prealert_id,
    )
    return {
        "status":      "recorded",
        "hospital_id": hospital_id,
        "prealert_id": prealert_id,
        "expires_at":  expires_at,
    }


@router.post("/prealerts/{prealert_id}/respond")
async def respond_prealert(prealert_id: str, payload: PrealertResponseRequest):
    """
    Hospital kiosk accept/divert response. Also writes back onto the incident
    doc so the dispatcher sees the resolution in real time.
    """
    updated = await firestore_client.respond_to_prealert(
        prealert_id,
        status=payload.status,
        note=payload.note,
        responder=payload.responder,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Pre-alert not found.")

    logger.info(
        "Prealert response: id=%s hospital=%s status=%s",
        prealert_id,
        updated.get("hospital_name"),
        payload.status,
    )
    return {"status": "updated", "prealert_id": prealert_id, "result": payload.status}


@router.post("/crew/reset-all")
async def reset_all_crews():
    """Reset all crew units to standby in Firestore. Used by dispatcher to clear stale state."""
    units = ["AMB_1", "AMB_2", "AMB_3", "AMB_4", "AMB_5"]
    await firestore_client.reset_all_crew_assignments(units)
    return {"status": "reset", "units": units}


@router.get("/incident/{incident_id}")
async def get_incident_by_id(incident_id: str):
    """Fetch a single incident by ID for crew and dispatcher views."""
    doc = await firestore_client.get_incident(incident_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Incident not found")
    return doc


@router.get("/kiosk/{hospital_key:path}/prealerts")
async def get_kiosk_prealerts(hospital_key: str, limit: int = 20):
    """
    REST polling fallback for the hospital kiosk.
    Accepts the hospital name (URL-encoded) and returns matching prealerts.
    """
    safe_key = _safe_hospital_key(hospital_key)
    rows = await firestore_client.get_kiosk_prealerts_for_hospital(
        safe_key, limit=min(max(1, limit), 50)
    )
    return {"hospital_key": safe_key, "prealerts": rows, "count": len(rows)}
