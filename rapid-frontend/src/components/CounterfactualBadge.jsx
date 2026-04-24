import React from 'react'

/**
 * Counterfactual Dispatch Scoreboard
 * Shows how RAPID's routing decision compares to a naive "closest hospital" baseline.
 * Fed by `result.counterfactual` produced by services/counterfactual.py.
 */
export default function CounterfactualBadge({ cf }) {
  if (!cf) return null

  const saved = Number(cf.minutes_delta ?? 0)
  const savedTotal = Number(cf.minutes_saved_total ?? 0)
  const goldenDelta = Number(cf.critical_in_golden_hour_delta ?? 0)
  const samePick = cf.rapid_top_hospital && cf.rapid_top_hospital === cf.naive_top_hospital

  const tone =
    saved > 0.1 ? 'text-green-400 border-green-700 bg-green-950/30'
    : saved < -0.1 ? 'text-amber-400 border-amber-700 bg-amber-950/30'
    : 'text-slate-300 border-slate-700 bg-slate-900/40'

  const headline =
    saved > 0.1 ? `−${saved.toFixed(1)} min vs naïve`
    : saved < -0.1 ? `+${Math.abs(saved).toFixed(1)} min (specialty priority)`
    : 'matched naïve timing'

  return (
    <div className={`px-3 py-2 rounded border ${tone}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide opacity-80">
            vs. Naïve Dispatch
          </p>
          <p className="text-sm font-black leading-tight mt-0.5">{headline}</p>
        </div>
        {savedTotal !== 0 && (
          <div className="text-right shrink-0">
            <p className="text-[10px] uppercase tracking-wide opacity-70">Patient-min</p>
            <p className="text-sm font-black">
              {savedTotal > 0 ? '−' : '+'}{Math.abs(savedTotal).toFixed(1)}
            </p>
          </div>
        )}
      </div>

      {/* Hospital comparison */}
      {!samePick && cf.rapid_top_hospital && cf.naive_top_hospital && (
        <div className="mt-1.5 grid grid-cols-2 gap-1.5 text-xs">
          <div className="px-1.5 py-1 rounded bg-green-950/40 border border-green-900">
            <p className="text-[10px] text-green-500 uppercase tracking-wide">RAPID</p>
            <p className="text-xs font-semibold text-green-300 truncate">{cf.rapid_top_hospital}</p>
          </div>
          <div className="px-1.5 py-1 rounded bg-slate-900/40 border border-slate-800">
            <p className="text-[10px] text-slate-500 uppercase tracking-wide">Naïve</p>
            <p className="text-xs font-semibold text-slate-400 truncate">{cf.naive_top_hospital}</p>
          </div>
        </div>
      )}

      {samePick && (
        <p className="text-xs text-slate-500 mt-1">
          Same pick as naïve ({cf.rapid_top_hospital}) — scoring agreed.
        </p>
      )}

      {/* Badges */}
      <div className="flex flex-wrap gap-1 mt-1.5">
        {cf.trauma_preserved && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-950/60 border border-red-800 text-red-300 font-bold">
            TRAUMA CENTRE PRESERVED
          </span>
        )}
        {cf.specialty_preserved && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-950/60 border border-purple-800 text-purple-300 font-bold">
            SPECIALTY MATCH KEPT
          </span>
        )}
        {goldenDelta > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-950/60 border border-amber-800 text-amber-300 font-bold">
            +{goldenDelta} CRITICAL IN GOLDEN HOUR
          </span>
        )}
      </div>
    </div>
  )
}
