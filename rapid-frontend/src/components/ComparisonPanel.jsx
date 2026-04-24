import React, { useState } from 'react'

/* ── Helper: summarise a result into simple display data ─────────────────── */
function summarise(result) {
  if (!result) return null
  const assignments = result.assignments || []
  const critical = assignments.filter(a => a.severity === 'critical').reduce((s, a) => s + a.patients_assigned, 0)
  const moderate = assignments.filter(a => a.severity === 'moderate').reduce((s, a) => s + a.patients_assigned, 0)
  const minor    = assignments.filter(a => a.severity === 'minor').reduce((s, a) => s + a.patients_assigned, 0)
  const topHospital = result.scores?.[0]
  return { assignments, critical, moderate, minor, topHospital }
}

/* ── Explainer: what do these terms mean? ────────────────────────────────── */
function TermExplainer() {
  const [open, setOpen] = useState(false)
  return (
    <div className="shrink-0">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="text-xs px-3 py-1.5 rounded-lg border border-slate-600 bg-slate-800 text-slate-300
                   hover:bg-slate-700 hover:text-white transition-colors font-semibold"
      >
        {open ? 'Hide explanation ▲' : 'What do these terms mean? ▼'}
      </button>
      {open && (
        <div className="mt-2 rounded-xl border border-slate-600 bg-slate-800 px-4 py-3 text-xs text-slate-300 space-y-2 max-w-3xl">
          <div>
            <span className="text-green-400 font-black">Groq AI (Primary)</span>
            {' — '}
            RAPID's main brain. An LLM running on Groq reads the full incident — patient severities, hospital capacities,
            trauma capability, blood readiness — and writes reasoned assignments the way an experienced dispatcher would.
            It can spread patients across hospitals and explain every decision.
          </div>
          <div>
            <span className="text-amber-400 font-black">Deterministic Fallback</span>
            {' — '}
            A pure math backup that kicks in when AI is slow or unavailable. It scores each hospital on a formula
            (ETA + capacity + trauma + blood) and sends patients to the highest-scoring option. No reasoning, no
            distribution logic — fast and predictable, but rigid.
          </div>
          <div>
            <span className="text-slate-200 font-black">Why show both?</span>
            {' — '}
            So you can see exactly what the AI added over a rule-based system on the same incident. If both pick the
            same hospital, the AI's reasoning confirmed the formula. If they diverge, the AI saw something the formula
            missed (specialty match, overflow risk, etc.).
          </div>
          <hr className="border-slate-700" />
          <div className="text-slate-400 italic">
            <span className="text-white not-italic font-semibold">Naïve dispatch</span>
            {' (shown elsewhere as "vs Naïve") — '}
            the absolute simplest baseline: send every patient to the single closest hospital regardless of capacity or
            capability. RAPID compares itself to this to show how much smarter routing saves in minutes and lives.
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Column: one side of the comparison ─────────────────────────────────── */
function ComparisonColumn({ label, result, loading, color }) {
  const s = summarise(result)
  const borderColor = color === 'green'  ? 'border-green-600' :
                      color === 'amber'  ? 'border-amber-600' : 'border-slate-600'
  const textColor   = color === 'green'  ? 'text-green-400'  :
                      color === 'amber'  ? 'text-amber-400'   : 'text-slate-400'
  const bgColor     = color === 'green'  ? 'bg-[#071a0e]' :
                      color === 'amber'  ? 'bg-[#1a1200]'  : 'bg-slate-900'

  if (loading) {
    return (
      <div className={`flex-1 rounded-2xl border ${borderColor} ${bgColor} p-5 flex flex-col items-center justify-center gap-3`}>
        <div className="w-6 h-6 border-2 border-current border-t-transparent rounded-full animate-spin opacity-60" style={{ color: color === 'green' ? '#4ade80' : '#fbbf24' }} />
        <p className="text-xs text-slate-400">Running fallback…</p>
      </div>
    )
  }

  if (!result) {
    return (
      <div className={`flex-1 rounded-2xl border border-slate-700 bg-slate-900 p-5 flex items-center justify-center`}>
        <p className="text-xs text-slate-500">No result</p>
      </div>
    )
  }

  return (
    <div className={`flex-1 rounded-2xl border ${borderColor} ${bgColor} p-5 flex flex-col gap-3 overflow-y-auto`}>
      {/* Header badge */}
      <div className={`flex items-center gap-2 px-3 py-2 rounded-xl border ${borderColor} bg-black/30`}>
        <span className={`text-lg ${textColor}`}>
          {color === 'green' ? '✦' : '⚡'}
        </span>
        <div>
          <p className={`text-sm font-black ${textColor}`}>{label}</p>
          <p className="text-xs text-slate-400">{result.elapsed_s ?? '?'}s response</p>
        </div>
        <div className="ml-auto text-right">
          <p className="text-xs text-slate-400">Hospitals</p>
          <p className={`text-sm font-black ${textColor}`}>{result.scores?.length ?? 0}</p>
        </div>
      </div>

      {/* Patient distribution */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-xl bg-red-950/70 border border-red-800 p-2 text-center">
          <p className="text-xl font-black text-red-300">{s.critical}</p>
          <p className="text-[10px] text-slate-400">critical</p>
        </div>
        <div className="rounded-xl bg-amber-950/60 border border-amber-800 p-2 text-center">
          <p className="text-xl font-black text-amber-300">{s.moderate}</p>
          <p className="text-[10px] text-slate-400">moderate</p>
        </div>
        <div className="rounded-xl bg-green-950/60 border border-green-800 p-2 text-center">
          <p className="text-xl font-black text-green-300">{s.minor}</p>
          <p className="text-[10px] text-slate-400">minor</p>
        </div>
      </div>

      {/* Top hospital */}
      {s.topHospital && (
        <div className="rounded-xl bg-slate-800 border border-slate-600 px-3 py-2">
          <p className="text-[10px] text-slate-400 uppercase tracking-wider mb-1">Top Ranked</p>
          <div className="flex items-center gap-2">
            <span className="text-2xl font-black text-white">{s.topHospital.composite_score}</span>
            <p className="text-xs font-bold text-slate-200 leading-tight">{s.topHospital.name}</p>
          </div>
        </div>
      )}

      {/* Assignments */}
      <div className="space-y-1.5">
        <p className="text-[10px] text-slate-400 uppercase tracking-wider">Assignments</p>
        {s.assignments.map((a, i) => (
          <div key={i} className={`rounded-xl px-3 py-2 border text-xs ${
            a.severity === 'critical' ? 'border-red-800 bg-red-950/60 text-red-200' :
            a.severity === 'moderate' ? 'border-amber-800 bg-amber-950/50 text-amber-200' :
                                        'border-green-800 bg-green-950/50 text-green-200'
          }`}>
            <div className="flex items-center justify-between mb-0.5">
              <span className="font-black">{a.patients_assigned} {a.severity}</span>
              <span className="text-slate-300 text-[10px] truncate max-w-[120px]">{a.hospital}</span>
            </div>
            {a.reason && (
              <p className="text-[10px] text-slate-300 leading-tight line-clamp-2">{a.reason}</p>
            )}
          </div>
        ))}
      </div>

      {/* Reasoning */}
      {result.reasoning && (
        <div className="rounded-xl bg-slate-800 border border-slate-600 px-3 py-2">
          <p className="text-[10px] text-slate-400 uppercase tracking-wider mb-1">Reasoning</p>
          <p className="text-xs text-slate-200 leading-relaxed line-clamp-5">{result.reasoning}</p>
        </div>
      )}
    </div>
  )
}

/* ── Delta badge: show differences between AI and Fallback ───────────────── */
function DeltaBanner({ aiResult, fallbackResult }) {
  if (!aiResult || !fallbackResult) return null

  const aiTop       = aiResult.scores?.[0]?.name
  const fallTop     = fallbackResult.scores?.[0]?.name
  const sameTop     = aiTop === fallTop
  const aiHospitals = new Set((aiResult.assignments || []).map(a => a.hospital))
  const fbHospitals = new Set((fallbackResult.assignments || []).map(a => a.hospital))
  const shared      = [...aiHospitals].filter(h => fbHospitals.has(h))
  const aiOnly      = [...aiHospitals].filter(h => !fbHospitals.has(h))
  const fbOnly      = [...fbHospitals].filter(h => !aiHospitals.has(h))

  return (
    <div className="rounded-2xl border border-slate-600 bg-slate-800 px-5 py-3 flex flex-col gap-1.5 shrink-0">
      <p className="text-xs font-black text-slate-300 uppercase tracking-widest mb-1">Delta Analysis</p>
      <div className="flex flex-wrap gap-2">
        {sameTop ? (
          <span className="text-xs px-2 py-0.5 rounded-full border border-green-700 bg-green-900/60 text-green-300 font-bold">
            ✓ Same top hospital: {aiTop}
          </span>
        ) : (
          <span className="text-xs px-2 py-0.5 rounded-full border border-orange-700 bg-orange-900/60 text-orange-300 font-bold">
            ⚠ Top hospital differs: AI→{aiTop} · Fallback→{fallTop}
          </span>
        )}
        {aiOnly.length > 0 && (
          <span className="text-xs px-2 py-0.5 rounded-full border border-green-700 bg-green-900/40 text-green-300">
            AI-only: {aiOnly.join(', ')}
          </span>
        )}
        {fbOnly.length > 0 && (
          <span className="text-xs px-2 py-0.5 rounded-full border border-amber-700 bg-amber-900/40 text-amber-300">
            Fallback-only: {fbOnly.join(', ')}
          </span>
        )}
        {shared.length > 0 && (
          <span className="text-xs px-2 py-0.5 rounded-full border border-slate-600 bg-slate-700 text-slate-300">
            Shared: {shared.length} hospital{shared.length !== 1 ? 's' : ''}
          </span>
        )}
        <span className="text-xs px-2 py-0.5 rounded-full border border-slate-600 bg-slate-700/50 text-slate-400">
          AI: {aiResult.elapsed_s ?? '?'}s · Fallback: {fallbackResult.elapsed_s ?? '?'}s
        </span>
      </div>
    </div>
  )
}

/* ── Main panel ──────────────────────────────────────────────────────────── */
export default function ComparisonPanel({ aiResult, fallbackResult, fallbackLoading, onClose }) {
  return (
    <div
      className="fixed inset-0 flex flex-col bg-[#08090f] p-6 gap-4 overflow-hidden"
      style={{ zIndex: 10000 }}
    >
      {/* Header */}
      <div className="flex items-start justify-between shrink-0 gap-4">
        <div className="flex-1 min-w-0">
          <p className="text-lg font-black text-white tracking-wider uppercase">AI vs Fallback Comparison</p>
          <p className="text-xs text-slate-400">Same incident · Same data · Different decision engines</p>
          <div className="mt-2">
            <TermExplainer />
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-slate-500 hover:text-slate-200 transition-colors text-2xl w-8 h-8 shrink-0
                     flex items-center justify-center rounded-lg hover:bg-slate-700"
        >
          ✕
        </button>
      </div>

      {/* Delta */}
      {!fallbackLoading && fallbackResult && (
        <DeltaBanner aiResult={aiResult} fallbackResult={fallbackResult} />
      )}

      {/* Columns */}
      <div className="flex gap-4 flex-1 overflow-hidden min-h-0">
        <ComparisonColumn
          label="Groq AI (Primary)"
          result={aiResult}
          loading={false}
          color="green"
        />
        <ComparisonColumn
          label="Deterministic Fallback"
          result={fallbackResult}
          loading={fallbackLoading}
          color="amber"
        />
      </div>
    </div>
  )
}
