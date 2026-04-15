"""
Voice Parser
Two-step pipeline:
  1. Groq Whisper Large V3 — transcribes audio to text.
  2. Groq LLM — extracts structured incident data from the transcript.
  3. Nominatim — resolves the location text to lat/lon.

Returns a dict the frontend can use to pre-fill the incident form.
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_GROQ_API_KEY    = os.getenv("GROQ_API_KEY", "")
_WHISPER_URL     = "https://api.groq.com/openai/v1/audio/transcriptions"
_CHAT_URL        = "https://api.groq.com/openai/v1/chat/completions"
_NOMINATIM_URL   = "https://nominatim.openstreetmap.org/search"

_EXTRACT_PROMPT = """
Extract incident details from the following emergency dispatch transcript.
Return ONLY valid JSON with this exact structure (no markdown, no preamble):
{
  "location_text": "<place name or address, or null if not mentioned>",
  "patient_groups": [
    {"severity": "critical|moderate|minor", "count": <int>, "injury_type": "<burns|neuro|cardiac|ortho|trauma|general|null>"}
  ],
  "notes": "<brief summary of key details>"
}

Rules:
- severity must be one of: critical, moderate, minor
- injury_type must be one of: burns, neuro, cardiac, ortho, trauma, general, or null
- count must be a positive integer; estimate if vague (e.g. "many" = 10, "few" = 3)
- if no patient breakdown is given, use a single moderate group with count=10
- notes should be 1 sentence max

Transcript:
"""


async def parse_audio(audio_bytes: bytes, content_type: str) -> dict[str, Any]:
    """
    Accept raw audio bytes, return structured incident dict:
    {
        "transcript":     str,
        "location_text":  str | None,
        "lat":            float | None,
        "lon":            float | None,
        "patient_groups": list[dict],
        "notes":          str,
    }
    Raises ValueError if GROQ_API_KEY not set or transcription fails.
    """
    if not _GROQ_API_KEY:
        raise ValueError("GROQ_API_KEY not set — voice input unavailable")

    # ── Step 1: transcribe with Whisper ──────────────────────────────────────
    transcript = await _transcribe(audio_bytes, content_type)
    logger.info("Whisper transcript: %s", transcript[:120])

    # ── Step 2: extract structured data ──────────────────────────────────────
    extracted = await _extract(transcript)

    # ── Step 3: geocode location text → lat/lon ───────────────────────────────
    lat, lon = None, None
    if extracted.get("location_text"):
        lat, lon = await _geocode(extracted["location_text"])

    return {
        "transcript":     transcript,
        "location_text":  extracted.get("location_text"),
        "lat":            lat,
        "lon":            lon,
        "patient_groups": extracted.get("patient_groups", []),
        "notes":          extracted.get("notes", ""),
    }


# ── Step 1: Whisper transcription ─────────────────────────────────────────────

async def _transcribe(audio_bytes: bytes, content_type: str) -> str:
    ext = "webm" if "webm" in content_type else "wav" if "wav" in content_type else "m4a"
    filename = f"audio.{ext}"

    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            _WHISPER_URL,
            headers={"Authorization": f"Bearer {_GROQ_API_KEY}"},
            files={"file": (filename, audio_bytes, content_type)},
            data={"model": "whisper-large-v3", "response_format": "text"},
        )

    if response.status_code != 200:
        logger.warning("Whisper HTTP %d: %s", response.status_code, response.text[:200])
    response.raise_for_status()

    return response.text.strip()


# ── Step 2: LLM extraction ────────────────────────────────────────────────────

async def _extract(transcript: str) -> dict[str, Any]:
    body = {
        "model":    "llama-3.1-8b-instant",
        "messages": [
            {"role": "user", "content": _EXTRACT_PROMPT + transcript},
        ],
        "temperature":     0.0,
        "max_tokens":      512,
        "response_format": {"type": "json_object"},
    }

    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.post(
            _CHAT_URL,
            headers={"Authorization": f"Bearer {_GROQ_API_KEY}"},
            json=body,
        )

    response.raise_for_status()
    raw = response.json()["choices"][0]["message"]["content"]
    cleaned = re.sub(r"```.*?\n|```", "", raw, flags=re.DOTALL).strip()
    return json.loads(cleaned)


# ── Step 3: Nominatim geocoding ───────────────────────────────────────────────

async def _geocode(location_text: str) -> tuple[float | None, float | None]:
    """
    Geocode a location string to lat/lon via Nominatim.
    First tries India-restricted search (countrycodes=in), then falls back
    to a global search so overseas place names still resolve.
    """
    async def _query(params: dict) -> list:
        async with httpx.AsyncClient(timeout=8) as client:
            response = await client.get(
                _NOMINATIM_URL,
                params=params,
                headers={"User-Agent": "RAPID-Emergency-Dispatcher"},
            )
        return response.json()

    try:
        # Try India first (matches AddressSearch frontend behaviour)
        data = await _query({"q": location_text, "format": "json", "limit": 1, "countrycodes": "in"})
        if not data:
            # Fall back to global search
            data = await _query({"q": location_text, "format": "json", "limit": 1})
        if data:
            lat, lon = float(data[0]["lat"]), float(data[0]["lon"])
            logger.info("Geocoded '%s' → %.5f, %.5f", location_text, lat, lon)
            return lat, lon
        logger.warning("Nominatim returned no results for: %s", location_text)
    except Exception as exc:
        logger.warning("Nominatim geocoding failed: %s", exc)
    return None, None
