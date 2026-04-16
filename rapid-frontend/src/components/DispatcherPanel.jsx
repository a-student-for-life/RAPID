import React, { useState, useEffect } from 'react'
import axios from 'axios'
import { getContact } from '../hospitalContacts.js'

/* ── Firestore imports (guarded) ─────────────────────────────────────────────
   All usage is wrapped in try/catch so a mis-configured Firestore never crashes.
   ──────────────────────────────────────────────────────────────────────────── */
import { db } from '../firebaseConfig.js'
import { collection, doc, onSnapshot } from 'firebase/firestore'

const LS_KEY = (unit) => `rapid_crew_${unit}`

// A completed or standby doc means the unit is back on standby — treat as no active assignment
function activeOrNull(d) {
  if (!d) return null
  if (d.status === 'completed' || d.status === 'standby') return null
  return d
}

function useCrewDoc(unitId) {
  // Initialize from localStorage so the dispatcher status panel is instant
  const [data, setData] = useState(() => {
    try {
      const raw = localStorage.getItem(LS_KEY(unitId))
      return activeOrNull(raw ? JSON.parse(raw) : null)
    } catch { return null }
  })

  useEffect(() => {
    // Listen for cross-tab localStorage updates (crew ack, new dispatch, mission clear)
    function handleStorage(e) {
      if (e.key !== LS_KEY(unitId)) return
      try { setData(activeOrNull(e.newValue ? JSON.parse(e.newValue) : null)) } catch {}
    }
    window.addEventListener('storage', handleStorage)

    // Also subscribe to Firestore if it's available
    let unsub
    if (unitId && db) {
      try {
        const ref = doc(db, 'crew_assignments', unitId)
        unsub = onSnapshot(
          ref,
          (snap) => {
            try { setData(snap.exists() ? activeOrNull(snap.data()) : null) } catch {}
          },
          (err) => { console.warn('[Firestore]', unitId, err?.code) },
        )
      } catch (err) { console.warn('[Firestore] subscribe failed', err?.message) }
    }

    return () => {
      window.removeEventListener('storage', handleStorage)
      try { unsub?.() } catch {}
    }
  }, [unitId])

  return data
}

/* ── Scene Intelligence hook ─────────────────────────────────────────────────── */

function useSceneReports(incidentId) {
  const [reports,    setReports]    = useState([])
  const [aggregated, setAggregated] = useState(null)

  function aggregateLocal(rpts) {
    const totals  = { critical: 0, moderate: 0, minor: 0 }
    const hazards = new Set()
    const casualties = []
    for (const r of rpts) {
      for (const pg of (r.patient_groups || [])) {
        if (totals[pg.severity] !== undefined) totals[pg.severity] += (pg.count || 0)
      }
      for (const h of (r.hazard_flags || [])) hazards.add(h)
      if (r.estimated_casualties != null) casualties.push(Number(r.estimated_casualties))
    }
    const n = rpts.length
    return {
      report_count:    n,
      confidence:      n >= 3 ? 'HIGH' : n === 2 ? 'MEDIUM' : n > 0 ? 'LOW' : null,
      patient_groups:  Object.entries(totals)
                             .filter(([, v]) => v > 0)
                             .map(([k, v]) => ({ severity: k, count: v, injury_type: null })),
      total_estimated: casualties.length
                       ? Math.round(casualties.reduce((a, b) => a + b, 0) / casualties.length)
                       : null,
      hazard_flags:    [...hazards].sort(),
      reports:         rpts,
    }
  }

  useEffect(() => {
    if (!incidentId) return
    let unsub
    let pollInterval

    function startPolling() {
      if (pollInterval) return
      pollInterval = setInterval(async () => {
        try {
          const res = await fetch(`/api/scene-assessments/${incidentId}`)
          if (!res.ok) return
          const data = await res.json()
          if (data.aggregated) {
            setAggregated(data.aggregated)
            setReports(data.aggregated.reports || [])
          }
        } catch {}
      }, 5000)
    }

    if (db) {
      try {
        const ref = collection(db, 'scene_assessments', incidentId, 'reports')
        unsub = onSnapshot(
          ref,
          (snap) => {
            const rpts = snap.docs.map(d => ({ ...d.data(), id: d.id }))
            setReports(rpts)
            setAggregated(aggregateLocal(rpts))
          },
          () => { startPolling() },
        )
      } catch {
        startPolling()
      }
    } else {
      startPolling()
    }

    return () => {
      try { unsub?.() } catch {}
      if (pollInterval) clearInterval(pollInterval)
    }
  }, [incidentId])

  return { reports, aggregated }
}

