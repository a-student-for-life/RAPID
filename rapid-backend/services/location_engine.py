"""
Location Engine — Dynamic Hospital Discovery
Discovers nearby hospitals from OpenStreetMap via the Overpass API,
with Nominatim as an automatic fallback when Overpass is unavailable.

Discovery chain per request:
  1. Overpass API (primary)       — full amenity=hospital data
  2. Nominatim amenity search     — fallback when Overpass times out / fails
  3. Regional seed hospitals       — last resort, filtered to seeds within
                                    MAX_RADIUS_KM of the incident

Cache uses cachetools.TTLCache so it is safe when Cloud Run scales to multiple
instances (each instance has its own in-process cache with a 1-hour TTL).
"""

import logging
import math
import httpx
from cachetools import TTLCache
from typing import Any
import time as _time

logger = logging.getLogger(__name__)

# ── Cache ──────────────────────────────────────────────────────────────────────
_cache: TTLCache = TTLCache(maxsize=256, ttl=3600)

# ── Constants ──────────────────────────────────────────────────────────────────
OVERPASS_URL        = "https://overpass-api.de/api/interpreter"
OVERPASS_MIRROR_URL = "https://overpass.kumi.systems/api/interpreter"
OVERPASS_TIMEOUT    = 15
NOMINATIM_URL       = "https://nominatim.openstreetmap.org/search"
NOMINATIM_TIMEOUT   = 10

RADIUS_STEP_FACTOR = 1.6
MIN_HOSPITALS      = 1
INITIAL_RADIUS_KM  = 15.0
MAX_RADIUS_KM      = 50.0
MAX_RESULTS        = 10

# Circuit breaker — only activates after the FINAL Overpass attempt fails,
# not on intermediate expansion steps (old behaviour wasted all expansions).
_overpass_down_until: float = 0.0
_CIRCUIT_BREAKER_SECS = 30

# ── Regional seed hospitals ────────────────────────────────────────────────────
# Covers Mumbai Metropolitan Region: Mumbai, Thane, Navi Mumbai.
# Seeds are filtered by distance to incident — only those within MAX_RADIUS_KM
# are ever injected, so a Thane incident gets Thane seeds, not distant Mumbai seeds.
_REGIONAL_SEED_HOSPITALS = [
    # ── Mumbai ────────────────────────────────────────────────────────────────
    {"id": "seed_m1", "name": "KEM Hospital",
     "lat": 18.9990, "lon": 72.8380},
    {"id": "seed_m2", "name": "Lokmanya Tilak General Hospital",
     "lat": 19.0424, "lon": 72.8418},
    {"id": "seed_m3", "name": "Rajawadi Hospital",
     "lat": 19.0866, "lon": 72.8948},
    {"id": "seed_m4", "name": "Bhabha Hospital",
     "lat": 19.0704, "lon": 72.8818},
    {"id": "seed_m5", "name": "Kokilaben Dhirubhai Ambani Hospital",
     "lat": 19.1321, "lon": 72.8210},
    # ── Thane ─────────────────────────────────────────────────────────────────
    {"id": "seed_t1", "name": "Jupiter Hospital Thane",
     "lat": 19.2437, "lon": 72.9857},
    {"id": "seed_t2", "name": "Bethany Hospital Thane",
     "lat": 19.1963, "lon": 72.9597},
    {"id": "seed_t3", "name": "Hiranandani Hospital Powai",
     "lat": 19.1158, "lon": 72.9080},
    {"id": "seed_t4", "name": "Kaushalya Medical Foundation Thane",
     "lat": 19.2054, "lon": 72.9784},
    # ── Navi Mumbai ───────────────────────────────────────────────────────────
    {"id": "seed_n1", "name": "Apollo Hospital Navi Mumbai",
     "lat": 19.0352, "lon": 73.0136},
    {"id": "seed_n2", "name": "MGM Hospital Navi Mumbai",
     "lat": 19.0384, "lon": 73.0180},
    {"id": "seed_n3", "name": "DY Patil Hospital Navi Mumbai",
     "lat": 19.0441, "lon": 73.0645},
]

