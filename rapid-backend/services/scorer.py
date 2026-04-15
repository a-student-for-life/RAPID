"""
Scoring Engine
Computes a composite 0–100 score for each hospital based on four factors:
ETA, capacity, trauma capability, and blood (O-negative) availability.

Each factor is independently normalised to [0, 1] before weighting so that
no single raw unit dominates. Sub-scores are returned alongside the composite
so the dashboard and Gemini prompt both have full visibility.

No external calls are made — pure Python computation only.
"""

from typing import Any

# ── Weight configuration ───────────────────────────────────────────────────────
WEIGHTS: dict[str, float] = {
    "eta":      0.40,   # time costs lives in trauma
    "capacity": 0.25,   # available beds determine throughput
    "trauma":   0.20,   # dedicated trauma centre = structural readiness
    "blood":    0.15,   # O-negative as universal-donor surgical proxy
}

# ── Normalisation ceilings ─────────────────────────────────────────────────────
# Scores saturate at these values (returns 1.0 at or above ceiling).
# Urban settings (Mumbai): real road ETAs are 5-25 min; 3 min = exceptional, 25 min = poor.
_ETA_BEST_MINUTES   =  3.0   # ≤ 3 min → full score
_ETA_WORST_MINUTES  = 25.0   # ≥ 25 min → zero
_ICU_CEILING        = 20     # ICU beds at which capacity saturates
_BEDS_CEILING       = 300    # general beds at which capacity saturates
_O_NEG_CEILING      = 10     # O-negative units at which blood saturates


# ── Public API ─────────────────────────────────────────────────────────────────

def score_all(hospital_data: dict[str, dict]) -> list[dict[str, Any]]:
    """
    Score every hospital and return results sorted best-first.

    Args:
        hospital_data: mapping returned by aggregator.fetch_hospital_data().
                       Each value must contain: eta_minutes, capacity, blood.

    Returns:
        List of score dicts, highest composite_score first:
        [
            {
                "name":            str,
                "composite_score": float,   # 0–100
                "sub_scores": {
                    "eta":      float,      # 0–100
                    "capacity": float,
                    "trauma":   float,
                    "blood":    float,
                },
            },
            ...
        ]
    """
    scored = [
        _score_one(name, info)
        for name, info in hospital_data.items()
    ]
    scored.sort(key=lambda s: s["composite_score"], reverse=True)
    return scored


# ── Per-hospital scoring ───────────────────────────────────────────────────────

def _score_one(name: str, info: dict) -> dict[str, Any]:
    eta_score      = _score_eta(info.get("eta_minutes"))
    capacity_score = _score_capacity(info.get("capacity", {}))
    trauma_score   = _score_trauma(info.get("capacity", {}))
    blood_score    = _score_blood(info.get("blood", {}))

    composite = (
        eta_score      * WEIGHTS["eta"]      +
        capacity_score * WEIGHTS["capacity"] +
        trauma_score   * WEIGHTS["trauma"]   +
        blood_score    * WEIGHTS["blood"]
    ) * 100  # scale to 0–100

    return {
        "name": name,
        "composite_score": round(composite, 1),
        "sub_scores": {
            "eta":      round(eta_score      * 100, 1),
            "capacity": round(capacity_score * 100, 1),
            "trauma":   round(trauma_score   * 100, 1),
            "blood":    round(blood_score    * 100, 1),
        },
    }


# ── Factor normalisers (each returns a value in [0.0, 1.0]) ───────────────────

def _score_eta(eta_minutes: float | None) -> float:
    """
    Lower ETA → higher score.
    Linear interpolation between _ETA_BEST_MINUTES (1.0) and
    _ETA_WORST_MINUTES (0.0). Unknown ETA → neutral 0.5.
    """
    if eta_minutes is None:
        return 0.5
    if eta_minutes <= _ETA_BEST_MINUTES:
        return 1.0
    if eta_minutes >= _ETA_WORST_MINUTES:
        return 0.0
    return (_ETA_WORST_MINUTES - eta_minutes) / (_ETA_WORST_MINUTES - _ETA_BEST_MINUTES)


def _score_capacity(capacity: dict) -> float:
    """
    Combined ICU and general-bed availability.
    ICU beds carry more weight (60 %) as they are the critical bottleneck.
    General beds take the remaining 40 %.
    """
    icu_score  = min(1.0, capacity.get("available_icu",  0) / _ICU_CEILING)
    beds_score = min(1.0, capacity.get("available_beds", 0) / _BEDS_CEILING)
    return 0.6 * icu_score + 0.4 * beds_score


def _score_trauma(capacity: dict) -> float:
    """
    Binary: designated trauma centre → 1.0, otherwise 0.0.
    """
    return 1.0 if capacity.get("trauma_centre") else 0.0


def _score_blood(blood: dict) -> float:
    """
    O-negative availability as a surgical readiness proxy.
    Saturates at _O_NEG_CEILING units. Zero O-neg → 0.0.
    """
    o_neg = blood.get("O-", 0)
    return min(1.0, o_neg / _O_NEG_CEILING)
