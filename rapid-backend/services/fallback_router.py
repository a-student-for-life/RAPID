"""
Fallback Router
Assigns patients to hospitals using scored results only — no AI involved.

Processing order: critical → moderate → minor.

Critical patients:
  1. Trauma-capable hospitals with matching specialty (sorted by composite score).
  2. Any trauma-capable hospital (sorted by composite score).
  3. Any hospital with ICU capacity.
  ICU beds are consumed.

Moderate patients:
  Assigned by composite score descending. General beds are consumed.

Minor patients:
  Assigned to the nearest hospitals (highest ETA sub-score = shortest travel
  time). General beds are consumed.

Capacity is tracked with a mutable ledger so no hospital is overloaded across
severity tiers. Patients that cannot be placed due to exhausted capacity are
recorded as unassigned with an explicit warning.

The output schema is intentionally identical to what the Gemini router returns,
so the incident endpoint can use both interchangeably.
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
        patient_groups:   list of {"severity": str, "count": int, "injury_type": str|None}.
        hospital_data:    output of aggregator.fetch_hospital_data().

    Returns:
        {
            "decision_path": "FALLBACK",
            "assignments":   list[Assignment],
            "warnings":      list[str],
        }
    """
    ledger      = _build_ledger(hospital_data)
    groups      = _index_by_severity(patient_groups)
    assignments: list[dict] = []
    warnings:    list[str]  = []

    for severity in SEVERITY_ORDER:
        # collect all groups matching this severity (may include different injury_types)
        matching_groups = [pg for pg in patient_groups if pg["severity"] == severity]
        if not matching_groups:
            continue

        for group in matching_groups:
            count       = group["count"]
            injury_type = group.get("injury_type")
            ordered     = _priority_order(severity, scored_hospitals, hospital_data, injury_type)
            remaining   = count

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
                    name, assigned, severity, hospital, hospital_data, injury_type,
                ))

            if remaining > 0:
                label = f"{severity} [{injury_type}]" if injury_type else severity
                warnings.append(
                    f"{remaining} {label} patient(s) could not be assigned "
                    f"— no hospital has sufficient remaining capacity."
                )

    return {
        "decision_path": "FALLBACK",
        "assignments": assignments,
        "warnings": warnings,
    }


# ── Patient group index ────────────────────────────────────────────────────────

def _index_by_severity(patient_groups: list[dict]) -> dict[str, int]:
    result: dict[str, int] = {}
    for g in patient_groups:
        result[g["severity"]] = result.get(g["severity"], 0) + g["count"]
    return result


# ── Capacity ledger ────────────────────────────────────────────────────────────

def _build_ledger(hospital_data: dict[str, dict]) -> dict[str, dict]:
    ledger: dict[str, dict] = {}
    for name, info in hospital_data.items():
        cap = info.get("capacity", {})
        ledger[name] = {
            "icu":  cap.get("available_icu",  0),
            "beds": cap.get("available_beds", 0),
        }
    return ledger


def _available(severity: str, ledger: dict, name: str) -> int:
    entry = ledger.get(name, {})
    if severity == "critical":
        return entry.get("icu", 0)
    return entry.get("beds", 0)


def _consume(severity: str, ledger: dict, name: str, count: int) -> None:
    if severity == "critical":
        ledger[name]["icu"]  = max(0, ledger[name]["icu"]  - count)
    else:
        ledger[name]["beds"] = max(0, ledger[name]["beds"] - count)


# ── Priority ordering ──────────────────────────────────────────────────────────

def _priority_order(
    severity: str,
    scored: list[dict],
    hospital_data: dict[str, dict],
    injury_type: str | None = None,
) -> list[dict]:
    """
    Return hospitals in the preferred assignment order for this severity.

    critical  — specialty-matching trauma centres first, then any trauma
                centre (by score), then non-trauma (by score).
    moderate  — composite score descending.
    minor     — nearest first (ETA sub-score descending = shortest travel).
    """
    if severity == "critical":
        if injury_type:
            specialty_trauma = [
                h for h in scored
                if h["sub_scores"]["trauma"] == 100.0
                and _has_specialty(h["name"], injury_type, hospital_data)
            ]
            other_trauma = [
                h for h in scored
                if h["sub_scores"]["trauma"] == 100.0
                and not _has_specialty(h["name"], injury_type, hospital_data)
            ]
        else:
            specialty_trauma = []
            other_trauma = [h for h in scored if h["sub_scores"]["trauma"] == 100.0]

        non_trauma = [h for h in scored if h["sub_scores"]["trauma"] != 100.0]
        return specialty_trauma + other_trauma + non_trauma

    if severity == "minor":
        return sorted(scored, key=lambda h: h["sub_scores"]["eta"], reverse=True)

    # moderate — composite score descending (already sorted)
    return scored


def _has_specialty(name: str, injury_type: str, hospital_data: dict) -> bool:
    """Return True if the hospital's specialties list contains the injury_type."""
    cap = hospital_data.get(name, {}).get("capacity", {})
    specialties = cap.get("specialties", [])
    return any(injury_type.lower() in s.lower() for s in specialties)


# ── Assignment record ──────────────────────────────────────────────────────────

def _make_assignment(
    name: str,
    count: int,
    severity: str,
    scored_entry: dict,
    hospital_data: dict,
    injury_type: str | None = None,
) -> dict[str, Any]:
    info    = hospital_data.get(name, {})
    cap     = info.get("capacity", {})
    eta     = info.get("eta_minutes")
    score   = scored_entry["composite_score"]
    sub     = scored_entry["sub_scores"]
    trauma  = cap.get("trauma_centre", False)
    o_neg   = info.get("blood", {}).get("O-", "?")
    matched = (
        injury_type and _has_specialty(name, injury_type, hospital_data)
    )

    reason = _build_reason(severity, name, score, sub, eta, trauma, o_neg, injury_type, matched)

    return {
        "hospital":          name,
        "patients_assigned": count,
        "severity":          severity,
        "injury_type":       injury_type,
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
    injury_type: str | None,
    specialty_matched: bool,
) -> str:
    eta_str    = f"{eta} min" if eta is not None else "unknown ETA"
    trauma_str = "trauma centre" if trauma else "non-trauma hospital"
    parts = [
        "Fallback routing (AI unavailable).",
        f"{name} selected as {trauma_str} with composite score {score}/100.",
    ]
    if injury_type and specialty_matched:
        parts.append(f"Specialty match: {injury_type} capability confirmed.")
    elif injury_type and not specialty_matched:
        parts.append(f"No specialty match for {injury_type} — best available.")
    parts += [
        f"ETA: {eta_str}.",
        f"Sub-scores — ETA: {sub['eta']}/100, Capacity: {sub['capacity']}/100, "
        f"Trauma: {sub['trauma']}/100, Blood: {sub['blood']}/100.",
        f"O-negative units available: {o_neg}.",
    ]
    return " ".join(parts)
