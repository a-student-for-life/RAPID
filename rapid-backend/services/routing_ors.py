"""
Routing / ETA Service — Financial Circuit Breaker Model

ETA priority chain (tried in order, first success wins):

  Tier 1 — Google Routes Distance Matrix API
    Uses the $200/month renewable Maps credit.
    Guarded by QuotaTracker: if daily cap hit or HTTP 429/403 received,
    circuit breaker trips and Tier 2 is used for the rest of the day.

  Tier 2 — OpenRouteService (ORS) Matrix API
    Free tier: 2,000 matrix requests/day.
    Used when Google breaker is open or ORS_API_KEY is set.

  Tier 3 — Haversine estimate
    Always available, zero cost. Used when both Tier 1 and Tier 2 fail.

Results are cached for 30 minutes (TTL) keyed on rounded crash coordinates
+ hospital set hash — same incident area = cache hit across all tiers.
"""

import hashlib
import logging
import os
import random
from typing import Any

import httpx
from cachetools import TTLCache

from services.location_engine import haversine
from services.quota_tracker import quota_tracker

logger = logging.getLogger(__name__)

_GOOGLE_MAPS_KEY = os.getenv("GOOGLE_MAPS_API_KEY", "")
_GOOGLE_ROUTES_URL = "https://routes.googleapis.com/distancematrix/v2:computeRouteMatrix"
_GOOGLE_ROUTES_TIMEOUT = 10  # seconds

_ORS_API_KEY = os.getenv("ORS_API_KEY", "")
_ORS_URL     = "https://api.openrouteservice.org/v2/matrix/driving-car"
_ORS_TIMEOUT = 10  # seconds per request

# Cache: keyed by (rounded crash lat/lon + hospital names hash), 30-min TTL
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

    Tries Google Routes → ORS → Haversine in order.
    Results cached 30 minutes to preserve API quotas.
    """
    if not hospitals:
        return {}

    cache_key = _make_cache_key(crash_lat, crash_lon, hospitals)
    cached = _cache.get(cache_key)
    if cached is not None:
        logger.debug("ETA cache hit for %s", cache_key)
        return cached

    # ── Tier 1: Google Routes Distance Matrix (financial circuit breaker) ───────
    if quota_tracker.should_use_google("routes"):
        try:
            result = await _fetch_google_routes(crash_lat, crash_lon, hospitals)
            quota_tracker.record_success("routes")
            _cache[cache_key] = result
            return result
        except httpx.HTTPStatusError as exc:
            quota_tracker.record_error("routes", exc.response.status_code, exc.response.text)
            logger.warning("Google Routes HTTP %d — falling back to ORS.", exc.response.status_code)
        except Exception as exc:
            logger.warning("Google Routes unavailable (%s: %s) — falling back to ORS.",
                           type(exc).__name__, exc)

    # ── Tier 2: OpenRouteService ────────────────────────────────────────────────
    if _ORS_API_KEY:
        try:
            result = await _fetch_ors(crash_lat, crash_lon, hospitals)
            _cache[cache_key] = result
            return result
        except Exception as exc:
            logger.warning("ORS unavailable (%s: %s) — falling back to haversine.",
                           type(exc).__name__, exc)

    # ── Tier 3: Haversine estimate (always succeeds) ────────────────────────────
    result = {h["name"]: _haversine_eta(crash_lat, crash_lon, h) for h in hospitals}
    _cache[cache_key] = result
    return result


# ── Google Routes Distance Matrix ─────────────────────────────────────────────

async def _fetch_google_routes(
    crash_lat: float,
    crash_lon: float,
    hospitals: list[dict],
) -> dict[str, dict[str, Any]]:
    """
    Call Google Routes API v2 computeRouteMatrix.

    One origin (crash site) to N destinations (hospitals).
    Returns duration_seconds and distance_meters per hospital.
    Uses GOOGLE_MAPS_API_KEY via X-Goog-Api-Key header.
    """
    origins = [{"waypoint": {"location": {"latLng": {"latitude": crash_lat, "longitude": crash_lon}}}}]
    destinations = [
        {"waypoint": {"location": {"latLng": {"latitude": h["lat"], "longitude": h["lon"]}}}}
        for h in hospitals
    ]

    body = {
        "origins":      origins,
        "destinations": destinations,
        "travelMode":   "DRIVE",
        "routingPreference": "TRAFFIC_AWARE_OPTIMAL",
    }

    async with httpx.AsyncClient(timeout=_GOOGLE_ROUTES_TIMEOUT) as client:
        response = await client.post(
            _GOOGLE_ROUTES_URL,
            headers={
                "X-Goog-Api-Key":    _GOOGLE_MAPS_KEY,
                "X-Goog-FieldMask":  "originIndex,destinationIndex,duration,distanceMeters,status",
                "Content-Type":      "application/json",
            },
            json=body,
        )

    if response.status_code != 200:
        logger.warning("Google Routes HTTP %d: %s", response.status_code, response.text[:300])
        response.raise_for_status()

    rows = response.json()  # list of route elements
    result: dict[str, dict[str, Any]] = {}

    for element in rows:
        dest_idx = element.get("destinationIndex", 0)
        if dest_idx >= len(hospitals):
            continue
        hospital  = hospitals[dest_idx]
        status    = element.get("status", {})
        condition = status.get("code", 0) if isinstance(status, dict) else 0

        raw_secs = element.get("duration")
        raw_m    = element.get("distanceMeters")

        if condition != 0 or raw_secs is None:
            # Route not found for this element — use haversine for this hospital
            result[hospital["name"]] = _haversine_eta(crash_lat, crash_lon, hospital)
            continue

        # Google Routes v2 returns duration as proto Duration JSON:
        #   "423s" (proto3 string) — most common via REST
        #   {"seconds": 423, "nanos": 0} (dict) — some client configs
        #   423 (int) — older SDKs
        if isinstance(raw_secs, dict):
            secs = int(raw_secs.get("seconds", 0))
        elif isinstance(raw_secs, str):
            secs = int(raw_secs.rstrip("s")) if raw_secs.rstrip("s").isdigit() else 0
        else:
            secs = int(raw_secs) if raw_secs else 0
        eta_minutes = round(max(1.0, secs / 60.0), 1) if secs else None
        dist_km     = round(int(raw_m) / 1000.0, 2)   if raw_m else hospital.get("distance_km")

        result[hospital["name"]] = {
            "eta_minutes": eta_minutes,
            "distance_km": dist_km,
            "data_source": "google_routes",
        }

    # Fill any hospitals missing from the response
    for h in hospitals:
        if h["name"] not in result:
            result[h["name"]] = _haversine_eta(crash_lat, crash_lon, h)

    eta_vals = [v["eta_minutes"] for v in result.values() if v["eta_minutes"] is not None]
    if eta_vals:
        logger.info("Google Routes matrix: %d hospitals, ETAs %.1f–%.1f min",
                    len(hospitals), min(eta_vals), max(eta_vals))
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
