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

_ACTIVE_INCIDENT_STATUS_RANK = {
    "dispatched": 1,
    "en_route": 2,
    "on_scene": 3,
    "transporting": 4,
}

# In-memory fallback for scene assessments — works when Firestore is disabled
_scene_cache: dict[str, list[dict[str, Any]]] = {}

# In-memory fallback for kiosk prealerts — keyed by prealert_id
_prealert_cache: dict[str, dict[str, Any]] = {}

# In-memory fallback for bystander reports — keyed by report_id
_bystander_cache: dict[str, dict[str, Any]] = {}

# In-memory fallback for recent incidents — keyed by incident_id (enables pre-positioning without Firestore)
_incident_cache: dict[str, dict[str, Any]] = {}

# In-memory fallback for crew assignments — keyed by unit_id (enables pre-positioning without Firestore)
_crew_assignment_cache: dict[str, dict[str, Any]] = {}


def disable() -> None:
    """Proactively disable Firestore (called when Google is unreachable at startup).
    Prevents gRPC from spawning background auth-retry threads."""
    global _db, _init_attempted
    _init_attempted = True
    _db = None
    logger.warning("Firestore forcibly disabled — all operations will no-op.")


# ── Firestore ──────────────────────────────────────────────────────────────────

def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _default_incident_doc() -> dict[str, Any]:
    now = _utc_now_iso()
    return {
        "status": "new",
        "crew_statuses": {},
        "prealerts": [],
        "reroutes": [],
        "timeline": [],
        "saved_at": now,
        "updated_at": now,
    }


def _append_timeline_event(doc: dict[str, Any], event: dict[str, Any]) -> None:
    timeline = list(doc.get("timeline", []))
    timeline.append(event)
    doc["timeline"] = timeline[-100:]


def _derive_incident_status(crew_statuses: dict[str, str], fallback: str = "new") -> str:
    active = [status for status in crew_statuses.values() if status not in {"closed", "standby"}]
    if active:
        return max(active, key=lambda status: _ACTIVE_INCIDENT_STATUS_RANK.get(status, 0))
    if crew_statuses:
        return "closed"
    return fallback


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


async def _mutate_incident(
    incident_id: str,
    mutator,
    *,
    missing_ok: bool = True,
) -> None:
    db = _get_db()
    if db is None:
        return
    try:
        ref = db.collection("incidents").document(incident_id)
        snap = await ref.get()
        if snap.exists:
            doc = {**_default_incident_doc(), **snap.to_dict()}
        elif missing_ok:
            doc = _default_incident_doc()
        else:
            return

        mutator(doc)
        doc["updated_at"] = _utc_now_iso()
        await ref.set(doc)
    except Exception as exc:
        logger.warning("Firestore incident mutation failed for %s: %s", incident_id, exc)


async def save_incident(incident_id: str, data: dict[str, Any]) -> None:
    """Write an incident document to Firestore. Silent no-op on any failure."""
    # Always cache so pre-positioning + recent-incident list work without Firestore
    _incident_cache[incident_id] = {**data, "id": incident_id, "saved_at": data.get("saved_at") or _utc_now_iso()}

    def _save(doc: dict[str, Any]) -> None:
        timeline = list(doc.get("timeline", []))
        if not timeline:
            timeline.append({
                "event": "incident_created",
                "timestamp": _utc_now_iso(),
            })

        doc.update({
            **data,
            "hospitals": data.get("hospitals", doc.get("hospitals", [])),
            "scores": data.get("scores", doc.get("scores", [])),
            "status": doc.get("status", data.get("status", "new")),
            "timeline": timeline[-100:],
            "crew_statuses": dict(doc.get("crew_statuses", {})),
            "prealerts": list(doc.get("prealerts", [])),
            "reroutes": list(doc.get("reroutes", [])),
            "saved_at": doc.get("saved_at") or _utc_now_iso(),
        })

    await _mutate_incident(incident_id, _save)
    logger.info("Incident %s persisted to Firestore.", incident_id)


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
    """Return the most recent incidents from Firestore, newest first. Falls back to in-memory cache."""
    db = _get_db()
    if db is None:
        rows = sorted(_incident_cache.values(), key=lambda d: d.get("saved_at") or "", reverse=True)
        return rows[:limit]
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
        # Merge in-memory cache entries not yet flushed to Firestore
        fs_ids = {r.get("id") for r in results}
        for r in _incident_cache.values():
            if r.get("id") not in fs_ids:
                results.append(r)
        results.sort(key=lambda d: d.get("saved_at") or "", reverse=True)
        return results[:limit]
    except Exception as exc:
        logger.warning("Firestore read failed: %s", exc)
        rows = sorted(_incident_cache.values(), key=lambda d: d.get("saved_at") or "", reverse=True)
        return rows[:limit]


