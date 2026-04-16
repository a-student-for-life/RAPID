import React, { useState } from 'react'

const DATA_SOURCE_BADGE = {
  OpenStreetMap:           { label: 'OSM',  color: 'text-blue-400 border-blue-800 bg-blue-950/50'    },
  NHA_simulation:          { label: 'ABDM', color: 'text-amber-400 border-amber-800 bg-amber-950/50' },
  simulated_deterministic: { label: 'ABDM', color: 'text-amber-400 border-amber-800 bg-amber-950/50' },
  simulated:               { label: 'EST',  color: 'text-slate-400 border-slate-700 bg-slate-900/50' },
  ors:                     { label: 'ORS',  color: 'text-green-400 border-green-800 bg-green-950/50' },
  seed:                    { label: 'SEED', color: 'text-slate-400 border-slate-700 bg-slate-900/50' },
}

const SUB_SCORE_META = {
  eta:      { label: 'ETA',      color: 'bg-blue-500',   tip: 'Lower travel time = higher score (40% weight)' },
  capacity: { label: 'Capacity', color: 'bg-green-500',  tip: 'ABDM: Available ICU + beds (simulated, 25% weight)' },
  trauma:   { label: 'Trauma',   color: 'bg-red-500',    tip: 'Designated trauma centre (20% weight)' },
  blood:    { label: 'Blood O-', color: 'bg-purple-500', tip: 'e-Raktkosh: O-negative units (simulated, 15% weight)' },
}

function ScoreBar({ id, value }) {
  const meta = SUB_SCORE_META[id]
  return (
    <div className="flex items-center gap-2 group relative">
      <span className="text-xs text-slate-500 w-16 shrink-0">{meta.label}</span>
      <div className="flex-1 h-1.5 bg-rapid-bg rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ${meta.color}`}
          style={{ width: `${Math.max(2, value)}%` }}
        />
      </div>
      <span className="text-xs text-slate-400 w-8 text-right">{value}</span>
      {/* tooltip */}
      <span className="absolute left-0 -top-6 z-50 hidden group-hover:block
                       bg-slate-800 text-slate-200 text-xs px-2 py-1 rounded shadow-lg whitespace-nowrap">
        {meta.tip}
      </span>
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
  const r    = 18
  const circ = 2 * Math.PI * r
  const offset = circ - (score / 100) * circ
  const color  = score >= 70 ? '#10b981' : score >= 45 ? '#f59e0b' : '#ef4444'

  return (
    <svg width="48" height="48" className="shrink-0">
      <circle cx="24" cy="24" r={r} fill="none" stroke="#2d3148" strokeWidth="3" />
      <circle
        cx="24" cy="24" r={r}
        fill="none" stroke={color} strokeWidth="3"
        strokeDasharray={circ} strokeDashoffset={offset}
        strokeLinecap="round" transform="rotate(-90 24 24)"
        style={{ transition: 'stroke-dashoffset 1s ease' }}
      />
      <text x="24" y="28" textAnchor="middle" fontSize="11" fontWeight="bold" fill={color}>
        {score}
      </text>
    </svg>
  )
}

export default function HospitalCard({ scored, hospital, assignments, rank, allScores }) {
  const [showWhy, setShowWhy] = useState(false)
  const sub = scored.sub_scores

  const myAssignments = assignments.filter(a => a.hospital === scored.name)
  const hasAssignment = myAssignments.length > 0

  // XAI: find decisive sub-score (highest weighted contribution)
  const WEIGHTS = { eta: 0.40, capacity: 0.25, trauma: 0.20, blood: 0.15 }
  const contributions = Object.entries(sub).map(([k, v]) => ({
    key: k, value: v, weighted: v * (WEIGHTS[k] || 0),
  }))
  contributions.sort((a, b) => b.weighted - a.weighted)
  const decisive = contributions[0]

  // XAI: score delta vs next-ranked hospital (if allScores available)
  const nextScore  = allScores?.[rank]?.composite_score  // rank is 1-based, array is 0-based
  const scoreDelta = nextScore != null
    ? (scored.composite_score - nextScore).toFixed(1)
    : null

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
            {hospital?.trauma_centre && (
              <span className="text-xs px-1.5 py-0.5 rounded border border-red-800 bg-red-950/50 text-red-400">
                TRAUMA
              </span>
            )}
            {hospital?.specialties?.slice(0, 2).map(s => (
              <span key={s} className="text-xs px-1.5 py-0.5 rounded border border-purple-800 bg-purple-950/50 text-purple-400">
                {s}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Sub-scores */}
      <div className="space-y-1 mb-2">
        {Object.keys(SUB_SCORE_META).map(k => (
          <ScoreBar key={k} id={k} value={sub[k]} />
        ))}
      </div>

      {/* XAI: Why this hospital? toggle */}
      <button
        type="button"
        onClick={() => setShowWhy(v => !v)}
        className="text-xs text-slate-500 hover:text-blue-400 transition-colors w-full text-left mt-1"
      >
        {showWhy ? '▲ Hide explanation' : '▼ Why this hospital?'}
      </button>

      {showWhy && (
        <div className="mt-2 p-2 rounded bg-slate-900/60 border border-slate-700 text-xs space-y-1">
          <p className="text-slate-300">
            <span className="text-blue-400 font-semibold">Decisive factor:</span>{' '}
            {SUB_SCORE_META[decisive.key]?.label} score of {decisive.value}/100
            {' '}({Math.round(decisive.weighted)}/{Math.round(WEIGHTS[decisive.key] * 100)} weighted pts)
          </p>
          {scoreDelta !== null && (
            <p className="text-slate-400">
              Ranked <span className="text-green-400 font-semibold">+{scoreDelta} pts</span> ahead of #{rank + 1}
            </p>
          )}
          {hospital?.distance_km != null && (
            <p className="text-slate-400">
              Distance: <span className="text-slate-300">{hospital.distance_km} km</span>
              {hospital?.eta_minutes != null && (
                <span className="text-slate-300"> · {hospital.eta_minutes} min</span>
              )}
              {' '}
              {hospital?.eta_source === 'ors'
                ? <span className="text-green-400">(real road traffic)</span>
                : <span className="text-amber-400">(haversine estimate)</span>}
            </p>
          )}
        </div>
      )}

      {/* Hospital saturation bar — Feature 4 */}
      {(() => {
        const icu = hospital?.capacity?.available_icu
        if (!icu || !hasAssignment) return null
        const totalAssigned = myAssignments.reduce((s, a) => s + (a.patients_assigned ?? 0), 0)
        const pct = Math.min(100, Math.round((totalAssigned / icu) * 100))
        const barColor = pct >= 80 ? 'bg-red-500' : pct >= 50 ? 'bg-amber-400' : 'bg-green-500'
        const textColor = pct >= 80 ? 'text-red-400' : pct >= 50 ? 'text-amber-400' : 'text-green-400'
        return (
          <div className="mt-2 mb-1">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] text-slate-500 uppercase tracking-wider">ICU Saturation</span>
              <span className={`text-[10px] font-black ${textColor}`}>
                {totalAssigned}/{icu} beds · {pct}%{pct >= 80 ? ' ⚠' : ''}
              </span>
            </div>
            <div className="h-1.5 bg-rapid-bg rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-700 ${barColor}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )
      })()}

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
