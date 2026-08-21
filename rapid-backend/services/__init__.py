"""Service package compatibility helpers.

Keeps the public firestore_client module API compatible with the original RAPID
backend while the Firestore client itself supports Render JSON credentials.
"""

from __future__ import annotations

from datetime import datetime, timezone
import os

from . import firestore_client


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def save_kiosk_prealert(prealert_id: str, data: dict) -> None:
    now = _now()
    doc = {**data, "status": data.get("status", "pending"), "created_at": now, "updated_at": now}
    firestore_client._prealert_cache[prealert_id] = doc
    db = firestore_client._get_db()
    if db is None:
        return
    try:
        await db.collection("hospital_prealerts").document(prealert_id).set(doc)
    except Exception as exc:
        firestore_client.logger.warning("Kiosk prealert write failed for %s: %s", prealert_id, exc)


async def get_kiosk_prealerts_for_hospital(hospital_key: str, limit: int = 20) -> list[dict]:
    def ts(item: dict) -> str:
        return item.get("created_at") or item.get("timestamp") or ""

    cache_rows = [p for p in firestore_client._prealert_cache.values() if p.get("hospital_id") == hospital_key]
    db = firestore_client._get_db()
    if db is None:
        cache_rows.sort(key=ts, reverse=True)
        return cache_rows[:limit]
    try:
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
        results.sort(key=ts, reverse=True)
        return results[:limit]
    except Exception as exc:
        firestore_client.logger.warning("Firestore kiosk prealert query failed: %s", exc)
        cache_rows.sort(key=ts, reverse=True)
        return cache_rows[:limit]


async def get_kiosk_prealert(prealert_id: str) -> dict | None:
    db = firestore_client._get_db()
    if db is None:
        return firestore_client._prealert_cache.get(prealert_id)
    try:
        snap = await db.collection("hospital_prealerts").document(prealert_id).get()
        return snap.to_dict() if snap.exists else firestore_client._prealert_cache.get(prealert_id)
    except Exception as exc:
        firestore_client.logger.warning("Firestore kiosk prealert read failed: %s", exc)
        return firestore_client._prealert_cache.get(prealert_id)


async def respond_to_prealert(prealert_id: str, status: str, note: str = "", responder: str | None = None) -> dict | None:
    now = _now()
    cached = firestore_client._prealert_cache.get(prealert_id)
    if cached is not None:
        cached.update({"status": status, "response_note": note, "responder": responder, "responded_at": now, "updated_at": now})

    db = firestore_client._get_db()
    if db is None:
        return cached
    try:
        ref = db.collection("hospital_prealerts").document(prealert_id)
        snap = await ref.get()
        data = snap.to_dict() if snap.exists else dict(cached or {})
        if not data:
            return None
        data.update({"status": status, "response_note": note, "responder": responder, "responded_at": now, "updated_at": now})
        await ref.set(data)
        incident_id = data.get("incident_id")
        if incident_id:
            await firestore_client._mutate_incident(incident_id, lambda doc: _mirror_prealert(doc, prealert_id, status, note, data, now))
        return data
    except Exception as exc:
        firestore_client.logger.warning("Kiosk prealert update failed: %s", exc)
        return cached


def _mirror_prealert(doc: dict, prealert_id: str, status: str, note: str, data: dict, now: str) -> None:
    prealerts = list(doc.get("prealerts", []))
    for entry in prealerts:
        if entry.get("prealert_id") == prealert_id:
            entry.update({"status": status, "response_note": note, "responded_at": now})
            break
    doc["prealerts"] = prealerts[-50:]
    firestore_client._append_timeline_event(doc, {
        "event": "hospital_response",
        "timestamp": now,
        "prealert_id": prealert_id,
        "hospital_id": data.get("hospital_id"),
        "hospital_name": data.get("hospital_name"),
        "status": status,
        "note": note,
    })


async def record_incident_reroute(incident_id: str, reroute: dict, incident_snapshot: dict) -> None:
    if not incident_id:
        return
    def mutate(doc: dict) -> None:
        entry = {**reroute, "timestamp": reroute.get("timestamp") or _now()}
        reroutes = list(doc.get("reroutes", []))
        reroutes.append(entry)
        doc.update({**incident_snapshot, "reroutes": reroutes[-20:]})
        firestore_client._append_timeline_event(doc, {
            "event": "incident_rerouted",
            "timestamp": entry["timestamp"],
            "source": reroute.get("source", "scene_consensus"),
            "reason": reroute.get("reason", ""),
            "report_count": reroute.get("report_count"),
        })
    await firestore_client._mutate_incident(incident_id, mutate)


async def save_scene_assessment(incident_id: str, unit_id: str, data: dict) -> None:
    doc = {**data, "unit_id": unit_id, "incident_id": incident_id, "saved_at": _now()}
    cache = firestore_client._scene_cache.setdefault(incident_id, [])
    firestore_client._scene_cache[incident_id] = [r for r in cache if r.get("unit_id") != unit_id] + [doc]
    db = firestore_client._get_db()
    if db is None:
        return
    try:
        await (db.collection("scene_assessments").document(incident_id).collection("reports").document(unit_id).set(doc))
    except Exception as exc:
        firestore_client.logger.warning("Firestore scene assessment write failed: %s", exc)


async def get_scene_assessments(incident_id: str) -> list[dict]:
    db = firestore_client._get_db()
    if db is None:
        return list(firestore_client._scene_cache.get(incident_id, []))
    try:
        results = []
        async for doc in db.collection("scene_assessments").document(incident_id).collection("reports").stream():
            entry = doc.to_dict()
            entry["id"] = doc.id
            results.append(entry)
        cached = firestore_client._scene_cache.get(incident_id, [])
        ids = {r.get("unit_id") for r in results}
        results.extend(r for r in cached if r.get("unit_id") not in ids)
        return results
    except Exception as exc:
        firestore_client.logger.warning("Firestore get_scene_assessments failed: %s", exc)
        return list(firestore_client._scene_cache.get(incident_id, []))


async def send_crew_fcm(fcm_token: str, title: str, body: str) -> None:
    """Send FCM using the same Render JSON credentials when available."""
    try:
        import firebase_admin
        from firebase_admin import credentials, messaging

        if not firebase_admin._apps:
            sa_json = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
            sa_path = os.getenv("FIREBASE_SERVICE_ACCOUNT_PATH", "").strip()
            if sa_json:
                import json
                cred = credentials.Certificate(json.loads(sa_json))
            elif sa_path:
                cred = credentials.Certificate(sa_path)
            else:
                firestore_client.logger.warning("FCM disabled — no Firebase credentials configured.")
                return
            firebase_admin.initialize_app(cred)

        messaging.send(messaging.Message(
            notification=messaging.Notification(title=title, body=body),
            token=fcm_token,
        ))
    except Exception as exc:
        firestore_client.logger.warning("FCM send failed: %s", exc)


# Attach helpers to the imported module so existing `from services import firestore_client`
# callers continue to work without code changes in the routers.
firestore_client.save_kiosk_prealert = save_kiosk_prealert
firestore_client.get_kiosk_prealerts_for_hospital = get_kiosk_prealerts_for_hospital
firestore_client.get_kiosk_prealert = get_kiosk_prealert
firestore_client.respond_to_prealert = respond_to_prealert
firestore_client.record_incident_reroute = record_incident_reroute
firestore_client.save_scene_assessment = save_scene_assessment
firestore_client.get_scene_assessments = get_scene_assessments
firestore_client.send_crew_fcm = send_crew_fcm
