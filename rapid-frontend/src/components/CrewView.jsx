import React, { useEffect, useRef, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'

import { db } from '../firebaseConfig.js'

const UNIT_CFG = {
  AMB_1: { callsign: 'ALPHA-1', role: 'Advanced Life Support', color: 'blue' },
  AMB_2: { callsign: 'BRAVO-2', role: 'Basic Life Support', color: 'red' },
  AMB_3: { callsign: 'CHARLIE-3', role: 'Specialist Response', color: 'green' },
  AMB_4: { callsign: 'DELTA-4', role: 'Mass Casualty Response', color: 'violet' },
  AMB_5: { callsign: 'ECHO-5', role: 'Paediatric Rapid Response', color: 'orange' },
}

const COLOR = {
  blue: { grad: 'from-blue-950', ring: 'border-blue-600', text: 'text-blue-400', button: 'bg-blue-600 hover:bg-blue-500', chip: 'bg-blue-900/40 border-blue-600 text-blue-300' },
  red: { grad: 'from-red-950', ring: 'border-red-600', text: 'text-red-400', button: 'bg-red-600 hover:bg-red-500', chip: 'bg-red-900/40 border-red-600 text-red-300' },
  green: { grad: 'from-green-950', ring: 'border-green-600', text: 'text-green-400', button: 'bg-green-600 hover:bg-green-500', chip: 'bg-green-900/40 border-green-600 text-green-300' },
  violet: { grad: 'from-violet-950', ring: 'border-violet-600', text: 'text-violet-400', button: 'bg-violet-600 hover:bg-violet-500', chip: 'bg-violet-900/40 border-violet-600 text-violet-300' },
  orange: { grad: 'from-orange-950', ring: 'border-orange-600', text: 'text-orange-400', button: 'bg-orange-600 hover:bg-orange-500', chip: 'bg-orange-900/40 border-orange-600 text-orange-300' },
}

const STATUS_ORDER = ['dispatched', 'en_route', 'on_scene', 'transporting', 'closed']
const STATUS_CFG = {
  dispatched: { label: 'DISPATCHED', badge: 'bg-blue-900/60 border-blue-700 text-blue-400 animate-pulse' },
  en_route: { label: 'EN ROUTE', badge: 'bg-green-900/60 border-green-700 text-green-400' },
  on_scene: { label: 'ON SCENE', badge: 'bg-orange-900/60 border-orange-700 text-orange-400' },
  transporting: { label: 'TRANSPORTING', badge: 'bg-violet-900/60 border-violet-700 text-violet-300' },
  closed: { label: 'CLOSED', badge: 'bg-emerald-900/60 border-emerald-700 text-emerald-300' },
}
const SYNC_COLOR = {
  online: 'text-green-400',
  syncing: 'text-amber-400',
  queued: 'text-amber-400',
  offline: 'text-red-400',
}
const STANDBY_DELAY_MS = 4500

const SEV = {
  critical: { bg: 'bg-red-950', border: 'border-red-700', text: 'text-red-300', label: 'CRITICAL' },
  moderate: { bg: 'bg-amber-950', border: 'border-amber-700', text: 'text-amber-300', label: 'MODERATE' },
  minor: { bg: 'bg-green-950', border: 'border-green-700', text: 'text-green-300', label: 'MINOR' },
}

const CHECKLISTS = {
  trauma: ['Spinal board ready', 'Cervical collar', 'Hemorrhage control kit', 'Dual IV setup', 'Airway kit'],
  cardiac: ['12-lead ECG ready', 'Defibrillator charged', 'Aspirin and GTN prepared', 'IV access ready', 'ACLS card'],
  burns: ['Sterile burn dressings', 'Fluids prepared', 'Analgesia ready', 'Space blanket', 'High-flow oxygen'],
  neuro: ['GCS chart ready', 'Blood glucose monitor', 'Suction ready', 'IV saline', 'FAST assessment card'],
  respiratory: ['High-flow oxygen', 'Nebulizer prepared', 'Suction tested', 'Pulse oximeter', 'BVM ready'],
  ortho: ['Traction splint', 'SAM splints', 'Analgesia drawn', 'IV access', 'Pelvic binder standby'],
  general: ['Vitals monitor ready', 'IV fluids ready', 'Oxygen therapy ready', 'First-aid kit checked', 'Handover form ready'],
}

function parseUnitFromHash() {
  try {
    const hash = window.location.hash
    const query = hash.includes('?') ? hash.split('?')[1] : ''
    return new URLSearchParams(query).get('unit') || 'AMB_1'
  } catch {
    return 'AMB_1'
  }
}

function assignmentKey(unitId) { return `rapid_crew_${unitId}` }
function queueKey(unitId) { return `rapid_status_queue_${unitId}` }

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value))
}

