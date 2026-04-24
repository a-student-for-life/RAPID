"""
Counterfactual Dispatch Scoreboard
Runs a naive "closest hospital by ETA" baseline alongside the actual RAPID
routing, then reports the delta. Used to prove measurable impact vs. the status
quo where a dispatcher just picks the nearest hospital.

Naive rules (intentionally dumb):
    - Sort hospitals by ETA sub-score descending (shortest travel time first).
    - Fill every patient into the single nearest hospital, regardless of
      capacity, trauma designation, or specialty.
    - This matches how most Indian EMS services currently operate.

Outputs:
    {
      "naive_assignments":   [{hospital, patients_assigned, severity, eta, ...}],
      "naive_total_eta_min": float,
      "rapid_total_eta_min": float,
      "minutes_delta":       float,   # +ve means RAPID saved time
      "trauma_preserved":    bool,    # did RAPID put criticals in a trauma centre that naive missed?
      "specialty_preserved": bool,    # specialty-match kept that naive lost?
      "critical_in_golden_hour_delta": int,  # criticals reaching care within 60 min edge
      "summary":             str,     # one-liner for the UI badge
    }
"""

from __future__ import annotations

from typing import Any

GOLDEN_HOUR_MIN = 60.0


def _total_eta(assignments: list[dict], hospital_data: dict[str, dict]) -> float:
    """Weighted ETA: sum of (patients_assigned * eta_minutes) per assignment."""
    total = 0.0
    for a in assignments:
        info = hospital_data.get(a["hospital"], {})
        eta = info.get("eta_minutes")
        if eta is None:
            continue
        total += float(eta) * int(a.get("patients_assigned", 0))
    return round(total, 2)


def _patient_count(assignments: list[dict]) -> int:
    return sum(int(a.get("patients_assigned", 0)) for a in assignments)


def _naive_routing(
    scored_hospitals: list[dict],
    patient_groups: list[dict],
    hospital_data: dict[str, dict],
) -> list[dict]:
    """
    Naive baseline: send every patient to the single shortest-ETA hospital.

    A real-world naive dispatcher doesn't track capacity, doesn't care about
    injury type, and doesn't favour trauma centres — they look at the map and
    pick the closest red cross. We model that exactly.
    """
    if not scored_hospitals:
        return []

    by_eta = sorted(scored_hospitals, key=lambda h: h["sub_scores"]["eta"], reverse=True)
    nearest = by_eta[0]
    info = hospital_data.get(nearest["name"], {})

    total_patients = sum(int(pg.get("count", 0)) for pg in patient_groups)
    if total_patients == 0:
        return []

    assignments = []
    for pg in patient_groups:
        count = int(pg.get("count", 0))
        if count <= 0:
            continue
        assignments.append({
            "hospital": nearest["name"],
            "patients_assigned": count,
            "severity": pg.get("severity", "minor"),
            "injury_type": pg.get("injury_type"),
            "eta_minutes": info.get("eta_minutes"),
            "trauma_centre": info.get("capacity", {}).get("trauma_centre", False),
            "reason": "Naive baseline: closest hospital by road ETA, no capacity or specialty check.",
        })
    return assignments


def _has_trauma_assignment(assignments: list[dict], hospital_data: dict[str, dict]) -> bool:
    for a in assignments:
        if a.get("severity") != "critical":
            continue
        info = hospital_data.get(a["hospital"], {})
        if info.get("capacity", {}).get("trauma_centre", False):
            return True
    return False


def _has_specialty_match(assignments: list[dict], hospital_data: dict[str, dict]) -> bool:
    for a in assignments:
        injury = (a.get("injury_type") or "").lower()
        if not injury:
            continue
        info = hospital_data.get(a["hospital"], {})
        specialties = info.get("capacity", {}).get("specialties", [])
        if any(injury in s.lower() for s in specialties):
            return True
    return False


def _criticals_in_golden_hour(
    assignments: list[dict],
    hospital_data: dict[str, dict],
) -> int:
    """Count of critical patients whose destination ETA is ≤ GOLDEN_HOUR_MIN."""
    total = 0
    for a in assignments:
        if a.get("severity") != "critical":
            continue
        info = hospital_data.get(a["hospital"], {})
        eta = info.get("eta_minutes")
        if eta is None:
            continue
        if float(eta) <= GOLDEN_HOUR_MIN:
            total += int(a.get("patients_assigned", 0))
    return total


