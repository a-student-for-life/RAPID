"""
Location Engine — Dynamic Hospital Discovery
Discovers nearby hospitals from OpenStreetMap via the Overpass API.
Expands search radius automatically until a minimum number of results is found.

Cache uses cachetools.TTLCache so it is safe when Cloud Run scales to multiple
instances (each instance has its own in-process cache with a 1-hour TTL).
"""

import logging
import math
import httpx
from cachetools import TTLCache
from typing import Any

logger = logging.getLogger(__name__)

# ── Cache ──────────────────────────────────────────────────────────────────────
# maxsize=256 entries, each keyed by (lat, lon, radius) rounded to 2 dp.
_cache: TTLCache = TTLCache(maxsize=256, ttl=3600)

# ── Constants ──────────────────────────────────────────────────────────────────
OVERPASS_URL     = "https://overpass-api.de/api/interpreter"
OVERPASS_TIMEOUT = 6   # seconds — fail fast so seed fallback kicks in quickly
RADIUS_STEP_FACTOR = 1.6
MIN_HOSPITALS      = 3
INITIAL_RADIUS_KM  = 15.0
MAX_RADIUS_KM      = 30.0
MAX_RESULTS        = 10

# Circuit breaker — skip Overpass for 90 s after any failure
import time as _time
_overpass_down_until: float = 0.0

# Pre-seeded Mumbai hospitals used when Overpass is unavailable or rate-limited.
# Coordinates are approximate; names match simulator.py _KNOWN_HOSPITALS for
# rich capacity data.
_MUMBAI_SEED_HOSPITALS = [
    {"id": "seed_1", "name": "KEM Hospital",
     "lat": 18.9990, "lon": 72.8380, "data_source": "seed", "data_quality": "curated"},
    {"id": "seed_2", "name": "Lokmanya Tilak General Hospital",
     "lat": 19.0424, "lon": 72.8418, "data_source": "seed", "data_quality": "curated"},
    {"id": "seed_3", "name": "Rajawadi Hospital",
     "lat": 19.0866, "lon": 72.8948, "data_source": "seed", "data_quality": "curated"},
    {"id": "seed_4", "name": "Bhabha Hospital",
     "lat": 19.0704, "lon": 72.8818, "data_source": "seed", "data_quality": "curated"},
    {"id": "seed_5", "name": "Kokilaben Dhirubhai Ambani Hospital",
     "lat": 19.1321, "lon": 72.8210, "data_source": "seed", "data_quality": "curated"},
]


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

    while radius < max_radius_km:   # strict < prevents infinite loop at ceiling
        hospitals = await _fetch_and_cache(lat, lon, radius)
        if len(hospitals) >= min_count:
            return {
                "hospitals": hospitals,
                "radius_km": radius,
                "expanded": radius > initial_radius_km,
            }
        next_r = radius * RADIUS_STEP_FACTOR
        if next_r >= max_radius_km:
            break
        radius = next_r

    # Final attempt at max radius
    hospitals = await _fetch_and_cache(lat, lon, max_radius_km)

    # If Overpass returned too few results, fill in with pre-seeded hospitals.
    if len(hospitals) < min_count:
        existing_names = {h["name"] for h in hospitals}
        seeds = [
            {**h, "distance_km": haversine(lat, lon, h["lat"], h["lon"])}
            for h in _MUMBAI_SEED_HOSPITALS
            if h["name"] not in existing_names
        ]
        seeds.sort(key=lambda h: h["distance_km"])
        hospitals = sorted(
            hospitals + seeds,
            key=lambda h: h["distance_km"],
        )[:MAX_RESULTS]
        logger.warning(
            "Overpass returned fewer than %d hospitals — merged %d seed hospitals.",
            min_count, len(seeds),
        )

    return {
        "hospitals": hospitals,
        "radius_km": max_radius_km,
        "expanded": True,
    }


async def discover_agencies(
    lat: float,
    lon: float,
    radius_km: float = 10.0,
) -> list[dict]:
    """
    Discover fire stations and police stations near (lat, lon) via Overpass.
    Returns up to 6 nearest agencies with type label.
    Errors are silently swallowed — agencies are informational only.
    """
    radius_m = int(radius_km * 1000)
    query = (
        f"[out:json];"
        f"("
        f"  node[amenity=fire_station](around:{radius_m},{lat},{lon});"
        f"  way[amenity=fire_station](around:{radius_m},{lat},{lon});"
        f"  node[amenity=police](around:{radius_m},{lat},{lon});"
        f"  way[amenity=police](around:{radius_m},{lat},{lon});"
        f");"
        f"out center;"
    )
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                OVERPASS_URL,
                data={"data": query},
                timeout=10,
            )
            response.raise_for_status()
        elements = response.json().get("elements", [])
    except Exception as exc:
        logger.warning("Agency discovery failed (%s) — skipping.", exc)
        return []

    agencies = []
    for element in elements:
        tags    = element.get("tags", {})
        name    = tags.get("name") or tags.get("amenity", "Unknown")
        amenity = tags.get("amenity", "")
        a_lat   = element.get("lat") or element.get("center", {}).get("lat")
        a_lon   = element.get("lon") or element.get("center", {}).get("lon")
        if a_lat is None or a_lon is None:
            continue
        agencies.append({
            "id":           f"osm_{element['id']}",
            "name":         name,
            "type":         "fire_station" if amenity == "fire_station" else "police",
            "lat":          a_lat,
            "lon":          a_lon,
            "distance_km":  round(haversine(lat, lon, a_lat, a_lon), 2),
        })

    agencies.sort(key=lambda a: a["distance_km"])
    return agencies[:6]


# ── Internal helpers ───────────────────────────────────────────────────────────

async def _fetch_and_cache(lat: float, lon: float, radius_km: float) -> list[dict]:
    """Return cached result if fresh, otherwise query Overpass and cache."""
    key = f"{round(lat, 2)}_{round(lon, 2)}_{radius_km}"

    cached = _cache.get(key)
    if cached is not None:
        return cached

    hospitals = await _query_overpass(lat, lon, radius_km)
    _cache[key] = hospitals
    return hospitals


async def _query_overpass(lat: float, lon: float, radius_km: float) -> list[dict]:
    """Fetch hospitals from the Overpass API and return normalised dicts.

    Circuit-breaker: after any failure, Overpass is skipped for 90 s so
    subsequent radius-expansion attempts return instantly and the seed
    fallback is reached without delay.
    """
    global _overpass_down_until

    if _time.monotonic() < _overpass_down_until:
        logger.debug("Overpass circuit-breaker active — skipping API call.")
        return []

    radius_m = int(radius_km * 1000)
    query = (
        f"[out:json];"
        f"("
        f"  node[amenity=hospital](around:{radius_m},{lat},{lon});"
        f"  way[amenity=hospital](around:{radius_m},{lat},{lon});"
        f");"
        f"out center;"
    )

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                OVERPASS_URL,
                data={"data": query},
                timeout=OVERPASS_TIMEOUT,
            )
            response.raise_for_status()
        elements = response.json().get("elements", [])
    except (httpx.TimeoutException, httpx.HTTPStatusError, httpx.RequestError) as exc:
        logger.warning("Overpass API unavailable (%s: %s) — activating circuit-breaker for 90 s.",
                       type(exc).__name__, exc)
        _overpass_down_until = _time.monotonic() + 90.0
        return []

    hospitals = _parse_elements(elements, lat, lon)
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