# ── Crew assignments ───────────────────────────────────────────────────────────

async def save_crew_assignment(unit_id: str, data: dict[str, Any]) -> None:
    """
    Write (overwrite) a crew assignment to crew_assignments/{unit_id}.
    The crew page subscribes to this document in real-time via Firebase JS SDK.
    """
    doc = {
        **data,
        "dispatched_at": _utc_now_iso(),
        "status":        "dispatched",
        "updated_at":    _utc_now_iso(),
    }
    # Always cache so pre-positioning can read crew positions without Firestore
    _crew_assignment_cache[unit_id] = doc

    db = _get_db()
    if db is None:
        logger.warning("Firestore unavailable — crew assignment cached in-memory only for %s.", unit_id)
        return
    try:
        await db.collection("crew_assignments").document(unit_id).set(doc)
        logger.info("Crew assignment saved for unit %s.", unit_id)
    except Exception as exc:
        logger.warning("Firestore crew assignment write failed for %s: %s", unit_id, exc)


async def get_crew_assignment(unit_id: str) -> dict[str, Any] | None:
    """Read a single crew assignment doc by unit id. Falls back to in-memory cache."""
    db = _get_db()
    if db is None:
        return _crew_assignment_cache.get(unit_id)
    try:
        snap = await db.collection("crew_assignments").document(unit_id).get()
        return snap.to_dict() if snap.exists else _crew_assignment_cache.get(unit_id)
    except Exception as exc:
        logger.warning("Firestore crew assignment read failed for %s: %s", unit_id, exc)
        return _crew_assignment_cache.get(unit_id)


async def update_crew_assignment(unit_id: str, patch: dict[str, Any]) -> None:
    """Merge a patch into an existing crew assignment."""
    now = _utc_now_iso()
    # Always update the in-memory cache so pre-positioning reads current status
    # even when Firestore is unavailable or when the write hasn't completed yet.
    if unit_id in _crew_assignment_cache:
        _crew_assignment_cache[unit_id] = {**_crew_assignment_cache[unit_id], **patch, "updated_at": now}

    db = _get_db()
    if db is None:
        return
    try:
        ref = db.collection("crew_assignments").document(unit_id)
        snap = await ref.get()
        base = snap.to_dict() if snap.exists else {}
        await ref.set({**base, **patch, "updated_at": now})
        logger.info("Crew assignment updated for unit %s.", unit_id)
    except Exception as exc:
        logger.warning("Firestore crew assignment update failed for %s: %s", unit_id, exc)


async def reset_all_crew_assignments(unit_ids: list[str]) -> None:
    """Set all given crew units to standby status in memory and Firestore."""
    now = _utc_now_iso()
    # Always update in-memory cache so subsequent reads see standby immediately.
    for unit_id in unit_ids:
        _crew_assignment_cache[unit_id] = {"status": "standby", "updated_at": now}

    db = _get_db()
    if db is None:
        return
    for unit_id in unit_ids:
        try:
            await db.collection("crew_assignments").document(unit_id).set({
                "status": "standby", "updated_at": now
            })
        except Exception as exc:
            logger.warning("Firestore crew reset failed for %s: %s", unit_id, exc)


