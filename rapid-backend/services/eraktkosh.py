"""
Blood Availability Service
Simulates blood bank data per hospital using a deterministic seed so results
are consistent across calls for the same hospital name.

Real implementation: replace simulate_blood() with a live e-Raktkosh fetch.
O-negative is used as a surgical readiness proxy — see RAPID guide §3.2.
"""

import random
from typing import Any

BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-"]
DATA_SOURCE = "simulated_deterministic"


# ── Public API ─────────────────────────────────────────────────────────────────

async def simulate_blood(hospitals: list[dict]) -> dict[str, dict[str, Any]]:
    """
    Return simulated blood availability for each hospital.

    Keyed by hospital name. Each entry contains unit counts per blood group
    and a data_source label so the scorer and dashboard can downgrade
    confidence accordingly.

    Args:
        hospitals: list of hospital dicts (must contain "name").

    Returns:
        {
            "<hospital_name>": {
                "A+": int, "A-": int, "B+": int, "B-": int,
                "O+": int, "O-": int, "AB+": int, "AB-": int,
                "data_source": "simulated_deterministic",
            },
            ...
        }
    """
    return {h["name"]: _simulate_one(h["name"]) for h in hospitals}


# ── Internal helpers ───────────────────────────────────────────────────────────

def _simulate_one(hospital_name: str) -> dict[str, Any]:
    """
    Produce deterministic blood unit counts for a single hospital.
    Seeding on the hospital name ensures the same hospital always gets the
    same simulated inventory — important for reproducible demo behaviour.
    """
    rng = random.Random(hash(hospital_name) % 9999)
    units = {group: rng.randint(1, 18) for group in BLOOD_GROUPS}
    units["data_source"] = DATA_SOURCE
    return units
