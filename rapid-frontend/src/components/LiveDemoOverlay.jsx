import React, { useEffect, useRef, useState } from 'react'
import { DEMO_SCENARIO } from '../demoScenario.js'

/**
 * Cinematic voice-first demo — the WOW moment.
 *
 * Plays a pre-scripted Mumbai dispatch call, animates a waveform while the
 * "transcript" streams in character-by-character, then auto-dispatches the
 * Kurla scenario. No real microphone; no real audio (browsers block autoplay
 * for clips the user didn't explicitly start, and we want a deterministic
 * demo). The illusion is cheap and the payoff is huge — judges see the full
 * voice-to-ambulances-on-map path in ~10 seconds.
 */

const SCRIPT = [
  { delay: 0,    text: 'Control, this is Unit 4 — ' },
  { delay: 900,  text: 'train derailment Kurla Station, ' },
  { delay: 2100, text: 'approximately 35 casualties, ' },
  { delay: 3300, text: 'mixed injuries, request multi-ambulance response.' },
]
const SCRIPT_TOTAL_MS = 5400

function Waveform({ running }) {
  const bars = 32
  return (
    <div
      className="flex items-end gap-[3px] h-16"
      aria-hidden="true"
      style={{ opacity: running ? 1 : 0.3, transition: 'opacity 300ms' }}
    >
      {Array.from({ length: bars }).map((_, i) => {
        const delay = (i % 8) * 60
        return (
          <div
            key={i}
            className="w-[4px] rounded-full"
            style={{
              background: 'linear-gradient(to top, #3b82f6, #38bdf8)',
              height: running ? `${30 + Math.random() * 60}%` : '18%',
              animation: running ? `rapid-wave 900ms ${delay}ms ease-in-out infinite` : 'none',
            }}
          />
        )
      })}
      <style>{`
        @keyframes rapid-wave {
          0%, 100% { transform: scaleY(0.35); }
          50%      { transform: scaleY(1.0); }
        }
      `}</style>
    </div>
  )
}