_CREW_UNITS = ["AMB_1", "AMB_2", "AMB_3", "AMB_4", "AMB_5"]


async def seed_crew_assignments_if_empty() -> None:
    """
    Idempotent startup seed: if no crew_assignment documents exist yet (e.g. after
    a DB wipe), initialise all five units to standby so the CrewView and
    PrepositioningPanel have something to subscribe to immediately.
    """
    db = _get_db()
    if db is None:
        return
    try:
        # Peek at one doc — if any exist we don't need to seed.
        snap = await db.collection("crew_assignments").limit(1).get()
        if snap:
            return
        await reset_all_crew_assignments(_CREW_UNITS)
        logger.info("crew_assignments seeded to standby for units: %s", _CREW_UNITS)
    except Exception as exc:
        logger.warning("crew_assignments seed check failed (non-fatal): %s", exc)


async def record_incident_dispatch(incident_id: str, unit_id: str, assignment: dict[str, Any]) -> None:
    """Append a dispatch event and mark the incident active."""
    if not incident_id:
        return

    def _mutate(doc: dict[str, Any]) -> None:
        crew_statuses = dict(doc.get("crew_statuses", {}))
        crew_statuses[unit_id] = "dispatched"
        doc["crew_statuses"] = crew_statuses
        doc["status"] = _derive_incident_status(crew_statuses, fallback=doc.get("status", "new"))
        _append_timeline_event(doc, {
            "event": "crew_dispatched",
            "timestamp": _utc_now_iso(),
            "unit_id": unit_id,
            "hospital_name": assignment.get("hospital_name"),
            "severity": assignment.get("severity"),
            "patients_assigned": assignment.get("patients_assigned"),
        })

    await _mutate_incident(incident_id, _mutate)


async def record_crew_status(
    incident_id: str,
    unit_id: str,
    status: str,
    *,
    notes: str = "",
    timestamp: str | None = None,
) -> None:
    """Persist a crew status transition onto the incident timeline."""
    if not incident_id:
        return

    def _mutate(doc: dict[str, Any]) -> None:
        crew_statuses = dict(doc.get("crew_statuses", {}))
        crew_statuses[unit_id] = status
        doc["crew_statuses"] = crew_statuses
        doc["status"] = _derive_incident_status(crew_statuses, fallback=doc.get("status", "new"))
        _append_timeline_event(doc, {
            "event": "crew_status",
            "timestamp": timestamp or _utc_now_iso(),
            "unit_id": unit_id,
            "status": status,
            "notes": notes,
        })

    await _mutate_incident(incident_id, _mutate)


async def record_hospital_prealert(
    incident_id: str,
    hospital_id: str,
    prealert: dict[str, Any],
) -> None:
    """Store a hospital pre-alert against an incident."""
    if not incident_id:
        return

    def _mutate(doc: dict[str, Any]) -> None:
        entry = {
            **prealert,
            "hospital_id": hospital_id,
            "timestamp": prealert.get("timestamp") or _utc_now_iso(),
        }
        prealerts = list(doc.get("prealerts", []))
        prealerts.append(entry)
        doc["prealerts"] = prealerts[-50:]
        _append_timeline_event(doc, {
            "event": "hospital_prealert",
            "timestamp": entry["timestamp"],
            "hospital_id": hospital_id,
            "hospital_name": prealert.get("hospital_name"),
            "severity": prealert.get("severity"),
            "patients_assigned": prealert.get("patients_assigned"),
        })

    await _mutate_incident(incident_id, _mutate)


# ── Hospital kiosk accept/divert ───────────────────────────────────────────────

