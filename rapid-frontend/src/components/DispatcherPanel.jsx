import React, { useEffect, useRef, useState } from 'react'
import axios from 'axios'
import { doc, onSnapshot } from 'firebase/firestore'

import { db } from '../firebaseConfig.js'
import { getContact } from '../hospitalContacts.js'
import { buildCrewDispatchPayload } from '../lib/dispatchPayload.js'
import { recommendUnitForAssignment } from '../lib/unitRecommendation.js'
import SceneIntelPanel from './SceneIntelPanel.jsx'

const UNITS = ['AMB_1', 'AMB_2', 'AMB_3', 'AMB_4', 'AMB_5']
const LS_KEY = unitId => `rapid_crew_${unitId}`

const UNIT_CFG = {
  AMB_1: { callsign: 'ALPHA-1', idle: 'hover:border-blue-700 hover:text-blue-300', active: 'border-blue-500 bg-blue-900/50 text-blue-200' },
  AMB_2: { callsign: 'BRAVO-2', idle: 'hover:border-red-700 hover:text-red-300', active: 'border-red-500 bg-red-900/50 text-red-200' },
  AMB_3: { callsign: 'CHARLIE-3', idle: 'hover:border-green-700 hover:text-green-300', active: 'border-green-500 bg-green-900/50 text-green-200' },
  AMB_4: { callsign: 'DELTA-4', idle: 'hover:border-violet-700 hover:text-violet-300', active: 'border-violet-500 bg-violet-900/50 text-violet-200' },
  AMB_5: { callsign: 'ECHO-5', idle: 'hover:border-orange-700 hover:text-orange-300', active: 'border-orange-500 bg-orange-900/50 text-orange-200' },
}

const STATUS_META = {
  dispatched: { label: 'DISPATCHED', row: 'border-blue-800 bg-blue-950/30 text-blue-400', dot: 'bg-blue-500 animate-pulse', note: 'Waiting for acknowledgement.' },
  en_route: { label: 'EN ROUTE', row: 'border-green-800 bg-green-950/30 text-green-400', dot: 'bg-green-500', note: 'Crew acknowledged and is en route.' },
  on_scene: { label: 'ON SCENE', row: 'border-orange-800 bg-orange-950/30 text-orange-400', dot: 'bg-orange-500 animate-pulse', note: 'Crew is on scene.' },
  transporting: { label: 'TRANSPORTING', row: 'border-violet-800 bg-violet-950/30 text-violet-400', dot: 'bg-violet-500 animate-pulse', note: 'Crew is transporting to destination.' },
  closed: { label: 'CLOSED', row: 'border-emerald-800 bg-emerald-950/30 text-emerald-400', dot: 'bg-emerald-500', note: 'Mission closed, returning to standby.' },
  standby: { label: 'STANDBY', row: 'border-transparent text-slate-600', dot: 'bg-slate-700', note: 'Ready for next assignment.' },
}

const SEVERITY_META = {
  critical: 'border-red-700 bg-red-950/80 text-red-300',
  moderate: 'border-amber-700 bg-amber-950/80 text-amber-300',
  minor: 'border-green-700 bg-green-950/80 text-green-300',
}

function activeOrNull(data) {
  if (!data || data.status === 'standby') return null
  return data
}

function readCrewDoc(unitId) {
  try {
    const raw = localStorage.getItem(LS_KEY(unitId))
    return activeOrNull(raw ? JSON.parse(raw) : null)
  } catch {
    return null
  }
}

function useCrewDoc(unitId) {
  const [data, setData] = useState(() => readCrewDoc(unitId))

  useEffect(() => {
    function onStorage(event) {
      if (event.key !== LS_KEY(unitId)) return
      try { setData(activeOrNull(event.newValue ? JSON.parse(event.newValue) : null)) } catch {}
    }

    window.addEventListener('storage', onStorage)
    let unsub
    if (db) {
      try {
        unsub = onSnapshot(doc(db, 'crew_assignments', unitId), snap => {
          try { setData(snap.exists() ? activeOrNull(snap.data()) : null) } catch {}
        })
      } catch {}
    }

    return () => {
      window.removeEventListener('storage', onStorage)
      try { unsub?.() } catch {}
    }
  }, [unitId])

  return data
}

