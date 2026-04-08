"""
Pydantic request and response schemas for the RAPID API.
All validation happens here — routers stay free of parsing logic.
"""

from pydantic import BaseModel, Field
from typing import Any, Optional


# ── Request ────────────────────────────────────────────────────────────────────

class PatientGroup(BaseModel):
    severity:    str           = Field(..., pattern="^(critical|moderate|minor)$")
    count:       int           = Field(..., ge=1)
    injury_type: Optional[str] = Field(
        None,
        description=(
            "Specific injury type to enable specialty-aware routing. "
            "Examples: burns, neuro, cardiac, ortho, trauma, general"
        ),
    )


class IncidentRequest(BaseModel):
    lat:            float              = Field(..., ge=-90,  le=90)
    lon:            float              = Field(..., ge=-180, le=180)
    patients:       list[PatientGroup]
    force_fallback: bool               = Field(
        False,
        description="Set true to bypass Gemini and use deterministic fallback (demo/testing).",
    )


# ── Response ───────────────────────────────────────────────────────────────────

class IncidentResponse(BaseModel):
    incident_id:   str
    decision_path: str
    hospitals:     list[dict[str, Any]]
    scores:        list[dict[str, Any]]
    assignments:   list[dict[str, Any]]
    warnings:      list[str]
    reasoning:     str = ""
    elapsed_s:     float = 0.0