/* ── Config ──────────────────────────────────────────────────────────────────── */

const UNITS = ['AMB_1', 'AMB_2', 'AMB_3', 'AMB_4', 'AMB_5']

const UNIT_CFG = {
  AMB_1: { callsign: 'ALPHA-1',   idle: 'border-slate-700 text-slate-500 hover:border-blue-700 hover:text-blue-300',     sel: 'border-blue-500   bg-blue-900/50   text-blue-200'    },
  AMB_2: { callsign: 'BRAVO-2',   idle: 'border-slate-700 text-slate-500 hover:border-red-700 hover:text-red-300',       sel: 'border-red-500    bg-red-900/50    text-red-200'     },
  AMB_3: { callsign: 'CHARLIE-3', idle: 'border-slate-700 text-slate-500 hover:border-green-700 hover:text-green-300',   sel: 'border-green-500  bg-green-900/50  text-green-200'   },
  AMB_4: { callsign: 'DELTA-4',   idle: 'border-slate-700 text-slate-500 hover:border-purple-700 hover:text-purple-300', sel: 'border-purple-500 bg-purple-900/50 text-purple-200'  },
  AMB_5: { callsign: 'ECHO-5',    idle: 'border-slate-700 text-slate-500 hover:border-orange-700 hover:text-orange-300', sel: 'border-orange-500 bg-orange-900/50 text-orange-200'  },
}

const SEV_CFG = {
  critical: { pill: 'border-red-700   bg-red-950/80   text-red-300',   label: 'CRITICAL' },
  moderate: { pill: 'border-amber-700 bg-amber-950/80 text-amber-300', label: 'MODERATE' },
  minor:    { pill: 'border-green-700 bg-green-950/80 text-green-300', label: 'MINOR'    },
}

/* ── Sub-components ──────────────────────────────────────────────────────────── */

function CrewStatusRow({ unitId }) {
  const data = useCrewDoc(unitId)
  const uc   = UNIT_CFG[unitId] || { callsign: unitId }
  const ackd = !!data?.acknowledged_at
  const live = !!data
  return (
    <div className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border text-xs transition-all duration-300 ${
      ackd ? 'bg-green-950/30 border-green-800' :
      live ? 'bg-blue-950/30 border-blue-800'   : 'border-transparent'
    }`}>
      <span className={`w-2 h-2 rounded-full shrink-0 ${
        ackd ? 'bg-green-500' : live ? 'bg-blue-500 animate-pulse' : 'bg-slate-700'
      }`} />
      <span className={`font-black ${ackd ? 'text-green-400' : live ? 'text-blue-400' : 'text-slate-600'}`}>
        {uc.callsign}
      </span>
      <span className="ml-auto font-bold text-xs">
        {ackd ? <span className="text-green-400">EN ROUTE</span>
               : live ? <span className="text-blue-400">DISPATCHED</span>
                      : <span className="text-slate-700">STANDBY</span>}
      </span>
    </div>
  )
}

function CrewAckBar({ unitId }) {
  const data = useCrewDoc(unitId)
  if (!data) return null
  const ackd = !!data.acknowledged_at
  return (
    <div className={`flex items-center gap-2 mt-2 px-3 py-2 rounded-lg border text-xs transition-all ${
      ackd ? 'bg-green-950/50 border-green-700 text-green-400'
           : 'bg-blue-950/40 border-blue-800 text-blue-400'
    }`}>
      <span className={`w-2 h-2 rounded-full shrink-0 ${ackd ? 'bg-green-500' : 'bg-blue-500 animate-pulse'}`} />
      <span className="font-bold">{UNIT_CFG[unitId]?.callsign || unitId}</span>
      <span className="text-slate-500 mx-1">·</span>
      <span>
        {ackd
          ? `En Route — ack'd ${new Date(data.acknowledged_at).toLocaleTimeString()}`
          : 'Delivered — awaiting crew acknowledgement'}
      </span>
    </div>
  )
}

