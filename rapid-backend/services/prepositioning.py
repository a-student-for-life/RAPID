"""
Predictive Pre-positioning (F4)

Reads recent incident locations from Firestore, buckets them into a coarse
geo-grid, identifies the densest "hot zones", and emits suggestions to move
idle ambulance units toward those centroids.

The clustering is intentionally simple — production-grade K-means would need
more historical data than a demo Firestore has. Grid bucketing on a 0.01°
lat/lon grid (~1.1 km per cell at the equator) gives stable hot zones for the
hand-curated demo dataset and degrades gracefully when only a few incidents
exist.

Output shape:
{
  "hotzones":    [{lat, lon, incident_count, severity_weighted_score, last_seen}],
  "suggestions": [{unit_id, current_lat/lon, target_lat/lon, distance_km,
                   reason, confidence, hotzone_index}],
  "incidents_considered": int,
}
"""

from __future__ import annotations

import logging
import math
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Iterable

logger = logging.getLogger(__name__)

GRID_DEG = 0.01            # ~1.1 km buckets
MAX_HOTZONES = 5
MAX_SUGGESTIONS = 5
MIN_INCIDENTS_PER_ZONE = 1
SEVERITY_WEIGHT = {"critical": 3.0, "moderate": 1.5, "minor": 1.0}


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _bucket(lat: float, lon: float) -> tuple[int, int]:
    return (round(lat / GRID_DEG), round(lon / GRID_DEG))


def _severity_weight(patient_groups: Iterable[dict]) -> float:
    total = 0.0
    for pg in patient_groups or []:
        total += SEVERITY_WEIGHT.get(pg.get("severity"), 1.0) * float(pg.get("count", 0) or 0)
    return total or 1.0


def compute_hotzones(incidents: list[dict]) -> list[dict]:
    """Bucket incident lat/lon into a coarse grid and return top hot zones."""
    if not incidents:
        return []

    buckets: dict[tuple[int, int], dict] = defaultdict(lambda: {
        "lat_sum": 0.0, "lon_sum": 0.0, "count": 0, "weight": 0.0,
        "last_seen": "", "severities": defaultdict(int),
    })

    for inc in incidents:
        lat = inc.get("lat")
        lon = inc.get("lon")
        if lat is None or lon is None:
            continue
        key = _bucket(float(lat), float(lon))
        b = buckets[key]
        b["lat_sum"] += float(lat)
        b["lon_sum"] += float(lon)
        b["count"]   += 1
        b["weight"]  += _severity_weight(inc.get("patient_groups", []))
        ts = inc.get("saved_at") or inc.get("updated_at") or ""
        if ts > b["last_seen"]:
            b["last_seen"] = ts
        for pg in inc.get("patient_groups", []) or []:
            sev = pg.get("severity")
            if sev:
                b["severities"][sev] += int(pg.get("count", 0) or 0)

    hotzones = []
    for b in buckets.values():
        if b["count"] < MIN_INCIDENTS_PER_ZONE:
            continue
        hotzones.append({
            "lat":             round(b["lat_sum"] / b["count"], 5),
            "lon":             round(b["lon_sum"] / b["count"], 5),
            "incident_count":  b["count"],
            "severity_score":  round(b["weight"], 2),
            "last_seen":       b["last_seen"],
            "severity_mix":    dict(b["severities"]),
        })
    hotzones.sort(key=lambda z: (z["severity_score"], z["incident_count"]), reverse=True)
    return hotzones[:MAX_HOTZONES]


def _is_idle(crew_doc: dict | None) -> bool:
    if not crew_doc:
        return True
    status = (crew_doc.get("status") or "").lower()
    return status in {"", "standby", "closed"}


def _crew_position(crew_doc: dict | None, fallback: tuple[float, float] | None) -> tuple[float, float] | None:
    if crew_doc:
        lat = crew_doc.get("current_lat") or crew_doc.get("hospital_lat") or crew_doc.get("incident_lat")
        lon = crew_doc.get("current_lon") or crew_doc.get("hospital_lon") or crew_doc.get("incident_lon")
        if lat is not None and lon is not None:
            return float(lat), float(lon)
    return fallback


def suggest_moves(
    hotzones: list[dict],
    crew_assignments: dict[str, dict | None],
    *,
    base_position: tuple[float, float] | None = None,
) -> list[dict]:
    """
    Greedy assignment: each idle unit gets the highest-scored hot zone that
    isn't already covered by another idle unit standing on it.
    Suggestions returned in priority order.
    """
    if not hotzones:
        return []

    suggestions: list[dict] = []
    claimed: set[int] = set()

    idle_units = [
        (unit_id, _crew_position(doc, base_position))
        for unit_id, doc in crew_assignments.items()
        if _is_idle(doc)
    ]

    for hz_idx, hz in enumerate(hotzones):
        if hz_idx in claimed or len(suggestions) >= MAX_SUGGESTIONS:
            continue
        # Pick the closest idle unit to this hotzone
        best = None
        for unit_id, pos in idle_units:
            if pos is None:
                continue
            d = _haversine_km(pos[0], pos[1], hz["lat"], hz["lon"])
            if best is None or d < best[2]:
                best = (unit_id, pos, d)
        if best is None:
            break

        unit_id, pos, d = best
        idle_units = [(u, p) for (u, p) in idle_units if u != unit_id]
        claimed.add(hz_idx)

        confidence = "high" if hz["incident_count"] >= 4 else "medium" if hz["incident_count"] >= 2 else "low"
        suggestions.append({
            "unit_id":      unit_id,
            "current_lat":  pos[0],
            "current_lon":  pos[1],
            "target_lat":   hz["lat"],
            "target_lon":   hz["lon"],
            "distance_km":  round(d, 2),
            "hotzone_index": hz_idx,
            "incident_count": hz["incident_count"],
            "severity_score": hz["severity_score"],
            "confidence":   confidence,
            "reason": (
                f"Hot zone with {hz['incident_count']} recent incident(s) "
                f"(weighted score {hz['severity_score']}). "
                f"Move {unit_id} ~{round(d, 1)} km to cut response time."
            ),
        })

    return suggestions


def compute(
    incidents: list[dict],
    crew_assignments: dict[str, dict | None],
    *,
    base_position: tuple[float, float] | None = None,
) -> dict[str, Any]:
    hotzones = compute_hotzones(incidents)
    suggestions = suggest_moves(hotzones, crew_assignments, base_position=base_position)
    return {
        "incidents_considered": len(incidents),
        "hotzones":             hotzones,
        "suggestions":          suggestions,
        "computed_at":          datetime.now(timezone.utc).isoformat(),
    }
