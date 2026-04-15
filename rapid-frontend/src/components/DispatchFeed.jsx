import React, { useState, useEffect, useRef } from 'react'

/* Icons per pipeline layer */
const STEP_ICONS = { 1: '🏥', 2: '🗺️', 3: '📊', 4: '🤖' }

/* Fallback simulated steps when SSE is not available */
const SIM_STEPS = [
  { step: 1, done: false, msg: () => 'Scanning hospitals within 15 km of incident…',        delay: 0    },
  { step: 1, done: true,  msg: () => 'Hospitals & agencies located.',                         delay: 700  },
  { step: 2, done: false, msg: () => 'Computing road-network ETAs via OpenRouteService…',    delay: 900  },
  { step: 2, done: true,  msg: () => 'ETA & capacity data fetched.',                          delay: 1600 },
  { step: 3, done: false, msg: () => 'Scoring hospitals — ETA · capacity · trauma · blood…', delay: 1800 },
  { step: 3, done: true,  msg: () => 'Hospitals ranked.',                                     delay: 2400 },
  { step: 4, done: false, msg: (t) => `Routing ${t} patients via Gemini AI…`,                delay: 2600 },
]

function LogLine({ icon, msg, done, animating }) {
  return (
    <div className={`flex items-start gap-3 ${animating ? 'dispatch-step-enter' : ''}`}>
      <span className={`text-base w-6 text-center shrink-0 mt-0.5 ${done === false ? 'animate-pulse' : ''}`}>
        {icon}
      </span>
      <p className={`text-xs leading-relaxed flex-1 ${done ? 'text-slate-300' : 'text-slate-500'}`}>
        {msg}
      </p>
      {done && <span className="text-green-500 text-xs shrink-0">✓</span>}
      {done === false && (
        <span className="flex gap-0.5 shrink-0 mt-1">
          {[0, 150, 300].map(d => (
            <span key={d} className="w-1 h-1 rounded-full bg-blue-400 animate-bounce"
              style={{ animationDelay: `${d}ms` }} />
          ))}
        </span>
      )}
    </div>
  )
}

export default function DispatchFeed({
  totalPatients, injuryTypes, isDone, elapsed, onDismiss,
  streamLogs = [],   // real SSE entries from backend
}) {
  const [simVisible,   setSimVisible]   = useState([])
  const [showComplete, setShowComplete] = useState(false)
  const dismissTimer = useRef(null)
  const hasRealLogs  = streamLogs.length > 0

  /* Simulated step reveal (used when SSE unavailable) */
  useEffect(() => {
    if (hasRealLogs) return
    const timers = SIM_STEPS.map((step, i) =>
      setTimeout(() => setSimVisible(prev => [...prev, i]), step.delay)
    )
    return () => timers.forEach(clearTimeout)
  }, [hasRealLogs])

  /* Completion trigger */
  useEffect(() => {
    if (!isDone) return
    if (!hasRealLogs) setSimVisible(SIM_STEPS.map((_, i) => i))
    const t = setTimeout(() => {
      setShowComplete(true)
      dismissTimer.current = setTimeout(onDismiss, 1600)
    }, hasRealLogs ? 300 : 200)
    return () => clearTimeout(t)
  }, [isDone, hasRealLogs])

  useEffect(() => () => { if (dismissTimer.current) clearTimeout(dismissTimer.current) }, [])

  /* De-dupe real SSE logs: keep last entry per step, preserving order */
  const dedupedLogs = hasRealLogs
    ? Object.values(
        streamLogs.reduce((acc, e) => { acc[e.step] = e; return acc }, {})
      )
    : []

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-[#080a0f]/90 backdrop-blur-sm" style={{ zIndex: 9999 }}>
      <div className="w-[460px] rounded-2xl border border-[#2d3148] bg-[#0d0f1a] shadow-2xl overflow-hidden">

        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 bg-[#1a1d2e] border-b border-[#2d3148]">
          <span className="text-red-400 text-xl mci-pulse">🚨</span>
          <div>
            <p className="text-sm font-black text-white uppercase tracking-widest">Dispatching RAPID</p>
            <p className="text-xs text-slate-600">
              {totalPatients} patients
              {injuryTypes.length > 0 && ` · ${injuryTypes.join(', ')}`}
            </p>
          </div>
          {!showComplete && (
            <div className="ml-auto flex gap-1">
              {[0, 150, 300].map(d => (
                <span key={d} className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce"
                  style={{ animationDelay: `${d}ms` }} />
              ))}
            </div>
          )}
        </div>

        {/* Pipeline log */}
        <div className="px-5 py-4 space-y-3">
          {hasRealLogs ? (
            dedupedLogs.map((entry, i) => (
              <LogLine
                key={i}
                icon={STEP_ICONS[entry.step] || '⚙️'}
                msg={entry.msg}
                done={entry.done}
                animating
              />
            ))
          ) : (
            SIM_STEPS.map((step, i) => (
              simVisible.includes(i) && (
                <LogLine
                  key={i}
                  icon={STEP_ICONS[step.step] || '⚙️'}
                  msg={step.msg(totalPatients, injuryTypes)}
                  done={step.done}
                  animating
                />
              )
            ))
          )}

          {/* Completion */}
          {showComplete && (
            <div className="dispatch-step-enter pt-3 border-t border-[#2d3148] flex items-center gap-3">
              <span className="text-2xl">✅</span>
              <div>
                <p className="text-sm font-black text-green-400">DISPATCH COMPLETE</p>
                <p className="text-xs text-slate-500">
                  {totalPatients} patients routed in {elapsed}s — opening results
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