async def save_kiosk_prealert(prealert_id: str, data: dict[str, Any]) -> None:
    """
    Write a pointer doc to `hospital_prealerts/{prealert_id}` so the hospital
    kiosk can subscribe by hospital_id without knowing incident IDs.
    """
    now = _utc_now_iso()
    doc = {**data, "status": data.get("status", "pending"), "created_at": now, "updated_at": now}
    # Always save to in-memory cache so the REST polling fallback works without Firestore
    _prealert_cache[prealert_id] = doc

    db = _get_db()
    if db is None:
        return
    try:
        await db.collection("hospital_prealerts").document(prealert_id).set(doc)
        logger.info("Kiosk prealert written: %s -> %s", prealert_id, data.get("hospital_id"))
    except Exception as exc:
        logger.warning("Kiosk prealert write failed for %s: %s", prealert_id, exc)


async def get_kiosk_prealerts_for_hospital(hospital_key: str, limit: int = 20) -> list[dict[str, Any]]:
    """Return prealerts for a specific hospital, using Firestore or in-memory fallback."""
    def _ts(p: dict) -> str:
        return p.get("created_at") or p.get("timestamp") or ""

    cache_rows = [p for p in _prealert_cache.values() if p.get("hospital_id") == hospital_key]

    db = _get_db()
    if db is None:
        cache_rows.sort(key=_ts, reverse=True)
        return cache_rows[:limit]
    try:
        # Filter by hospital_id in the query so we never miss new prealerts when
        # the total collection size exceeds the fetch limit.
        results = []
        async for snap in (
            db.collection("hospital_prealerts")
              .where("hospital_id", "==", hospital_key)
              .limit(limit)
              .stream()
        ):
            entry = snap.to_dict()
            entry["prealert_id"] = snap.id
            results.append(entry)

        # Merge with cache: prefer cache for status fields (cache is updated synchronously
        # by respond_to_prealert; Firestore write may lag or fail).
        cache_by_id = {p["prealert_id"]: p for p in cache_rows}
        fs_ids = {r["prealert_id"] for r in results}
        for r in results:
            pid = r.get("prealert_id")
            if pid in cache_by_id:
                r.update({
                    k: v for k, v in cache_by_id[pid].items()
                    if k in ("status", "response_note", "responder", "responded_at", "updated_at")
                })
        for pid, p in cache_by_id.items():
            if pid not in fs_ids:
                results.append(p)

        results.sort(key=_ts, reverse=True)
        return results[:limit]
    except Exception as exc:
        logger.warning("Firestore kiosk prealert query failed for %s: %s", hospital_key, exc)
        cache_rows.sort(key=_ts, reverse=True)
        return cache_rows[:limit]


async def get_kiosk_prealert(prealert_id: str) -> dict[str, Any] | None:
    """Read a single kiosk prealert doc. Falls back to in-memory cache."""
    db = _get_db()
    if db is None:
        return _prealert_cache.get(prealert_id)
    try:
        snap = await db.collection("hospital_prealerts").document(prealert_id).get()
        if snap.exists:
            return snap.to_dict()
        return _prealert_cache.get(prealert_id)
    except Exception as exc:
        logger.warning("Kiosk prealert read failed for %s: %s", prealert_id, exc)
        return _prealert_cache.get(prealert_id)