function isStandbyDoc(data) {
  return !data || data.status === 'standby'
}

function buildStatusPatch(status, timestamp) {
  const patch = { status, updated_at: timestamp }
  if (status === 'en_route') patch.acknowledged_at = timestamp
  if (status === 'on_scene') patch.on_scene_at = timestamp
  if (status === 'transporting') patch.transporting_at = timestamp
  if (status === 'closed') patch.closed_at = timestamp
  return patch
}

function distKm(lat1, lon1, lat2, lon2) {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.asin(Math.sqrt(a))
}

function buildNavUrl(assignment, crewPos, toHospital) {
  if (!assignment?.hospital_lat || !assignment?.hospital_lon) return null
  const hospital = `${assignment.hospital_lat},${assignment.hospital_lon}`
  const hasScene = assignment?.incident_lat != null && assignment?.incident_lon != null
  const scene = hasScene ? `${assignment.incident_lat},${assignment.incident_lon}` : null
  const gpsNearby = crewPos && hasScene
    ? distKm(crewPos.lat, crewPos.lon, assignment.incident_lat, assignment.incident_lon) <= 50
    : crewPos && assignment?.hospital_lat != null
    ? distKm(crewPos.lat, crewPos.lon, assignment.hospital_lat, assignment.hospital_lon) <= 50
    : false

  let url = 'https://www.google.com/maps/dir/?api=1'
  if (toHospital) {
    if (gpsNearby) url += `&origin=${crewPos.lat},${crewPos.lon}`
    else if (scene) url += `&origin=${scene}`
    url += `&destination=${hospital}`
  } else if (scene) {
    if (gpsNearby) url += `&origin=${crewPos.lat},${crewPos.lon}&waypoints=${scene}`
    else url += `&origin=${scene}`
    url += `&destination=${hospital}`
  } else {
    if (gpsNearby) url += `&origin=${crewPos.lat},${crewPos.lon}`
    url += `&destination=${hospital}`
  }
  return `${url}&travelmode=driving`
}

function ETACountdown({ dispatchedAt, etaMinutes }) {
  const [minutes, setMinutes] = useState(null)
  useEffect(() => {
    if (!dispatchedAt || etaMinutes == null) return
    const end = new Date(dispatchedAt).getTime() + Number(etaMinutes) * 60_000
    const tick = () => setMinutes(Math.max(0, Math.ceil((end - Date.now()) / 60_000)))
    tick()
    const timer = setInterval(tick, 15_000)
    return () => clearInterval(timer)
  }, [dispatchedAt, etaMinutes])

  if (minutes === null) return null
  return (
    <div className="rounded-2xl border border-[#2d3148] bg-[#1a1d2e] p-3 text-center">
      {minutes === 0 ? <><p className="text-xl font-black text-green-400">ARRIVED</p><p className="mt-0.5 text-xs text-slate-500">ETA elapsed</p></> : <><p className="text-3xl font-black text-blue-400">{minutes}</p><p className="mt-0.5 text-xs text-slate-500">min ETA</p></>}
    </div>
  )
}

