import React, { useState, useEffect, useRef } from 'react'

import { db } from '../firebaseConfig.js'
import { doc, onSnapshot, updateDoc } from 'firebase/firestore'

/* ── Unit identity ───────────────────────────────────────────────────────────── */

const UNIT_CFG = {
  AMB_1: { callsign: 'ALPHA-1',   role: 'Advanced Life Support',      color: 'blue'   },
  AMB_2: { callsign: 'BRAVO-2',   role: 'Basic Life Support',          color: 'red'    },
  AMB_3: { callsign: 'CHARLIE-3', role: 'Specialist Response',         color: 'green'  },
  AMB_4: { callsign: 'DELTA-4',   role: 'Mass Casualty Response',      color: 'purple' },
  AMB_5: { callsign: 'ECHO-5',    role: 'Paediatric Rapid Response',   color: 'orange' },
}

const COLOR = {
  blue:   { grad: 'from-blue-950',   ring: 'border-blue-600',   text: 'text-blue-400',   navBtn: 'bg-blue-600 hover:bg-blue-500',   chip: 'bg-blue-900/40 border-blue-600 text-blue-300'    },
  red:    { grad: 'from-red-950',    ring: 'border-red-600',    text: 'text-red-400',    navBtn: 'bg-red-600 hover:bg-red-500',     chip: 'bg-red-900/40 border-red-600 text-red-300'      },
  green:  { grad: 'from-green-950',  ring: 'border-green-600',  text: 'text-green-400',  navBtn: 'bg-green-600 hover:bg-green-500', chip: 'bg-green-900/40 border-green-600 text-green-300' },
  purple: { grad: 'from-purple-950', ring: 'border-purple-600', text: 'text-purple-400', navBtn: 'bg-purple-600 hover:bg-purple-500',chip: 'bg-purple-900/40 border-purple-600 text-purple-300'},
  orange: { grad: 'from-orange-950', ring: 'border-orange-600', text: 'text-orange-400', navBtn: 'bg-orange-600 hover:bg-orange-500',chip: 'bg-orange-900/40 border-orange-600 text-orange-300'},
}

const SEV = {
  critical: { bg: 'bg-red-950',   border: 'border-red-700',   text: 'text-red-300',   label: 'CRITICAL' },
  moderate: { bg: 'bg-amber-950', border: 'border-amber-700', text: 'text-amber-300', label: 'MODERATE' },
  minor:    { bg: 'bg-green-950', border: 'border-green-700', text: 'text-green-300', label: 'MINOR'    },
}

/* ── Status phases ────────────────────────────────────────────────────────────── */
// dispatched → en_route → on_scene → completed → (clear) → standby
const STATUS_CFG = {
  dispatched: { label: 'DISPATCHED', badge: 'bg-blue-900/60 border-blue-700 text-blue-400 animate-pulse', dot: 'bg-blue-500 animate-pulse' },
  en_route:   { label: 'EN ROUTE',   badge: 'bg-green-900/60 border-green-700 text-green-400',            dot: 'bg-green-500'             },
  on_scene:   { label: 'ON SCENE',   badge: 'bg-orange-900/60 border-orange-700 text-orange-400',         dot: 'bg-orange-500 animate-pulse'},
  completed:  { label: 'COMPLETE',   badge: 'bg-green-900/80 border-green-600 text-green-300',            dot: 'bg-green-400'             },
}

/* ── Pre-arrival checklists ──────────────────────────────────────────────────── */
const CHECKLISTS = {
  trauma:      ['Spinal immobilization board', 'Cervical collar', 'Hemorrhage control kit', 'IV access × 2 (16G + 18G)', 'Airway management kit'],
  cardiac:     ['12-lead ECG ready', 'Defibrillator charged + pads on', 'Aspirin 300 mg + GTN spray', 'IV access + heparin drawn', 'ACLS protocol card'],
  burns:       ['Sterile burn dressings (large)', "IV Hartmann's × 2 L", 'Morphine + ondansetron drawn', 'Space blanket (hypothermia)', 'High-flow O₂ mask'],
  neuro:       ['Neuro obs chart (GCS)', 'Blood glucose monitor', 'O₂ + suction ready', 'IV access + normal saline', 'FAST stroke assessment card'],
  respiratory: ['High-flow O₂ mask (15 L/min)', 'Salbutamol nebulizer prepared', 'Suction unit tested', 'Pulse oximeter + capnography', 'BVM + intubation kit standby'],
  ortho:       ['Traction splint (femur)', 'SAM splints × 3', 'Morphine + ketorolac drawn', 'IV access × 1', 'Pelvis binder (standby)'],
  general:     ['Vitals monitoring set up', 'IV access + crystalloid fluids', 'O₂ therapy ready', 'First-aid kit restocked', 'Patient handover form ready'],
}