async def respond_to_prealert(
    prealert_id: str,
    status: str,
    note: str = "",
    responder: str | None = None,
) -> dict[str, Any] | None:
    """
    Hospital kiosk response.
    Updates the kiosk doc and mirrors the status onto the incident's prealerts[] entry,
    then appends a timeline event.
    Returns the updated kiosk doc (or None if Firestore is unavailable).
    """
    now = _utc_now_iso()

    # Update in-memory cache regardless of Firestore state
    if prealert_id in _prealert_cache:
        _prealert_cache[prealert_id].update({
            "status": status, "response_note": note,
            "responder": responder, "responded_at": now, "updated_at": now,
        })

    db = _get_db()
    if db is None:
        return _prealert_cache.get(prealert_id)
    data: dict[str, Any] | None = None
    try:
        ref = db.collection("hospital_prealerts").document(prealert_id)
        snap = await ref.get()
        if snap.exists:
            data = snap.to_dict()
        else:
            # Not in Firestore — use in-memory cache entry if available
            data = dict(_prealert_cache.get(prealert_id) or {}) or None
        if data is None:
            return None
        data.update({
            "status": status,
            "response_note": note,
            "responder": responder,
            "responded_at": now,
            "updated_at": now,
        })
        await ref.set(data)
    except Exception as exc:
        logger.warning("Kiosk prealert update failed for %s: %s", prealert_id, exc)
        return _prealert_cache.get(prealert_id)

    incident_id = data.get("incident_id")
    hospital_id = data.get("hospital_id")
    if incident_id:
        def _mirror(doc: dict[str, Any]) -> None:
            prealerts = list(doc.get("prealerts", []))
            for entry in prealerts:
                if entry.get("prealert_id") == prealert_id:
                    entry["status"] = status
                    entry["response_note"] = note
                    entry["responded_at"] = now
                    break
            doc["prealerts"] = prealerts[-50:]
            _append_timeline_event(doc, {
                "event": "hospital_response",
                "timestamp": now,
                "prealert_id": prealert_id,
                "hospital_id": hospital_id,
                "hospital_name": data.get("hospital_name"),
                "status": status,
                "note": note,
            })

        await _mutate_incident(incident_id, _mirror)

    return data


async def record_incident_reroute(
    incident_id: str,
    reroute: dict[str, Any],
    incident_snapshot: dict[str, Any],
) -> None:
    """Append reroute history while replacing the current incident snapshot."""
    if not incident_id:
        return

    def _mutate(doc: dict[str, Any]) -> None:
        reroute_entry = {
            **reroute,
            "timestamp": reroute.get("timestamp") or _utc_now_iso(),
        }
        reroutes = list(doc.get("reroutes", []))
        reroutes.append(reroute_entry)
        doc["reroutes"] = reroutes[-20:]
        doc.update({
            **incident_snapshot,
            "saved_at": doc.get("saved_at") or _utc_now_iso(),
            "crew_statuses": dict(doc.get("crew_statuses", {})),
            "prealerts": list(doc.get("prealerts", [])),
            "timeline": list(doc.get("timeline", [])),
            "reroutes": reroutes[-20:],
            "status": doc.get("status", "new"),
        })
        _append_timeline_event(doc, {
            "event": "incident_rerouted",
            "timestamp": reroute_entry["timestamp"],
            "source": reroute.get("source", "scene_consensus"),
            "reason": reroute.get("reason", ""),
            "report_count": reroute.get("report_count"),
        })

    await _mutate_incident(incident_id, _mutate)


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


# ── Bystander reports ──────────────────────────────────────────────────────────

async def save_bystander_report(report_id: str, data: dict[str, Any]) -> None:
    """Write a bystander report to Firestore and update the in-memory cache.
    Always called with await (never create_task) so reads see it immediately."""
    now = _utc_now_iso()
    doc = {**data, "id": report_id, "saved_at": now, "updated_at": now}
    _bystander_cache[report_id] = doc   # update cache first — used as fallback if Firestore unavailable
    db = _get_db()
    if db is None:
        logger.warning("Firestore unavailable — bystander report %s stored in memory only.", report_id)
        return
    try:
        await db.collection("bystander_reports").document(report_id).set(doc)
        logger.info("Bystander report saved to Firestore: %s", report_id)
    except Exception as exc:
        logger.warning("Firestore bystander save failed for %s: %s", report_id, exc)


