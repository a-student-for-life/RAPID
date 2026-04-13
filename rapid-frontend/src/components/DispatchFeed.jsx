import React, { useState, useEffect, useRef } from 'react'

const STEPS = [
  { icon: '🔍', text: () => 'Locating hospitals within 15 km of incident…',          delay: 0    },
  { icon: '🗺️', text: () => 'Computing road-network ETAs via OpenRouteService…',     delay: 600  },
  { icon: '🤖', text: (t) => `Gemini AI analyzing ${t} casualties…`,                  delay: 1300 },
  { icon: '🩺', text: (_, types) => types.length
      ? `Matching specialty centers: ${types.join(', ')}…`
      : 'Matching hospital capabilities to patient needs…',                            delay: 2100 },
  { icon: '⚡', text: () => 'Ranking hospitals by composite score…',                  delay: 2700 },
]

function StepLine({ step, visible, totalPatients, injuryTypes }) {
  const text = step.text(totalPatients, injuryTypes)
  if (!visible) return (
    <div className="flex items-center gap-2.5 opacity-20">
      <span className="text-base w-6 text-center">{step.icon}</span>
      <p className="text-xs text-slate-500">{text}</p>
    </div>
  )
  return (
    <div className="flex items-center gap-2.5 dispatch-step-enter">
      <span className="text-base w-6 text-center">{step.icon}</span>
      <p className="text-xs text-slate-300">{text}</p>
      <span className="ml-auto text-green-500 text-xs">✓</span>
    </div>
  )
}

export default function DispatchFeed({ totalPatients, injuryTypes, isDone, elapsed, onDismiss }) {
  const [visibleSteps, setVisibleSteps] = useState([])
  const [showComplete, setShowComplete] = useState(false)
  const dismissTimer = useRef(null)

  useEffect(() => {
    const timers = STEPS.map((step, i) =>
      setTimeout(() => setVisibleSteps(prev => [...prev, i]), step.delay)
    )
    return () => timers.forEach(clearTimeout)
  }, [])

  useEffect(() => {
    if (isDone) {
      // Flush any remaining pending steps immediately
      setVisibleSteps([0, 1, 2, 3, 4])
      // Brief pause then show completion
      const t = setTimeout(() => {
        setShowComplete(true)
        dismissTimer.current = setTimeout(onDismiss, 1400)
      }, 200)
      return () => clearTimeout(t)
    }
  }, [isDone])

  useEffect(() => {
    return () => { if (dismissTimer.current) clearTimeout(dismissTimer.current) }
  }, [])

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-[#0f1117]/88 z-50 backdrop-blur-sm">
      <div className="w-[420px] rounded-xl border border-rapid-border bg-rapid-surface p-5 shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-2.5 mb-4 pb-3 border-b border-rapid-border">
          <span className="text-red-400 text-xl mci-pulse">🚨</span>
          <p className="text-sm font-black text-white uppercase tracking-widest">Dispatching RAPID</p>
          {!showComplete && (
            <div className="ml-auto flex gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          )}
        </div>

        {/* Steps */}
        <div className="space-y-2.5">
          {STEPS.map((step, i) => (
            <StepLine
              key={i}
              step={step}
              visible={visibleSteps.includes(i)}
              totalPatients={totalPatients}
              injuryTypes={injuryTypes}
            />
          ))}

          {/* Completion line */}
          {showComplete && (
            <div className="dispatch-step-enter mt-3 pt-3 border-t border-rapid-border flex items-center gap-2.5">
              <span className="text-base w-6 text-center text-green-400">✅</span>
              <p className="text-xs font-bold text-green-400">
                DISPATCH COMPLETE — {totalPatients} patients routed in {elapsed}s
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
