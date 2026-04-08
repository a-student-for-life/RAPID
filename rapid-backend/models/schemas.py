"""
Pydantic request and response schemas for the RAPID API.
All validation happens here — routers stay free of parsing logic.
"""

from pydantic import BaseModel, Field
from typing import Any


# ── Request ────────────────────────────────────────────────────────────────────

class PatientGroup(BaseModel):
    severity: str = Field(..., pattern="^(critical|moderate|minor)$")
    count:    int = Field(..., ge=1)


class IncidentRequest(BaseModel):
    lat:      float         = Field(..., ge=-90,  le=90)
    lon:      float         = Field(..., ge=-180, le=180)
    patients: list[PatientGroup]


# ── Response ───────────────────────────────────────────────────────────────────

class IncidentResponse(BaseModel):
    decision_path: str
    hospitals:     list[dict[str, Any]]
    scores:        list[dict[str, Any]]
    assignments:   list[dict[str, Any]]
    warnings:      list[str]
    reasoning:     str = ""