function useUnitDocsSnapshot() {
  const [unitDocs, setUnitDocs] = useState(() => UNITS.reduce((acc, unitId) => ({ ...acc, [unitId]: readCrewDoc(unitId) }), {}))
  const clearAt = useRef(0)

  useEffect(() => {
    function refresh() {
      if (Date.now() - clearAt.current < 2000) return
      setUnitDocs(UNITS.reduce((acc, unitId) => ({ ...acc, [unitId]: readCrewDoc(unitId) }), {}))
    }

    window.addEventListener('storage', refresh)
    const unsubs = []
    if (db) {
      try {
        UNITS.forEach(unitId => {
          unsubs.push(onSnapshot(doc(db, 'crew_assignments', unitId), snap => {
            if (Date.now() - clearAt.current < 2000) return
            setUnitDocs(prev => ({ ...prev, [unitId]: snap.exists() ? activeOrNull(snap.data()) : null }))
          }))
        })
      } catch {}
    }

    return () => {
      window.removeEventListener('storage', refresh)
      unsubs.forEach(unsub => { try { unsub?.() } catch {} })
    }
  }, [])

  return {
    unitDocs,
    upsertUnitDoc(unitId, data) {
      setUnitDocs(prev => ({ ...prev, [unitId]: activeOrNull(data) }))
    },
    async clearAllDocs() {
      clearAt.current = Date.now()
      UNITS.forEach(unitId => {
        localStorage.removeItem(`rapid_crew_${unitId}`)
        localStorage.removeItem(`rapid_status_queue_${unitId}`)
      })
      setUnitDocs(UNITS.reduce((acc, unitId) => ({ ...acc, [unitId]: null }), {}))
      try { await fetch('/api/crew/reset-all', { method: 'POST' }) } catch {}
    },
  }
}

function usePrealertStatus(prealertId) {
  const [data, setData] = useState(null)
  useEffect(() => {
    if (!prealertId || !db) { setData(null); return }
    let unsub
    try {
      unsub = onSnapshot(doc(db, 'hospital_prealerts', prealertId), snap => {
        setData(snap.exists() ? snap.data() : null)
      })
    } catch {}
    return () => { try { unsub?.() } catch {} }
  }, [prealertId])
  return data
}

