"""
Firestore Client
Persists incidents for audit trail and history replay.
Initialised lazily — if GOOGLE_CLOUD_PROJECT is not set or Firestore is
unavailable, all operations silently no-op so the main pipeline is unaffected.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)

_db = None
_init_attempted = False


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
        doc = {**data, "saved_at": datetime.now(timezone.utc).isoformat()}
        await db.collection("incidents").document(incident_id).set(doc)
        logger.info("Incident %s persisted to Firestore.", incident_id)
    except Exception as exc:
        logger.warning("Firestore write failed for %s: %s", incident_id, exc)


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