def _build_summary(
    minutes_delta: float,
    trauma_preserved: bool,
    specialty_preserved: bool,
    rapid_top: str,
    naive_top: str,
) -> str:
    same_hospital = rapid_top == naive_top
    parts: list[str] = []
    if minutes_delta > 0.1:
        parts.append(f"saved {round(minutes_delta, 1)} min vs naïve")
    elif minutes_delta < -0.1:
        parts.append(f"+{round(abs(minutes_delta), 1)} min vs naïve (specialty priority)")
    else:
        parts.append("matched naïve timing")

    if trauma_preserved and not same_hospital:
        parts.append("trauma centre preserved ✓")
    if specialty_preserved and not same_hospital:
        parts.append("specialty match kept ✓")
    if same_hospital:
        parts.append(f"same pick as naïve ({rapid_top})")
    return " · ".join(parts)


def compute(
    rapid_assignments: list[dict],
    scored_hospitals: list[dict],
    patient_groups: list[dict],
    hospital_data: dict[str, dict],
) -> dict[str, Any]:
    """
    Compute the counterfactual scoreboard comparing RAPID routing to naive-closest.

    Args:
        rapid_assignments: output of _route() (AI or fallback) — the actual decision.
        scored_hospitals:  output of scorer.score_all() — sorted best-first.
        patient_groups:    [{severity, count, injury_type}, ...].
        hospital_data:     aggregator output keyed by hospital name.

    Returns the result dict documented in the module docstring.
    """
    naive_assignments = _naive_routing(scored_hospitals, patient_groups, hospital_data)

    rapid_total = _total_eta(rapid_assignments, hospital_data)
    naive_total = _total_eta(naive_assignments, hospital_data)
    rapid_patients = max(1, _patient_count(rapid_assignments))
    naive_patients = max(1, _patient_count(naive_assignments))

    rapid_avg_eta = rapid_total / rapid_patients
    naive_avg_eta = naive_total / naive_patients
    minutes_delta = round(naive_avg_eta - rapid_avg_eta, 2)

    rapid_trauma = _has_trauma_assignment(rapid_assignments, hospital_data)
    naive_trauma = _has_trauma_assignment(naive_assignments, hospital_data)
    trauma_preserved = rapid_trauma and not naive_trauma

    rapid_specialty = _has_specialty_match(rapid_assignments, hospital_data)
    naive_specialty = _has_specialty_match(naive_assignments, hospital_data)
    specialty_preserved = rapid_specialty and not naive_specialty

    rapid_golden = _criticals_in_golden_hour(rapid_assignments, hospital_data)
    naive_golden = _criticals_in_golden_hour(naive_assignments, hospital_data)

    rapid_top = rapid_assignments[0]["hospital"] if rapid_assignments else "—"
    naive_top = naive_assignments[0]["hospital"] if naive_assignments else "—"

    return {
        "naive_assignments": naive_assignments,
        "naive_top_hospital": naive_top,
        "rapid_top_hospital": rapid_top,
        "naive_total_weighted_eta_min": naive_total,
        "rapid_total_weighted_eta_min": rapid_total,
        "naive_avg_eta_min": round(naive_avg_eta, 2),
        "rapid_avg_eta_min": round(rapid_avg_eta, 2),
        "minutes_delta": minutes_delta,
        "minutes_saved_total": round(minutes_delta * rapid_patients, 2),
        "trauma_preserved": trauma_preserved,
        "specialty_preserved": specialty_preserved,
        "critical_in_golden_hour_delta": rapid_golden - naive_golden,
        "rapid_critical_in_golden_hour": rapid_golden,
        "naive_critical_in_golden_hour": naive_golden,
        "summary": _build_summary(
            minutes_delta, trauma_preserved, specialty_preserved, rapid_top, naive_top,
        ),
    }


def aggregate_session(incidents: list[dict]) -> dict[str, Any]:
    """Sum counterfactual results across a list of incident documents."""
    minutes_saved_total = 0.0
    trauma_saves = 0
    specialty_saves = 0
    golden_hour_extra = 0
    with_cf = 0

    for inc in incidents:
        cf = inc.get("counterfactual")
        if not cf:
            continue
        with_cf += 1
        minutes_saved_total += float(cf.get("minutes_saved_total") or 0)
        if cf.get("trauma_preserved"):
            trauma_saves += 1
        if cf.get("specialty_preserved"):
            specialty_saves += 1
        golden_hour_extra += int(cf.get("critical_in_golden_hour_delta") or 0)

    return {
        "incident_count": len(incidents),
        "incidents_with_counterfactual": with_cf,
        "minutes_saved_total": round(minutes_saved_total, 1),
        "trauma_saves": trauma_saves,
        "specialty_saves": specialty_saves,
        "extra_criticals_in_golden_hour": golden_hour_extra,
    }