function useCountdown(etaMinutes, dispatchedAt) {
  const [remaining, setRemaining] = useState(null)

  useEffect(() => {
    if (etaMinutes == null || !dispatchedAt) return
    const end = new Date(dispatchedAt).getTime() + Number(etaMinutes) * 60_000
    const tick = () => setRemaining(Math.max(0, end - Date.now()))
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [etaMinutes, dispatchedAt])

  if (remaining === null) return null
  const minutes = Math.floor(remaining / 60_000)
  const seconds = Math.floor((remaining % 60_000) / 1000)
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function findAssignmentDispatch(unitDocs, incidentId, assignment) {
  const hospitalName = assignment?.hospital ?? null
  const injuryType = assignment?.injury_type ?? null
  return Object.entries(unitDocs).find(([, doc]) =>
    doc &&
    doc.incident_id === incidentId &&
    (doc.hospital_name ?? null) === hospitalName &&
    Number(doc.patients_assigned || 0) === Number(assignment?.patients_assigned || 0) &&
    (doc.severity || 'minor') === (assignment?.severity || 'minor') &&
    (doc.injury_type ?? null) === injuryType
  ) || [null, null]
}

function CrewStatusRow({ unitId }) {
  const doc = useCrewDoc(unitId)
  const meta = STATUS_META[doc?.status || 'standby'] || STATUS_META.standby
  return (
    <div className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-xs ${meta.row}`}>
      <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
      <span className="font-black">{UNIT_CFG[unitId]?.callsign || unitId}</span>
      <span className="ml-auto font-bold">{meta.label}</span>
    </div>
  )
}

function CrewAckBar({ unitId }) {
  const doc = useCrewDoc(unitId)
  if (!doc) return null
  const meta = STATUS_META[doc.status || 'dispatched'] || STATUS_META.dispatched
  const at = doc.closed_at || doc.transporting_at || doc.on_scene_at || doc.acknowledged_at || doc.dispatched_at
  return (
    <div className={`mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${meta.row}`}>
      <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
      <span className="font-bold">{UNIT_CFG[unitId]?.callsign || unitId}</span>
      <span className="text-slate-500">|</span>
      <span className="flex-1">{meta.note}</span>
      {at && <span className="text-[11px] text-slate-400">{new Date(at).toLocaleTimeString()}</span>}
    </div>
  )
}

const PREALERT_TONE = {
  pending:       { label: 'Awaiting hospital response', tone: 'border-amber-800 bg-amber-950/30 text-amber-300', dot: 'bg-amber-400 animate-pulse' },
  accepted:      { label: 'Hospital ACCEPTED',          tone: 'border-green-800 bg-green-950/30 text-green-300', dot: 'bg-green-500' },
  diverted:      { label: 'Hospital DIVERTED — reroute required', tone: 'border-red-800 bg-red-950/40 text-red-300', dot: 'bg-red-500 animate-pulse' },
  auto_accepted: { label: 'Auto-accepted (no response in 90s)', tone: 'border-emerald-800 bg-emerald-950/30 text-emerald-300', dot: 'bg-emerald-400' },
}

function PrealertResponseBar({ prealert }) {
  const meta = PREALERT_TONE[prealert.status] || PREALERT_TONE.pending
  return (
    <div className={`mt-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${meta.tone}`}>
      <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
      <span className="font-bold">{meta.label}</span>
      {prealert.responded_at && (
        <span className="ml-auto text-[11px] text-slate-400">
          {new Date(prealert.responded_at).toLocaleTimeString()}
        </span>
      )}
    </div>
  )
}

function AssignmentCard({ assignment, hospital, incidentId, incidentLat, incidentLon, unitDocs, upsertUnitDoc }) {
  const [selectedUnit, setSelectedUnit] = useState('AMB_1')
  const [sending, setSending] = useState(false)
  const [prealerting, setPrealerting] = useState(false)
  const [prealerted, setPrealerted] = useState(false)
  const [prealertId, setPrealertId] = useState(null)
  const [error, setError] = useState(null)
  const [dispatchedUnit, dispatchedDoc] = findAssignmentDispatch(unitDocs, incidentId, assignment)
  const prealertLive = usePrealertStatus(prealertId)
  const countdown = useCountdown(hospital?.eta_minutes, dispatchedDoc?.dispatched_at)
  const recommendation = recommendUnitForAssignment(assignment, unitDocs)
  const contact = getContact(hospital?.name || assignment?.hospital || '')

  useEffect(() => {
    if (!dispatchedUnit && recommendation?.unitId) setSelectedUnit(recommendation.unitId)
  }, [dispatchedUnit, recommendation?.unitId])

  useEffect(() => {
    if (!dispatchedUnit) {
      setPrealertId(null)
      setPrealerted(false)
    }
  }, [dispatchedUnit])

  async function handleDispatch() {
    setSending(true)
    setError(null)
    try {
      const payload = buildCrewDispatchPayload({ unitId: selectedUnit, incidentId, assignment, hospital, contact, incidentLat, incidentLon })
      await axios.post('/api/crew/dispatch', payload)
      const crewDoc = { ...payload, dispatched_at: new Date().toISOString(), status: 'dispatched' }
      localStorage.setItem(LS_KEY(selectedUnit), JSON.stringify(crewDoc))
      upsertUnitDoc(selectedUnit, crewDoc)
    } catch (dispatchError) {
      setError(dispatchError?.response?.data?.detail || dispatchError?.message || 'Dispatch failed.')
    } finally {
      setSending(false)
    }
  }

  async function handlePrealert() {
    const hospitalId = hospital?.id || hospital?.name || assignment?.hospital
    if (!incidentId || !hospitalId) return
    setPrealerting(true)
    setError(null)
    try {
      const resp = await axios.post(`/api/hospitals/${encodeURIComponent(hospitalId)}/prealert`, {
        incident_id: incidentId,
        hospital_name: assignment?.hospital || hospital?.name || '',
        unit_id: dispatchedUnit || recommendation?.unitId || null,
        eta_minutes: hospital?.eta_minutes ?? null,
        severity: assignment?.severity || null,
        patients_assigned: assignment?.patients_assigned ?? null,
        note: dispatchedUnit ? `Crew ${UNIT_CFG[dispatchedUnit]?.callsign || dispatchedUnit} assigned.` : 'Pre-alert sent before crew assignment.',
      })
      setPrealerted(true)
      if (resp?.data?.prealert_id) setPrealertId(resp.data.prealert_id)
    } catch (prealertError) {
      setError(prealertError?.response?.data?.detail || prealertError?.message || 'Hospital pre-alert failed.')
    } finally {
      setPrealerting(false)
    }
  }

  function openKiosk() {
    const name = assignment?.hospital || hospital?.name
    if (!name) return
    const url = `${window.location.origin}/#hospital?name=${encodeURIComponent(name)}`
    window.open(url, `rapid_kiosk_${name}`, 'width=440,height=780')
  }

  return (
    <div className={`rounded-2xl border p-5 ${dispatchedUnit ? 'border-green-700 bg-[#0a1c0e]' : 'border-[#2d3148] bg-[#1a1d2e]'}`}>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <span className={`rounded-full border px-2.5 py-0.5 text-xs font-black ${SEVERITY_META[assignment?.severity] || SEVERITY_META.minor}`}>{(assignment?.severity || 'minor').toUpperCase()}</span>
            {hospital?.trauma_centre && <span className="rounded-full border border-red-800 bg-red-950/60 px-2 py-0.5 text-xs font-bold text-red-400">TRAUMA</span>}
            {assignment?.injury_type && <span className="rounded-full border border-slate-700 px-2 py-0.5 text-xs capitalize text-slate-400">{assignment.injury_type}</span>}
            {(hospital?.specialties || []).slice(0, 2).map(specialty => <span key={specialty} className="rounded-full border border-violet-800 bg-violet-950/40 px-2 py-0.5 text-xs text-violet-300">{specialty}</span>)}
          </div>
          <p className="truncate text-xl font-black text-white">{assignment?.hospital || '-'}</p>
          {contact && <p className="mt-0.5 text-xs text-slate-500">{contact.area} | {contact.phone}</p>}
        </div>
        <div className="text-right"><p className="text-4xl font-black text-white">{assignment?.patients_assigned ?? 0}</p><p className="text-xs text-slate-500">patients</p></div>
      </div>

      <div className="mb-4 flex flex-wrap gap-2 text-xs">
        {hospital?.eta_minutes != null && <span className="rounded-lg border border-blue-800 bg-blue-950/30 px-2.5 py-1 text-blue-300">ETA {Number(hospital.eta_minutes).toFixed(0)} min</span>}
        {hospital?.capacity?.available_icu != null && <span className="rounded-lg border border-slate-700 px-2.5 py-1 text-slate-400">ICU: {hospital.capacity.available_icu}</span>}
        {hospital?.distance_km != null && <span className="rounded-lg border border-slate-700 px-2.5 py-1 text-slate-400">{Number(hospital.distance_km).toFixed(1)} km</span>}
      </div>

      {assignment?.reason && <p className="mb-4 border-l-2 border-[#2d3148] pl-3 text-xs italic leading-relaxed text-slate-400">{assignment.reason}</p>}

      {!dispatchedUnit && (
        <div className="mb-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-slate-600">Assign unit</p>
          {recommendation?.reason && <p className="mb-2 text-[11px] leading-snug text-blue-300">Recommended: {UNIT_CFG[recommendation.unitId]?.callsign || recommendation.unitId} | {recommendation.reason}</p>}
          <div className="flex flex-wrap gap-2">
            {UNITS.map(unitId => {
              const busy = !!unitDocs[unitId]
              const cfg = UNIT_CFG[unitId]
              const selected = selectedUnit === unitId
              return (
                <button key={unitId} type="button" disabled={busy} onClick={() => setSelectedUnit(unitId)} className={`rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-black text-slate-500 transition-all ${selected ? cfg.active : cfg.idle} ${busy ? 'cursor-not-allowed opacity-40' : ''}`}>
                  {cfg.callsign}
                  {recommendation?.unitId === unitId && <span className="ml-1 text-[10px] text-white/80">REC</span>}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {dispatchedUnit ? (
        <div>
          <div className="rounded-xl border border-green-700 bg-[#0d2412] p-4">
            <div className="mb-3 flex items-center gap-2">
              <p className="flex-1 text-sm font-black text-green-300">Dispatched to {UNIT_CFG[dispatchedUnit]?.callsign || dispatchedUnit}</p>
              <a href={`${window.location.origin}/#crew?unit=${dispatchedUnit}`} target="_blank" rel="noopener noreferrer" className="text-xs font-bold text-blue-400 hover:text-blue-300">View Crew</a>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-[#0a1a0e] py-2"><p className="text-xl font-black text-white">{assignment?.patients_assigned ?? 0}</p><p className="text-[10px] text-slate-500">patients</p></div>
              <div className="rounded-lg bg-[#0a1a0e] py-2"><p className={`text-xl font-black ${countdown === '0:00' ? 'text-green-300' : 'text-blue-300'}`}>{countdown === '0:00' ? 'ARRIVED' : countdown ?? '--'}</p><p className="text-[10px] text-slate-500">ETA remaining</p></div>
              <div className="rounded-lg bg-[#0a1a0e] py-2"><p className="text-xs font-black text-slate-300">{(assignment?.severity || 'minor').toUpperCase()}</p><p className="text-[10px] text-slate-500">severity</p></div>
            </div>
          </div>
          <CrewAckBar unitId={dispatchedUnit} />
        </div>
      ) : (
        <button type="button" onClick={handleDispatch} disabled={sending || !!unitDocs[selectedUnit]} className="w-full rounded-xl bg-blue-600 py-3 text-sm font-black text-white transition-all hover:bg-blue-500 active:bg-blue-700 disabled:opacity-50">
          {sending ? 'Sending...' : `DISPATCH TO ${UNIT_CFG[selectedUnit]?.callsign || selectedUnit}`}
        </button>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={handlePrealert}
          disabled={!incidentId || !(hospital?.id || hospital?.name || assignment?.hospital) || prealerting}
          className={`flex-1 rounded-xl border py-2.5 text-xs font-black ${prealerted ? 'border-green-700 bg-green-950/30 text-green-300' : 'border-violet-800 bg-violet-950/20 text-violet-300 hover:bg-violet-900/30'} disabled:opacity-40`}
        >
          {prealerting ? 'Sending...' : prealerted ? 'PRE-ALERT SENT' : 'PRE-ALERT HOSPITAL'}
        </button>
        <button
          type="button"
          onClick={openKiosk}
          title="Open hospital kiosk in a new window"
          className="shrink-0 rounded-xl border border-slate-700 px-3 py-2.5 text-xs font-black text-slate-300 hover:bg-slate-800"
        >
          KIOSK ↗
        </button>
      </div>

      {prealertLive && <PrealertResponseBar prealert={prealertLive} />}

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  )
}

export default function DispatcherPanel({ result, hospitalMap, incidentLocation, onClose, onRerunWithSceneData }) {
  const { unitDocs, upsertUnitDoc, clearAllDocs } = useUnitDocsSnapshot()
  if (!result) return null

  const assignments = result.assignments || []
  const totalPatients = assignments.reduce((sum, item) => sum + (item.patients_assigned ?? 0), 0)
  const criticalCount = assignments.filter(item => item.severity === 'critical').reduce((sum, item) => sum + (item.patients_assigned ?? 0), 0)
  const moderateCount = assignments.filter(item => item.severity === 'moderate').reduce((sum, item) => sum + (item.patients_assigned ?? 0), 0)

  function openAllCrewViews() {
    let blocked = 0
    UNITS.forEach(unitId => { if (!window.open(`${window.location.origin}/#crew?unit=${unitId}`, `rapid_crew_${unitId}`, 'width=420,height=750')) blocked += 1 })
    if (blocked > 0) alert(`${blocked} crew window(s) were blocked. Allow popups for this site, then try again.`)
  }

  return (
    <div className="fixed inset-0 flex bg-[#06080e]/96 backdrop-blur-md" style={{ zIndex: 9999 }}>
      <div className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-[#1c1f30] bg-[#0a0c14]">
        <div className="border-b border-[#1c1f30] px-5 py-4"><p className="text-xs font-black uppercase tracking-[0.2em] text-white">RAPID COMMAND</p><p className="font-mono text-xs text-slate-600">INC-{(result.incident_id || '').slice(0, 8).toUpperCase()}</p></div>
        <div className="border-b border-[#1c1f30] px-5 py-4">
          <p className="mb-3 text-xs font-black uppercase tracking-widest text-slate-500">Incident Summary</p>
          <div className="mb-3 grid grid-cols-3 gap-2">
            <div className="rounded-xl border border-red-900 bg-red-950/40 p-2 text-center"><p className="text-xl font-black text-red-400">{criticalCount}</p><p className="text-[10px] text-slate-500">critical</p></div>
            <div className="rounded-xl border border-amber-900 bg-amber-950/30 p-2 text-center"><p className="text-xl font-black text-amber-400">{moderateCount}</p><p className="text-[10px] text-slate-500">moderate</p></div>
            <div className="rounded-xl border border-green-900 bg-green-950/30 p-2 text-center"><p className="text-xl font-black text-green-400">{Math.max(0, totalPatients - criticalCount - moderateCount)}</p><p className="text-[10px] text-slate-500">minor</p></div>
          </div>
          <span className="text-xs text-slate-600">{result.elapsed_s ?? '?'}s | {totalPatients} pts</span>
        </div>
        <div className="border-b border-[#1c1f30] px-5 py-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs font-black uppercase tracking-widest text-slate-500">Crew Status</p>
            <button
              type="button"
              onClick={clearAllDocs}
              title="Reset all unit statuses to standby (clears stale data from previous sessions)"
              className="text-[10px] font-bold text-slate-600 hover:text-red-400 transition-colors"
            >
              RESET UNITS
            </button>
          </div>
          <div className="space-y-1.5">{UNITS.map(unitId => <CrewStatusRow key={unitId} unitId={unitId} />)}</div>
        </div>
        <SceneIntelPanel
          incidentId={result.incident_id || null}
          incidentLocation={incidentLocation}
          onRerun={onRerunWithSceneData}
        />
        <div className="flex-1 px-5 py-4">
          <p className="mb-3 text-xs font-black uppercase tracking-widest text-slate-500">Crew Companion App</p>
          <div className="mb-4 space-y-1.5">{UNITS.map(unitId => <a key={unitId} href={`${window.location.origin}/#crew?unit=${unitId}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-xl border border-[#2d3148] px-3 py-2 hover:border-blue-700 hover:bg-blue-950/20"><span className="w-20 text-xs font-black text-slate-400">{UNIT_CFG[unitId].callsign}</span><span className="flex-1 truncate font-mono text-[10px] text-slate-700">/#crew?unit={unitId}</span><span className="text-xs text-slate-600">open</span></a>)}</div>
          <button type="button" onClick={openAllCrewViews} className="w-full rounded-xl bg-blue-600 py-3 text-xs font-black text-white hover:bg-blue-500">OPEN ALL 5 CREW VIEWS</button>
        </div>
        <div className="border-t border-[#1c1f30] px-5 py-4"><button type="button" onClick={onClose} className="w-full rounded-xl border border-[#2d3148] py-2.5 text-xs text-slate-500 hover:border-slate-500 hover:text-slate-200">Close Command Center</button></div>
      </div>

      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-4 border-b border-[#1c1f30] bg-[#0a0c14] px-6 py-4">
          <div><p className="text-base font-black uppercase tracking-wider text-white">Dispatch Assignments</p><p className="text-xs text-slate-500">{assignments.length} hospital group{assignments.length !== 1 ? 's' : ''} | select unit | dispatch | monitor acknowledgements</p></div>
          <button type="button" onClick={onClose} className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-2xl leading-none text-slate-600 hover:bg-[#1c1f30] hover:text-slate-200">x</button>
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-2xl space-y-4">
            {assignments.map((assignment, index) => <AssignmentCard key={`${assignment?.hospital || 'assignment'}-${index}`} assignment={assignment} hospital={(hospitalMap || {})[assignment?.hospital]} incidentId={result.incident_id || ''} incidentLat={incidentLocation?.lat ?? null} incidentLon={incidentLocation?.lon ?? null} unitDocs={unitDocs} upsertUnitDoc={upsertUnitDoc} />)}
            {result.warnings?.length > 0 && <div className="rounded-2xl border border-amber-900/50 bg-amber-950/20 p-4"><p className="mb-2 text-xs font-black uppercase tracking-widest text-amber-400">Warnings</p>{result.warnings.map((warning, index) => <p key={`${warning}-${index}`} className="text-xs text-amber-300/80">! {warning}</p>)}</div>}
          </div>
        </div>
      </div>
    </div>
  )
}
