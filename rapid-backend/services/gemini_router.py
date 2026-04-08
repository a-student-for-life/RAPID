"""
Gemini Router
Sends a structured prompt to Gemini 2.0 Flash (via Vertex AI) and parses the
JSON routing response.

The Vertex AI SDK is synchronous, so the blocking call is offloaded to a
thread-pool executor so it does not block the FastAPI event loop.

asyncio.wait_for enforces an 8-second hard timeout. Any exception — timeout,
API error, or JSON parse failure — propagates to the caller, which falls back
to the scoring engine.

Output schema is identical to fallback_router so the incident endpoint can
swap between them without any structural changes.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from functools import partial
from typing import Any

import vertexai
from vertexai.generative_models import GenerationConfig, GenerativeModel

logger = logging.getLogger(__name__)

# ── Vertex AI initialisation ───────────────────────────────────────────────────
_PROJECT  = os.getenv("GOOGLE_CLOUD_PROJECT", "")
_LOCATION = "asia-south1"

_MODEL = None

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


def _get_model():
    global _MODEL

    if _MODEL is not None:
        return _MODEL

    if not _PROJECT:
        raise ValueError("GOOGLE_CLOUD_PROJECT not set")

    vertexai.init(project=_PROJECT, location=_LOCATION)

    _MODEL = GenerativeModel(
        "gemini-2.0-flash",
        system_instruction=_SYSTEM_PROMPT,
    )
    logger.info("Gemini 2.0 Flash model initialised.")
    return _MODEL


_GEN_CONFIG = GenerationConfig(
    temperature=0.1,
    max_output_tokens=2048,
    response_mime_type="application/json",
)

_AI_TIMEOUT_SECONDS = float(os.getenv("GEMINI_TIMEOUT_SECONDS", "8.0"))


# ── Public API ─────────────────────────────────────────────────────────────────

async def route_patients(
    scores: list[dict],
    patient_groups: list[dict],
    hospital_data: dict[str, dict],
) -> dict[str, Any]:

    prompt = _build_prompt(scores, patient_groups, hospital_data)

    loop = asyncio.get_running_loop()
    call = partial(_call_gemini_sync, prompt)

    raw = await asyncio.wait_for(
        loop.run_in_executor(None, call),
        timeout=_AI_TIMEOUT_SECONDS,
    )

    cleaned = re.sub(r"```.*?\n|```", "", raw, flags=re.DOTALL).strip()
    result = json.loads(cleaned)

    if not isinstance(result, dict):
        raise ValueError("Invalid AI response (not dict)")

    if "assignments" not in result:
        raise ValueError("Invalid AI response (missing assignments)")

    result["decision_path"] = "AI"
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


# ── Synchronous Vertex AI call (runs in thread executor) ──────────────────────

def _call_gemini_sync(prompt: str) -> str:
    model = _get_model()
    response = model.generate_content(prompt, generation_config=_GEN_CONFIG)
    return response.text.strip()
