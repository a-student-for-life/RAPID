"""
Scene consensus helpers.

Multiple crews can assess the same scene, so simply summing their estimates
inflates casualty counts. This module derives a safer cross-crew consensus
using per-severity medians plus hazard unioning.
"""

from __future__ import annotations

from collections import Counter
from statistics import median
from typing import Any

SEVERITY_ORDER = ("critical", "moderate", "minor")


def build_scene_consensus(reports: list[dict[str, Any]]) -> dict[str, Any]:
    """Return a consensus summary for multiple crew scene reports."""
    normalized = sorted((_normalize_report(report) for report in reports), key=_report_sort_key)
    if not normalized:
        return {
            "report_count": 0,
            "confidence": "NONE",
            "consensus_patient_groups": [],
            "patient_groups": [],
            "total_estimated": None,
            "hazard_flags": [],
            "variance": {},
            "raw_reports": [],
            "reports": [],
        }

    per_severity: dict[str, list[int]] = {severity: [] for severity in SEVERITY_ORDER}
    all_hazards: set[str] = set()
    casualty_estimates: list[int] = []

    for report in normalized:
        for severity in SEVERITY_ORDER:
            per_severity[severity].append(_severity_count(report, severity))
        all_hazards.update(report.get("hazard_flags", []))

        estimated = report.get("estimated_casualties")
        if estimated is not None:
            casualty_estimates.append(int(estimated))

    consensus_groups = []
    for severity in SEVERITY_ORDER:
        counts = per_severity[severity]
        count = int(round(median(counts))) if counts else 0
        if count <= 0:
            continue
        consensus_groups.append({
            "severity": severity,
            "count": count,
            "injury_type": _dominant_injury_type(normalized, severity),
        })

    totals_per_report = [
        sum(_severity_count(report, severity) for severity in SEVERITY_ORDER)
        for report in normalized
    ]
    total_estimated = (
        int(round(median(casualty_estimates)))
        if casualty_estimates
        else sum(group["count"] for group in consensus_groups)
    )

    variance = {
        severity: _variance_entry(counts)
        for severity, counts in per_severity.items()
    }
    variance["total"] = _variance_entry(totals_per_report)

    return {
        "report_count": len(normalized),
        "confidence": _confidence_label(len(normalized), variance["total"]["spread"], total_estimated),
        "consensus_patient_groups": consensus_groups,
        # Keep the legacy field populated so older UI code degrades gracefully.
        "patient_groups": consensus_groups,
        "total_estimated": total_estimated,
        "hazard_flags": sorted(all_hazards),
        "variance": variance,
        "raw_reports": normalized,
        "reports": normalized,
    }


def _normalize_report(report: dict[str, Any]) -> dict[str, Any]:
    """Keep only the human-meaningful report fields used in the UI and routing."""
    patient_groups = []
    for severity in SEVERITY_ORDER:
        patient_groups.append({
            "severity": severity,
            "count": _severity_count(report, severity),
            "injury_type": _injury_type_for(report, severity),
        })

    estimated = report.get("estimated_casualties")
    if estimated is not None:
        try:
            estimated = int(estimated)
        except (TypeError, ValueError):
            estimated = None

    return {
        "unit_id": report.get("unit_id"),
        "incident_id": report.get("incident_id"),
        "estimated_casualties": estimated,
        "severity_distribution": report.get("severity_distribution"),
        "patient_groups": patient_groups,
        "hazard_flags": sorted({flag for flag in report.get("hazard_flags", []) if flag}),
        "triage_notes": report.get("triage_notes"),
        "saved_at": report.get("saved_at"),
        "model": report.get("_model") or report.get("model"),
    }


def _severity_count(report: dict[str, Any], severity: str) -> int:
    total = 0
    for patient_group in report.get("patient_groups", []):
        if patient_group.get("severity") != severity:
            continue
        try:
            total += int(patient_group.get("count", 0))
        except (TypeError, ValueError):
            continue
    return total


def _injury_type_for(report: dict[str, Any], severity: str) -> str | None:
    injuries = [
        patient_group.get("injury_type")
        for patient_group in report.get("patient_groups", [])
        if patient_group.get("severity") == severity and patient_group.get("injury_type")
    ]
    if not injuries:
        return None
    return Counter(injuries).most_common(1)[0][0]


def _dominant_injury_type(reports: list[dict[str, Any]], severity: str) -> str | None:
    injuries = [
        _injury_type_for(report, severity)
        for report in reports
    ]
    injuries = [injury for injury in injuries if injury]
    if not injuries:
        return None
    return Counter(injuries).most_common(1)[0][0]


def _variance_entry(values: list[int]) -> dict[str, int]:
    if not values:
        return {"min": 0, "max": 0, "spread": 0}
    return {
        "min": min(values),
        "max": max(values),
        "spread": max(values) - min(values),
    }


def _confidence_label(report_count: int, total_spread: int, total_estimated: int | None) -> str:
    if report_count == 0:
        return "NONE"
    if report_count == 1:
        return "LOW"

    baseline = max(total_estimated or 0, 1)
    spread_ratio = total_spread / baseline

    if report_count >= 3 and spread_ratio <= 0.2:
        return "HIGH"
    if spread_ratio <= 0.5:
        return "MEDIUM"
    return "LOW"


def _report_sort_key(report: dict[str, Any]) -> tuple[int, str]:
    saved_at = report.get("saved_at") or ""
    return (0 if saved_at else 1, saved_at)
