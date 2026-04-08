"""
Phase 3 test — scoring engine.

Two test modes:

  1. MOCK  — fully offline, hand-crafted hospital data.
             Run this first to verify scorer logic in isolation.

  2. LIVE  — discovers real hospitals via OSM, fetches simulated data,
             then scores them. Requires internet access.

Run from rapid-backend/:
    python test_scorer.py          # mock only
    python test_scorer.py --live   # live OSM + scoring
"""

import asyncio
import sys
from services.scorer import score_all, WEIGHTS

# ── Mock data (mirrors the shape returned by aggregator.fetch_hospital_data) ──

MOCK_HOSPITAL_DATA: dict = {
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
        "blood": {
            "O-": 11, "O+": 9, "A+": 7, "A-": 3,
            "B+": 6, "B-": 2, "AB+": 4, "AB-": 1,
            "data_source": "simulated_deterministic",
        },
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
        "blood": {
            "O-": 4, "O+": 8, "A+": 5, "A-": 2,
            "B+": 7, "B-": 1, "AB+": 3, "AB-": 0,
            "data_source": "simulated_deterministic",
        },
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
        "blood": {
            "O-": 0, "O+": 5, "A+": 3, "A-": 1,
            "B+": 4, "B-": 0, "AB+": 2, "AB-": 0,
            "data_source": "simulated_deterministic",
        },
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
        "blood": {
            "O-": 7, "O+": 6, "A+": 4, "A-": 2,
            "B+": 5, "B-": 1, "AB+": 2, "AB-": 1,
            "data_source": "simulated_deterministic",
        },
    },
}


# ── Display helpers ────────────────────────────────────────────────────────────

def print_scores(scores: list[dict]) -> None:
    factor_labels = {
        "eta":      f"ETA      (w={WEIGHTS['eta']:.2f})",
        "capacity": f"Capacity (w={WEIGHTS['capacity']:.2f})",
        "trauma":   f"Trauma   (w={WEIGHTS['trauma']:.2f})",
        "blood":    f"Blood    (w={WEIGHTS['blood']:.2f})",
    }
    separator = "─" * 60

    for rank, entry in enumerate(scores, start=1):
        print(separator)
        print(f"  #{rank}  {entry['name']}")
        print(f"       Composite score: {entry['composite_score']:>5.1f} / 100")
        for factor, label in factor_labels.items():
            print(f"         {label}: {entry['sub_scores'][factor]:>5.1f}")
        print()


# ── Test modes ────────────────────────────────────────────────────────────────

def run_mock() -> None:
    print("=" * 60)
    print("  MOCK TEST — offline, hand-crafted data")
    print("=" * 60 + "\n")

    scores = score_all(MOCK_HOSPITAL_DATA)
    print_scores(scores)

    # Sanity assertions
    assert scores[0]["name"] == "KEM Hospital", (
        f"Expected KEM Hospital ranked #1, got {scores[0]['name']}"
    )
    assert scores[-1]["name"] == "Wockhardt Hospital Mulund", (
        f"Expected Wockhardt ranked last, got {scores[-1]['name']}"
    )
    assert all(0 <= s["composite_score"] <= 100 for s in scores), (
        "Composite score out of [0, 100] range"
    )
    print("  All assertions passed.\n")


async def run_live() -> None:
    print("=" * 60)
    print("  LIVE TEST — OSM discovery + simulated data + scoring")
    print("=" * 60 + "\n")

    from services.location_engine import discover_hospitals_adaptive
    from services.aggregator import fetch_hospital_data

    crash_lat, crash_lon = 19.0728, 72.8826
    print(f"  Crash site: ({crash_lat}, {crash_lon})\n")

    discovery = await discover_hospitals_adaptive(crash_lat, crash_lon)
    hospitals = discovery["hospitals"]
    print(f"  Discovered {len(hospitals)} hospitals within {discovery['radius_km']} km\n")

    data = await fetch_hospital_data(crash_lat, crash_lon, hospitals)
    scores = score_all(data)
    print_scores(scores)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if "--live" in sys.argv:
        asyncio.run(run_live())
    else:
        run_mock()
