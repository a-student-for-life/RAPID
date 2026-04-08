"""
Quick test: discover hospitals near a Mumbai crash site.
Run from rapid-backend/:
    python test_location.py
"""

import asyncio
from services.location_engine import discover_hospitals_adaptive

# Kurla, Mumbai — used as the demo crash site in the RAPID guide
TEST_LAT = 19.0728
TEST_LON = 72.8826


async def main() -> None:
    print(f"Searching for hospitals near ({TEST_LAT}, {TEST_LON}) ...\n")

    result = await discover_hospitals_adaptive(TEST_LAT, TEST_LON)

    print(f"Radius used : {result['radius_km']} km")
    print(f"Expanded    : {result['expanded']}")
    print(f"Found       : {len(result['hospitals'])} hospitals\n")

    for i, h in enumerate(result["hospitals"], start=1):
        print(
            f"  {i:>2}. {h['name']:<45} "
            f"{h['distance_km']:>5.2f} km  "
            f"({h['lat']:.4f}, {h['lon']:.4f})"
        )


if __name__ == "__main__":
    asyncio.run(main())
