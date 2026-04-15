"""
Routing / ETA Service
Fetches real road-network travel times from crash site to each hospital
using the OpenRouteService (ORS) Matrix API.

ORS free tier: 2,000 matrix requests/day.
To protect quota, results are cached with a 30-minute TTL keyed on
(crash_lat, crash_lon) rounded to 3 decimal places (~110 m grid) plus
a hash of the hospital list. Same incident area = cache hit.

Falls back to haversine-based simulation if ORS is unavailable or key not set.
"""

import hashlib
import logging
import os
import random
from typing import Any

import httpx
from cachetools import TTLCache

from services.location_engine import haversine

logger = logging.getLogger(__name__)

_ORS_API_KEY = os.getenv("ORS_API_KEY", "")
_ORS_URL     = "https://api.openrouteservice.org/v2/matrix/driving-car"
_ORS_TIMEOUT = 10  # seconds per request

# Cache: keyed by (rounded crash lat/lon + hospital names hash), 30-min TTL
# maxsize=128 covers many concurrent incidents without unbounded memory use
_cache: TTLCache = TTLCache(maxsize=128, ttl=1800)

# Haversine fallback constants
_URBAN_SPEED_KMH  = 30.0
_VARIANCE_MINUTES = 3.0


# ── Public API ─────────────────────────────────────────────────────────────────

async def get_all_etas(
    crash_lat: float,
    crash_lon: float,
    hospitals: list[dict],
) -> dict[str, dict[str, Any]]:
    """
    Return ETAs from (crash_lat, crash_lon) to every hospital.

    Uses ORS matrix API if ORS_API_KEY is set; otherwise falls back to
    haversine simulation. Results are cached for 30 minutes to preserve
    the ORS free-tier quota (2,000 requests/day).
    """
    if not hospitals:
        return {}

    cache_key = _make_cache_key(crash_lat, crash_lon, hospitals)
    cached = _cache.get(cache_key)
    if cached is not None:
        logger.debug("ORS cache hit for %s", cache_key)
        return cached

    if _ORS_API_KEY:
        try:
            result = await _fetch_ors(crash_lat, crash_lon, hospitals)
            _cache[cache_key] = result
            return result
        except Exception as exc:
            logger.warning(
                "ORS unavailable (%s: %s) — falling back to haversine.",
                type(exc).__name__, exc,
            )

    result = {h["name"]: _haversine_eta(crash_lat, crash_lon, h) for h in hospitals}
    _cache[cache_key] = result
    return result


# ── ORS matrix call ────────────────────────────────────────────────────────────

async def _fetch_ors(
    crash_lat: float,
    crash_lon: float,
    hospitals: list[dict],
) -> dict[str, dict[str, Any]]:
    """
    Call ORS /v2/matrix/driving-car.

    locations[0]   = crash site (source)
    locations[1..N] = hospitals (destinations)

    ORS uses [lon, lat] order throughout.
    durations[0][i] = seconds from crash to hospital i-1
    distances[0][i] = metres  from crash to hospital i-1
    """
    locations = (
        [[crash_lon, crash_lat]]
        + [[h["lon"], h["lat"]] for h in hospitals]
    )

    body = {
        "locations": locations,
        "sources":   [0],
        "metrics":   ["duration", "distance"],
    }

    async with httpx.AsyncClient(timeout=_ORS_TIMEOUT) as client:
        response = await client.post(
            _ORS_URL,
            headers={
                "Authorization":  _ORS_API_KEY,
                "Content-Type":   "application/json",
            },
            json=body,
        )

    if response.status_code != 200:
        logger.warning("ORS HTTP %d: %s", response.status_code, response.text[:300])
    response.raise_for_status()

    data      = response.json()
    durations = data["durations"][0]   # list of seconds; index 0 = source→source = 0
    distances = data["distances"][0]   # list of metres

    result: dict[str, dict[str, Any]] = {}
    for i, hospital in enumerate(hospitals, start=1):
        raw_secs = durations[i]
        raw_m    = distances[i]

        eta_minutes = round(max(1.0, raw_secs / 60.0), 1) if raw_secs is not None else None
        dist_km     = round(raw_m / 1000.0, 2)           if raw_m    is not None else hospital.get("distance_km")

        result[hospital["name"]] = {
            "eta_minutes": eta_minutes,
            "distance_km": dist_km,
            "data_source": "ors",
        }

    eta_vals = [v["eta_minutes"] for v in result.values() if v["eta_minutes"] is not None]
    if eta_vals:
        logger.info("ORS matrix: %d hospitals, ETAs %.1f–%.1f min",
                    len(hospitals), min(eta_vals), max(eta_vals))
    return result


# ── Haversine fallback ─────────────────────────────────────────────────────────

def _haversine_eta(
    crash_lat: float,
    crash_lon: float,
    hospital: dict,
) -> dict[str, Any]:
    """Distance-based ETA estimate — used when ORS is unavailable."""
    distance_km  = haversine(crash_lat, crash_lon, hospital["lat"], hospital["lon"])
    base_minutes = (distance_km / _URBAN_SPEED_KMH) * 60.0
    rng    = random.Random(hash(hospital["name"]) % 9999)
    jitter = rng.uniform(-_VARIANCE_MINUTES, _VARIANCE_MINUTES)
    return {
        "eta_minutes": round(max(1.0, base_minutes + jitter), 1),
        "distance_km": round(distance_km, 2),
        "data_source": "simulated",
    }


# ── Cache key ──────────────────────────────────────────────────────────────────

def _make_cache_key(lat: float, lon: float, hospitals: list[dict]) -> str:
    """
    Stable cache key combining rounded crash coordinates and hospital set.
    Rounding to 3 dp gives ~110 m grid cells — close incidents share the cache.
    """
    coord_part    = f"{round(lat, 3)}_{round(lon, 3)}"
    hospital_part = hashlib.md5(
        ",".join(sorted(h["name"] for h in hospitals)).encode()
    ).hexdigest()[:8]
    return f"{coord_part}_{hospital_part}"
