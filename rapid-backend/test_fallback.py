"""
Phase 4 test — fallback router.

Three scenarios tested with the same hospital pool:

  1. STANDARD  — mixed patient groups, enough capacity for everyone.
  2. OVERLOAD  — more critical patients than total ICU beds available.
  3. MINOR     — minor-only group; verifies nearest-first ordering.

Run from rapid-backend/:
    python test_fallback.py
"""

import json
from services.scorer import score_all
from services.fallback_router import route_patients

# ── Shared mock hospital data (aggregator shape) ───────────────────────────────

HOSPITAL_DATA: dict = {
    "KEM Hospital": {
        "distance_km": 3.2,
        "eta_minutes": 7.0,
        "capacity": {
            "available_icu": 18,
            "available_beds": 280,
            "trauma_centre": True,
            "specialties": ["neurosurgery", "trauma", "burns"],
            "data_source": "NHA_simulation",
        },
        "blood": {"O-": 11, "data_source": "simulated_deterministic"},
    },
    "Bhabha Hospital": {
        "distance_km": 4.8,
        "eta_minutes": 11.0,
        "capacity": {
            "available_icu": 6,
            "available_beds": 130,
            "trauma_centre": False,
            "specialties": ["general_surgery", "paediatrics"],
            "data_source": "NHA_simulation",
        },
        "blood": {"O-": 7, "data_source": "simulated_deterministic"},
    },
    "Rajawadi Hospital": {
        "distance_km": 6.1,
        "eta_minutes": 14.0,
        "capacity": {
            "available_icu": 8,
            "available_beds": 160,
            "trauma_centre": False,
            "specialties": ["general_surgery", "orthopaedics"],
            "data_source": "NHA_simulation",
        },
        "blood": {"O-": 4, "data_source": "simulated_deterministic"},
    },
    "Wockhardt Hospital Mulund": {
        "distance_km": 14.5,
        "eta_minutes": 28.0,
        "capacity": {
            "available_icu": 10,
            "available_beds": 90,
            "trauma_centre": False,
            "specialties": ["cardiology", "neurology"],
            "data_source": "NHA_simulation",
        },
        "blood": {"O-": 0, "data_source": "simulated_deterministic"},
    },
}

SCORED = score_all(HOSPITAL_DATA)


# ── Display helper ─────────────────────────────────────────────────────────────

def print_result(label: str, result: dict) -> None:
    sep = "─" * 64
    print(f"\n{'=' * 64}")
    print(f"  {label}")
    print(f"{'=' * 64}")
    print(f"  decision_path : {result['decision_path']}")

    print(f"\n  Assignments ({len(result['assignments'])}):")
    for a in result["assignments"]:
        print(f"  {sep}")
        print(f"    Hospital  : {a['hospital']}")
        print(f"    Severity  : {a['severity']}")
        print(f"    Assigned  : {a['patients_assigned']} patient(s)")
        print(f"    Reason    : {a['reason']}")

    if result["warnings"]:
        print(f"\n  Warnings:")
        for w in result["warnings"]:
            print(f"    ⚠  {w}")
    else:
        print(f"\n  No warnings — all patients assigned.")
    print()


# ── Scenario 1: standard mixed load ───────────────────────────────────────────

def test_standard() -> None:
    groups = [
        {"severity": "critical", "count": 12},
        {"severity": "moderate", "count": 18},
        {"severity": "minor",    "count": 10},
    ]
    result = route_patients(SCORED, groups, HOSPITAL_DATA)
    print_result("SCENARIO 1 — Standard mixed load (12 critical / 18 moderate / 10 minor)", result)

    total_assigned = sum(a["patients_assigned"] for a in result["assignments"])
    total_patients = sum(g["count"] for g in groups)
    assert total_assigned == total_patients, (
        f"Expected {total_patients} patients assigned, got {total_assigned}"
    )

    critical_assignments = [a for a in result["assignments"] if a["severity"] == "critical"]
    assert critical_assignments[0]["hospital"] == "KEM Hospital", (
        "Critical patients should go to KEM (trauma centre, highest score) first"
    )
    print("  ✓ Assertion passed: all patients assigned, critical → KEM first.")


# ── Scenario 2: ICU overload ───────────────────────────────────────────────────

def test_overload() -> None:
    # 60 critical patients — total ICU across all hospitals is 18+6+8+10 = 42
    groups = [{"severity": "critical", "count": 60}]
    result = route_patients(SCORED, groups, HOSPITAL_DATA)
    print_result("SCENARIO 2 — ICU overload (60 critical, only 42 ICU beds available)", result)

    assert result["warnings"], "Expected an unassigned-patients warning"
    unassigned_warning = result["warnings"][0]
    assert "18" in unassigned_warning, (
        f"Expected 18 unassigned patients in warning, got: {unassigned_warning}"
    )
    print("  ✓ Assertion passed: overload warning generated correctly.")


# ── Scenario 3: minor-only (nearest-first ordering) ───────────────────────────

def test_minor_nearest_first() -> None:
    groups = [{"severity": "minor", "count": 5}]
    result = route_patients(SCORED, groups, HOSPITAL_DATA)
    print_result("SCENARIO 3 — Minor-only (should route nearest hospital first)", result)

    assert result["assignments"], "Expected at least one assignment"
    first = result["assignments"][0]["hospital"]
    assert first == "KEM Hospital", (
        f"Minor patients should go to nearest hospital (KEM, 7 min ETA), got: {first}"
    )
    print("  ✓ Assertion passed: minor patients routed to nearest hospital first.")


# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    test_standard()
    test_overload()
    test_minor_nearest_first()
    print("All scenarios passed.\n")
