"""
Data Aggregator
Fetches ETA, blood, and capacity for a list of hospitals in parallel using
asyncio.gather, then merges everything into a single dict keyed by hospital name.

This module will be called directly from routers/incident.py (Phase 5).
"""

import asyncio
from typing import Any

from services.eraktkosh import simulate_blood
from services.routing_ors import get_all_etas
from services.simulator import simulate_capacity


# ── Public API ─────────────────────────────────────────────────────────────────

async def fetch_hospital_data(
    crash_lat: float,
    crash_lon: float,
    hospitals: list[dict],
) -> dict[str, dict[str, Any]]:
    """
    Fetch ETA, blood, and capacity for all hospitals in parallel.

    All three service calls run concurrently via asyncio.gather.
    Results are merged into one dict per hospital containing:
        - distance_km
        - eta_minutes
        - blood  (per blood-group unit counts + data_source)
        - capacity (icu, beds, specialties, trauma_centre, data_source)

    Args:
        crash_lat:  latitude of the incident.
        crash_lon:  longitude of the incident.
        hospitals:  list of hospital dicts from location_engine.

    Returns:
        {
            "<hospital_name>": {
                "distance_km":  float,
                "eta_minutes":  float,
                "blood":        dict,
                "capacity":     dict,
            },
            ...
        }
    """
    etas, blood, capacity = await asyncio.gather(
        get_all_etas(crash_lat, crash_lon, hospitals),
        simulate_blood(hospitals),
        simulate_capacity(hospitals),
    )

    return {
        h["name"]: _merge(h, etas, blood, capacity)
        for h in hospitals
    }


# ── Internal helpers ───────────────────────────────────────────────────────────

def _merge(
    hospital: dict,
    etas: dict,
    blood: dict,
    capacity: dict,
) -> dict[str, Any]:
    """Combine per-hospital slices from each service into one flat dict."""
    name = hospital["name"]
    eta_entry = etas.get(name, {})

    return {
        "distance_km": hospital.get("distance_km", eta_entry.get("distance_km")),
        "eta_minutes": eta_entry.get("eta_minutes"),
        "blood": blood.get(name, {}),
        "capacity": capacity.get(name, {}),
    }