/* ── ETA countdown hook ──────────────────────────────────────────────────────── */
function useCountdown(etaMinutes, startedAt) {
  const [remaining, setRemaining] = useState(null)
  useEffect(() => {
    if (etaMinutes == null || !startedAt) return
    const endMs = startedAt + etaMinutes * 60_000
    const tick  = () => setRemaining(Math.max(0, endMs - Date.now()))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [etaMinutes, startedAt])
  if (remaining === null) return null
  const m = Math.floor(remaining / 60000)
  const s = Math.floor((remaining % 60000) / 1000)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function AssignmentCard({ assignment, hospital, incidentId, incidentLat, incidentLon }) {
  const [selectedUnit, setSelectedUnit] = useState('AMB_1')
  const [dispatched,   setDispatched]   = useState(null)
  const [dispatchedAt, setDispatchedAt] = useState(null)
  const [sending,      setSending]      = useState(false)
  const [error,        setError]        = useState(null)

  const countdown = useCountdown(hospital?.eta_minutes, dispatchedAt)

  const contact = getContact(hospital?.name || assignment?.hospital || '')
  const sev     = SEV_CFG[assignment?.severity] || SEV_CFG.minor

  async function handleDispatch() {
    setSending(true)
    setError(null)
    try {
      await axios.post('/api/crew/dispatch', {
        unit_id:           selectedUnit,
        incident_id:       incidentId  || '',
        hospital_name:     assignment?.hospital  || '',
        hospital_lat:      hospital?.lat         ?? 0,
        hospital_lon:      hospital?.lon         ?? 0,
        incident_lat:      incidentLat           ?? null,
        incident_lon:      incidentLon           ?? null,
        eta_minutes:       hospital?.eta_minutes ?? null,
        patients_assigned: assignment?.patients_assigned ?? 0,
        severity:          assignment?.severity  || 'minor',
        injury_type:       assignment?.injury_type ?? null,
        reason:            assignment?.reason    ?? '',
        available_icu:     hospital?.capacity?.available_icu ?? null,
        trauma_centre:     hospital?.trauma_centre ?? false,
        specialties:       Array.isArray(hospital?.specialties) ? hospital.specialties : [],
        phone:             contact?.phone ?? null,
        area:              contact?.area  ?? null,
      })
      setDispatched(selectedUnit)
      setDispatchedAt(Date.now())

      // Voice announcement — Feature 1 (Web Speech API, no key required)
      try {
        const callsign = UNIT_CFG[selectedUnit]?.callsign || selectedUnit
        const eta      = hospital?.eta_minutes != null ? `ETA ${Math.round(hospital.eta_minutes)} minutes.` : ''
        const pts      = assignment?.patients_assigned ?? 0
        const sev      = (assignment?.severity || 'minor').toUpperCase()
        const hosp     = assignment?.hospital || 'destination hospital'
        const utterance = new SpeechSynthesisUtterance(
          `${callsign} dispatched. ${pts} ${sev} patients to ${hosp}. ${eta}`
        )
        utterance.rate = 0.95
        utterance.pitch = 1.0
        window.speechSynthesis?.speak(utterance)
      } catch {}

      // Write to localStorage — cross-tab sync for crew views (works even without Firestore)
      try {
        localStorage.setItem(LS_KEY(selectedUnit), JSON.stringify({
          unit_id:           selectedUnit,
          incident_id:       incidentId  || '',
          hospital_name:     assignment?.hospital  || '',
          hospital_lat:      hospital?.lat         ?? 0,
          hospital_lon:      hospital?.lon         ?? 0,
          incident_lat:      incidentLat           ?? null,
          incident_lon:      incidentLon           ?? null,
          eta_minutes:       hospital?.eta_minutes ?? null,
          patients_assigned: assignment?.patients_assigned ?? 0,
          severity:          assignment?.severity  || 'minor',
          injury_type:       assignment?.injury_type ?? null,
          reason:            assignment?.reason    ?? '',
          available_icu:     hospital?.capacity?.available_icu ?? null,
          trauma_centre:     hospital?.trauma_centre ?? false,
          phone:             contact?.phone ?? null,
          area:              contact?.area  ?? null,
          dispatched_at:     new Date().toISOString(),
          status:            'dispatched',
        }))
      } catch {}
    } catch (err) {
      setError(
        err?.response?.data?.detail ||
        err?.message ||
        'Dispatch failed — check backend.'
      )
    } finally {
      setSending(false)
    }
  }

  if (!assignment) return null

  return (
    <div className={`rounded-2xl border p-5 transition-all duration-300 ${
      dispatched ? 'border-green-700 bg-[#0a1c0e]' : 'border-[#2d3148] bg-[#1a1d2e]'
    }`}>

      {/* Hospital header */}
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
            <span className={`px-2.5 py-0.5 rounded-full text-xs font-black border ${sev.pill}`}>
              {sev.label}
            </span>
            {hospital?.trauma_centre && (
              <span className="px-2 py-0.5 rounded-full text-xs font-bold border border-red-800 bg-red-950/60 text-red-400">
                TRAUMA
              </span>
            )}
            {assignment.injury_type && (
              <span className="px-2 py-0.5 rounded-full text-xs border border-slate-700 text-slate-400 capitalize">
                {assignment.injury_type}
              </span>
            )}
          </div>
          <p className="text-xl font-black text-white leading-tight truncate">
            {assignment.hospital || '—'}
          </p>
          {contact && (
            <p className="text-xs text-slate-500 mt-0.5">{contact.area} · {contact.phone}</p>
          )}
        </div>
        <div className="text-right shrink-0">
          <p className="text-4xl font-black text-white">{assignment.patients_assigned ?? 0}</p>
          <p className="text-xs text-slate-500">patients</p>
        </div>
      </div>

      {/* Stats chips */}
      <div className="flex flex-wrap gap-2 mb-4">
        {hospital?.eta_minutes != null && (
          <span className="text-xs px-2.5 py-1 rounded-lg border border-blue-800 bg-blue-950/40 text-blue-400 font-semibold">
            ETA {Number(hospital.eta_minutes).toFixed(0)} min
          </span>
        )}
        {hospital?.capacity?.available_icu != null && (
          <span className="text-xs px-2.5 py-1 rounded-lg border border-slate-700 text-slate-400">
            ICU: {hospital.capacity.available_icu}
          </span>
        )}
        {hospital?.distance_km != null && (
          <span className="text-xs px-2.5 py-1 rounded-lg border border-slate-700 text-slate-400">
            {Number(hospital.distance_km).toFixed(1)} km
          </span>
        )}
      </div>

      {/* AI reason */}
      {assignment.reason && (
        <p className="text-xs text-slate-400 italic mb-4 leading-relaxed pl-3 border-l-2 border-[#2d3148]">
          {assignment.reason}
        </p>
      )}

      {/* Unit selector */}
      {!dispatched && (
        <div className="mb-4">
          <p className="text-xs text-slate-600 uppercase tracking-widest font-semibold mb-2">
            Assign unit
          </p>
          <div className="flex flex-wrap gap-2">
            {UNITS.map(unit => {
              const uc     = UNIT_CFG[unit]
              const active = selectedUnit === unit
              return (
                <button
                  key={unit}
                  type="button"
                  onClick={() => setSelectedUnit(unit)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-black border transition-all ${
                    active ? uc.sel + ' shadow-lg' : uc.idle
                  }`}
                >
                  {uc.callsign}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Dispatch action */}
      {dispatched ? (
        <div>
          <div className="rounded-xl bg-[#0d2412] border border-green-700 p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-green-400 text-base">✓</span>
              <p className="text-sm font-black text-green-300 flex-1">
                Dispatched to {UNIT_CFG[dispatched]?.callsign || dispatched}
              </p>
              <a
                href={`${window.location.origin}/#crew?unit=${dispatched}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-400 hover:text-blue-300 font-bold transition-colors"
              >
                View Crew ↗
              </a>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="bg-[#0a1a0e] rounded-lg py-2">
                <p className="text-xl font-black text-white">{assignment.patients_assigned ?? 0}</p>
                <p className="text-[10px] text-slate-500">patients</p>
              </div>
              {hospital?.eta_minutes != null ? (
                <div className="bg-[#0a1a0e] rounded-lg py-2">
                  <p className={`text-xl font-black ${countdown === '0:00' ? 'text-green-300' : 'text-blue-300'}`}>
                    {countdown === '0:00' ? '✓ ARRIVED' : countdown ?? `${Number(hospital.eta_minutes).toFixed(0)}m`}
                  </p>
                  <p className="text-[10px] text-slate-500">ETA remaining</p>
                </div>
              ) : <div />}
              <div className="bg-[#0a1a0e] rounded-lg py-2">
                <p className={`text-xs font-black ${
                  assignment.severity === 'critical' ? 'text-red-300' :
                  assignment.severity === 'moderate' ? 'text-amber-300' : 'text-green-300'
                }`}>{(assignment.severity || 'minor').toUpperCase()}</p>
                <p className="text-[10px] text-slate-500">severity</p>
              </div>
            </div>
          </div>
          <CrewAckBar unitId={dispatched} />
        </div>
      ) : (
        <button
          type="button"
          onClick={handleDispatch}
          disabled={sending}
          className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 active:bg-blue-700
                     text-white font-black text-sm transition-all disabled:opacity-50
                     shadow-lg shadow-blue-900/30"
        >
          {sending
            ? 'Sending…'
            : `DISPATCH TO ${UNIT_CFG[selectedUnit]?.callsign || selectedUnit}`}
        </button>
      )}

      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </div>
  )
}

/* ── Main Panel ──────────────────────────────────────────────────────────────── */

export default function DispatcherPanel({ result, hospitalMap, incidentLocation, onClose, onRerunWithSceneData }) {
  if (!result) return null

  const assignments   = result.assignments  || []
  const hospitals     = result.hospitals    || []
  const totalPatients = assignments.reduce((s, a) => s + (a.patients_assigned ?? 0), 0)
  const criticalCount = assignments.filter(a => a.severity === 'critical')
                                   .reduce((s, a) => s + (a.patients_assigned ?? 0), 0)
  const moderateCount = assignments.filter(a => a.severity === 'moderate')
                                   .reduce((s, a) => s + (a.patients_assigned ?? 0), 0)
  const minorCount    = totalPatients - criticalCount - moderateCount

  const safeHospitalMap = hospitalMap || {}
  const incLat = incidentLocation?.lat ?? null
  const incLon = incidentLocation?.lon ?? null

  const incidentId = result?.incident_id || null
  // eslint-disable-next-line no-unused-vars
  const { reports: sceneReports, aggregated: sceneAggregated } = useSceneReports(incidentId)

  function openAllCrewViews() {
    let blocked = 0
    UNITS.forEach(unit => {
      const w = window.open(
        `${window.location.origin}/#crew?unit=${unit}`,
        `rapid_crew_${unit}`,
        'width=420,height=750',
      )
      if (!w) blocked++
    })
    if (blocked > 0) {
      // eslint-disable-next-line no-alert
      alert(
        `${blocked} window(s) were blocked by your browser.\n\n` +
        'To fix: click the popup-blocked icon in your address bar → "Always allow popups from this site" → OK, then try again.\n\n' +
        'Alternatively, click each crew link individually in the sidebar.'
      )
    }
  }

  return (
    <div
      className="fixed inset-0 flex bg-[#06080e]/96 backdrop-blur-md"
      style={{ zIndex: 9999 }}
    >
      {/* ══ LEFT SIDEBAR ════════════════════════════════════════════════════ */}
      <div className="w-72 shrink-0 flex flex-col border-r border-[#1c1f30] bg-[#0a0c14] overflow-y-auto">

        {/* Logo */}
        <div className="px-5 py-4 border-b border-[#1c1f30]">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-red-500 mci-pulse">🚨</span>
            <p className="text-xs font-black text-white uppercase tracking-[0.2em]">RAPID COMMAND</p>
          </div>
          <p className="text-xs text-slate-600 font-mono">
            INC-{(result.incident_id || '').slice(0, 8).toUpperCase()}
          </p>
        </div>

        {/* Incident summary */}
        <div className="px-5 py-4 border-b border-[#1c1f30]">
          <p className="text-xs font-black text-slate-500 uppercase tracking-widest mb-3">
            Incident Summary
          </p>
          <div className="grid grid-cols-3 gap-2 mb-3">
            <div className="rounded-xl bg-red-950/40 border border-red-900 p-2 text-center">
              <p className="text-xl font-black text-red-400">{criticalCount}</p>
              <p className="text-[10px] text-slate-500 leading-tight">critical</p>
            </div>
            <div className="rounded-xl bg-amber-950/30 border border-amber-900 p-2 text-center">
              <p className="text-xl font-black text-amber-400">{moderateCount}</p>
              <p className="text-[10px] text-slate-500 leading-tight">moderate</p>
            </div>
            <div className="rounded-xl bg-green-950/30 border border-green-900 p-2 text-center">
              <p className="text-xl font-black text-green-400">{Math.max(0, minorCount)}</p>
              <p className="text-[10px] text-slate-500 leading-tight">minor</p>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className={`px-2 py-1 rounded-lg text-xs font-black border ${
              result.decision_path === 'groq'
                ? 'bg-green-950/50 border-green-800 text-green-400'
                : result.decision_path === 'gemini' || result.decision_path === 'AI'
                ? 'bg-blue-950/50 border-blue-800 text-blue-400'
                : 'bg-amber-950/50 border-amber-800 text-amber-400'
            }`}>
              {result.decision_path === 'groq'   ? '✦ Groq AI'
               : result.decision_path === 'gemini' || result.decision_path === 'AI' ? '✦ Gemini AI'
               : '⚡ Fallback'}
            </span>
            <span className="text-xs text-slate-600">
              {result.elapsed_s ?? '?'}s · {totalPatients} pts
            </span>
          </div>
        </div>

        {/* AI reasoning */}
        {result.reasoning && (
          <div className="px-5 py-4 border-b border-[#1c1f30]">
            <p className="text-xs font-black text-slate-500 uppercase tracking-widest mb-2">
              AI Reasoning
            </p>
            <p className="text-xs text-slate-400 leading-relaxed">{result.reasoning}</p>
          </div>
        )}

        {/* Live crew status board */}
        <div className="px-5 py-4 border-b border-[#1c1f30]">
          <p className="text-xs font-black text-slate-500 uppercase tracking-widest mb-3">
            Crew Status
          </p>
          <div className="space-y-1.5">
            {UNITS.map(u => <CrewStatusRow key={u} unitId={u} />)}
          </div>
        </div>

        {/* Scene Intelligence — real-time aggregated crew scene reports */}
        {sceneAggregated && sceneAggregated.report_count > 0 && (
          <div className="px-5 py-4 border-b border-[#1c1f30]">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-black text-slate-500 uppercase tracking-widest">
                Scene Reports
              </p>
              <span className={`px-2 py-0.5 rounded-full text-xs font-black border ${
                sceneAggregated.confidence === 'HIGH'
                  ? 'border-green-700 bg-green-950/50 text-green-400'
                  : sceneAggregated.confidence === 'MEDIUM'
                  ? 'border-amber-700 bg-amber-950/50 text-amber-400'
                  : 'border-slate-700 bg-slate-900/50 text-slate-400'
              }`}>
                {sceneAggregated.confidence}
              </span>
            </div>

            <div className="flex items-center gap-2 mb-3">
              <span className="text-purple-400">🔬</span>
              <p className="text-sm font-black text-white">
                {sceneAggregated.report_count} scene report{sceneAggregated.report_count !== 1 ? 's' : ''} received
              </p>
            </div>

            {sceneAggregated.patient_groups?.length > 0 && (
              <div className="grid grid-cols-3 gap-2 mb-3">
                {['critical', 'moderate', 'minor'].map(sev => {
                  const pg = sceneAggregated.patient_groups.find(p => p.severity === sev)
                  return (
                    <div key={sev} className={`rounded-xl border p-2 text-center ${
                      sev === 'critical' ? 'border-red-900 bg-red-950/40' :
                      sev === 'moderate' ? 'border-amber-900 bg-amber-950/30' :
                                          'border-green-900 bg-green-950/30'
                    }`}>
                      <p className={`text-xl font-black ${
                        sev === 'critical' ? 'text-red-400' :
                        sev === 'moderate' ? 'text-amber-400' : 'text-green-400'
                      }`}>{pg?.count ?? 0}</p>
                      <p className="text-[10px] text-slate-500 capitalize">{sev}</p>
                    </div>
                  )
                })}
              </div>
            )}

            {sceneAggregated.hazard_flags?.length > 0 && (
              <div className="rounded-xl bg-red-950/20 border border-red-900/50 px-3 py-2 mb-3">
                <p className="text-xs font-black text-red-400 mb-1">⚠ Hazards</p>
                <p className="text-xs text-red-300">{sceneAggregated.hazard_flags.join(' · ')}</p>
              </div>
            )}

            {onRerunWithSceneData && sceneAggregated.patient_groups?.length > 0 && (
              <button
                type="button"
                onClick={() => onRerunWithSceneData(sceneAggregated.patient_groups, incLat, incLon)}
                className="w-full py-3 rounded-xl bg-purple-700 hover:bg-purple-600 active:bg-purple-800
                           text-white text-xs font-black transition-all shadow-lg shadow-purple-900/30"
              >
                🔄 RERUN ROUTING WITH SCENE DATA
              </button>
            )}
          </div>
        )}

        {/* Crew companion links — all 5 units */}
        <div className="px-5 py-4 flex-1">
          <p className="text-xs font-black text-slate-500 uppercase tracking-widest mb-3">
            Crew Companion App
          </p>
          <div className="space-y-1.5 mb-4">
            {UNITS.map(unit => {
              const uc = UNIT_CFG[unit]
              return (
                <a
                  key={unit}
                  href={`${window.location.origin}/#crew?unit=${unit}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 px-3 py-2 rounded-xl border border-[#2d3148]
                             hover:border-blue-700 hover:bg-blue-950/20 transition-all group"
                >
                  <span className="text-xs font-black text-slate-400 group-hover:text-blue-300 w-20">
                    {uc.callsign}
                  </span>
                  <span className="text-[10px] text-slate-700 font-mono flex-1 truncate">
                    /#crew?unit={unit}
                  </span>
                  <span className="text-slate-600 group-hover:text-blue-400 text-xs transition-colors">↗</span>
                </a>
              )
            })}
          </div>
          <button
            type="button"
            onClick={openAllCrewViews}
            className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 active:bg-blue-700
                       text-white text-xs font-black transition-all shadow-lg shadow-blue-900/30"
          >
            OPEN ALL 5 CREW VIEWS
          </button>
          <p className="text-[10px] text-slate-700 mt-2 text-center leading-snug">
            Opens all crew companion apps — allow popups if prompted
          </p>
        </div>

        {/* Close */}
        <div className="px-5 py-4 border-t border-[#1c1f30]">
          <button
            type="button"
            onClick={onClose}
            className="w-full py-2.5 rounded-xl border border-[#2d3148] text-slate-500
                       text-xs hover:border-slate-500 hover:text-slate-200 transition-colors"
          >
            Close Command Center
          </button>
        </div>
      </div>

      {/* ══ MAIN ASSIGNMENTS AREA ════════════════════════════════════════════ */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* Top bar */}
        <div className="px-6 py-4 border-b border-[#1c1f30] bg-[#0a0c14] flex items-center gap-4 shrink-0">
          <div>
            <p className="text-base font-black text-white tracking-wider uppercase">
              Dispatch Assignments
            </p>
            <p className="text-xs text-slate-500">
              {assignments.length} hospital group{assignments.length !== 1 ? 's' : ''} ·
              select unit · press DISPATCH · each crew view updates live
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto text-slate-600 hover:text-slate-200 transition-colors text-2xl
                       leading-none w-8 h-8 flex items-center justify-center rounded-lg hover:bg-[#1c1f30]"
          >
            ✕
          </button>
        </div>

        {/* Cards */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-2xl mx-auto space-y-4">
            {assignments.map((assignment, i) => (
              <AssignmentCard
                key={i}
                assignment={assignment}
                hospital={safeHospitalMap[assignment?.hospital]}
                incidentId={result.incident_id || ''}
                incidentLat={incLat}
                incidentLon={incLon}
              />
            ))}

            {result.warnings?.length > 0 && (
              <div className="rounded-2xl border border-amber-900/50 bg-amber-950/20 p-4">
                <p className="text-xs font-black text-amber-400 uppercase tracking-widest mb-2">
                  Warnings
                </p>
                {result.warnings.map((w, i) => (
                  <p key={i} className="text-xs text-amber-300/70">⚠ {w}</p>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
