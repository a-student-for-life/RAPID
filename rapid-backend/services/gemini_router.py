"""
Gemini Router
Calls the Gemini API (AI Studio) via httpx and parses the JSON routing response.

Requires only a GEMINI_API_KEY in the environment — no Google Cloud project
or Vertex AI credentials needed.

Output schema is identical to fallback_router so the incident endpoint can
swap between them without any structural changes.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# ── Configuration ──────────────────────────────────────────────────────────────
_API_KEY  = os.getenv("GEMINI_API_KEY", "")
_MODEL    = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"

_AI_TIMEOUT_SECONDS = float(os.getenv("GEMINI_TIMEOUT_SECONDS", "15.0"))

_SYSTEM_PROMPT = """
You are RAPID, an AI emergency medical routing coordinator.
Route mass casualty patients to hospitals based on the scored data provided.

ROUTING PRIORITIES (strict order):
1. TRAUMA CAPABILITY  — for critical patients, prefer trauma centres.
2. SPECIALTY MATCH    — if injury_type is given (burns, neuro, cardiac, ortho),
                        strongly prefer hospitals whose specialties list includes it.
3. CAPACITY           — do not assign critical patients to a hospital with no ICU beds.
4. BLOOD READINESS    — prefer hospitals with O-negative units available.
5. LOAD BALANCE       — distribute patients; avoid overloading a single hospital.
6. ETA                — all else equal, shorter travel time is better.

OUTPUT — strict JSON only, no preamble, no markdown:
{
  "decision_path": "AI",
  "assignments": [
    {
      "hospital":          "<exact name from context>",
      "patients_assigned": <integer>,
      "severity":          "<critical|moderate|minor>",
      "injury_type":       "<injury_type if given, else null>",
      "reason":            "<1-2 sentences citing scores and specialty match>"
    }
  ],
  "reasoning": "<2-3 sentence overall summary>",
  "warnings":  ["<any critical gaps or concerns>"]
}
"""


# ── Public API ─────────────────────────────────────────────────────────────────

async def route_patients(
    scores: list[dict],
    patient_groups: list[dict],
    hospital_data: dict[str, dict],
) -> dict[str, Any]:
    """
    Call Gemini API and return patient routing decisions.
    Raises ValueError if GEMINI_API_KEY is not set.
    Raises on HTTP or JSON errors — caller falls back to fallback_router.
    """
    if not _API_KEY:
        raise ValueError("GEMINI_API_KEY not set — AI routing disabled")

    prompt = _build_prompt(scores, patient_groups, hospital_data)

    request_body = {
        "system_instruction": {
            "parts": [{"text": _SYSTEM_PROMPT.strip()}]
        },
        "contents": [
            {"parts": [{"text": prompt}]}
        ],
        "generationConfig": {
            "temperature":      0.1,
            "maxOutputTokens":  2048,
            "responseMimeType": "application/json",
        },
    }

    url = f"{_BASE_URL}/{_MODEL}:generateContent"

    # Retry up to 2 times on 429 (free-tier rate limit), with backoff.
    max_attempts = 2
    for attempt in range(1, max_attempts + 1):
        async with httpx.AsyncClient(timeout=_AI_TIMEOUT_SECONDS) as client:
            response = await client.post(
                url,
                params={"key": _API_KEY},
                json=request_body,
            )

        if response.status_code != 200:
            logger.warning("Gemini HTTP %d (attempt %d/%d): %s",
                           response.status_code, attempt, max_attempts, response.text[:300])

        if response.status_code == 429 and attempt < max_attempts:
            # Quota exhaustion (daily limit) won't recover with retries — fail fast
            body = response.text
            if "quota" in body.lower() or "billing" in body.lower():
                logger.warning("Gemini quota exhausted — skipping retries.")
                response.raise_for_status()

            retry_after = int(response.headers.get("Retry-After", 5))
            logger.warning("Gemini rate-limited — retrying in %ds.", retry_after)
            await asyncio.sleep(retry_after)
            continue

        response.raise_for_status()
        break

    data = response.json()

    try:
        raw = data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError) as exc:
        raise ValueError(f"Unexpected Gemini response shape: {exc}") from exc

    cleaned = re.sub(r"```.*?\n|```", "", raw, flags=re.DOTALL).strip()
    result  = json.loads(cleaned)

    if not isinstance(result, dict):
        raise ValueError("Invalid AI response (not a dict)")
    if "assignments" not in result:
        raise ValueError("Invalid AI response (missing assignments)")

    result["decision_path"] = "gemini"
    return result


# ── Prompt builder ─────────────────────────────────────────────────────────────

def _build_prompt(
    scores: list[dict],
    patient_groups: list[dict],
    hospital_data: dict[str, dict],
) -> str:
    total = sum(pg["count"] for pg in patient_groups)
    patient_lines = "\n".join(
        "  - {count} {severity} patient(s){injury}".format(
            count=pg["count"],
            severity=pg["severity"],
            injury=f" [injury_type: {pg['injury_type']}]" if pg.get("injury_type") else "",
        )
        for pg in patient_groups
    )

    hospital_lines = ""

    for rank, scored in enumerate(scores, start=1):
        name  = scored["name"]
        info  = hospital_data.get(name, {})
        cap   = info.get("capacity", {})
        eta   = info.get("eta_minutes", "?")
        sub   = scored.get("sub_scores", {})
        o_neg = info.get("blood", {}).get("O-", "?")

        hospital_lines += (
            f"\n[#{rank} — {name}]\n"
            f"  composite_score : {scored.get('composite_score', '?')}/100\n"
            f"  sub_scores      : ETA={sub.get('eta','?')} | "
            f"capacity={sub.get('capacity','?')} | "
            f"trauma={sub.get('trauma','?')} | "
            f"blood={sub.get('blood','?')}\n"
            f"  eta_minutes     : {eta}\n"
            f"  icu_available   : {cap.get('available_icu','?')}\n"
            f"  beds_available  : {cap.get('available_beds','?')}\n"
            f"  trauma_centre   : {cap.get('trauma_centre', False)}\n"
            f"  specialties     : {', '.join(cap.get('specialties', []))}\n"
            f"  O-negative_units: {o_neg}\n"
        )

    return (
        f"PATIENTS (total: {total}):\n{patient_lines}\n\n"
        f"HOSPITALS ({len(hospital_data)}, ranked by composite score):\n{hospital_lines}\n"
        f"Assign all {total} patients. Verify assignments sum to {total}. "
        f"Justify every decision. Use scores and specialty matches as context."
    )
