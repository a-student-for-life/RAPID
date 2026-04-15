import React, { useState } from 'react'

function buildDraftAlerts(result) {
  if (!result) return []

  const criticalAssignments = (result.assignments || []).filter(a => a.severity === 'critical')
  const totalPatients = (result.assignments || []).reduce((s, a) => s + a.patients_assigned, 0)
  const criticalCount = criticalAssignments.reduce((s, a) => s + a.patients_assigned, 0)
  const assignedHospitals = [...new Set((result.assignments || []).map(a => a.hospital))].slice(0, 2)
  const primaryHosp = assignedHospitals[0] ?? 'nearest hospital'
  const secondHosp  = assignedHospitals[1]
  const injuryTypes = [...new Set(
    (result.assignments || []).filter(a => a.injury_type).map(a => a.injury_type)
  )].join(', ')

  const bloodLines = criticalAssignments.slice(0, 2).map(a => {
    const units = Math.ceil(a.patients_assigned * 1.5)
    return `${a.hospital} (+${units} units)`
  }).join(', ')

  return [
    {
      icon: '📟', agency: 'NDRF',
      message: `MCI — ${totalPatients} casualties (${criticalCount} critical)${injuryTypes ? `, ${injuryTypes}` : ''}. Primary: ${primaryHosp}${secondHosp ? ` & ${secondHosp}` : ''}. Requesting rapid response teams.`,
    },
    {
      icon: '🩸', agency: 'Blood Bank Network',
      message: bloodLines
        ? `Urgent O-negative: ${bloodLines}. MCI protocol — ${criticalCount} critical in transit.`
        : `O-negative surge request — ${criticalCount} critical patients in transit.`,
    },
    {
      icon: '🚦', agency: 'Local Traffic Control',
      message: `Emergency corridor to ${primaryHosp}${secondHosp ? ` & ${secondHosp}` : ''}. Multiple ambulances dispatched.`,
    },
    {
      icon: '🏥', agency: 'State DMER',
      message: `Surge protocol active. ${totalPatients} casualties across ${assignedHospitals.length} hospitals. Trauma team standby requested.`,
    },
  ]
}

export default function MCIBanner({ isMCI, result }) {
  const [expanded, setExpanded] = useState(false)

  if (!isMCI) return null

  const drafts = buildDraftAlerts(result)

  return (
    <div className="shrink-0 bg-red-950/50 border-b border-red-900">
      {/* Single compact header line */}
      <div className="flex items-center gap-2 px-4 py-1.5">
        <span className="text-red-400 font-black text-xs uppercase tracking-widest mci-pulse shrink-0">
          ⚠ MASS CASUALTY EVENT
        </span>
        <span className="text-red-800 shrink-0">|</span>
        <span className="text-red-400/70 text-xs shrink-0">SURGE PROTOCOL ACTIVE</span>
        <div className="flex-1" />
        {result && (
          <button
            onClick={() => setExpanded(v => !v)}
            className="text-xs text-red-500 hover:text-red-300 transition-colors font-mono shrink-0"
          >
            {expanded ? '▲ hide alerts' : '▼ draft alerts'}
          </button>
        )}
      </div>

      {/* Expandable draft alert panel */}
      {expanded && result && (
        <div className="px-4 pb-3 space-y-1.5 border-t border-red-900/50 pt-2">
          <p className="text-xs text-red-700 font-mono mb-1.5">
            [SIMULATED — production would send to registered agency contacts]
          </p>
          {drafts.map((draft, i) => (
            <div key={i} className="flex gap-2 bg-red-950/40 border border-red-900/40 rounded px-2.5 py-2">
              <span className="text-sm shrink-0">{draft.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <p className="text-xs font-bold text-red-300">{draft.agency}</p>
                  <span className="text-xs text-slate-600 italic">Draft — not sent</span>
                </div>
                <p className="text-xs text-slate-400 leading-snug">{draft.message}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
