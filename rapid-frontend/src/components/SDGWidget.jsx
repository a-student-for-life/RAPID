import React from 'react'

function StatCell({ value, label, color }) {
  return (
    <div className="bg-rapid-bg rounded px-2 py-1.5 text-center">
      <p className={`text-sm font-black ${color}`}>{value}</p>
      <p className="text-xs text-slate-600 leading-tight">{label}</p>
    </div>
  )
}

export default function SDGWidget({ stats }) {
  const avgResponseS = stats.totalDispatches > 0
    ? ((stats.totalElapsedMs / stats.totalDispatches) / 1000).toFixed(1) + 's'
    : '—'

  // Survivability delta: Σ(minutes_delta) × 1pp/min per Lerner & Moscati 2001.
  // Positive means RAPID's routing beat the naïve closest-hospital baseline.
  const survivabilityPct = Number(stats.survivabilityPointsTotal ?? 0)
  const hasSurvivability = Math.abs(survivabilityPct) >= 0.1

  return (
    <div className="rounded-lg border border-rapid-border bg-rapid-surface/60 p-3">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
          SDG Impact
        </p>
        <div className="flex gap-1.5 items-center">
          {/* SDG 3 badge — UN official green #3F7E44 */}
          <div
            className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-white text-xs font-bold"
            style={{ backgroundColor: '#3F7E4433', border: '1px solid #3F7E44' }}
            title="SDG 3: Good Health & Well-Being"
          >
            <span>❤️</span><span style={{ color: '#6abf6e' }}>3</span>
          </div>
          {/* SDG 11 badge — UN official orange #FD6925 */}
          <div
            className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-white text-xs font-bold"
            style={{ backgroundColor: '#FD692533', border: '1px solid #FD6925' }}
            title="SDG 11: Sustainable Cities & Communities"
          >
            <span>🏙️</span><span style={{ color: '#fd9465' }}>11</span>
          </div>
        </div>
      </div>

      {/* Hero survivability stat — the one number judges should remember */}
      {hasSurvivability && (
        <div
          className={`mb-2 rounded-md px-2 py-1.5 text-center border ${
            survivabilityPct >= 0
              ? 'bg-green-950/40 border-green-800'
              : 'bg-amber-950/40 border-amber-800'
          }`}
          title="Lerner & Moscati 2001: each minute of delay drops critical-trauma survival odds by ~1 percentage point."
        >
          <p className={`text-lg font-black ${survivabilityPct >= 0 ? 'text-green-300' : 'text-amber-300'}`}>
            {survivabilityPct >= 0 ? '↑' : '↓'} {Math.abs(survivabilityPct).toFixed(1)}%
          </p>
          <p className="text-[10px] text-slate-400 leading-tight">survival odds for critical patients</p>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-1.5">
        <StatCell value={stats.totalPatients}   label="Routed"    color="text-blue-400" />
        <StatCell value={stats.totalCritical}   label="Critical"  color="text-red-400"  />
        <StatCell value={avgResponseS}          label="Avg AI"    color="text-green-400" />
      </div>

      {/* Counterfactual — RAPID vs naïve closest */}
      {stats.minutesSavedTotal !== undefined && (stats.minutesSavedTotal !== 0 || (stats.traumaSaves + stats.specialtySaves) > 0) && (
        <div className="mt-1.5 grid grid-cols-2 gap-1.5">
          <StatCell
            value={`${stats.minutesSavedTotal >= 0 ? '−' : '+'}${Math.abs(stats.minutesSavedTotal).toFixed(1)}m`}
            label="vs Naïve"
            color={stats.minutesSavedTotal >= 0 ? 'text-green-400' : 'text-amber-400'}
          />
          <StatCell
            value={(stats.traumaSaves ?? 0) + (stats.specialtySaves ?? 0)}
            label="Better Picks"
            color="text-purple-400"
          />
        </div>
      )}

      {stats.totalDispatches > 0 && (
        <p className="text-xs text-slate-600 text-center mt-1.5">
          {stats.totalDispatches} dispatch{stats.totalDispatches !== 1 ? 'es' : ''} this session
        </p>
      )}
    </div>
  )
}
