"""
Routing / ETA Service
Simulates ambulance travel times from a crash site to each hospital.

ETA is derived from haversine distance with a realistic urban speed assumption
so values scale correctly with geography rather than being purely random.

Real implementation: replace get_all_etas() with an OpenRouteService matrix
call — POST /v2/matrix/driving-car with the crash origin and all hospital
destinations in one request.
"""

import random
from typing import Any

from services.location_engine import haversine

# Urban ambulance average speed (km/h) — conservative for Mumbai traffic
_URBAN_SPEED_KMH = 30.0
# Small variance band applied on top of the distance-based ETA (minutes)
_VARIANCE_MINUTES = 3.0
DATA_SOURCE = "simulated"


# ── Public API ─────────────────────────────────────────────────────────────────

async def get_all_etas(
    crash_lat: float,
    crash_lon: float,
    hospitals: list[dict],
) -> dict[str, dict[str, Any]]:
    """
    Return simulated ETAs from (crash_lat, crash_lon) to every hospital.

    ETA is distance ÷ speed + small deterministic jitter so values are
    geographically plausible and consistent across calls.

    Args:
        crash_lat: latitude of the incident.
        crash_lon: longitude of the incident.
        hospitals: list of hospital dicts (must contain name, lat, lon).

    Returns:
        {
            "<hospital_name>": {
                "eta_minutes":   float,
                "distance_km":   float,
                "data_source":   "simulated",
            },
            ...
        }
    """
    return {
        h["name"]: _estimate_eta(crash_lat, crash_lon, h)
        for h in hospitals
    }


# ── Internal helpers ───────────────────────────────────────────────────────────

def _estimate_eta(
    crash_lat: float,
    crash_lon: float,
    hospital: dict,
) -> dict[str, Any]:
    """
    Compute a single hospital ETA.

    Uses haversine distance + urban speed for the base value, then adds a
    small deterministic jitter seeded on the hospital name so repeated calls
    return the same result.
    """
    distance_km = haversine(crash_lat, crash_lon, hospital["lat"], hospital["lon"])

    base_minutes = (distance_km / _URBAN_SPEED_KMH) * 60.0

    rng = random.Random(hash(hospital["name"]) % 9999)
    jitter = rng.uniform(-_VARIANCE_MINUTES, _VARIANCE_MINUTES)

    eta_minutes = round(max(1.0, base_minutes + jitter), 1)

    return {
        "eta_minutes": eta_minutes,
        "distance_km": round(distance_km, 2),
        "data_source": DATA_SOURCE,
    }
