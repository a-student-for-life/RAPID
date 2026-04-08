"""
Fallback Router
Assigns patients to hospitals using scored results only — no AI involved.

Processing order: critical → moderate → minor.

Critical patients:
  Trauma-capable hospitals are tried first (sorted by composite score).
  Falls back to any hospital with ICU capacity if no trauma centre is
  available. ICU beds are consumed.

Moderate patients:
  Assigned by composite score descending. General beds are consumed.

Minor patients:
  Assigned to the nearest hospitals (highest ETA sub-score = shortest travel
  time). General beds are consumed.

Capacity is tracked with a mutable ledger so no hospital is overloaded across
severity tiers. Patients that cannot be placed due to exhausted capacity are
recorded as unassigned with an explicit warning.

The output schema is intentionally identical to what the Gemini router will
return (Phase 5), so the incident endpoint can use both interchangeably.
"""

from __future__ import annotations
from typing import Any

SEVERITY_ORDER = ["critical", "moderate", "minor"]


# ── Public API ─────────────────────────────────────────────────────────────────

def route_patients(
    scored_hospitals: list[dict],
    patient_groups: list[dict],
    hospital_data: dict[str, dict],
) -> dict[str, Any]:
    """
    Assign patients to hospitals deterministically using scores.

    Args:
        scored_hospitals: output of scorer.score_all() — sorted best-first.
        patient_groups:   list of {"severity": str, "count": int}.
        hospital_data:    output of aggregator.fetch_hospital_data() —
                          provides raw capacity numbers for the ledger.

    Returns:
        {
            "decision_path": "FALLBACK",
            "assignments":   list[Assignment],
            "warnings":      list[str],
        }

        Assignment:
        {
            "hospital":          str,
            "patients_assigned": int,
            "severity":          str,
            "reason":            str,
        }
    """
    ledger    = _build_ledger(hospital_data)
    groups    = _index_by_severity(patient_groups)
    assignments: list[dict] = []
    warnings:    list[str]  = []

    for severity in SEVERITY_ORDER:
        count = groups.get(severity, 0)
        if count == 0:
            continue

        ordered = _priority_order(severity, scored_hospitals)
        remaining = count

        for hospital in ordered:
            if remaining <= 0:
                break

            name     = hospital["name"]
            capacity = _available(severity, ledger, name)
            if capacity <= 0:
                continue

            assigned = min(remaining, capacity)
            _consume(severity, ledger, name, assigned)
            remaining -= assigned

            assignments.append(_make_assignment(
                name, assigned, severity, hospital, hospital_data,
            ))

        if remaining > 0:
            warnings.append(
                f"{remaining} {severity} patient(s) could not be assigned "
                f"— no hospital has sufficient remaining capacity."
            )

    return {
        "decision_path": "FALLBACK",
        "assignments": assignments,
        "warnings": warnings,
    }


# ── Patient group index ────────────────────────────────────────────────────────

def _index_by_severity(patient_groups: list[dict]) -> dict[str, int]:
    """Convert patient_groups list to a dict keyed by severity."""
    return {g["severity"]: g["count"] for g in patient_groups}


# ── Capacity ledger ────────────────────────────────────────────────────────────

def _build_ledger(hospital_data: dict[str, dict]) -> dict[str, dict]:
    """
    Create a mutable capacity tracker from raw hospital data.
    Uses deepcopy so the original data is never mutated.
    """
    ledger: dict[str, dict] = {}
    for name, info in hospital_data.items():
        cap = info.get("capacity", {})
        ledger[name] = {
            "icu":  cap.get("available_icu",  0),
            "beds": cap.get("available_beds", 0),
        }
    return ledger


def _available(severity: str, ledger: dict, name: str) -> int:
    """Return remaining capacity for the given severity tier."""
    entry = ledger.get(name, {})
    if severity == "critical":
        return entry.get("icu", 0)
    return entry.get("beds", 0)


def _consume(severity: str, ledger: dict, name: str, count: int) -> None:
    """Deduct assigned patients from the ledger."""
    if severity == "critical":
        ledger[name]["icu"]  = max(0, ledger[name]["icu"]  - count)
    else:
        ledger[name]["beds"] = max(0, ledger[name]["beds"] - count)


# ── Priority ordering ──────────────────────────────────────────────────────────

def _priority_order(severity: str, scored: list[dict]) -> list[dict]:
    """
    Return hospitals in the preferred assignment order for this severity.

    critical  — trauma centres first (by score), then non-trauma (by score).
    moderate  — composite score descending.
    minor     — nearest first (ETA sub-score descending = shortest travel).
    """
    if severity == "critical":
        trauma     = [h for h in scored if h["sub_scores"]["trauma"] == 100.0]
        non_trauma = [h for h in scored if h["sub_scores"]["trauma"] != 100.0]
        return trauma + non_trauma

    if severity == "minor":
        return sorted(scored, key=lambda h: h["sub_scores"]["eta"], reverse=True)

    # moderate — composite score descending (already sorted)
    return scored


# ── Assignment record ──────────────────────────────────────────────────────────

def _make_assignment(
    name: str,
    count: int,
    severity: str,
    scored_entry: dict,
    hospital_data: dict,
) -> dict[str, Any]:
    """Build a single assignment record with a human-readable reason."""
    info    = hospital_data.get(name, {})
    cap     = info.get("capacity", {})
    eta     = info.get("eta_minutes")
    score   = scored_entry["composite_score"]
    sub     = scored_entry["sub_scores"]
    trauma  = cap.get("trauma_centre", False)
    o_neg   = info.get("blood", {}).get("O-", "?")

    reason = _build_reason(severity, name, score, sub, eta, trauma, o_neg)

    return {
        "hospital":          name,
        "patients_assigned": count,
        "severity":          severity,
        "reason":            reason,
    }


def _build_reason(
    severity: str,
    name: str,
    score: float,
    sub: dict,
    eta: float | None,
    trauma: bool,
    o_neg: int | str,
) -> str:
    eta_str    = f"{eta} min" if eta is not None else "unknown ETA"
    trauma_str = "trauma centre" if trauma else "non-trauma hospital"
    parts = [
        f"Fallback routing (AI unavailable).",
        f"{name} selected as {trauma_str} with composite score {score}/100.",
        f"ETA: {eta_str}.",
        f"ETA sub-score: {sub['eta']}/100.",
        f"Capacity sub-score: {sub['capacity']}/100.",
        f"O-negative units available: {o_neg}.",
    ]
    return " ".join(parts)