/* ── Helpers ─────────────────────────────────────────────────────────────────── */

function parseUnitFromHash() {
  try {
    const hash = window.location.hash
    const qs   = hash.includes('?') ? hash.split('?')[1] : ''
    return new URLSearchParams(qs).get('unit') || 'AMB_1'
  } catch { return 'AMB_1' }
}

function lsKey(unit) { return `rapid_crew_${unit}` }

function buildNavUrl(assignment, crewPos, atScene) {
  if (!assignment?.hospital_lat || !assignment?.hospital_lon) return null
  const hosp     = `${assignment.hospital_lat},${assignment.hospital_lon}`
  const hasScene = !!(assignment?.incident_lat && assignment?.incident_lon)
  const scene    = hasScene ? `${assignment.incident_lat},${assignment.incident_lon}` : null

  let url = 'https://www.google.com/maps/dir/?api=1'
  if (crewPos) url += `&origin=${crewPos.lat},${crewPos.lon}`
  // Add incident scene as waypoint only if crew hasn't arrived there yet
  if (scene && !atScene) url += `&waypoints=${scene}`
  url += `&destination=${hosp}`
  url += '&travelmode=driving'
  return url
}

function navLabel(crewPos, hasScene, atScene) {
  if (atScene)             return 'NAVIGATE TO HOSPITAL'
  if (crewPos && hasScene) return 'NAVIGATE — SCENE → HOSPITAL'
  if (hasScene)            return 'NAVIGATE — SCENE → HOSPITAL'
  return 'NAVIGATE TO HOSPITAL'
}

function ETACountdown({ dispatchedAt, etaMinutes }) {
  const [mins, setMins] = useState(null)
  useEffect(() => {
    if (!dispatchedAt || etaMinutes == null) return
    try {
      const end  = new Date(dispatchedAt).getTime() + Number(etaMinutes) * 60_000
      const tick = () => setMins(Math.max(0, Math.ceil((end - Date.now()) / 60_000)))
      tick()
      const id = setInterval(tick, 15_000)
      return () => clearInterval(id)
    } catch {}
  }, [dispatchedAt, etaMinutes])

  if (mins === null) return null
  return (
    <div className="rounded-2xl border border-[#2d3148] bg-[#1a1d2e] p-3 text-center">
      {mins === 0 ? (
        <>
          <p className="text-xl font-black text-green-400">ARRIVED</p>
          <p className="text-xs text-slate-500 mt-0.5">ETA elapsed</p>
        </>
      ) : (
        <>
          <p className="text-3xl font-black text-blue-400">{mins}</p>
          <p className="text-xs text-slate-500 mt-0.5">min ETA</p>
        </>
      )}
    </div>
  )
}

function CheckItem({ text }) {
  const [done, setDone] = useState(false)
  return (
    <button type="button" onClick={() => setDone(d => !d)}
      className={`flex items-center gap-3 w-full text-left py-2.5 px-1 rounded-lg transition-colors ${done ? 'opacity-40' : 'active:bg-white/5'}`}>
      <span className={`w-5 h-5 rounded border flex items-center justify-center shrink-0 transition-colors ${done ? 'bg-green-600 border-green-500' : 'border-slate-600'}`}>
        {done && <span className="text-white text-xs font-black">✓</span>}
      </span>
      <span className={`text-sm leading-snug ${done ? 'line-through text-slate-600' : 'text-slate-300'}`}>{text}</span>
    </button>
  )
}

/* ── Main Component ──────────────────────────────────────────────────────────── */

