"""
Hospital Capacity Simulator
Returns available bed counts, ICU availability, and specialty lists per
hospital. Values are seeded deterministically on the hospital name so results
are stable across repeated calls.

Real implementation: replace simulate_capacity() with live ABDM HFR or
national bed-availability API data when available.
"""

import random
from typing import Any

# Specialties pool — drawn from injury_map keys in the scorer (Phase 3)
_SPECIALTY_POOL = [
    "neurosurgery",
    "neurology",
    "orthopaedics",
    "burns",
    "plastic_surgery",
    "trauma",
    "general_surgery",
    "cardiology",
    "cardiac_surgery",
    "paediatrics",
]

# Mumbai reference seed — hospitals known from the guide (§12.2)
# These override purely random values to keep the demo realistic.
_KNOWN_HOSPITALS: dict[str, dict] = {
    "KEM Hospital": {
        "available_icu": 18,
        "available_beds": 280,
        "specialties": ["neurosurgery", "trauma", "burns"],
        "trauma_centre": True,
    },
    "Lokmanya Tilak General Hospital": {
        "available_icu": 14,
        "available_beds": 240,
        "specialties": ["trauma", "burns", "orthopaedics"],
        "trauma_centre": True,
    },
    "Rajawadi Hospital": {
        "available_icu": 8,
        "available_beds": 160,
        "specialties": ["general_surgery", "orthopaedics"],
        "trauma_centre": False,
    },
    "Bhabha Hospital": {
        "available_icu": 6,
        "available_beds": 130,
        "specialties": ["general_surgery", "paediatrics"],
        "trauma_centre": False,
    },
    "Wockhardt Hospital Mulund": {
        "available_icu": 10,
        "available_beds": 90,
        "specialties": ["cardiology", "neurology"],
        "trauma_centre": False,
    },
    "Kokilaben Dhirubhai Ambani Hospital": {
        "available_icu": 20,
        "available_beds": 200,
        "specialties": ["neurosurgery", "cardiology", "cardiac_surgery"],
        "trauma_centre": True,
    },
}

DATA_SOURCE = "NHA_simulation"


# ── Public API ─────────────────────────────────────────────────────────────────

async def simulate_capacity(hospitals: list[dict]) -> dict[str, dict[str, Any]]:
    """
    Return simulated capacity data for each hospital.

    Known Mumbai hospitals receive fixed reference values. All others receive
    deterministic random values seeded on hospital name.

    Args:
        hospitals: list of hospital dicts (must contain "name").

    Returns:
        {
            "<hospital_name>": {
                "available_icu":   int,
                "available_beds":  int,
                "specialties":     list[str],
                "trauma_centre":   bool,
                "data_source":     str,
            },
            ...
        }
    """
    return {h["name"]: _capacity_for(h["name"]) for h in hospitals}


# ── Internal helpers ───────────────────────────────────────────────────────────

def _capacity_for(hospital_name: str) -> dict[str, Any]:
    """Return capacity dict — known seed first, random fallback."""
    if hospital_name in _KNOWN_HOSPITALS:
        entry = dict(_KNOWN_HOSPITALS[hospital_name])
        entry["data_source"] = DATA_SOURCE
        return entry

    return _random_capacity(hospital_name)


def _random_capacity(hospital_name: str) -> dict[str, Any]:
    """Produce deterministic capacity values for an unknown hospital."""
    rng = random.Random(hash(hospital_name) % 9999)

    num_specialties = rng.randint(1, 4)
    specialties = rng.sample(_SPECIALTY_POOL, num_specialties)

    return {
        "available_icu": rng.randint(2, 20),
        "available_beds": rng.randint(30, 300),
        "specialties": specialties,
        "trauma_centre": rng.random() > 0.6,
        "data_source": DATA_SOURCE,
    }
