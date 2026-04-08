import React, { useState, useCallback } from 'react'
import axios from 'axios'

import RapidMap            from './components/Map.jsx'
import IncidentForm        from './components/IncidentForm.jsx'
import HospitalCard        from './components/HospitalCard.jsx'
import GeminiReasoningPanel from './components/GeminiReasoningPanel.jsx'
import IncidentHistory     from './components/IncidentHistory.jsx'
import DemoControls        from './components/DemoControls.jsx'

export default function App() {
  const [loading,       setLoading]       = useState(false)
  const [result,        setResult]        = useState(null)
  const [incident,      setIncident]      = useState(null)
  const [error,         setError]         = useState(null)
  const [forceFallback, setForceFallback] = useState(false)
  const [histRefresh,   setHistRefresh]   = useState(0)
  const [demoValues,    setDemoValues]    = useState(null)
  const [elapsed,       setElapsed]       = useState(null)

  const handleSubmit = useCallback(async (payload) => {
    setLoading(true)
    setError(null)
    setResult(null)
    setIncident({ lat: payload.lat, lon: payload.lon })

    try {
      const t0  = Date.now()
      const res = await axios.post('/api/incident', {
        ...payload,
        force_fallback: forceFallback,
      })
      setElapsed(((Date.now() - t0) / 1000).toFixed(2))
      setResult(res.data)
      setHistRefresh(n => n + 1)
    } catch (err) {
      setError(
        err.response?.data?.detail
          || err.message
          || 'Request failed — is the backend running?',
      )
    } finally {
      setLoading(false)
    }
  }, [forceFallback])

  function handleLoadScenario(scenario) {
    setDemoValues(scenario)
    setResult(null)
    setError(null)
    setIncident(null)
  }

  function handleReset() {
    setResult(null)
    setIncident(null)
    setError(null)
    setDemoValues(null)
  }

  // Build hospital lookup for cards
  const hospitalMap = Object.fromEntries(
    (result?.hospitals || []).map(h => [h.name, h])
  )

  const totalPatients = result?.assignments?.reduce((s, a) => s + a.patients_assigned, 0) ?? 0

  return (
    <div className="flex flex-col h-screen bg-rapid-bg text-slate-200 overflow-hidden">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between px-4 py-2.5 border-b border-rapid-border bg-rapid-surface shrink-0">
        <div className="flex items-center gap-2.5">
          <span className="text-2xl">🚑</span>
          <div>
            <h1 className="text-base font-black tracking-tight text-white">RAPID</h1>
            <p className="text-xs text-slate-500 leading-tight">Real-time AI Patient Incident Dispatcher</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {result && (
            <div className="flex items-center gap-2 text-xs">
              <span className={`px-2 py-0.5 rounded-full font-semibold ${
                result.decision_path === 'AI'
                  ? 'bg-green-900/50 text-green-300 border border-green-700'
                  : 'bg-amber-900/50 text-amber-300 border border-amber-700'
              }`}>
                {result.decision_path === 'AI' ? '✦ Gemini AI' : '⚡ Fallback'}
              </span>
              <span className="text-slate-500">{elapsed}s · {totalPatients} routed</span>
            </div>
          )}
          <a
            href="/docs"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-slate-600 hover:text-blue-400 transition-colors"
          >
            API docs →
          </a>
        </div>
      </header>

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* Left sidebar */}
        <aside className="w-72 shrink-0 flex flex-col border-r border-rapid-border overflow-y-auto">
          <div className="p-3 space-y-4">

            {/* Dispatch form */}
            <section>
              <IncidentForm
                onSubmit={handleSubmit}
                loading={loading}
                initialValues={demoValues}
              />
            </section>

            {error && (
              <div className="px-3 py-2 rounded bg-red-950/40 border border-red-800 text-xs text-red-300">
                {error}
              </div>
            )}

            {/* Demo controls */}
            <section className="pt-2 border-t border-rapid-border">
              <DemoControls
                onLoadScenario={handleLoadScenario}
                onReset={handleReset}
                forceFallback={forceFallback}
                onToggleFallback={() => setForceFallback(f => !f)}
                hasResults={!!result}
              />
            </section>

            {/* Incident history */}
            <section className="pt-2 border-t border-rapid-border">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
                Recent Incidents
              </p>
              <IncidentHistory
                refreshKey={histRefresh}
                onReplay={inc => setIncident({ lat: inc.lat, lon: inc.lon })}
              />
            </section>
          </div>
        </aside>

        {/* Centre — Map */}
        <main className="flex-1 flex flex-col overflow-hidden">

          {/* Map */}
          <div className="flex-1 relative" style={{ minHeight: 0 }}>
            <RapidMap incident={incident} result={result} />

            {loading && (
              <div className="absolute inset-0 flex items-center justify-center bg-rapid-bg/70 z-50">
                <div className="text-center">
                  <div className="text-4xl mb-3">🚨</div>
                  <p className="text-white font-bold text-lg">Dispatching RAPID…</p>
                  <p className="text-slate-400 text-sm mt-1">Contacting Gemini AI</p>
                </div>
              </div>
            )}
          </div>

          {/* Hospital cards strip */}
          {result && (
            <div className="h-52 shrink-0 border-t border-rapid-border bg-rapid-surface overflow-x-auto overflow-y-hidden">
              <div className="flex gap-3 p-3 h-full">
                {result.scores.map((scored, i) => (
                  <div key={scored.name} className="w-64 shrink-0 h-full overflow-y-auto">
                    <HospitalCard
                      scored={scored}
                      hospital={hospitalMap[scored.name]}
                      assignments={result.assignments}
                      rank={i + 1}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </main>

        {/* Right panel — Gemini reasoning */}
        <aside className="w-72 shrink-0 border-l border-rapid-border bg-rapid-surface overflow-hidden">
          <div className="px-3 py-2 border-b border-rapid-border">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
              AI Decision Reasoning
            </p>
          </div>
          <div className="h-full overflow-y-auto pb-12">
            <GeminiReasoningPanel result={result} elapsed={elapsed} />
          </div>
        </aside>

      </div>
    </div>
  )
}