export default function CrewView() {
  const [assignment,   setAssignment]   = useState(null)
  const [crewStatus,   setCrewStatus]   = useState('dispatched') // dispatched|en_route|on_scene|completed
  const [missionDone,  setMissionDone]  = useState(false)        // completion splash
  const [unitId]                        = useState(parseUnitFromHash)
  const clearTimer                      = useRef(null)

  /* GPS — best-effort */
  const [crewPos,  setCrewPos]  = useState(null)
  const [geoState, setGeoState] = useState('requesting')

  useEffect(() => {
    if (!navigator.geolocation) { setGeoState('unsupported'); return }
    navigator.geolocation.getCurrentPosition(
      pos => { setCrewPos({ lat: pos.coords.latitude, lon: pos.coords.longitude }); setGeoState('ok') },
      err => { console.warn('[GPS]', err.code); setGeoState('denied') },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 60_000 },
    )
  }, [])

  const unitCfg  = UNIT_CFG[unitId] || { callsign: unitId, role: 'Emergency Response', color: 'blue' }
  const c        = COLOR[unitCfg.color] || COLOR.blue
  const sev      = assignment ? (SEV[assignment.severity] || SEV.minor) : null
  const checks   = CHECKLISTS[assignment?.injury_type] || CHECKLISTS.general
  const hasScene = !!(assignment?.incident_lat && assignment?.incident_lon)
  const atScene  = crewStatus === 'on_scene' || crewStatus === 'completed'
  const navUrl   = buildNavUrl(assignment, crewPos, atScene)
  const statusCfg = STATUS_CFG[crewStatus] || STATUS_CFG.dispatched

  function applyData(data) {
    if (!data) { setAssignment(null); setCrewStatus('dispatched'); return }
    setAssignment(data)
    setCrewStatus(data.status || (data.acknowledged_at ? 'en_route' : 'dispatched'))
  }

  /* ── Primary sync: localStorage ─────────────────────────────────────────── */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(lsKey(unitId))
      if (raw) applyData(JSON.parse(raw))
    } catch {}

    function handleStorage(e) {
      if (e.key !== lsKey(unitId)) return
      try { applyData(e.newValue ? JSON.parse(e.newValue) : null) } catch {}
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [unitId]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Secondary sync: Firestore ───────────────────────────────────────────── */
  useEffect(() => {
    if (!db) return
    let unsub
    try {
      unsub = onSnapshot(
        doc(db, 'crew_assignments', unitId),
        snap => { try { if (snap.exists()) applyData(snap.data()) } catch {} },
        err  => { console.warn('[CrewView] Firestore:', err?.code) },
      )
    } catch (err) { console.warn('[CrewView] Firestore subscribe:', err?.message) }
    return () => { try { unsub?.() } catch {} }
  }, [unitId]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Status transition helpers ───────────────────────────────────────────── */
  function lsWrite(patch) {
    try {
      const raw  = localStorage.getItem(lsKey(unitId))
      const base = raw ? JSON.parse(raw) : {}
      localStorage.setItem(lsKey(unitId), JSON.stringify({ ...base, ...patch }))
    } catch {}
  }

  async function fsWrite(patch) {
    try {
      if (db) await updateDoc(doc(db, 'crew_assignments', unitId), patch)
    } catch (err) { console.warn('[CrewView] Firestore write:', err?.message) }
  }

  async function handleAcknowledge() {
    if (crewStatus !== 'dispatched') return
    const now = new Date().toISOString()
    const patch = { acknowledged_at: now, status: 'en_route' }
    setCrewStatus('en_route')
    lsWrite(patch)
    await fsWrite(patch)
  }

  async function handleOnScene() {
    if (crewStatus !== 'en_route') return
    const patch = { on_scene_at: new Date().toISOString(), status: 'on_scene' }
    setCrewStatus('on_scene')
    lsWrite(patch)
    await fsWrite(patch)
  }

  async function handleComplete() {
    if (crewStatus !== 'on_scene') return
    const now   = new Date().toISOString()
    const patch = { completed_at: now, status: 'completed' }
    setCrewStatus('completed')
    lsWrite(patch)
    await fsWrite(patch)
    setMissionDone(true)
    // After 5 s: clear assignment and return to STANDBY
    clearTimer.current = setTimeout(() => {
      try { localStorage.removeItem(lsKey(unitId)) } catch {}
      setAssignment(null)
      setCrewStatus('dispatched')
      setMissionDone(false)
    }, 5000)
  }

  useEffect(() => () => { if (clearTimer.current) clearTimeout(clearTimer.current) }, [])

  /* ── STANDBY screen ──────────────────────────────────────────────────────── */
  if (!assignment) {
    return (
      <div className="min-h-screen bg-[#080a0f] text-slate-200" style={{ fontFamily: 'system-ui, sans-serif' }}>
        <div className={`bg-gradient-to-b ${c.grad} to-[#080a0f] border-b ${c.ring} px-4 py-5`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-3xl">🚑</span>
              <div>
                <p className={`text-xl font-black tracking-wider ${c.text}`}>{unitCfg.callsign}</p>
                <p className="text-xs text-slate-500">{unitCfg.role}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse" />
              <span className="text-xs text-green-400 font-black">ONLINE</span>
            </div>
          </div>
        </div>

        <div className="flex flex-col items-center justify-center min-h-[calc(100vh-88px)] text-center p-8">
          <div className={`w-24 h-24 rounded-full border-2 ${c.ring} flex items-center justify-center mb-6`}
               style={{ background: 'rgba(255,255,255,0.04)' }}>
            <span className="text-4xl">📡</span>
          </div>
          <p className="text-3xl font-black text-white mb-2">STANDBY</p>
          <p className={`text-base font-bold ${c.text} mb-1`}>{unitCfg.callsign}</p>
          <p className="text-sm text-slate-500 mb-6">{unitCfg.role}</p>
          <p className="text-xs text-slate-700 max-w-xs leading-relaxed">
            Waiting for dispatcher assignment. Updates automatically.
          </p>
          {geoState === 'denied' && (
            <div className="mt-6 px-4 py-3 rounded-xl border border-amber-900 bg-amber-950/30 max-w-xs text-left">
              <p className="text-xs font-black text-amber-400 mb-1">GPS Access Denied</p>
              <p className="text-xs text-slate-500 leading-relaxed">
                GPS requires <strong className="text-slate-400">HTTPS</strong>. Use{' '}
                <strong className="text-slate-400">localhost</strong> or Firebase Hosting URL for location access.
              </p>
            </div>
          )}
        </div>
      </div>
    )
  }

  /* ── MISSION COMPLETE splash ─────────────────────────────────────────────── */
  if (missionDone) {
    return (
      <div className="min-h-screen bg-[#030805] text-slate-200 flex flex-col items-center justify-center p-8 text-center"
           style={{ fontFamily: 'system-ui, sans-serif' }}>
        <div className="text-7xl mb-6">✅</div>
        <p className="text-4xl font-black text-green-400 mb-2">MISSION COMPLETE</p>
        <p className={`text-xl font-black mb-1 ${c.text}`}>{unitCfg.callsign}</p>
        <p className="text-base text-slate-400 mb-6">{assignment.hospital_name}</p>
        <div className="bg-[#0a1f10] border border-green-800 rounded-2xl px-6 py-4 mb-6">
          <p className="text-sm text-slate-400">Patients delivered: <strong className="text-white text-lg">{assignment.patients_assigned}</strong></p>
          <p className="text-sm text-slate-400 mt-1">Completed at: <strong className="text-slate-300">{new Date().toLocaleTimeString()}</strong></p>
        </div>
        <p className="text-xs text-slate-600">Returning to STANDBY…</p>
      </div>
    )
  }

  /* ── ACTIVE assignment screen ────────────────────────────────────────────── */
  return (
    <div className="min-h-screen bg-[#080a0f] text-slate-200" style={{ fontFamily: 'system-ui, sans-serif' }}>

      {/* Header */}
      <div className={`bg-gradient-to-b ${c.grad} to-[#080a0f] border-b ${c.ring} px-4 py-4`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-3xl">🚑</span>
            <div>
              <p className={`text-xl font-black tracking-wider ${c.text}`}>{unitCfg.callsign}</p>
              <p className="text-xs text-slate-500">{unitCfg.role}</p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span className="text-xs text-green-400 font-black">ONLINE</span>
            </div>
            <span className={`text-xs px-2.5 py-0.5 rounded-full border font-black ${statusCfg.badge}`}>
              {statusCfg.label}
            </span>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="p-4 space-y-3 pb-10">

        {/* Phase progress bar */}
        <div className="flex gap-1">
          {['dispatched', 'en_route', 'on_scene', 'completed'].map((phase, i) => {
            const phases = ['dispatched', 'en_route', 'on_scene', 'completed']
            const currentIdx = phases.indexOf(crewStatus)
            const isDone = i <= currentIdx
            return (
              <div key={phase} className={`flex-1 h-1 rounded-full transition-colors duration-500 ${
                isDone ? (phase === 'completed' ? 'bg-green-500' : `${c.navBtn.split(' ')[0]}`) : 'bg-[#2d3148]'
              }`} />
            )
          })}
        </div>

        {/* Navigate CTA */}
        {navUrl ? (
          <a href={navUrl} target="_blank" rel="noopener noreferrer"
            className={`flex items-center justify-center gap-2 w-full py-4 rounded-2xl font-black text-base
                        text-white border-2 ${c.ring} ${c.navBtn} shadow-lg transition-all active:scale-95`}>
            <span>🗺</span>
            <span>{navLabel(crewPos, hasScene, atScene)}</span>
          </a>
        ) : (
          <div className="w-full text-center py-3 rounded-2xl border-2 border-slate-700 bg-slate-900/50 text-slate-500 text-sm">
            Navigation unavailable — no hospital coordinates
          </div>
        )}

        {/* GPS status */}
        <div className="flex gap-2 flex-wrap">
          <span className={`text-xs px-2.5 py-1 rounded-lg border font-semibold ${
            geoState === 'ok'         ? 'bg-green-950/40 border-green-800 text-green-400' :
            geoState === 'denied'     ? 'bg-amber-950/40 border-amber-800 text-amber-400' :
            geoState === 'requesting' ? 'bg-slate-900 border-slate-700 text-slate-500' :
                                        'bg-slate-900 border-slate-700 text-slate-600'
          }`}>
            {geoState === 'ok'         ? '📍 GPS locked' :
             geoState === 'denied'     ? '⚠ GPS denied' :
             geoState === 'requesting' ? '⏳ Getting GPS…' : '📍 GPS unsupported'}
          </span>
          {hasScene && !atScene && (
            <span className="text-xs px-2.5 py-1 rounded-lg border border-blue-800 bg-blue-950/30 text-blue-400 font-semibold">
              Route: scene → hospital
            </span>
          )}
          {atScene && (
            <span className="text-xs px-2.5 py-1 rounded-lg border border-orange-800 bg-orange-950/30 text-orange-400 font-semibold">
              At scene — routing to hospital
            </span>
          )}
        </div>

        {/* Mission banner */}
        <div className={`rounded-2xl border-2 p-4 ${
          crewStatus === 'on_scene'  ? 'border-orange-700 bg-orange-950/20' :
          crewStatus === 'en_route'  ? 'border-green-700 bg-green-950/20'   :
          crewStatus === 'completed' ? 'border-green-600 bg-green-950/30'   :
                                      'border-blue-700 bg-blue-950/20'
        }`}>
          <div className="flex items-center justify-between mb-1">
            <p className={`text-xs font-black uppercase tracking-widest ${
              crewStatus === 'on_scene'  ? 'text-orange-400' :
              crewStatus === 'en_route'  ? 'text-green-400'  :
              crewStatus === 'completed' ? 'text-green-300'  : 'text-blue-400'
            }`}>
              {crewStatus === 'dispatched' ? 'MISSION ACTIVE'       :
               crewStatus === 'en_route'   ? '✓ EN ROUTE'           :
               crewStatus === 'on_scene'   ? '🚨 ON SCENE'          : '✓ MISSION COMPLETE'}
            </p>
            {assignment.dispatched_at && (
              <p className="text-xs text-slate-600">{new Date(assignment.dispatched_at).toLocaleTimeString()}</p>
            )}
          </div>
          <p className="text-2xl font-black text-white leading-tight">{assignment.hospital_name || '—'}</p>
          {assignment.area && <p className="text-base text-slate-400 mt-0.5">{assignment.area}</p>}
          {hasScene && (
            <div className="mt-3 pt-3 border-t border-[#2d3148]">
              <p className="text-xs font-black text-slate-500 uppercase tracking-widest mb-0.5">Incident Scene</p>
              <p className="text-xs text-slate-400 font-mono">
                {Number(assignment.incident_lat).toFixed(5)}, {Number(assignment.incident_lon).toFixed(5)}
              </p>
            </div>
          )}
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-2 gap-3">
          <ETACountdown dispatchedAt={assignment.dispatched_at} etaMinutes={assignment.eta_minutes} />
          {assignment.available_icu != null && (
            <div className="rounded-2xl border border-[#2d3148] bg-[#1a1d2e] p-3 text-center">
              <p className="text-3xl font-black text-green-400">{assignment.available_icu}</p>
              <p className="text-xs text-slate-500 mt-0.5">ICU beds</p>
            </div>
          )}
          {assignment.trauma_centre && (
            <div className="rounded-2xl border border-red-800 bg-red-950/40 p-3 text-center">
              <p className="text-sm font-black text-red-400">TRAUMA CTR</p>
              <p className="text-xs text-slate-500">Designated facility</p>
            </div>
          )}
          {assignment.phone && (
            <a href={`tel:${assignment.phone}`}
               className="rounded-2xl border border-[#2d3148] bg-[#1a1d2e] p-3 text-center block active:bg-[#2d3148]">
              <p className="text-sm font-black text-blue-400">{assignment.phone}</p>
              <p className="text-xs text-slate-500 mt-0.5">Tap to call</p>
            </a>
          )}
        </div>

        {/* Patient load */}
        {sev && (
          <div className={`rounded-2xl border-2 p-5 ${sev.border} ${sev.bg}`}>
            <div className="flex items-end justify-between">
              <div>
                <p className={`text-xs font-black uppercase tracking-widest opacity-60 ${sev.text}`}>Patient Load</p>
                <p className="text-6xl font-black text-white mt-1 leading-none">{assignment.patients_assigned ?? 0}</p>
                <p className={`text-2xl font-black mt-2 ${sev.text}`}>{sev.label}</p>
                {assignment.injury_type && (
                  <p className={`text-sm opacity-70 mt-0.5 capitalize ${sev.text}`}>{assignment.injury_type}</p>
                )}
              </div>
              <span className={`text-8xl opacity-10 font-black ${sev.text}`}>+</span>
            </div>
          </div>
        )}

        {/* Pre-arrival checklist */}
        <div className="rounded-2xl border border-[#2d3148] bg-[#1a1d2e] overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-[#2d3148]">
            <span>📋</span>
            <p className="text-xs font-black text-white uppercase tracking-widest">Pre-Arrival Checklist</p>
            {assignment.injury_type && (
              <span className={`ml-auto text-xs px-2.5 py-0.5 rounded-full border font-black ${c.chip}`}>
                {assignment.injury_type}
              </span>
            )}
          </div>
          <div className="px-4 py-2 divide-y divide-[#1e2235]">
            {checks.map((item, i) => <CheckItem key={i} text={item} />)}
          </div>
        </div>

        {/* AI rationale */}
        {assignment.reason && (
          <div className="rounded-2xl border border-[#2d3148] bg-[#1a1d2e] p-4">
            <p className="text-xs font-black text-slate-600 uppercase tracking-widest mb-2">AI Routing Rationale</p>
            <p className="text-sm text-slate-300 leading-relaxed">{assignment.reason}</p>
          </div>
        )}

        {/* ── Action buttons — sequential flow ── */}
        <div className="space-y-3">

          {/* Step 1: Acknowledge */}
          <button type="button" onClick={handleAcknowledge} disabled={crewStatus !== 'dispatched'}
            className={`w-full py-4 rounded-2xl font-black text-base transition-all active:scale-95 border-2 ${
              crewStatus === 'dispatched'
                ? `${c.navBtn} text-white ${c.ring} shadow-lg`
                : crewStatus !== 'dispatched'
                  ? 'bg-green-950/30 border-green-800 text-green-500 opacity-60'
                  : 'bg-[#1a1d2e] border-[#2d3148] text-slate-500'
            }`}>
            {crewStatus === 'dispatched' ? 'ACKNOWLEDGE DISPATCH'
              : `✓ ACKNOWLEDGED`}
          </button>

          {/* Step 2: On Scene */}
          {crewStatus !== 'dispatched' && (
            <button type="button" onClick={handleOnScene} disabled={crewStatus !== 'en_route'}
              className={`w-full py-4 rounded-2xl font-black text-base transition-all active:scale-95 border-2 ${
                crewStatus === 'en_route'
                  ? 'bg-orange-600 hover:bg-orange-500 text-white border-orange-500 shadow-lg shadow-orange-900/30'
                  : 'bg-orange-950/30 border-orange-900 text-orange-500 opacity-60'
              }`}>
              {crewStatus === 'en_route' ? 'MARK ARRIVED AT SCENE'
                : crewStatus === 'on_scene' ? '✓ ON SCENE'
                : '✓ ON SCENE'}
            </button>
          )}

          {/* Step 3: Mission Complete */}
          {(crewStatus === 'on_scene' || crewStatus === 'completed') && (
            <button type="button" onClick={handleComplete} disabled={crewStatus !== 'on_scene'}
              className={`w-full py-5 rounded-2xl font-black text-lg transition-all active:scale-95 border-2 ${
                crewStatus === 'on_scene'
                  ? 'bg-green-600 hover:bg-green-500 text-white border-green-500 shadow-xl shadow-green-900/40'
                  : 'bg-green-950/30 border-green-800 text-green-500 opacity-60'
              }`}>
              {crewStatus === 'on_scene' ? 'MISSION COMPLETE — PATIENTS DELIVERED' : '✓ COMPLETE'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