# Attach source info once at module load
for _s in _REGIONAL_SEED_HOSPITALS:
    _s.setdefault("data_source", "seed")
    _s.setdefault("data_quality", "curated")


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

    Chain:
      1. Try Overpass at expanding radii until ≥ min_count found.
      2. If Overpass fails/returns nothing, try Nominatim amenity search.
      3. If both fail, fill with regional seed hospitals within max_radius_km.
    """
    # ── Step 1: Overpass with radius expansion ─────────────────────────────────
    hospitals = await _overpass_with_expansion(lat, lon, initial_radius_km,
                                               min_count, max_radius_km)

    if len(hospitals) >= min_count:
        return {"hospitals": hospitals, "radius_km": max_radius_km, "expanded": False}

    # ── Step 2: Nominatim fallback ─────────────────────────────────────────────
    logger.warning(
        "Overpass returned 0 hospitals for (%.4f, %.4f) — trying Nominatim.", lat, lon
    )
    hospitals = await _nominatim_hospital_search(lat, lon, max_radius_km)

    if len(hospitals) >= min_count:
        logger.info("Nominatim found %d hospitals near (%.4f, %.4f).", len(hospitals), lat, lon)
        return {"hospitals": hospitals, "radius_km": max_radius_km, "expanded": True}

    # ── Step 3: Distance-filtered regional seeds ───────────────────────────────
    existing_names = {h["name"] for h in hospitals}
    seeds = []
    for s in _REGIONAL_SEED_HOSPITALS:
        if s["name"] in existing_names:
            continue
        dist = haversine(lat, lon, s["lat"], s["lon"])
        if dist <= max_radius_km:
            seeds.append({**s, "distance_km": round(dist, 2)})

    seeds.sort(key=lambda h: h["distance_km"])
    merged = sorted(hospitals + seeds, key=lambda h: h["distance_km"])[:MAX_RESULTS]

    if seeds:
        logger.warning(
            "Both Overpass and Nominatim failed for (%.4f, %.4f) — "
            "injecting %d nearby seed hospital(s) within %.0f km.",
            lat, lon, len(seeds), max_radius_km,
        )
    else:
        logger.warning(
            "No hospitals found within %.0f km of (%.4f, %.4f) from any source.",
            max_radius_km, lat, lon,
        )

    return {"hospitals": merged, "radius_km": max_radius_km, "expanded": True}


async def discover_agencies(
    lat: float,
    lon: float,
    radius_km: float = 10.0,
) -> list[dict]:
    """
    Discover fire stations and police stations near (lat, lon) via Overpass.
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
    for url in (OVERPASS_URL, OVERPASS_MIRROR_URL):
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(url, data={"data": query}, timeout=10)
                response.raise_for_status()
            elements = response.json().get("elements", [])
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
                    "id":          f"osm_{element['id']}",
                    "name":        name,
                    "type":        "fire_station" if amenity == "fire_station" else "police",
                    "lat":         a_lat,
                    "lon":         a_lon,
                    "distance_km": round(haversine(lat, lon, a_lat, a_lon), 2),
                })
            agencies.sort(key=lambda a: a["distance_km"])
            return agencies[:6]
        except Exception as exc:
            logger.warning("Agency discovery failed on %s (%s) — skipping.", url, exc)
    return []


# ── Internal helpers ───────────────────────────────────────────────────────────

async def _overpass_with_expansion(
    lat: float, lon: float,
    initial_radius_km: float,
    min_count: int,
    max_radius_km: float,
) -> list[dict]:
    """Try Overpass at increasing radii. Circuit breaker only trips on the
    FINAL attempt so intermediate expansion steps are never short-circuited."""
    radius = initial_radius_km

    while radius < max_radius_km:
        hospitals = await _fetch_and_cache(lat, lon, radius, use_circuit_breaker=False)
        if len(hospitals) >= min_count:
            return hospitals
        next_r = radius * RADIUS_STEP_FACTOR
        if next_r >= max_radius_km:
            break
        radius = next_r

    # Final attempt — allow the circuit breaker to activate on failure
    return await _fetch_and_cache(lat, lon, max_radius_km, use_circuit_breaker=True)