function CheckItem({ text }) {
  const [done, setDone] = useState(false)
  return (
    <button type="button" onClick={() => setDone(value => !value)} className={`flex w-full items-center gap-3 rounded-lg px-1 py-2.5 text-left transition-colors ${done ? 'opacity-40' : 'active:bg-white/5'}`}>
      <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${done ? 'border-green-500 bg-green-600 text-white' : 'border-slate-600'}`}>{done && <span aria-hidden="true" className="text-xs font-black">✓</span>}</span>
      <span className={`text-sm leading-snug ${done ? 'text-slate-600 line-through' : 'text-slate-300'}`}>{text}</span>
    </button>
  )
}

function SceneAssessButton({ unitId, incidentId }) {
  const [state, setState] = useState('idle')
  const [result, setResult] = useState(null)
  const [aggregated, setAggregated] = useState(null)
  const fileRef = useRef(null)

  async function handleFile(event) {
    const file = event.target.files?.[0]
    if (!file) return
    setState('loading')
    setResult(null)
    setAggregated(null)
    try {
      const form = new FormData()
      form.append('image', file)
      form.append('unit_id', unitId)
      if (incidentId) form.append('incident_id', incidentId)
      const response = await fetch('/api/scene-assess', { method: 'POST', body: form })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      setResult(data)
      setAggregated(data.aggregated || null)
      setState('result')
    } catch {
      setState('error')
    } finally {
      event.target.value = ''
    }
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-violet-800 bg-violet-950/20">
      <div className="border-b border-violet-900 px-4 py-3"><p className="text-xs font-black uppercase tracking-widest text-violet-300">AI Scene Assessment</p></div>
      <div className="space-y-2 px-4 py-3">
        <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handleFile} />
        <button type="button" onClick={() => fileRef.current?.click()} disabled={state === 'loading'} className="w-full rounded-xl border-2 border-violet-700 bg-violet-900/40 py-3 text-sm font-black text-violet-300 transition-all hover:bg-violet-800/40 disabled:opacity-50">
          {state === 'loading' ? 'Analysing scene...' : 'CAPTURE SCENE PHOTO'}
        </button>
        {result && <div className="space-y-2 pt-1 text-xs">{result.estimated_casualties != null && <p className="text-slate-300">Estimated casualties: {result.estimated_casualties}</p>}{result.triage_notes && <p className="italic leading-relaxed text-slate-400">{result.triage_notes}</p>}{aggregated?.report_count > 1 && <p className="text-blue-300">{aggregated.report_count} crews reported | {aggregated.confidence}</p>}</div>}
        {state === 'error' && <p className="text-center text-xs text-red-400">Assessment failed. Check backend.</p>}
      </div>
    </div>
  )
}

export default function CrewView() {
  const [unitId] = useState(parseUnitFromHash)
  const [assignment, setAssignment] = useState(null)
  const [crewStatus, setCrewStatus] = useState('standby')
  const [syncState, setSyncState] = useState(navigator.onLine ? 'online' : 'offline')
  const [crewPos, setCrewPos] = useState(null)
  const [geoState, setGeoState] = useState('requesting')
  const standbyTimer = useRef(null)
  const speakKey = useRef('')
  const flushing = useRef(false)
  const knownUpdatedAt = useRef(0)

  const unitCfg = UNIT_CFG[unitId] || { callsign: unitId, role: 'Emergency Response', color: 'blue' }
  const color = COLOR[unitCfg.color] || COLOR.blue
  const sev = assignment ? (SEV[assignment.severity] || SEV.minor) : null
  const checks = CHECKLISTS[assignment?.injury_type] || CHECKLISTS.general
  const statusCfg = STATUS_CFG[crewStatus] || STATUS_CFG.dispatched
  const toHospital = ['transporting', 'closed'].includes(crewStatus)
  const navUrl = buildNavUrl(assignment, crewPos, toHospital)
  const gpsNearby = crewPos && assignment?.incident_lat != null && assignment?.incident_lon != null
    ? distKm(crewPos.lat, crewPos.lon, assignment.incident_lat, assignment.incident_lon) <= 50
    : false

  function applyData(data) {
    if (isStandbyDoc(data)) {
      setAssignment(null)
      setCrewStatus('standby')
      // Reset the timestamp guard so the next dispatch is never silently rejected
      // due to a stale timestamp from a previous assignment.
      knownUpdatedAt.current = 0
      if (standbyTimer.current) { clearTimeout(standbyTimer.current); standbyTimer.current = null }
      return
    }
    const rawStatus = data.status === 'completed' ? 'closed' : (data.status || 'dispatched')
    const normalized = rawStatus === data.status ? data : { ...data, status: rawStatus }
    const ts = Date.parse(normalized.updated_at || '') || 0
    if (ts) knownUpdatedAt.current = Math.max(knownUpdatedAt.current, ts)
    setAssignment(normalized)
    setCrewStatus(rawStatus)
    if (rawStatus === 'closed') {
      const closedAt = Date.parse(normalized.closed_at || '') || 0
      const elapsed = closedAt ? Date.now() - closedAt : 0
      const remaining = Math.max(0, STANDBY_DELAY_MS - (Number.isFinite(elapsed) ? elapsed : 0))
      scheduleStandby(normalized, remaining)
    } else if (standbyTimer.current) {
      clearTimeout(standbyTimer.current)
      standbyTimer.current = null
    }
  }

  function writeLocal(nextDoc) {
    writeJson(assignmentKey(unitId), nextDoc)
    applyData(nextDoc)
  }

  function readQueue() {
    return readJson(queueKey(unitId), [])
  }

  function saveQueue(queue) {
    writeJson(queueKey(unitId), queue)
  }

  async function sendStatus(payload) {
    const response = await fetch(`/api/crew/${unitId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      const err = new Error(`HTTP ${response.status}`)
      err.status = response.status
      err.permanent = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
      throw err
    }
  }

  function headIs(head, entry) {
    return !!entry && entry.timestamp === head.timestamp && entry.status === head.status && entry.incident_id === head.incident_id
  }

  async function flushQueue() {
    if (flushing.current || !navigator.onLine) return
    if (!readQueue().length) { setSyncState('online'); return }

    flushing.current = true
    setSyncState('syncing')
    try {
      while (navigator.onLine) {
        const queue = readQueue()
        if (!queue.length) break
        const head = queue[0]
        let drop = true
        try {
          await sendStatus(head)
        } catch (err) {
          if (!err?.permanent) { setSyncState('queued'); return }
        }
        if (drop) {
          const current = readQueue()
          if (headIs(head, current[0])) saveQueue(current.slice(1))
        }
      }
      setSyncState(navigator.onLine ? 'online' : 'queued')
    } finally {
      flushing.current = false
    }
  }

  async function queueOrSend(payload) {
    saveQueue([...readQueue(), payload])
    setSyncState(navigator.onLine ? 'syncing' : 'queued')
    if (navigator.onLine) await flushQueue()
  }

  function scheduleStandby(baseDoc, delayMs = STANDBY_DELAY_MS) {
    if (standbyTimer.current) clearTimeout(standbyTimer.current)
    standbyTimer.current = setTimeout(() => {
      standbyTimer.current = null
      // Abort if a newer dispatch arrived while we were waiting
      const current = readJson(assignmentKey(unitId), null)
      const baseClosedAt = Date.parse(baseDoc.closed_at || '') || 0
      const currentDispatchedAt = Date.parse(current?.dispatched_at || '') || 0
      if (currentDispatchedAt > baseClosedAt) return
      const timestamp = new Date().toISOString()
      writeLocal({ ...baseDoc, status: 'standby', updated_at: timestamp })
      queueOrSend({ incident_id: baseDoc.incident_id, status: 'standby', notes: 'Unit back in standby.', timestamp })
    }, Math.max(0, delayMs))
  }

  async function transitionTo(status, notes) {
    if (!assignment || crewStatus === status) return
    const timestamp = new Date().toISOString()
    const nextDoc = { ...assignment, ...buildStatusPatch(status, timestamp) }
    writeLocal(nextDoc)
    await queueOrSend({ incident_id: assignment.incident_id, status, notes, timestamp })
    if (status === 'closed') scheduleStandby(nextDoc)
  }

  useEffect(() => {
    if (!navigator.geolocation) {
      setGeoState('unsupported')
      return
    }
    navigator.geolocation.getCurrentPosition(
      position => { setCrewPos({ lat: position.coords.latitude, lon: position.coords.longitude }); setGeoState('ok') },
      () => setGeoState('denied'),
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 60_000 },
    )
  }, [])

  useEffect(() => {
    applyData(readJson(assignmentKey(unitId), null))
    const onStorage = event => {
      if (event.key !== assignmentKey(unitId)) return
      try { applyData(event.newValue ? JSON.parse(event.newValue) : null) } catch {}
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [unitId])

  useEffect(() => {
    if (!db) return
    let unsub
    try {
      unsub = onSnapshot(doc(db, 'crew_assignments', unitId), snapshot => {
        try {
          if (!snapshot.exists()) return
          const data = snapshot.data()
          const serverAt = Date.parse(data.updated_at || '') || 0
          if (serverAt && knownUpdatedAt.current && serverAt < knownUpdatedAt.current) return
          applyData(data)
        } catch {}
      })
    } catch {}
    return () => { try { unsub?.() } catch {} }
  }, [unitId])

  useEffect(() => {
    const onOnline = () => { setSyncState('syncing'); flushQueue() }
    const onOffline = () => setSyncState(readQueue().length ? 'queued' : 'offline')
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    flushQueue()
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [unitId])

  useEffect(() => {
    if (!assignment) {
      speakKey.current = ''
      return
    }
    const key = `${assignment.incident_id || 'incident'}:${assignment.dispatched_at || ''}`
    if (speakKey.current === key) return
    speakKey.current = key
    try {
      const count = Number(assignment.patients_assigned) || 0
      const severityWord = assignment.severity ? ` ${assignment.severity}` : ''
      const noun = count === 1 ? 'patient' : 'patients'
      const utterance = new SpeechSynthesisUtterance(`${unitCfg.callsign}. Dispatch confirmed. Proceed to ${assignment.hospital_name}. ${count}${severityWord} ${noun}.`)
      utterance.rate = 0.92
      window.speechSynthesis?.speak(utterance)
    } catch {}
  }, [assignment, unitCfg.callsign])

  useEffect(() => () => { if (standbyTimer.current) clearTimeout(standbyTimer.current) }, [])

  if (!assignment) {
    return (
      <div className="min-h-screen bg-[#080a0f] text-slate-200" style={{ fontFamily: 'system-ui, sans-serif' }}>
        <div className={`border-b ${color.ring} bg-gradient-to-b ${color.grad} to-[#080a0f] px-4 py-5`}>
          <div className="flex items-center justify-between">
            <div><p className={`text-xl font-black tracking-wider ${color.text}`}>{unitCfg.callsign}</p><p className="text-xs text-slate-500">{unitCfg.role}</p></div>
            <span className="text-xs font-black text-green-400">ONLINE</span>
          </div>
        </div>
        <div className="flex min-h-[calc(100vh-88px)] flex-col items-center justify-center p-8 text-center">
          <p className="mb-2 text-3xl font-black text-white">STANDBY</p>
          <p className={`mb-1 text-base font-bold ${color.text}`}>{unitCfg.callsign}</p>
          <p className="text-sm text-slate-500">{unitCfg.role}</p>
          <p className="mt-6 max-w-xs text-xs leading-relaxed text-slate-700">Waiting for dispatcher assignment. Offline updates will sync when the device reconnects.</p>
        </div>
      </div>
    )
  }

  if (crewStatus === 'closed') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-[#030805] p-8 text-center text-slate-200" style={{ fontFamily: 'system-ui, sans-serif' }}>
        <p className="mb-2 text-4xl font-black text-green-400">MISSION CLOSED</p>
        <p className={`mb-1 text-xl font-black ${color.text}`}>{unitCfg.callsign}</p>
        <p className="mb-6 text-base text-slate-400">{assignment.hospital_name}</p>
        <div className="mb-6 rounded-2xl border border-green-800 bg-[#0a1f10] px-6 py-4">
          <p className="text-sm text-slate-400">Patients delivered: <strong className="text-lg text-white">{assignment.patients_assigned}</strong></p>
          <p className="mt-1 text-sm text-slate-400">Status sync: <strong className="text-slate-300">{syncState.toUpperCase()}</strong></p>
        </div>
        <p className="text-xs text-slate-600">Returning to standby...</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#080a0f] text-slate-200" style={{ fontFamily: 'system-ui, sans-serif' }}>
      <div className={`border-b ${color.ring} bg-gradient-to-b ${color.grad} to-[#080a0f] px-4 py-4`}>
        <div className="flex items-center justify-between">
          <div><p className={`text-xl font-black tracking-wider ${color.text}`}>{unitCfg.callsign}</p><p className="text-xs text-slate-500">{unitCfg.role}</p></div>
          <div className="flex flex-col items-end gap-1.5">
            <span className={`text-xs font-black ${SYNC_COLOR[syncState] || 'text-slate-400'}`}>{syncState.toUpperCase()}</span>
            <span className={`rounded-full border px-2.5 py-0.5 text-xs font-black ${statusCfg.badge}`}>{statusCfg.label}</span>
          </div>
        </div>
      </div>

      <div className="space-y-3 p-4 pb-10">
        <div className="flex gap-1">{STATUS_ORDER.map((phase, index) => { const done = index <= STATUS_ORDER.indexOf(crewStatus); return <div key={phase} className={`h-1 flex-1 rounded-full ${done ? (phase === 'closed' ? 'bg-emerald-500' : color.button.split(' ')[0]) : 'bg-[#2d3148]'}`} /> })}</div>

        {navUrl ? <a href={navUrl} target="_blank" rel="noopener noreferrer" className={`flex w-full items-center justify-center gap-2 rounded-2xl border-2 ${color.ring} ${color.button} py-4 text-base font-black text-white shadow-lg`}>NAVIGATE {toHospital ? 'TO HOSPITAL' : 'TO SCENE'}</a> : <div className="w-full rounded-2xl border-2 border-slate-700 bg-slate-900/50 py-3 text-center text-sm text-slate-500">Navigation unavailable</div>}

        <div className="flex flex-wrap gap-2 text-xs">
          <span className={`rounded-lg border px-2.5 py-1 font-semibold ${gpsNearby ? 'border-green-800 bg-green-950/40 text-green-400' : geoState === 'denied' ? 'border-slate-700 bg-slate-900 text-slate-500' : 'border-amber-800 bg-amber-950/40 text-amber-400'}`}>{gpsNearby ? 'GPS locked near scene' : geoState === 'denied' ? 'GPS denied' : geoState === 'unsupported' ? 'GPS unsupported' : geoState === 'ok' ? 'GPS active' : 'Locating GPS'}</span>
          {assignment?.specialties?.length > 0 && assignment.specialties.slice(0, 2).map(specialty => <span key={specialty} className={`rounded-lg border px-2.5 py-1 font-semibold ${color.chip}`}>{specialty}</span>)}
        </div>

        <div className={`rounded-2xl border-2 p-4 ${crewStatus === 'transporting' ? 'border-violet-700 bg-violet-950/20' : crewStatus === 'on_scene' ? 'border-orange-700 bg-orange-950/20' : crewStatus === 'en_route' ? 'border-green-700 bg-green-950/20' : 'border-blue-700 bg-blue-950/20'}`}>
          <div className="mb-1 flex items-center justify-between"><p className="text-xs font-black uppercase tracking-widest text-slate-400">{crewStatus === 'dispatched' ? 'MISSION ACTIVE' : crewStatus === 'en_route' ? 'EN ROUTE' : crewStatus === 'on_scene' ? 'ON SCENE' : 'TRANSPORTING'}</p>{assignment.dispatched_at && <p className="text-xs text-slate-600">{new Date(assignment.dispatched_at).toLocaleTimeString()}</p>}</div>
          <p className="text-2xl font-black text-white">{assignment.hospital_name || '-'}</p>
          {assignment.area && <p className="mt-0.5 text-base text-slate-400">{assignment.area}</p>}
          {assignment.incident_lat != null && assignment.incident_lon != null && <p className="mt-3 border-t border-[#2d3148] pt-3 font-mono text-xs text-slate-400">{Number(assignment.incident_lat).toFixed(5)}, {Number(assignment.incident_lon).toFixed(5)}</p>}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <ETACountdown dispatchedAt={assignment.dispatched_at} etaMinutes={assignment.eta_minutes} />
          {assignment.available_icu != null && <div className="rounded-2xl border border-[#2d3148] bg-[#1a1d2e] p-3 text-center"><p className="text-3xl font-black text-green-400">{assignment.available_icu}</p><p className="mt-0.5 text-xs text-slate-500">ICU beds</p></div>}
          {assignment.trauma_centre && <div className="rounded-2xl border border-red-800 bg-red-950/40 p-3 text-center"><p className="text-sm font-black text-red-400">TRAUMA CTR</p><p className="text-xs text-slate-500">Designated facility</p></div>}
          {assignment.phone && <a href={`tel:${assignment.phone}`} className="block rounded-2xl border border-[#2d3148] bg-[#1a1d2e] p-3 text-center"><p className="text-sm font-black text-blue-400">{assignment.phone}</p><p className="mt-0.5 text-xs text-slate-500">Tap to call</p></a>}
        </div>

        {sev && <div className={`rounded-2xl border-2 p-5 ${sev.border} ${sev.bg}`}><p className={`text-xs font-black uppercase tracking-widest opacity-60 ${sev.text}`}>Patient Load</p><p className="mt-1 text-6xl font-black leading-none text-white">{assignment.patients_assigned ?? 0}</p><p className={`mt-2 text-2xl font-black ${sev.text}`}>{sev.label}</p>{assignment.injury_type && <p className={`mt-0.5 text-sm capitalize opacity-70 ${sev.text}`}>{assignment.injury_type}</p>}</div>}

        <div className="overflow-hidden rounded-2xl border border-[#2d3148] bg-[#1a1d2e]">
          <div className="flex items-center gap-2 border-b border-[#2d3148] px-4 py-3"><p className="text-xs font-black uppercase tracking-widest text-white">Pre-Arrival Checklist</p>{assignment.injury_type && <span className={`ml-auto rounded-full border px-2.5 py-0.5 text-xs font-black ${color.chip}`}>{assignment.injury_type}</span>}</div>
          <div className="divide-y divide-[#1e2235] px-4 py-2">{checks.map(item => <CheckItem key={item} text={item} />)}</div>
        </div>

        {crewStatus === 'on_scene' && <SceneAssessButton unitId={unitId} incidentId={assignment?.incident_id} />}

        {assignment.reason && <div className="rounded-2xl border border-[#2d3148] bg-[#1a1d2e] p-4"><p className="mb-2 text-xs font-black uppercase tracking-widest text-slate-600">AI Routing Rationale</p><p className="text-sm leading-relaxed text-slate-300">{assignment.reason}</p></div>}

        <div className="space-y-3">
          <button type="button" onClick={() => transitionTo('en_route', 'Crew acknowledged dispatch.')} disabled={crewStatus !== 'dispatched'} className={`w-full rounded-2xl border-2 py-4 text-base font-black ${crewStatus === 'dispatched' ? `${color.button} ${color.ring} text-white shadow-lg` : 'border-green-800 bg-green-950/30 text-green-500 opacity-60'}`}>{crewStatus === 'dispatched' ? 'ACKNOWLEDGE DISPATCH' : 'ACKNOWLEDGED'}</button>
          {crewStatus !== 'dispatched' && <button type="button" onClick={() => transitionTo('on_scene', 'Crew arrived on scene.')} disabled={crewStatus !== 'en_route'} className={`w-full rounded-2xl border-2 py-4 text-base font-black ${crewStatus === 'en_route' ? 'border-orange-500 bg-orange-600 text-white shadow-lg shadow-orange-900/30 hover:bg-orange-500' : 'border-orange-900 bg-orange-950/30 text-orange-500 opacity-60'}`}>{crewStatus === 'en_route' ? 'MARK ARRIVED AT SCENE' : 'ON SCENE'}</button>}
          {(crewStatus === 'on_scene' || crewStatus === 'transporting') && <button type="button" onClick={() => transitionTo('transporting', 'Crew departed scene for destination hospital.')} disabled={crewStatus !== 'on_scene'} className={`w-full rounded-2xl border-2 py-4 text-base font-black ${crewStatus === 'on_scene' ? 'border-violet-500 bg-violet-600 text-white shadow-lg shadow-violet-900/30 hover:bg-violet-500' : 'border-violet-900 bg-violet-950/30 text-violet-500 opacity-60'}`}>{crewStatus === 'on_scene' ? 'START TRANSPORT TO HOSPITAL' : 'TRANSPORT IN PROGRESS'}</button>}
          {(crewStatus === 'transporting' || crewStatus === 'closed') && <button type="button" onClick={() => transitionTo('closed', 'Patients handed over at destination hospital.')} disabled={crewStatus !== 'transporting'} className={`w-full rounded-2xl border-2 py-5 text-lg font-black ${crewStatus === 'transporting' ? 'border-green-500 bg-green-600 text-white shadow-xl shadow-green-900/40 hover:bg-green-500' : 'border-green-800 bg-green-950/30 text-green-500 opacity-60'}`}>{crewStatus === 'transporting' ? 'CLOSE MISSION - PATIENTS DELIVERED' : 'MISSION CLOSING'}</button>}
        </div>
      </div>
    </div>
  )
}
