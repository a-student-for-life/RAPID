"""
Groq Router
Calls the Groq API (OpenAI-compatible) for patient routing when Gemini is
unavailable. Uses llama-3.3-70b-versatile — fast, free tier, JSON mode.

Acts as the second-tier AI fallback in the routing chain:
  Gemini → Groq → deterministic fallback_router

Two modes (controlled by GROQ_AGENTIC env flag):
  STANDARD (default): single prompt → assignments  (1 Groq call)
  AGENTIC:            analyze → assign              (2 Groq calls, richer reasoning)

Output schema is identical to gemini_router and fallback_router.
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# ── Configuration ──────────────────────────────────────────────────────────────
_API_KEY  = os.getenv("GROQ_API_KEY", "")
_MODEL    = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
_URL      = "https://api.groq.com/openai/v1/chat/completions"

_AI_TIMEOUT_SECONDS = float(os.getenv("GROQ_TIMEOUT_SECONDS", "8.0"))
_AGENTIC            = os.getenv("GROQ_AGENTIC", "true").lower() == "true"

_ANALYZE_PROMPT = """
You are RAPID, an AI emergency medical triage analyst.
Given the incident data, produce a triage assessment. Return ONLY valid JSON:
{
  "critical_needs":    ["<what the most critical patients urgently need>"],
  "specialty_flags":   ["<injury types requiring specialist hospitals>"],
  "capacity_warnings": ["<hospitals that may be overwhelmed>"],
  "load_strategy":     "<1 sentence on how to distribute patients>",
  "priority_hospital": "<name of hospital that should receive the most critical cases>"
}
"""

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
    Route patients via Groq.
    If GROQ_AGENTIC=true: Step 1 (analyze) → Step 2 (assign) — richer reasoning.
    Otherwise: single-prompt mode.
    """
    if not _API_KEY:
        raise ValueError("GROQ_API_KEY not set")

    if _AGENTIC:
        return await _agentic_route(scores, patient_groups, hospital_data)
    return await _single_route(scores, patient_groups, hospital_data)


async def _agentic_route(
    scores: list[dict],
    patient_groups: list[dict],
    hospital_data: dict[str, dict],
) -> dict[str, Any]:
    """Two-step: analyze then assign."""
    prompt = _build_prompt(scores, patient_groups, hospital_data)

    # ── Step 1: Analyze ───────────────────────────────────────────────────────
    analysis_raw = await _groq_call(
        system=_ANALYZE_PROMPT.strip(),
        user=prompt,
        max_tokens=512,
    )
    try:
        cleaned  = re.sub(r"```.*?\n|```", "", analysis_raw, flags=re.DOTALL).strip()
        analysis = json.loads(cleaned)
    except Exception:
        analysis = {"load_strategy": analysis_raw[:200]}

    logger.info("Groq agent analysis: %s", str(analysis)[:120])

    # ── Step 2: Assign using analysis as extra context ────────────────────────
    assignment_context = (
        f"\nTRIAGE ANALYSIS (use this to guide your assignments):\n"
        f"  Critical needs:    {analysis.get('critical_needs', [])}\n"
        f"  Specialty flags:   {analysis.get('specialty_flags', [])}\n"
        f"  Load strategy:     {analysis.get('load_strategy', '')}\n"
        f"  Priority hospital: {analysis.get('priority_hospital', '')}\n"
    )

    result = await _single_route(
        scores, patient_groups, hospital_data,
        extra_context=assignment_context,
    )
    result["decision_path"] = "groq"

    # Enrich reasoning with analysis insights
    if analysis.get("load_strategy"):
        result["reasoning"] = (
            f"[Agent Step 1] {analysis.get('load_strategy', '')} "
            + result.get("reasoning", "")
        )
    return result


async def _single_route(
    scores: list[dict],
    patient_groups: list[dict],
    hospital_data: dict[str, dict],
    extra_context: str = "",
) -> dict[str, Any]:
    """Single-prompt routing call."""
    prompt = _build_prompt(scores, patient_groups, hospital_data) + extra_context
    raw    = await _groq_call(
        system=_SYSTEM_PROMPT.strip(),
        user=prompt,
        max_tokens=2048,
    )
    cleaned = re.sub(r"```.*?\n|```", "", raw, flags=re.DOTALL).strip()
    result  = json.loads(cleaned)

    if not isinstance(result, dict):
        raise ValueError("Invalid Groq response (not a dict)")
    if "assignments" not in result:
        raise ValueError("Invalid Groq response (missing assignments)")

    result["decision_path"] = "groq"
    return result


async def _groq_call(system: str, user: str, max_tokens: int = 2048) -> str:
    """Make one Groq chat completion call and return the content string."""
    body = {
        "model":    _MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user",   "content": user},
        ],
        "temperature":     0.1,
        "max_tokens":      max_tokens,
        "response_format": {"type": "json_object"},
    }

    async with httpx.AsyncClient(timeout=_AI_TIMEOUT_SECONDS) as client:
        response = await client.post(
            _URL,
            headers={"Authorization": f"Bearer {_API_KEY}"},
            json=body,
        )

    if response.status_code != 200:
        logger.warning("Groq HTTP %d: %s", response.status_code, response.text[:300])
    response.raise_for_status()

    try:
        return response.json()["choices"][0]["message"]["content"]
    except (KeyError, IndexError) as exc:
        raise ValueError(f"Unexpected Groq response shape: {exc}") from exc


# ── Prompt builder (shared logic with gemini_router) ──────────────────────────

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