async def _fetch_and_cache(
    lat: float, lon: float, radius_km: float,
    use_circuit_breaker: bool = True,
) -> list[dict]:
    """Return cached result if fresh, otherwise query Overpass and cache."""
    key = f"{round(lat, 2)}_{round(lon, 2)}_{radius_km}"
    cached = _cache.get(key)
    if cached is not None:
        return cached

    hospitals = await _query_overpass(lat, lon, radius_km, use_circuit_breaker)
    if hospitals:          # only cache successful results
        _cache[key] = hospitals
    return hospitals


async def _query_overpass(
    lat: float, lon: float, radius_km: float,
    use_circuit_breaker: bool = True,
) -> list[dict]:
    """Query Overpass (primary then mirror). Circuit breaker optional."""
    global _overpass_down_until

    if use_circuit_breaker and _time.monotonic() < _overpass_down_until:
        logger.debug("Overpass circuit-breaker active — skipping.")
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

    for url in (OVERPASS_URL, OVERPASS_MIRROR_URL):
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    url, data={"data": query}, timeout=OVERPASS_TIMEOUT,
                )
                response.raise_for_status()
            elements = response.json().get("elements", [])
            hospitals = _parse_elements(elements, lat, lon)
            hospitals.sort(key=lambda h: h["distance_km"])
            logger.info(
                "Overpass (%s) returned %d hospitals within %.0f km of (%.4f, %.4f).",
                url.split("/")[2], len(hospitals), radius_km, lat, lon,
            )
            return hospitals[:MAX_RESULTS]
        except (httpx.TimeoutException, httpx.HTTPStatusError, httpx.RequestError) as exc:
            logger.warning("Overpass %s failed (%s: %s).", url.split("/")[2],
                           type(exc).__name__, exc)

    # Both endpoints failed
    if use_circuit_breaker:
        logger.warning("All Overpass endpoints failed — circuit-breaker active for %d s.",
                       _CIRCUIT_BREAKER_SECS)
        _overpass_down_until = _time.monotonic() + _CIRCUIT_BREAKER_SECS
    return []


async def _nominatim_hospital_search(
    lat: float, lon: float, radius_km: float
) -> list[dict]:
    """
    Search for hospitals near (lat, lon) using Nominatim's amenity search
    with a bounding box. This is the fallback when Overpass is unavailable.
    """
    # Build bounding box: west, south, east, north (Nominatim viewbox order)
    delta_lat = radius_km / 111.0
    delta_lon = radius_km / (111.0 * math.cos(math.radians(lat)))
    viewbox = f"{lon - delta_lon},{lat - delta_lat},{lon + delta_lon},{lat + delta_lat}"

    try:
        async with httpx.AsyncClient(timeout=NOMINATIM_TIMEOUT) as client:
            response = await client.get(
                NOMINATIM_URL,
                params={
                    "amenity":      "hospital",
                    "format":       "json",
                    "limit":        MAX_RESULTS,
                    "viewbox":      viewbox,
                    "bounded":      "1",
                    "addressdetails": "0",
                },
                headers={"User-Agent": "RAPID-Emergency-Dispatcher",
                         "Accept-Language": "en"},
            )
            response.raise_for_status()
        data = response.json()
    except Exception as exc:
        logger.warning("Nominatim hospital search failed: %s", exc)
        return []

    hospitals = []
    for item in data:
        name = item.get("display_name", "").split(",")[0].strip()
        if not name:
            continue
        h_lat = float(item.get("lat", 0))
        h_lon = float(item.get("lon", 0))
        if not h_lat or not h_lon:
            continue
        dist = haversine(lat, lon, h_lat, h_lon)
        if dist > radius_km:
            continue
        hospitals.append({
            "id":           f"nom_{item.get('osm_id', item.get('place_id', ''))}",
            "name":         name,
            "lat":          h_lat,
            "lon":          h_lon,
            "distance_km":  round(dist, 2),
            "data_source":  "Nominatim",
            "data_quality": "community",
        })

    hospitals.sort(key=lambda h: h["distance_km"])
    return hospitals


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
            "id":           f"osm_{element['id']}",
            "name":         name,
            "lat":          h_lat,
            "lon":          h_lon,
            "data_source":  "OpenStreetMap",
            "data_quality": "community",
            "distance_km":  haversine(origin_lat, origin_lon, h_lat, h_lon),
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