async def list_bystander_reports(status: str | None = None, limit: int = 20) -> list[dict[str, Any]]:
    """Return the most recent bystander reports, optionally filtered by status. Falls back to in-memory cache."""
    def _from_cache() -> list[dict[str, Any]]:
        rows = list(_bystander_cache.values())
        if status:
            rows = [r for r in rows if r.get("status") == status]
        rows.sort(key=lambda d: d.get("saved_at") or "", reverse=True)
        return rows[:limit]

    db = _get_db()
    if db is None:
        return _from_cache()
    try:
        fetch_limit = max(limit * 5, 100)
        query = db.collection("bystander_reports").limit(fetch_limit)
        results = []
        async for snap in query.stream():
            entry = snap.to_dict()
            entry["id"] = snap.id
            if not status or entry.get("status") == status:
                results.append(entry)
        # Merge in-memory cache entries not in Firestore
        fs_ids = {r.get("id") for r in results}
        for r in _bystander_cache.values():
            if r.get("id") not in fs_ids:
                if not status or r.get("status") == status:
                    results.append(r)
        results.sort(key=lambda d: d.get("saved_at") or "", reverse=True)
        return results[:limit]
    except Exception as exc:
        logger.warning("Firestore bystander list failed: %s", exc)
        return _from_cache()


async def update_bystander_report(report_id: str, patch: dict[str, Any]) -> bool:
    """Patch a bystander report doc. Updates in-memory cache; Firestore is best-effort."""
    if report_id in _bystander_cache:
        _bystander_cache[report_id].update({**patch, "updated_at": _utc_now_iso()})

    db = _get_db()
    if db is None:
        return report_id in _bystander_cache
    try:
        ref = db.collection("bystander_reports").document(report_id)
        snap = await ref.get()
        if snap.exists:
            base = snap.to_dict() or {}
            await ref.set({**base, **patch, "updated_at": _utc_now_iso()})
        elif report_id in _bystander_cache:
            await ref.set({**_bystander_cache[report_id], **patch, "updated_at": _utc_now_iso()})
        else:
            return False
        return True
    except Exception as exc:
        logger.warning("Firestore bystander update failed for %s: %s", report_id, exc)
        return report_id in _bystander_cache


async def dismiss_all_bystander_reports(reason: str = "session_ended") -> int:
    """Dismiss all 'new' bystander reports. Returns count dismissed."""
    now = _utc_now_iso()
    count = 0
    for doc in _bystander_cache.values():
        if doc.get("status") == "new":
            doc.update({"status": "dismissed", "dismiss_reason": reason, "updated_at": now})
            count += 1

    db = _get_db()
    if db is None:
        return count
    try:
        dismissed = 0
        async for snap in db.collection("bystander_reports").where("status", "==", "new").stream():
            base = snap.to_dict() or {}
            await snap.reference.set({**base, "status": "dismissed", "dismiss_reason": reason, "updated_at": now})
            dismissed += 1
        return dismissed
    except Exception as exc:
        logger.warning("dismiss_all_bystander_reports failed: %s", exc)
        return count


async def save_scene_assessment(incident_id: str, unit_id: str, data: dict[str, Any]) -> None:
    """Write a scene assessment to Firestore and update the in-memory cache.
    Always called with await (never create_task) so subsequent reads see it immediately."""
    doc = {**data, "unit_id": unit_id, "incident_id": incident_id, "saved_at": _utc_now_iso()}
    cache = _scene_cache.setdefault(incident_id, [])
    _scene_cache[incident_id] = [r for r in cache if r.get("unit_id") != unit_id] + [doc]

    db = _get_db()
    if db is None:
        return
    try:
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
    """Return all scene assessment reports for an incident. Falls back to in-memory cache."""
    db = _get_db()
    if db is None:
        return list(_scene_cache.get(incident_id, []))
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
        # Merge with in-memory cache to include any reports saved since last Firestore write
        cached = _scene_cache.get(incident_id, [])
        fs_ids = {r.get("unit_id") for r in results}
        for r in cached:
            if r.get("unit_id") not in fs_ids:
                results.append(r)
        return results
    except Exception as exc:
        logger.warning("Firestore get_scene_assessments failed: %s", exc)
        return list(_scene_cache.get(incident_id, []))


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
