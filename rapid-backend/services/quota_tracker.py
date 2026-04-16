"""
Quota Tracker — Financial Circuit Breaker for Google APIs

Tracks usage of paid Google APIs and automatically flips to the free
open-source fallback stack when a quota threshold is hit or an API
error indicates the limit has been reached.

State machine per service:
  CLOSED = using Google (paid/primary)
  OPEN   = using OSS fallback (Leaflet, ORS, Nominatim)

Trip conditions (CLOSED → OPEN):
  1. Google API returns HTTP 429 (rate limited)
  2. Google API returns HTTP 403 with "quotaExceeded" in body
  3. Daily call counter exceeds configured threshold
  4. GOOGLE_MAPS_API_KEY not set (dev / offline mode)

Recovery: breaker auto-resets hourly and reattempts Google.

Usage:
  from services.quota_tracker import quota_tracker

  if quota_tracker.should_use_google("routes"):
      try:
          result = await _call_google_routes(...)
          quota_tracker.record_success("routes")
          return result
      except httpx.HTTPStatusError as exc:
          quota_tracker.record_error("routes", exc.response.status_code, exc.response.text)
          raise   # caller falls back to ORS
"""

import logging
import os
import time
from dataclasses import dataclass, field
from typing import Literal

logger = logging.getLogger(__name__)

# ── Configurable daily soft-caps ───────────────────────────────────────────────
# Set these in .env to override. Defaults are conservative — well inside the
# $200/month Google Maps credit at typical demo usage levels.
_DAILY_LIMITS: dict[str, int] = {
    "routes":   int(os.getenv("GOOGLE_ROUTES_DAILY_LIMIT",  "800")),   # elements/day  (~$4 max)
    "places":   int(os.getenv("GOOGLE_PLACES_DAILY_LIMIT",  "400")),   # requests/day  (~$1.12 max)
    "geocode":  int(os.getenv("GOOGLE_GEOCODE_DAILY_LIMIT", "300")),   # requests/day  (~$1.50 max)
}

_WARN_FRACTION = 0.80   # log warning at 80% of daily limit
_RESET_SECONDS = 3600   # breaker auto-resets every hour

ServiceName = Literal["routes", "places", "geocode", "maps_js"]


@dataclass
class _ServiceState:
    name: str
    count: int       = 0
    open: bool       = False   # True = breaker tripped, use OSS fallback
    tripped_at: float = 0.0
    trip_reason: str  = ""


class QuotaTracker:
    """
    Singleton that tracks Google API usage and manages circuit breaker state.
    Thread-safe for asyncio (single-threaded event loop); not safe for
    multi-process deployments (use Redis for that, but not needed for demo).
    """

    def __init__(self) -> None:
        self._services: dict[str, _ServiceState] = {
            name: _ServiceState(name=name) for name in _DAILY_LIMITS
        }
        # maps_js has no server-side counter — frontend handles it
        self._google_maps_key_set = bool(os.getenv("GOOGLE_MAPS_API_KEY", ""))

    # ── Public query methods ────────────────────────────────────────────────────

    def should_use_google(self, service: ServiceName) -> bool:
        """
        Return True if the Google API for this service should be attempted.
        Returns False if:
          - breaker is OPEN (tripped by error or quota)
          - GOOGLE_MAPS_API_KEY is not set (for Maps-credit services)
        """
        if not self._google_maps_key_set and service in ("routes", "places", "geocode", "maps_js"):
            return False

        if service not in self._services:
            return self._google_maps_key_set

        state = self._services[service]
        self._maybe_reset(state)
        return not state.open

    def record_success(self, service: ServiceName) -> None:
        """Increment counter after a successful Google API call."""
        if service not in self._services:
            return
        state = self._services[service]
        state.count += 1
        limit = _DAILY_LIMITS.get(service, 9999)

        if state.count >= limit:
            self._trip(state, f"daily limit reached ({state.count}/{limit})")
        elif state.count >= int(limit * _WARN_FRACTION):
            logger.warning(
                "QuotaTracker: %s at %d/%d (%.0f%%) — approaching daily limit",
                service, state.count, limit, 100 * state.count / limit,
            )

    def record_error(self, service: ServiceName, status_code: int, body: str = "") -> None:
        """
        Call this when a Google API returns an error.
        Trips the breaker on quota/rate-limit errors.
        """
        if service not in self._services:
            return
        state = self._services[service]
        body_lower = body.lower()

        if status_code == 429:
            self._trip(state, f"HTTP 429 rate-limited")
        elif status_code == 403 and ("quota" in body_lower or "exceeded" in body_lower or "billing" in body_lower):
            self._trip(state, f"HTTP 403 quota exceeded")
        else:
            # Non-quota error (network, bad key, etc.) — log but don't trip breaker
            logger.warning("QuotaTracker: %s HTTP %d — not tripping breaker", service, status_code)

    # ── Status for /api/system-status endpoint ─────────────────────────────────

    def get_status(self) -> dict:
        """
        Return current provider state for each service.
        Used by the frontend to decide which map/search component to render.
        """
        maps_key_set = self._google_maps_key_set

        routes_state  = self._services.get("routes")
        places_state  = self._services.get("places")

        if routes_state:
            self._maybe_reset(routes_state)
        if places_state:
            self._maybe_reset(places_state)

        return {
            "map_provider":     "google" if maps_key_set else "oss",
            "eta_provider":     "google" if (maps_key_set and routes_state and not routes_state.open) else "ors",
            "address_provider": "google" if (maps_key_set and places_state and not places_state.open) else "nominatim",
            "google_maps_key":  maps_key_set,
            "services": {
                name: {
                    "provider":    "oss" if state.open else "google",
                    "count_today": state.count,
                    "limit":       _DAILY_LIMITS.get(name, 0),
                    "open":        state.open,
                    "trip_reason": state.trip_reason if state.open else "",
                }
                for name, state in self._services.items()
            },
        }

    # ── Internal helpers ────────────────────────────────────────────────────────

    def _trip(self, state: _ServiceState, reason: str) -> None:
        if not state.open:
            logger.warning(
                "QuotaTracker: circuit breaker OPEN for '%s' — %s. "
                "Falling back to OSS stack. Will retry in %ds.",
                state.name, reason, _RESET_SECONDS,
            )
        state.open       = True
        state.tripped_at = time.monotonic()
        state.trip_reason = reason

    def _maybe_reset(self, state: _ServiceState) -> None:
        """Auto-reset breaker after _RESET_SECONDS to reattempt Google."""
        if state.open and (time.monotonic() - state.tripped_at) >= _RESET_SECONDS:
            logger.info(
                "QuotaTracker: circuit breaker RESET for '%s' — retrying Google.",
                state.name,
            )
            state.open = False
            state.trip_reason = ""
            # Note: we do NOT reset count — daily counter continues accumulating


# Module-level singleton — import this everywhere
quota_tracker = QuotaTracker()