export default function LiveDemoOverlay({ onDispatch, onClose }) {
  const [phase, setPhase]         = useState('intro')   // intro | listening | transcribing | dispatching | done
  const [typed, setTyped]         = useState('')
  const timers = useRef([])

  // Full transcript used for the streaming effect
  const fullTranscript = SCRIPT.map(s => s.text).join('')

  useEffect(() => {
    function clear() {
      timers.current.forEach(clearTimeout)
      timers.current = []
    }

    // Stage the flow: 600 ms intro → "listening" with pulsing mic → stream
    // the transcript → auto-trigger dispatch → close shortly after.
    timers.current.push(setTimeout(() => setPhase('listening'),    600))
    timers.current.push(setTimeout(() => setPhase('transcribing'), 900))

    // Stream the transcript character-by-character, spaced across the script.
    const chunks = []
    let elapsed = 0
    for (const line of SCRIPT) {
      const start = Math.max(0, line.delay + 900)   // align with listening phase start
      const perChar = 22
      for (let i = 0; i < line.text.length; i++) {
        const charAt = start + i * perChar
        elapsed = Math.max(elapsed, charAt)
        chunks.push([charAt, (prev) => prev + line.text[i]])
      }
    }
    chunks.forEach(([ts, fn]) => {
      timers.current.push(setTimeout(() => setTyped(prev => fn(prev)), ts))
    })

    const dispatchAt = SCRIPT_TOTAL_MS + 1200
    timers.current.push(setTimeout(() => {
      setPhase('dispatching')
      onDispatch?.({
        lat: DEMO_SCENARIO.lat,
        lon: DEMO_SCENARIO.lon,
        patients: DEMO_SCENARIO.patients,
      })
    }, dispatchAt))

    timers.current.push(setTimeout(() => setPhase('done'), dispatchAt + 1400))
    timers.current.push(setTimeout(() => onClose?.(),     dispatchAt + 2200))

    return clear
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const typedFormatted = typed || ' '
  const caretVisible = phase === 'transcribing'

  // Simulated patient breakdown — matches DEMO_SCENARIO; used for the
  // "form is filling" UI so the audience sees the structured extraction,
  // not just raw text.
  const patientGroupsVisible = phase !== 'intro' && phase !== 'listening' && typed.length > 40
  const totalPatients = DEMO_SCENARIO.patients.reduce((s, p) => s + p.count, 0)

  return (
    <div
      className="fixed inset-0 flex flex-col bg-black/90 backdrop-blur-md"
      style={{ zIndex: 10_001 }}
      onClick={onClose}
    >
      {/* Close */}
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 text-slate-500 hover:text-slate-200 text-2xl w-10 h-10 rounded-lg hover:bg-slate-800 z-10"
        aria-label="Close demo"
      >
        ✕
      </button>

      <div className="flex-1 flex flex-col items-center justify-center px-6" onClick={(e) => e.stopPropagation()}>
        {/* Mic + waveform */}
        <div className="flex flex-col items-center gap-6 mb-10">
          <div
            className={`relative flex items-center justify-center rounded-full transition-all duration-500 ${
              phase === 'listening' || phase === 'transcribing'
                ? 'bg-red-600/90 shadow-[0_0_60px_rgba(239,68,68,0.65)]'
                : phase === 'dispatching' || phase === 'done'
                  ? 'bg-green-600/90 shadow-[0_0_60px_rgba(34,197,94,0.65)]'
                  : 'bg-slate-800'
            }`}
            style={{ width: '120px', height: '120px' }}
          >
            <span className="text-5xl">
              {phase === 'dispatching' || phase === 'done' ? '🚑' : '🎙️'}
            </span>
            {(phase === 'listening' || phase === 'transcribing') && (
              <>
                <span className="absolute inset-0 rounded-full border-2 border-red-500/60 animate-ping" />
                <span className="absolute -inset-4 rounded-full border-2 border-red-500/30 animate-ping" style={{ animationDelay: '300ms' }} />
              </>
            )}
          </div>

          <Waveform running={phase === 'listening' || phase === 'transcribing'} />

          <div className="flex items-center gap-3 text-xs font-black uppercase tracking-[0.3em]">
            {phase === 'intro' && <span className="text-slate-500">Incoming radio call…</span>}
            {phase === 'listening' && <span className="text-red-400 animate-pulse">● LIVE — Dispatcher Radio Channel 1</span>}
            {phase === 'transcribing' && <span className="text-blue-400">✦ Whisper-Large-V3 · Streaming transcript</span>}
            {phase === 'dispatching' && <span className="text-green-400 animate-pulse">→ Dispatching RAPID…</span>}
            {phase === 'done' && <span className="text-green-400">✓ Ambulances en route</span>}
          </div>
        </div>

        {/* Transcript box */}
        <div className="w-full max-w-3xl rounded-2xl border border-slate-700 bg-[#0a0c14] p-6 shadow-2xl">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[11px] font-black uppercase tracking-widest text-slate-500">
              Dispatch transcript — Unit 4
            </p>
            <span className="text-[10px] font-mono text-slate-600">EN · Whisper-Large-V3</span>
          </div>
          <p className="text-lg md:text-xl leading-relaxed text-slate-100 font-mono min-h-[4.5rem]">
            {typedFormatted}
            {caretVisible && <span className="inline-block w-2 h-5 bg-blue-400 ml-1 align-middle animate-pulse" />}
          </p>

          {/* Structured extraction strip */}
          {patientGroupsVisible && (
            <div className="mt-5 pt-5 border-t border-slate-800">
              <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2">
                Auto-extracted structured incident
              </p>
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="rounded-full border border-blue-800 bg-blue-950/50 px-2.5 py-1 text-blue-300 font-bold">
                  📍 Kurla Station · {DEMO_SCENARIO.lat.toFixed(4)}, {DEMO_SCENARIO.lon.toFixed(4)}
                </span>
                <span className="rounded-full border border-slate-700 bg-slate-900 px-2.5 py-1 text-slate-300 font-bold">
                  {totalPatients} casualties
                </span>
                {DEMO_SCENARIO.patients.filter(p => p.count > 0).map(p => (
                  <span
                    key={`${p.severity}-${p.injury_type || 'any'}`}
                    className={`rounded-full border px-2.5 py-1 font-bold ${
                      p.severity === 'critical' ? 'border-red-800 bg-red-950/50 text-red-300'
                      : p.severity === 'moderate' ? 'border-amber-800 bg-amber-950/50 text-amber-300'
                      : 'border-green-800 bg-green-950/50 text-green-300'
                    }`}
                  >
                    {p.count} {p.severity}{p.injury_type ? ` · ${p.injury_type}` : ''}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Progress dots */}
        <div className="mt-8 flex items-center gap-2 text-[10px] uppercase tracking-widest text-slate-500">
          <StepDot label="Audio" active={phase !== 'intro'} />
          <span className="text-slate-700">→</span>
          <StepDot label="Transcribe" active={phase === 'transcribing' || phase === 'dispatching' || phase === 'done'} />
          <span className="text-slate-700">→</span>
          <StepDot label="Extract" active={patientGroupsVisible} />
          <span className="text-slate-700">→</span>
          <StepDot label="Dispatch" active={phase === 'dispatching' || phase === 'done'} />
          <span className="text-slate-700">→</span>
          <StepDot label="Rolling" active={phase === 'done'} />
        </div>
      </div>
    </div>
  )
}

function StepDot({ label, active }) {
  return (
    <span className={`flex items-center gap-1 ${active ? 'text-green-300' : 'text-slate-600'}`}>
      <span
        className={`inline-block w-2 h-2 rounded-full ${
          active ? 'bg-green-400 shadow-[0_0_10px_#22c55e]' : 'bg-slate-700'
        }`}
      />
      {label}
    </span>
  )
}
