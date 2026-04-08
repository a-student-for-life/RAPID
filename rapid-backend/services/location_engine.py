"""
Location Engine — Dynamic Hospital Discovery
Discovers nearby hospitals from OpenStreetMap via the Overpass API.
Expands search radius automatically until a minimum number of results is found.
"""

import math
import time
import httpx
from typing import Any

# ── Cache ──────────────────────────────────────────────────────────────────────
_cache: dict[str, dict] = {}
_CACHE_TTL = 3600  # seconds

# ── Constants ──────────────────────────────────────────────────────────────────
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OVERPASS_TIMEOUT = 18  # seconds
RADIUS_STEP_FACTOR = 1.6
MIN_HOSPITALS = 3
INITIAL_RADIUS_KM = 15.0
MAX_RADIUS_KM = 30.0
MAX_RESULTS = 10


# ── Public API ─────────────────────────────────────────────────────────────────

async def discover_hospitals_adaptive(
    lat: float,
    lon: float,
    initial_radius_km: float = INITIAL_RADIUS_KM,
    min_count: int = MIN_HOSPITALS,
    max_radius_km: float = MAX_RADIUS_KM,
) -> dict[str, Any]:
    """
    Discover hospitals near (lat, lon).

    Starts at initial_radius_km and expands by RADIUS_STEP_FACTOR each
    iteration until at least min_count hospitals are found or max_radius_km
    is reached.

    Returns:
        {
            "hospitals":   list of hospital dicts,
            "radius_km":   float — radius that returned results,
            "expanded":    bool  — True if radius was increased,
        }
    """
    radius = initial_radius_km

    while radius <= max_radius_km:
        hospitals = await _fetch_and_cache(lat, lon, radius)
        if len(hospitals) >= min_count:
            return {
                "hospitals": hospitals,
                "radius_km": radius,
                "expanded": radius > initial_radius_km,
            }
        radius = min(radius * RADIUS_STEP_FACTOR, max_radius_km)

    # Final attempt at max radius
    hospitals = await _fetch_and_cache(lat, lon, max_radius_km)
    return {
        "hospitals": hospitals,
        "radius_km": max_radius_km,
        "expanded": True,
    }


# ── Internal helpers ───────────────────────────────────────────────────────────

async def _fetch_and_cache(lat: float, lon: float, radius_km: float) -> list[dict]:
    """Return cached result if fresh, otherwise query Overpass and cache."""
    key = f"{round(lat, 2)}_{round(lon, 2)}_{radius_km}"

    if key in _cache and time.time() - _cache[key]["ts"] < _CACHE_TTL:
        return _cache[key]["data"]

    hospitals = await _query_overpass(lat, lon, radius_km)
    _cache[key] = {"data": hospitals, "ts": time.time()}
    return hospitals


async def _query_overpass(lat: float, lon: float, radius_km: float) -> list[dict]:
    """Fetch hospitals from the Overpass API and return normalised dicts."""
    radius_m = int(radius_km * 1000)
    query = (
        f"[out:json];"
        f"("
        f"  node[amenity=hospital](around:{radius_m},{lat},{lon});"
        f"  way[amenity=hospital](around:{radius_m},{lat},{lon});"
        f");"
        f"out center;"
    )

    async with httpx.AsyncClient() as client:
        response = await client.post(
            OVERPASS_URL,
            data={"data": query},
            timeout=OVERPASS_TIMEOUT,
        )
        response.raise_for_status()

    hospitals = _parse_elements(response.json().get("elements", []), lat, lon)
    hospitals.sort(key=lambda h: h["distance_km"])
    return hospitals[:MAX_RESULTS]


def _parse_elements(elements: list[dict], origin_lat: float, origin_lon: float) -> list[dict]:
    """Convert raw Overpass elements into normalised hospital dicts."""
    results = []
    for element in elements:
        tags = element.get("tags", {})
        name = tags.get("name")
        if not name:
            continue

        h_lat = element.get("lat") or element.get("center", {}).get("lat")
        h_lon = element.get("lon") or element.get("center", {}).get("lon")
        if h_lat is None or h_lon is None:
            continue

        results.append({
            "id": f"osm_{element['id']}",
            "name": name,
            "lat": h_lat,
            "lon": h_lon,
            "data_source": "OpenStreetMap",
            "data_quality": "community",
            "distance_km": haversine(origin_lat, origin_lon, h_lat, h_lon),
        })

    return results


# ── Geometry ───────────────────────────────────────────────────────────────────

def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Return great-circle distance in kilometres between two points."""
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(dlon / 2) ** 2
    )
    return R * 2 * math.asin(math.sqrt(a))
