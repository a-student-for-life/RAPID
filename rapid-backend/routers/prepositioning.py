"""
Predictive Pre-positioning Router (F4)

GET /prepositioning/suggestions
  Returns hot zones derived from recent incidents and idle-unit move
  recommendations. Used by the dispatcher to push ambulances toward
  predicted demand instead of waiting passively at base.
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Query

from services import firestore_client, prepositioning

logger = logging.getLogger(__name__)
router = APIRouter()

UNITS = ["AMB_1", "AMB_2", "AMB_3", "AMB_4", "AMB_5"]


@router.get("/prepositioning/suggestions")
async def get_suggestions(
    limit: int = Query(50, ge=5, le=200),
    base_lat: Optional[float] = Query(None, description="Default position for units with no recorded location."),
    base_lon: Optional[float] = None,
):
    incidents = await firestore_client.get_recent_incidents(limit=limit)

    crew_assignments: dict[str, dict | None] = {}
    for unit_id in UNITS:
        doc = await firestore_client.get_crew_assignment(unit_id)
        crew_assignments[unit_id] = doc

    base = (base_lat, base_lon) if base_lat is not None and base_lon is not None else None
    return prepositioning.compute(incidents, crew_assignments, base_position=base)
