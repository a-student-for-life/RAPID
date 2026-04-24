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
import PrepositioningPanel from './components/PrepositioningPanel.jsx'
import BystanderInbox    from './components/BystanderInbox.jsx'
import { DEMO_SCENARIO } from './demoScenario.js'
import { AUTO_DEMO_ENABLED } from './lib/appConfig.js'
import { getConsensusPatientGroups } from './lib/sceneIntel.js'

const RapidMap = lazy(() => import('./components/Map.jsx'))
const DispatcherPanel = lazy(() => import('./components/DispatcherPanel.jsx'))
const ComparisonPanel = lazy(() => import('./components/ComparisonPanel.jsx'))
const WhatsAppSimulator = lazy(() => import('./components/WhatsAppSimulator.jsx'))

const DEFAULT_SDG_STATS = {
  totalPatients: 0,
  totalCritical: 0,
  totalDispatches: 0,
  totalElapsedMs: 0,
  minutesSavedTotal: 0,
  traumaSaves: 0,
  specialtySaves: 0,
  goldenHourExtra: 0,
}

function loadSdgStats() {
  try {
    const saved = JSON.parse(localStorage.getItem('rapid_sdg_stats')) || {}
    return { ...DEFAULT_SDG_STATS, ...saved }
  } catch { return DEFAULT_SDG_STATS }
}

