"""
Firestore Seed Script
Populates the required collections from scratch after a DB wipe.

Usage (from rapid-backend/):
    python seed_firestore.py

Requires GOOGLE_CLOUD_PROJECT (and optionally FIREBASE_SERVICE_ACCOUNT_PATH)
to be set in .env or the environment.
"""

import asyncio
import logging
import os
import sys

from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s — %(message)s")
logger = logging.getLogger("seed")

CREW_UNITS = ["AMB_1", "AMB_2", "AMB_3", "AMB_4", "AMB_5"]

# Demo incident locations (Mumbai) — gives pre-positioning something to work with
DEMO_INCIDENTS = [
    {"lat": 19.0760, "lon": 72.8777, "patient_groups": [{"severity": "critical", "count": 2}, {"severity": "moderate", "count": 3}], "status": "closed"},
    {"lat": 19.1136, "lon": 72.8697, "patient_groups": [{"severity": "moderate", "count": 4}, {"severity": "minor", "count": 6}], "status": "closed"},
    {"lat": 19.0330, "lon": 72.8650, "patient_groups": [{"severity": "critical", "count": 1}, {"severity": "minor", "count": 5}], "status": "closed"},
    {"lat": 19.0896, "lon": 72.8656, "patient_groups": [{"severity": "moderate", "count": 2}], "status": "closed"},
    {"lat": 19.0595, "lon": 72.8373, "patient_groups": [{"severity": "critical", "count": 3}, {"severity": "moderate", "count": 2}, {"severity": "minor", "count": 4}], "status": "closed"},
]


async def run():
    project = os.getenv("GOOGLE_CLOUD_PROJECT", "")
    if not project:
        logger.error("GOOGLE_CLOUD_PROJECT not set — cannot connect to Firestore.")
        sys.exit(1)

    try:
        from google.cloud import firestore as _fs
        sa_path = os.getenv("FIREBASE_SERVICE_ACCOUNT_PATH", "")
        if sa_path:
            from google.oauth2 import service_account
            creds = service_account.Credentials.from_service_account_file(
                sa_path, scopes=["https://www.googleapis.com/auth/cloud-platform"]
            )
            db = _fs.AsyncClient(project=project, credentials=creds)
        else:
            db = _fs.AsyncClient(project=project)
    except Exception as exc:
        logger.error("Firestore init failed: %s", exc)
        sys.exit(1)

    from datetime import datetime, timezone

    def utc_now():
        return datetime.now(timezone.utc).isoformat()

    # ── Crew assignments ────────────────────────────────────────────────────────
    logger.info("Seeding crew_assignments (%d units)…", len(CREW_UNITS))
    now = utc_now()
    for unit_id in CREW_UNITS:
        await db.collection("crew_assignments").document(unit_id).set({
            "status": "standby",
            "updated_at": now,
        })
        logger.info("  ✓ %s → standby", unit_id)

    # ── Demo incidents (for pre-positioning hot zones) ─────────────────────────
    import uuid
    logger.info("Seeding %d demo incidents for pre-positioning…", len(DEMO_INCIDENTS))
    for inc in DEMO_INCIDENTS:
        inc_id = str(uuid.uuid4())
        await db.collection("incidents").document(inc_id).set({
            **inc,
            "decision_path": "seed",
            "patient_count": sum(pg["count"] for pg in inc["patient_groups"]),
            "assignments": [],
            "warnings": [],
            "reasoning": "Seeded demo incident.",
            "elapsed_s": 0.0,
            "hospitals": [],
            "scores": [],
            "crew_statuses": {},
            "prealerts": [],
            "reroutes": [],
            "timeline": [{"event": "incident_created", "timestamp": now}],
            "saved_at": now,
            "updated_at": now,
        })
        logger.info("  ✓ incident %s at (%.4f, %.4f)", inc_id[:8], inc["lat"], inc["lon"])

    logger.info("Seed complete.")
    db.close()


if __name__ == "__main__":
    asyncio.run(run())
