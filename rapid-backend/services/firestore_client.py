"""
Firestore Client
Persists incidents and crew assignments. Initialised lazily — if
GOOGLE_CLOUD_PROJECT is not set or Firestore is unavailable, all operations
silently no-op so the main pipeline is unaffected.

Also provides Firebase Admin (FCM) for push notifications to crew devices.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)

_db               = None
_init_attempted   = False
_firebase_admin   = None
_fcm_initialized  = False


def disable() -> None:
    """Proactively disable Firestore (called when Google is unreachable at startup).
    Prevents gRPC from spawning background auth-retry threads."""
    global _db, _init_attempted
    _init_attempted = True
    _db = None
    logger.warning("Firestore forcibly disabled — all operations will no-op.")


# ── Firestore ──────────────────────────────────────────────────────────────────

def _get_db():
    global _db, _init_attempted
    if _init_attempted:
        return _db
    _init_attempted = True

    project = os.getenv("GOOGLE_CLOUD_PROJECT", "")
    if not project:
        logger.warning("Firestore disabled — GOOGLE_CLOUD_PROJECT not set.")
        return None

    try:
        from google.cloud import firestore as _fs
        sa_path = os.getenv("FIREBASE_SERVICE_ACCOUNT_PATH", "")
        if sa_path:
            from google.oauth2 import service_account
            creds = service_account.Credentials.from_service_account_file(
                sa_path,
                scopes=["https://www.googleapis.com/auth/cloud-platform"],
            )
            _db = _fs.AsyncClient(project=project, credentials=creds)
        else:
            _db = _fs.AsyncClient(project=project)
        logger.info("Firestore async client initialised (project=%s).", project)
    except Exception as exc:
        logger.warning("Firestore init failed: %s", exc)
        _db = None

    return _db


async def save_incident(incident_id: str, data: dict[str, Any]) -> None:
    """Write an incident document to Firestore. Silent no-op on any failure."""
    db = _get_db()
    if db is None:
        return
    try:
        doc = {
            **data,
            "hospitals": data.get("hospitals", []),
            "scores":    data.get("scores", []),
            "saved_at":  datetime.now(timezone.utc).isoformat(),
        }
        await db.collection("incidents").document(incident_id).set(doc)
        logger.info("Incident %s persisted to Firestore.", incident_id)
    except Exception as exc:
        logger.warning("Firestore write failed for %s: %s", incident_id, exc)


async def get_incident(incident_id: str) -> dict[str, Any] | None:
    """Retrieve a single incident by ID. Returns None if not found."""
    db = _get_db()
    if db is None:
        return None
    try:
        doc = await db.collection("incidents").document(incident_id).get()
        if not doc.exists:
            return None
        return {**doc.to_dict(), "id": doc.id}
    except Exception as exc:
        logger.warning("Firestore get_incident failed for %s: %s", incident_id, exc)
        return None


async def get_recent_incidents(limit: int = 10) -> list[dict[str, Any]]:
    """Return the most recent incidents from Firestore, newest first."""
    db = _get_db()
    if db is None:
        return []
    try:
        query = (
            db.collection("incidents")
            .order_by("saved_at", direction="DESCENDING")
            .limit(limit)
        )
        results = []
        async for doc in query.stream():
            entry = doc.to_dict()
            entry["id"] = doc.id
            results.append(entry)
        return results
    except Exception as exc:
        logger.warning("Firestore read failed: %s", exc)
        return []


# ── Crew assignments ───────────────────────────────────────────────────────────

async def save_crew_assignment(unit_id: str, data: dict[str, Any]) -> None:
    """
    Write (overwrite) a crew assignment to crew_assignments/{unit_id}.
    The crew page subscribes to this document in real-time via Firebase JS SDK.
    """
    db = _get_db()
    if db is None:
        logger.warning("Firestore unavailable — crew assignment not saved for %s.", unit_id)
        return
    try:
        doc = {
            **data,
            "dispatched_at": datetime.now(timezone.utc).isoformat(),
            "status":        "dispatched",
        }
        await db.collection("crew_assignments").document(unit_id).set(doc)
        logger.info("Crew assignment saved for unit %s.", unit_id)
    except Exception as exc:
        logger.warning("Firestore crew assignment write failed for %s: %s", unit_id, exc)


# ── FCM push notifications ─────────────────────────────────────────────────────

def _init_firebase_admin() -> bool:
    """Initialise firebase-admin SDK once. Returns True if available."""
    global _fcm_initialized
    if _fcm_initialized:
        return True

    sa_path = os.getenv("FIREBASE_SERVICE_ACCOUNT_PATH", "")
    if not sa_path:
        logger.warning("FCM disabled — FIREBASE_SERVICE_ACCOUNT_PATH not set.")
        _fcm_initialized = False
        return False

    try:
        import firebase_admin
        from firebase_admin import credentials
        if not firebase_admin._apps:
            cred = credentials.Certificate(sa_path)
            firebase_admin.initialize_app(cred)
        _fcm_initialized = True
        logger.info("Firebase Admin SDK initialised (FCM enabled).")
        return True
    except Exception as exc:
        logger.warning("Firebase Admin init failed: %s", exc)
        _fcm_initialized = False
        return False


async def save_scene_assessment(incident_id: str, unit_id: str, data: dict[str, Any]) -> None:
    """Save a scene assessment report to scene_assessments/{incident_id}/reports/{unit_id}."""
    db = _get_db()
    if db is None:
        return
    try:
        doc = {
            **data,
            "unit_id":     unit_id,
            "incident_id": incident_id,
            "saved_at":    datetime.now(timezone.utc).isoformat(),
        }
        await (
            db.collection("scene_assessments")
              .document(incident_id)
              .collection("reports")
              .document(unit_id)
              .set(doc)
        )
        logger.info("Scene assessment saved: incident=%s unit=%s", incident_id, unit_id)
    except Exception as exc:
        logger.warning("Firestore scene assessment write failed: %s", exc)


async def get_scene_assessments(incident_id: str) -> list[dict[str, Any]]:
    """Return all scene assessment reports for an incident. Empty list if unavailable."""
    db = _get_db()
    if db is None:
        return []
    try:
        results = []
        async for doc in (
            db.collection("scene_assessments")
              .document(incident_id)
              .collection("reports")
              .stream()
        ):
            entry = doc.to_dict()
            entry["id"] = doc.id
            results.append(entry)
        return results
    except Exception as exc:
        logger.warning("Firestore get_scene_assessments failed: %s", exc)
        return []


async def send_crew_fcm(fcm_token: str, title: str, body: str) -> None:
    """Send a push notification to a crew device. Silent no-op on failure."""
    if not _init_firebase_admin():
        return
    try:
        from firebase_admin import messaging
        message = messaging.Message(
            notification=messaging.Notification(title=title, body=body),
            token=fcm_token,
        )
        messaging.send(message)
        logger.info("FCM push sent to token %s…", fcm_token[:12])
    except Exception as exc:
        logger.warning("FCM send failed: %s", exc)
