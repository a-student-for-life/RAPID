import React, { lazy, Suspense, useEffect, useRef, useState, useCallback } from 'react'

import IncidentForm      from './components/IncidentForm.jsx'
import HospitalCard      from './components/HospitalCard.jsx'
import AIReasoningPanel  from './components/AIReasoningPanel.jsx'
import IncidentHistory   from './components/IncidentHistory.jsx'
import DemoControls      from './components/DemoControls.jsx'
import DispatchFeed      from './components/DispatchFeed.jsx'
import MCIBanner         from './components/MCIBanner.jsx'
import GoldenHourBanner  from './components/GoldenHourBanner.jsx'
import SDGWidget         from './components/SDGWidget.jsx'
import { DEMO_SCENARIO } from './demoScenario.js'
import { AUTO_DEMO_ENABLED } from './lib/appConfig.js'
import { buildRerouteConfirmationMessage, getConsensusPatientGroups } from './lib/sceneIntel.js'

const RapidMap = lazy(() => import('./components/Map.jsx'))
const DispatcherPanel = lazy(() => import('./components/DispatcherPanel.jsx'))
const ComparisonPanel = lazy(() => import('./components/ComparisonPanel.jsx'))

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

  const [showDispatcher,    setShowDispatcher]    = useState(false)
  const [showComparison,    setShowComparison]    = useState(false)
  const [comparisonResult,  setComparisonResult]  = useState(null)
  const [comparisonLoading, setComparisonLoading] = useState(false)
  const [systemStatus,      setSystemStatus]      = useState(null)
  const [sceneIntel,        setSceneIntel]        = useState(null)  // aggregated scene reports

  const dismissTimer    = useRef(null)
  const autoRan         = useRef(false)
  const handleSubmitRef = useRef(null)

  /* ── System status (provider pill) ──────────────────────────────────────── */
  useEffect(() => {
    fetch('/api/system-status')
      .then(r => r.json())
      .then(setSystemStatus)
      .catch(() => {})
  }, [])

  /* ── Scene intel polling — runs whenever a dispatched incident is active ─── */
  useEffect(() => {
    if (!result?.incident_id) { setSceneIntel(null); return }
    const id = result.incident_id

    async function poll() {
      try {
        const res = await fetch(`/api/scene-assessments/${id}`)
        if (!res.ok) return
        const data = await res.json()
        setSceneIntel(data.aggregated?.report_count > 0 ? data.aggregated : null)
      } catch {}
    }

    poll()                                          // immediate first fetch
    const interval = setInterval(poll, 5000)        // then every 5 s
    return () => clearInterval(interval)
  }, [result?.incident_id])

  /* ── Auto-demo: load Kurla scenario + dispatch after 1.5s ───────────────── */
  useEffect(() => {
    if (!AUTO_DEMO_ENABLED || autoRan.current) return
    autoRan.current = true
    setDemoValues(DEMO_SCENARIO)
    const timer = setTimeout(() => {
      if (handleSubmitRef.current) {
        handleSubmitRef.current({
          lat:      DEMO_SCENARIO.lat,
          lon:      DEMO_SCENARIO.lon,
          patients: DEMO_SCENARIO.patients,
        })
      }
    }, 1500)
    return () => clearTimeout(timer)
  }, [])

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

  // Keep ref in sync so the auto-demo effect always calls the latest version
  handleSubmitRef.current = handleSubmit

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
    setSceneIntel(null)
    // sdgStats intentionally NOT reset — accumulates across session
  }

  async function handleRerunWithSceneData(sceneSummary, lat, lon) {
    const sceneLat = lat ?? incident?.lat
    const sceneLon = lon ?? incident?.lon
    if (!sceneLat || !sceneLon || !result?.incident_id) return

    const patientGroups = getConsensusPatientGroups(sceneSummary)
    const patients = patientGroups
      .filter(pg => pg.count > 0)
      .map(pg => ({ severity: pg.severity, count: pg.count, injury_type: pg.injury_type ?? null }))
    if (!patients.length) return
    setPendingTotal(patients.reduce((sum, patient) => sum + patient.count, 0))
    setPendingTypes([...new Set(patients.map(patient => patient.injury_type).filter(Boolean))])

    const confirmed = window.confirm(
      buildRerouteConfirmationMessage(sceneSummary, result?.assignments || []),
    )
    if (!confirmed) return

    setLoading(true)
    setError(null)
    setDispatchDone(false)
    setStreamLogs([{ type: 'step', step: 1, done: false, msg: 'Re-routing from confirmed scene reports...' }])

    try {
      const response = await fetch(`/api/incidents/${result.incident_id}/reroute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lat: sceneLat,
          lon: sceneLon,
          patients,
          force_fallback: forceFallback,
          confirm_consensus: true,
          source: 'scene_consensus',
          reason: 'Dispatcher confirmed reroute from crew scene reports.',
          report_count: sceneSummary?.report_count ?? null,
        }),
      })

      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || `Server error ${response.status}`)
      }

      const data = await response.json()
      setIncident({ lat: sceneLat, lon: sceneLon })
      setDemoValues({ lat: sceneLat, lon: sceneLon, patients })
      setResult(data)
      setElapsed(Number(data.elapsed_s || 0).toFixed(2))
      setDispatchDone(true)
      setShowDispatcher(false)
      setHistRefresh(n => n + 1)
      setStreamLogs([{ type: 'step', step: 1, done: true, msg: 'Reroute complete from confirmed scene reports.' }])
    } catch (err) {
      setError(err.message || 'Reroute failed')
    } finally {
      setLoading(false)
    }
  }

  async function handleCompare() {
    if (!incident || !result) return
    setShowComparison(true)
    setComparisonResult(null)
    setComparisonLoading(true)
    try {
      const payload = {
        lat:           incident.lat,
        lon:           incident.lon,
        patients:      (result.assignments || []).map(a => ({
          severity:    a.severity,
          count:       a.patients_assigned,
          injury_type: a.injury_type ?? null,
        })),
        force_fallback: true,
      }
      const response = await fetch('/api/incident/stream', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      })
      if (!response.ok) throw new Error(`Server error ${response.status}`)
      const reader  = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
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
          if (data.type === 'complete') {
            setComparisonResult(data.result)
          }
        }
      }
    } catch {}
    finally { setComparisonLoading(false) }
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
  const sceneConsensusGroups = getConsensusPatientGroups(sceneIntel)

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
          {/* Provider status pill */}
          {systemStatus && (
            <span className={`text-xs px-2 py-0.5 rounded-full border font-mono hidden sm:inline ${
              systemStatus.map_provider === 'google'
                ? 'text-green-400 border-green-800 bg-green-950/30'
                : 'text-slate-400 border-slate-700 bg-slate-900/30'
            }`}>
              {systemStatus.map_provider === 'google' ? '● Google APIs' : '● OSS Mode'}
            </span>
          )}

          {result && (
            <div className="flex items-center gap-2 text-xs">
              <span className={`px-2 py-0.5 rounded-full font-semibold ${
                result.decision_path === 'groq'
                  ? 'bg-green-900/50 text-green-300 border border-green-700'
                  : result.decision_path === 'gemini' || result.decision_path === 'AI'
                  ? 'bg-blue-900/50 text-blue-300 border border-blue-700'
                  : 'bg-amber-900/50 text-amber-300 border border-amber-700'
              }`}>
                {result.decision_path === 'groq'   ? '✦ Groq AI'
                 : result.decision_path === 'gemini' || result.decision_path === 'AI' ? '✦ Gemini AI'
                 : '⚡ Fallback'}
              </span>
              <span className="text-slate-500">{elapsed}s · {totalPatients} routed</span>
              <button
                onClick={() => setShowDispatcher(true)}
                className="relative px-3 py-1 rounded-full font-black text-sm bg-blue-600 text-white border border-blue-500 hover:bg-blue-500 transition-colors shadow-lg shadow-blue-900/40"
              >
                COMMAND CENTER ↗
                {sceneIntel?.report_count > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full
                                   bg-purple-500 border border-purple-300 text-[10px] font-black text-white
                                   flex items-center justify-center leading-none animate-pulse">
                    {sceneIntel.report_count}
                  </span>
                )}
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
                onCompare={result ? handleCompare : null}
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
            <Suspense fallback={<div className="absolute inset-0 grid place-items-center text-sm text-slate-500">Loading map...</div>}>
              <RapidMap incident={incident} result={result} onLocationSelect={handleLocationSelect} />
            </Suspense>

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

          {/* Scene Intelligence Banner — appears when crew scene reports arrive */}
          {result && sceneIntel?.report_count > 0 && (() => {
            // Compute delta: scene numbers vs. original dispatch numbers
            const origByType = {}
            ;(result.assignments || []).forEach(a => {
              origByType[a.severity] = (origByType[a.severity] || 0) + (a.patients_assigned || 0)
            })
            return (
              <div className="shrink-0 border-t-2 border-purple-700 bg-purple-950/25 px-4 py-2.5">
                <div className="flex items-center gap-4">
                  {/* Label */}
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-purple-400 text-base">🔬</span>
                    <div>
                      <p className="text-xs font-black text-purple-300 leading-tight">
                        Scene Intelligence · {sceneIntel.report_count} crew report{sceneIntel.report_count !== 1 ? 's' : ''}
                      </p>
                      <p className="text-[10px] leading-tight">
                        <span className={
                          sceneIntel.confidence === 'HIGH'   ? 'text-green-400 font-bold' :
                          sceneIntel.confidence === 'MEDIUM' ? 'text-amber-400 font-bold' :
                                                               'text-slate-500'
                        }>{sceneIntel.confidence} CONFIDENCE</span>
                        {sceneIntel.total_estimated != null && (
                          <span className="text-slate-500"> · ~{sceneIntel.total_estimated} on scene</span>
                        )}
                      </p>
                    </div>
                  </div>

                  {/* Original → Scene comparison */}
                  <div className="flex items-center gap-1.5 flex-1 min-w-0 flex-wrap">
                      {['critical', 'moderate', 'minor'].map(sev => {
                        const scenePg  = sceneConsensusGroups?.find(p => p.severity === sev)
                      const sceneN   = scenePg?.count ?? 0
                      const origN    = origByType[sev] ?? 0
                      const delta    = sceneN - origN
                      if (sceneN === 0 && origN === 0) return null
                      const sevColor = sev === 'critical'
                        ? 'border-red-800 bg-red-950/60 text-red-300'
                        : sev === 'moderate'
                        ? 'border-amber-800 bg-amber-950/60 text-amber-300'
                        : 'border-green-800 bg-green-950/60 text-green-300'
                      return (
                        <span key={sev} className={`text-xs px-2 py-0.5 rounded-full border font-bold flex items-center gap-1 ${sevColor}`}>
                          {sceneN} {sev}
                          {delta !== 0 && (
                            <span className={`text-[10px] font-black ${delta > 0 ? 'text-orange-400' : 'text-green-400'}`}>
                              {delta > 0 ? `+${delta}` : delta}
                            </span>
                          )}
                        </span>
                      )
                    })}
                    {sceneIntel.hazard_flags?.length > 0 && (
                      <span className="text-xs text-red-400 truncate ml-1">
                        ⚠ {sceneIntel.hazard_flags.slice(0, 2).join(' · ')}
                      </span>
                    )}
                  </div>

                  {/* Rerun button */}
                  <button
                    onClick={() => handleRerunWithSceneData(sceneIntel, incident?.lat, incident?.lon)}
                    className="shrink-0 px-3 py-1.5 rounded-lg bg-purple-700 hover:bg-purple-600 active:bg-purple-800
                               text-white text-xs font-black transition-all shadow shadow-purple-900/40 whitespace-nowrap"
                  >
                    🔄 RERUN WITH SCENE DATA
                  </button>
                </div>

                {/* Explanation line */}
                <p className="text-[10px] text-slate-600 mt-1 leading-tight">
                  Routing used estimated counts. Re-routing now requires explicit dispatcher confirmation
                  before applying the cross-crew consensus.
                </p>
              </div>
            )
          })()}

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

        {/* Right panel — AI reasoning */}
        <aside className="w-72 shrink-0 border-l border-rapid-border bg-rapid-surface overflow-hidden">
          <div className="px-3 py-2 border-b border-rapid-border">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
              AI Decision Reasoning
            </p>
          </div>
          <div className="h-full overflow-y-auto pb-12">
            <AIReasoningPanel result={result} elapsed={elapsed} />
          </div>
        </aside>

      </div>

      {/* Dispatcher / Command Center */}
      {showDispatcher && (
        <Suspense fallback={<div className="fixed inset-0 z-[9999] grid place-items-center bg-[#06080e]/96 text-sm text-slate-400">Loading command center...</div>}>
          <DispatcherPanel
            result={result}
            hospitalMap={hospitalMap}
            incidentLocation={incident}
            onClose={() => setShowDispatcher(false)}
            onRerunWithSceneData={handleRerunWithSceneData}
          />
        </Suspense>
      )}

      {/* AI vs Fallback Comparison */}
      {showComparison && (
        <Suspense fallback={<div className="fixed inset-0 z-[9999] grid place-items-center bg-[#06080e]/96 text-sm text-slate-400">Loading comparison...</div>}>
          <ComparisonPanel
            aiResult={result}
            fallbackResult={comparisonResult}
            fallbackLoading={comparisonLoading}
            onClose={() => setShowComparison(false)}
          />
        </Suspense>
      )}
    </div>
  )
}
