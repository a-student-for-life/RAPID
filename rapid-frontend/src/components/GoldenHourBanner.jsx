import React from 'react'

function urgencyConfig(minutesLeft) {
  if (minutesLeft > 40) return { text: 'text-green-400', bg: 'bg-green-900/30 border-green-800', label: 'SAFE' }
  if (minutesLeft > 20) return { text: 'text-amber-400', bg: 'bg-amber-900/30 border-amber-800', label: 'URGENT' }
  return { text: 'text-red-400', bg: 'bg-red-900/30 border-red-800', label: 'CRIT' }
}

function computeGoldenHour(result) {
  const hospMap = Object.fromEntries((result.hospitals || []).map(h => [h.name, h]))

  const sorted = [...(result.hospitals || [])]
    .filter(h => h.eta_minutes != null)
    .sort((a, b) => a.eta_minutes - b.eta_minutes)
  const nearestEta = sorted[0]?.eta_minutes ?? null

  const total = (result.assignments || []).reduce((s, a) => s + a.patients_assigned, 0)
  const weightedAiEta = total > 0
    ? (result.assignments || []).reduce((sum, a) => {
        const eta = hospMap[a.hospital]?.eta_minutes ?? nearestEta ?? 0
        return sum + eta * a.patients_assigned
      }, 0) / total
    : null

  const minutesSaved = (nearestEta != null && weightedAiEta != null)
    ? (nearestEta - weightedAiEta)
    : null

  const criticalRows = (result.assignments || [])
    .filter(a => a.severity === 'critical')
    .map(a => {
      const eta = hospMap[a.hospital]?.eta_minutes
      if (eta == null) return null
      return {
        hospital:    a.hospital,
        patients:    a.patients_assigned,
        eta,
        minutesLeft: Math.max(0, 60 - eta),
        injuryType:  a.injury_type,
      }
    })
    .filter(Boolean)

  return { minutesSaved, criticalRows, nearestEta }
}

export default function GoldenHourBanner({ result }) {
  if (!result) return null
  const { minutesSaved, criticalRows } = computeGoldenHour(result)
  if (criticalRows.length === 0) return null

  return (
    <div className="shrink-0 border-t border-rapid-border bg-rapid-bg flex items-center gap-3 px-4 py-1.5 overflow-x-auto">
      {/* Label + savings */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-xs font-bold text-slate-500 uppercase tracking-wide">Golden Hour</span>
        {minutesSaved != null && Math.abs(minutesSaved) > 0.5 && (
          <span className={`text-xs font-semibold ${minutesSaved > 0 ? 'text-green-400' : 'text-blue-400'}`}>
            {minutesSaved > 0
              ? `AI saved ~${minutesSaved.toFixed(1)} min`
              : 'AI chose specialty over proximity'}
          </span>
        )}
      </div>

      <span className="text-slate-700 shrink-0">|</span>

      {/* Compact pill per critical assignment */}
      <div className="flex items-center gap-2 overflow-x-auto">
        {criticalRows.map((row, i) => {
          const u = urgencyConfig(row.minutesLeft)
          const shortName = row.hospital.split(' ').slice(0, 2).join(' ')
          return (
            <div key={i} className={`shrink-0 flex items-center gap-1.5 px-2 py-0.5 rounded border text-xs ${u.bg}`}>
              <span className={`font-black ${u.text}`}>{u.label}</span>
              <span className="text-slate-300">{row.patients}×crit</span>
              {row.injuryType && <span className="text-purple-400 font-mono">[{row.injuryType}]</span>}
              <span className="text-slate-500">→</span>
              <span className="text-slate-300">{shortName}</span>
              <span className={`${u.text}`}>{row.minutesLeft.toFixed(0)}m left</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