export default function App() {
  const [loading,       setLoading]       = useState(false)
  const [result,        setResult]        = useState(() => {
    try { const s = sessionStorage.getItem('rapid_result'); return s ? JSON.parse(s) : null } catch { return null }
  })
  const [incident,      setIncident]      = useState(() => {
    try { const s = sessionStorage.getItem('rapid_incident'); return s ? JSON.parse(s) : null } catch { return null }
  })
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
  const [showWhatsApp,      setShowWhatsApp]      = useState(false)
  const [comparisonResult,  setComparisonResult]  = useState(null)
  const [comparisonLoading, setComparisonLoading] = useState(false)
  const [systemStatus,      setSystemStatus]      = useState(null)
  const [sceneIntelCount,   setSceneIntelCount]   = useState(0)

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

  /* ── Scene intel badge count — only the number, panel lives in Command Center ── */
  useEffect(() => {
    if (!result?.incident_id) { setSceneIntelCount(0); return }
    const id = result.incident_id
    async function poll() {
      try {
        const res = await fetch(`/api/scene-intel/${id}`)
        if (!res.ok) return
        const data = await res.json()
        setSceneIntelCount(data.aggregated?.report_count ?? 0)
      } catch {}
    }
    poll()
    const interval = setInterval(poll, 12000)
    return () => clearInterval(interval)
  }, [result?.incident_id])

  /* ── Persist result + incident across hash-route navigation ────────────── */
  useEffect(() => {
    if (result) sessionStorage.setItem('rapid_result', JSON.stringify(result))
    else sessionStorage.removeItem('rapid_result')
  }, [result])

  useEffect(() => {
    if (incident) sessionStorage.setItem('rapid_incident', JSON.stringify(incident))
    else sessionStorage.removeItem('rapid_incident')
  }, [incident])

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
    // Clear stale crew assignments from any prior session on each fresh dispatch
    ;['AMB_1', 'AMB_2', 'AMB_3', 'AMB_4', 'AMB_5'].forEach(unitId => {
      localStorage.removeItem(`rapid_crew_${unitId}`)
      localStorage.removeItem(`rapid_status_queue_${unitId}`)
    })
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
            const cf = data.result.counterfactual || {}
            const newStats = {
              totalPatients:     sdgStats.totalPatients + total,
              totalCritical:     sdgStats.totalCritical + newCritical,
              totalDispatches:   sdgStats.totalDispatches + 1,
              totalElapsedMs:    sdgStats.totalElapsedMs + (Date.now() - t0),
              minutesSavedTotal: (sdgStats.minutesSavedTotal ?? 0) + Number(cf.minutes_saved_total || 0),
              traumaSaves:       (sdgStats.traumaSaves ?? 0) + (cf.trauma_preserved ? 1 : 0),
              specialtySaves:    (sdgStats.specialtySaves ?? 0) + (cf.specialty_preserved ? 1 : 0),
              goldenHourExtra:   (sdgStats.goldenHourExtra ?? 0) + Number(cf.critical_in_golden_hour_delta || 0),
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

  async function handleReset() {
    // Dismiss all pending bystander reports so the inbox is clean for the next session
    try { await fetch('/api/bystander/reports/dismiss-all', { method: 'POST' }) } catch {}
    // Clear persisted crew assignments so Command Center starts fresh
    ;['AMB_1', 'AMB_2', 'AMB_3', 'AMB_4', 'AMB_5'].forEach(unitId => {
      localStorage.removeItem(`rapid_crew_${unitId}`)
      localStorage.removeItem(`rapid_status_queue_${unitId}`)
    })
    sessionStorage.removeItem('rapid_result')
    sessionStorage.removeItem('rapid_incident')
    setResult(null)
    setIncident(null)
    setError(null)
    setDemoValues(null)
    setMapLocation(null)
    setSceneIntelCount(0)
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
    if (!patients.length) {
      setError('Scene intel has no patient counts yet — wait for the crew photo to finish processing.')
      return
    }

    setPendingTotal(patients.reduce((sum, patient) => sum + patient.count, 0))
    setPendingTypes([...new Set(patients.map(patient => patient.injury_type).filter(Boolean))])

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
      // Open Command Center so dispatcher can immediately re-dispatch crews with new assignments
      setShowDispatcher(true)
      setHistRefresh(n => n + 1)
      setStreamLogs([{ type: 'step', step: 1, done: true, msg: 'Reroute complete — open Command Center to re-dispatch crews.' }])
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

  async function promoteBystanderReport(report) {
    const triage = report?.triage || {}
    const groups = (triage.patient_groups || [])
      .filter(g => (g?.count ?? 0) > 0)
      .map(g => ({
        severity:    g.severity,
        count:       g.count,
        injury_type: g.injury_type ?? null,
      }))
    if (!groups.length) {
      groups.push({ severity: 'moderate', count: Number(triage.estimated_casualties) || 1, injury_type: null })
    }
    await handleSubmit({ lat: report.lat, lon: report.lon, patients: groups })
    return { incident_id: null }
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
                onClick={() => setShowWhatsApp(true)}
                className="px-2.5 py-1 rounded-full font-bold text-xs bg-emerald-700 text-white border border-emerald-500 hover:bg-emerald-600 transition-colors"
                title="Open WhatsApp dispatch channel"
              >
                💬 CHAT
              </button>
              <button
                onClick={() => setShowDispatcher(true)}
                className="relative px-3 py-1 rounded-full font-black text-sm bg-blue-600 text-white border border-blue-500 hover:bg-blue-500 transition-colors shadow-lg shadow-blue-900/40"
              >
                COMMAND CENTER ↗
                {sceneIntelCount > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full
                                   bg-purple-500 border border-purple-300 text-[10px] font-black text-white
                                   flex items-center justify-center leading-none animate-pulse">
                    {sceneIntelCount}
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
              <BystanderInbox
                onPromote={promoteBystanderReport}
                activeIncidentId={result?.incident_id ?? null}
              />
            </section>

            <section className="pt-2 border-t border-rapid-border">
              <PrepositioningPanel basePosition={incident} />
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

      {/* WhatsApp Dispatch Simulator */}
      {showWhatsApp && (
        <Suspense fallback={null}>
          <WhatsAppSimulator
            incidentId={result?.incident_id || null}
            assignments={result?.assignments || []}
            onClose={() => setShowWhatsApp(false)}
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
