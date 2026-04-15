import React, { useState, useCallback, useRef } from 'react'

import RapidMap             from './components/Map.jsx'
import IncidentForm         from './components/IncidentForm.jsx'
import HospitalCard         from './components/HospitalCard.jsx'
import GeminiReasoningPanel from './components/GeminiReasoningPanel.jsx'
import IncidentHistory      from './components/IncidentHistory.jsx'
import DemoControls         from './components/DemoControls.jsx'
import DispatchFeed         from './components/DispatchFeed.jsx'
import MCIBanner            from './components/MCIBanner.jsx'
import GoldenHourBanner     from './components/GoldenHourBanner.jsx'
import SDGWidget            from './components/SDGWidget.jsx'
import DispatcherPanel      from './components/DispatcherPanel.jsx'

const DEFAULT_SDG_STATS = { totalPatients: 0, totalCritical: 0, totalDispatches: 0, totalElapsedMs: 0 }

function loadSdgStats() {
  try { return JSON.parse(localStorage.getItem('rapid_sdg_stats')) || DEFAULT_SDG_STATS }
  catch { return DEFAULT_SDG_STATS }
}

export default function App() {
  const [loading,       setLoading]       = useState(false)
  const [result,        setResult]        = useState(null)
  const [incident,      setIncident]      = useState(null)
  const [error,         setError]         = useState(null)
  const [forceFallback, setForceFallback] = useState(false)
  const [histRefresh,   setHistRefresh]   = useState(0)
  const [demoValues,    setDemoValues]    = useState(null)
  const [elapsed,       setElapsed]       = useState(null)
  const [mapLocation,   setMapLocation]   = useState(null)

  // Dispatch feed state
  const [dispatchDone,   setDispatchDone]   = useState(false)
  const [pendingTotal,   setPendingTotal]   = useState(0)
  const [pendingTypes,   setPendingTypes]   = useState([])
  const [streamLogs,     setStreamLogs]     = useState([])   // SSE log entries

  // SDG stats (persisted in localStorage — never reset on handleReset)
  const [sdgStats, setSdgStats] = useState(loadSdgStats)

  const [showDispatcher, setShowDispatcher] = useState(false)

  const dismissTimer = useRef(null)

  /* ── SSE streaming dispatch ──────────────────────────────────────────────── */
  const handleSubmit = useCallback(async (payload) => {
    setLoading(true)
    setError(null)
    setResult(null)
    setDispatchDone(false)
    setStreamLogs([])
    setIncident({ lat: payload.lat, lon: payload.lon })

    const total = payload.patients.reduce((s, p) => s + p.count, 0)
    const types = [...new Set(payload.patients.map(p => p.injury_type).filter(Boolean))]
    setPendingTotal(total)
    setPendingTypes(types)

    const t0 = Date.now()
    try {
      const response = await fetch('/api/incident/stream', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ...payload, force_fallback: forceFallback }),
      })

      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || `Server error ${response.status}`)
      }

      const reader  = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer    = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const messages = buffer.split('\n\n')
        buffer = messages.pop() ?? ''

        for (const msg of messages) {
          const line = msg.trim()
          if (!line.startsWith('data: ')) continue

          let data
          try { data = JSON.parse(line.slice(6)) } catch { continue }

          if (data.type === 'step') {
            setStreamLogs(prev => {
              const idx = prev.findIndex(e => e.step === data.step)
              if (idx >= 0) {
                const next = [...prev]
                next[idx] = data
                return next
              }
              return [...prev, data]
            })
          } else if (data.type === 'complete') {
            const elapsedSec = ((Date.now() - t0) / 1000).toFixed(2)
            setElapsed(elapsedSec)
            setResult(data.result)
            setDispatchDone(true)
            setHistRefresh(n => n + 1)

            const newCritical = (data.result.assignments || [])
              .filter(a => a.severity === 'critical')
              .reduce((s, a) => s + a.patients_assigned, 0)
            const newStats = {
              totalPatients:   sdgStats.totalPatients + total,
              totalCritical:   sdgStats.totalCritical + newCritical,
              totalDispatches: sdgStats.totalDispatches + 1,
              totalElapsedMs:  sdgStats.totalElapsedMs + (Date.now() - t0),
            }
            setSdgStats(newStats)
            localStorage.setItem('rapid_sdg_stats', JSON.stringify(newStats))

            dismissTimer.current = setTimeout(() => setLoading(false), 1800)
          } else if (data.type === 'error') {
            setError(data.msg)
            setLoading(false)
          }
        }
      }
    } catch (err) {
      setError(err.message || 'Request failed — is the backend running?')
      setLoading(false)
    }
  }, [forceFallback, sdgStats])

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
    setMapLocation(null)
    // sdgStats intentionally NOT reset — accumulates across session
  }

  function handleLocationSelect(coords) { setMapLocation(coords) }

  function handleFeedDismiss() {
    if (dismissTimer.current) clearTimeout(dismissTimer.current)
    setLoading(false)
  }

  // Build hospital lookup for cards
  const hospitalMap = Object.fromEntries(
    (result?.hospitals || []).map(h => [h.name, h])
  )

  const totalPatients  = result?.assignments?.reduce((s, a) => s + a.patients_assigned, 0) ?? 0
  const criticalCount  = result?.assignments?.filter(a => a.severity === 'critical')
                                             .reduce((s, a) => s + a.patients_assigned, 0) ?? 0
  const isMCI  = result ? (totalPatients >= 30 || criticalCount >= 10) : false
  const preMCI = !result && demoValues
    ? (() => {
        const t = (demoValues.patients || []).reduce((s, p) => s + p.count, 0)
        const c = (demoValues.patients || []).filter(p => p.severity === 'critical').reduce((s, p) => s + p.count, 0)
        return t >= 30 || c >= 10
      })()
    : false
  const showMCI = isMCI || preMCI

  return (
    <div className="flex flex-col h-screen bg-rapid-bg text-slate-200 overflow-hidden">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className={`flex items-center justify-between px-4 py-2.5 border-b shrink-0 transition-colors duration-700 ${
        showMCI ? 'bg-red-950/70 border-red-900' : 'bg-rapid-surface border-rapid-border'
      }`}>
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
              <button
                onClick={() => setShowDispatcher(true)}
                className="px-3 py-1 rounded-full font-black text-sm bg-blue-600 text-white border border-blue-500 hover:bg-blue-500 transition-colors shadow-lg shadow-blue-900/40"
              >
                COMMAND CENTER ↗
              </button>
            </div>
          )}
          {showMCI && (
            <span className="text-xs font-black text-red-400 mci-pulse uppercase tracking-wide">
              ⚠ MCI ACTIVE
            </span>
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

            <section>
              <IncidentForm
                onSubmit={handleSubmit}
                loading={loading}
                initialValues={demoValues}
                locationOverride={mapLocation}
              />
            </section>

            {error && (
              <div className="px-3 py-2 rounded bg-red-950/40 border border-red-800 text-xs text-red-300">
                {error}
              </div>
            )}

            <section className="pt-2 border-t border-rapid-border">
              <DemoControls
                onLoadScenario={handleLoadScenario}
                onReset={handleReset}
                forceFallback={forceFallback}
                onToggleFallback={() => setForceFallback(f => !f)}
                hasResults={!!result}
              />
            </section>

            <section className="pt-2 border-t border-rapid-border">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
                Recent Incidents
              </p>
              <IncidentHistory
                refreshKey={histRefresh}
                onReplay={inc => setIncident({ lat: inc.lat, lon: inc.lon })}
              />
            </section>

            <section className="pt-2 border-t border-rapid-border">
              <SDGWidget stats={sdgStats} />
            </section>
          </div>
        </aside>

        {/* Centre — Map */}
        <main className="flex-1 flex flex-col overflow-hidden">

          <MCIBanner isMCI={showMCI} result={result} />

          <div
            className={`flex-1 relative transition-all duration-700 ${showMCI ? 'mci-map-pulse' : ''}`}
            style={{ minHeight: 0 }}
          >
            <RapidMap incident={incident} result={result} onLocationSelect={handleLocationSelect} />

            {loading && (
              <DispatchFeed
                totalPatients={pendingTotal}
                injuryTypes={pendingTypes}
                isDone={dispatchDone}
                elapsed={elapsed}
                onDismiss={handleFeedDismiss}
                streamLogs={streamLogs}
              />
            )}
          </div>

          {result && <GoldenHourBanner result={result} />}

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
                      allScores={result.scores}
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

      {/* Dispatcher / Command Center */}
      {showDispatcher && (
        <DispatcherPanel
          result={result}
          hospitalMap={hospitalMap}
          incidentLocation={incident}
          onClose={() => setShowDispatcher(false)}
        />
      )}
    </div>
  )
}
