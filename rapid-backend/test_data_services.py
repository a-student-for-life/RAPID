"""
Phase 2 integration test — data services.
Discovers hospitals then fetches ETA, blood, and capacity in parallel.

Run from rapid-backend/:
    python test_data_services.py
"""

import asyncio
from services.location_engine import discover_hospitals_adaptive
from services.aggregator import fetch_hospital_data

# Kurla, Mumbai — demo crash site
CRASH_LAT = 19.0728
CRASH_LON = 72.8826


async def main() -> None:
    # ── Step 1: discover hospitals ─────────────────────────────────────────────
    print("Discovering hospitals ...\n")
    discovery = await discover_hospitals_adaptive(CRASH_LAT, CRASH_LON)
    hospitals = discovery["hospitals"]

    print(f"  Found {len(hospitals)} hospitals within {discovery['radius_km']} km")
    print(f"  Radius expanded: {discovery['expanded']}\n")

    # ── Step 2: fetch all data in parallel ────────────────────────────────────
    print("Fetching ETA, blood, and capacity in parallel ...\n")
    data = await fetch_hospital_data(CRASH_LAT, CRASH_LON, hospitals)

    # ── Step 3: print combined results ────────────────────────────────────────
    _print_results(data)


def _print_results(data: dict) -> None:
    separator = "─" * 72

    for name, info in data.items():
        print(separator)
        print(f"  {name}")
        print(separator)

        print(f"    Distance : {info['distance_km']:.2f} km")
        print(f"    ETA      : {info['eta_minutes']} min")

        cap = info["capacity"]
        print(f"    ICU beds : {cap.get('available_icu', '?')}")
        print(f"    Gen beds : {cap.get('available_beds', '?')}")
        print(f"    Trauma   : {cap.get('trauma_centre', False)}")
        print(f"    Specialty: {', '.join(cap.get('specialties', []))}")
        print(f"    Cap src  : {cap.get('data_source', '?')}")

        blood = info["blood"]
        o_neg = blood.get("O-", "?")
        print(f"    O-neg    : {o_neg} units  (source: {blood.get('data_source', '?')})")

        print()


if __name__ == "__main__":
    asyncio.run(main())
