import React from 'react'

const DATA_SOURCE_BADGE = {
  OpenStreetMap:           { label: 'OSM', color: 'text-blue-400 border-blue-800 bg-blue-950/50' },
  NHA_simulation:          { label: 'SIM', color: 'text-amber-400 border-amber-800 bg-amber-950/50' },
  simulated_deterministic: { label: 'SIM', color: 'text-amber-400 border-amber-800 bg-amber-950/50' },
  simulated:               { label: 'EST', color: 'text-slate-400 border-slate-700 bg-slate-900/50' },
}

function ScoreBar({ label, value, color }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-slate-500 w-16 shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-rapid-bg rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ${color}`}
          style={{ width: `${Math.max(2, value)}%` }}
        />
      </div>
      <span className="text-xs text-slate-400 w-8 text-right">{value}</span>
    </div>
  )
}

function DataBadge({ source }) {
  const config = DATA_SOURCE_BADGE[source] || DATA_SOURCE_BADGE.simulated
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded border font-mono ${config.color}`}>
      {config.label}
    </span>
  )
}

function ScoreRing({ score }) {
  const r = 18
  const circ = 2 * Math.PI * r
  const offset = circ - (score / 100) * circ
  const color = score >= 70 ? '#10b981' : score >= 45 ? '#f59e0b' : '#ef4444'

  return (
    <svg width="48" height="48" className="shrink-0">
      <circle cx="24" cy="24" r={r} fill="none" stroke="#2d3148" strokeWidth="3" />
      <circle
        cx="24" cy="24" r={r}
        fill="none"
        stroke={color}
        strokeWidth="3"
        strokeDasharray={circ}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform="rotate(-90 24 24)"
        style={{ transition: 'stroke-dashoffset 1s ease' }}
      />
      <text x="24" y="28" textAnchor="middle" fontSize="11" fontWeight="bold" fill={color}>
        {score}
      </text>
    </svg>
  )
}

export default function HospitalCard({ scored, hospital, assignments, rank }) {
  const sub = scored.sub_scores
  const cap = hospital  // hospital dict from discovery (has data_source, lat, lon)

  const myAssignments = assignments.filter(a => a.hospital === scored.name)
  const hasAssignment = myAssignments.length > 0

  const SEVERITY_COLORS = {
    critical: 'bg-red-900/40 text-red-300 border-red-800',
    moderate: 'bg-amber-900/40 text-amber-300 border-amber-800',
    minor:    'bg-green-900/40 text-green-300 border-green-800',
  }

  return (
    <div
      className={`rounded-lg border p-3 transition-all duration-300 ${
        hasAssignment
          ? 'border-blue-600 bg-blue-950/20'
          : 'border-rapid-border bg-rapid-surface'
      }`}
    >
      {/* Header */}
      <div className="flex items-start gap-2 mb-2">
        <ScoreRing score={scored.composite_score} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-slate-500">#{rank}</span>
            <p className="text-sm font-semibold text-slate-100 truncate">{scored.name}</p>
          </div>
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            <DataBadge source={hospital?.data_source} />
            {cap?.trauma_centre && (
              <span className="text-xs px-1.5 py-0.5 rounded border border-red-800 bg-red-950/50 text-red-400">
                TRAUMA
              </span>
            )}
            {cap?.specialties?.slice(0, 2).map(s => (
              <span key={s} className="text-xs px-1.5 py-0.5 rounded border border-purple-800 bg-purple-950/50 text-purple-400">
                {s}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Sub-scores */}
      <div className="space-y-1 mb-2">
        <ScoreBar label="ETA"      value={sub.eta}      color="bg-blue-500" />
        <ScoreBar label="Capacity" value={sub.capacity} color="bg-green-500" />
        <ScoreBar label="Trauma"   value={sub.trauma}   color="bg-red-500" />
        <ScoreBar label="Blood"    value={sub.blood}    color="bg-purple-500" />
      </div>

      {/* Assignments */}
      {hasAssignment && (
        <div className="space-y-1 mt-2 pt-2 border-t border-rapid-border">
          {myAssignments.map((a, i) => (
            <div key={i} className={`text-xs px-2 py-1.5 rounded border ${SEVERITY_COLORS[a.severity]}`}>
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className="font-bold">{a.patients_assigned} {a.severity}</span>
                {a.injury_type && (
                  <span className="text-purple-400 font-mono">[{a.injury_type}]</span>
                )}
              </div>
              <p className="text-slate-400 leading-tight">{a.reason}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
