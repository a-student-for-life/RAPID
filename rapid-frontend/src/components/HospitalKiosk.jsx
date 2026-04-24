import React, { useEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'

/**
 * Hospital Kiosk — Accept / Divert Loop (F5)
 *
 * Hash route: #hospital?name=Kurla+General
 * Each pending pre-alert gets a 90 s countdown with ACCEPT / DIVERT buttons.
 * Auto-accept fires client-side once expires_at is reached.
 */

function safeHospitalKey(raw) {
  return (raw || '').replace(/\//g, '_').replace(/\./g, '_').trim()
}

function parseHospitalFromHash() {
  const hash = window.location.hash || ''
  const qs = hash.split('?')[1] || ''
  const params = new URLSearchParams(qs)
  return params.get('name') || params.get('hospital') || ''
}

const SEVERITY_TONE = {
  critical: 'border-red-700 bg-red-950/70 text-red-300',
  moderate: 'border-amber-700 bg-amber-950/70 text-amber-300',
  minor:    'border-green-700 bg-green-950/70 text-green-300',
}

function useCountdown(expiresAtIso) {
  const [msLeft, setMsLeft] = useState(() => {
    if (!expiresAtIso) return null
    return Math.max(0, new Date(expiresAtIso).getTime() - Date.now())
  })

  useEffect(() => {
    if (!expiresAtIso) return
    const target = new Date(expiresAtIso).getTime()
    const id = setInterval(() => {
      setMsLeft(Math.max(0, target - Date.now()))
    }, 250)
    return () => clearInterval(id)
  }, [expiresAtIso])

  return msLeft
}

function PrealertCard({ prealert, onRespond }) {
  const msLeft = useCountdown(prealert.expires_at)
  const secondsLeft = msLeft == null ? null : Math.ceil(msLeft / 1000)
  const pct = msLeft == null ? 0 : Math.min(100, (msLeft / 90000) * 100)
  const [busy, setBusy] = useState(false)
  // Track whether auto-accept was already sent for THIS prealert to prevent
  // the poll overwriting the optimistic status update and firing a second call.
  const autoAcceptedRef = useRef(false)

  useEffect(() => {
    if (prealert.status !== 'pending') { autoAcceptedRef.current = false; return }
    if (secondsLeft === 0 && !busy && !autoAcceptedRef.current) {
      autoAcceptedRef.current = true
      setBusy(true)
      onRespond(prealert, 'auto_accepted', 'Auto-accepted after 90s timeout.')
        .finally(() => setBusy(false))
    }
  }, [secondsLeft, prealert.prealert_id, prealert.status, busy, onRespond])

  async function handle(status) {
    setBusy(true)
    try { await onRespond(prealert, status, '') }
    finally { setBusy(false) }
  }

  const sevTone = SEVERITY_TONE[prealert.severity] || SEVERITY_TONE.minor
  const isResolved = prealert.status !== 'pending'
  const statusMeta = {
    accepted:      { label: 'ACCEPTED',      tone: 'text-green-300 border-green-700 bg-green-950/50' },
    diverted:      { label: 'DIVERTED',      tone: 'text-red-300 border-red-700 bg-red-950/50' },
    auto_accepted: { label: 'AUTO-ACCEPTED', tone: 'text-emerald-300 border-emerald-700 bg-emerald-950/50' },
  }[prealert.status]

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`rounded-full border px-2.5 py-0.5 text-xs font-black ${sevTone}`}>
              {(prealert.severity || 'minor').toUpperCase()}
            </span>
            {prealert.unit_id && (
              <span className="rounded-full border border-slate-700 px-2 py-0.5 text-xs text-slate-400">
                {prealert.unit_id}
              </span>
            )}
            {isResolved && statusMeta && (
              <span className={`rounded-full border px-2 py-0.5 text-xs font-bold ${statusMeta.tone}`}>
                {statusMeta.label}
              </span>
            )}
          </div>
          <p className="mt-1 text-lg font-black text-white">
            {prealert.patients_assigned ?? '?'} patients inbound
          </p>
          {prealert.eta_minutes != null && (
            <p className="text-sm text-slate-400">
              ETA ~{Number(prealert.eta_minutes).toFixed(0)} min · INC-{String(prealert.incident_id || '').slice(0, 8).toUpperCase()}
            </p>
          )}
          {prealert.note && (
            <p className="mt-1.5 text-xs italic text-slate-500">"{prealert.note}"</p>
          )}
        </div>

        {!isResolved && secondsLeft != null && (
          <div className="text-right shrink-0">
            <p className={`text-3xl font-black ${secondsLeft <= 15 ? 'text-red-400' : 'text-slate-200'}`}>
              {String(Math.max(0, Math.floor(secondsLeft / 60))).padStart(1, '0')}:
              {String(Math.max(0, secondsLeft % 60)).padStart(2, '0')}
            </p>
            <p className="text-[10px] uppercase tracking-wide text-slate-500">to auto-accept</p>
          </div>
        )}
      </div>

      {/* Countdown progress */}
      {!isResolved && (
        <div className="mt-3 h-1 w-full rounded-full bg-slate-800 overflow-hidden">
          <div
            className={`h-full transition-all ${secondsLeft <= 15 ? 'bg-red-500' : 'bg-blue-500'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      {!isResolved && (
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => handle('accepted')}
            disabled={busy}
            className="rounded-xl bg-green-600 py-3 text-sm font-black text-white hover:bg-green-500 disabled:opacity-50"
          >
            ✓ ACCEPT
          </button>
          <button
            type="button"
            onClick={() => handle('diverted')}
            disabled={busy}
            className="rounded-xl bg-red-700 py-3 text-sm font-black text-white hover:bg-red-600 disabled:opacity-50"
          >
            ✗ DIVERT
          </button>
        </div>
      )}

      {isResolved && prealert.responded_at && (
        <p className="mt-2 text-xs text-slate-500">
          Responded {new Date(prealert.responded_at).toLocaleTimeString()}
          {prealert.response_note ? ` · "${prealert.response_note}"` : ''}
        </p>
      )}
    </div>
  )
}

export default function HospitalKiosk() {
  const [hospitalName, setHospitalName] = useState(() => parseHospitalFromHash())
  const hospitalKey = useMemo(() => safeHospitalKey(hospitalName), [hospitalName])
  const [prealerts, setPrealerts] = useState([])
  const [error, setError] = useState(null)

  useEffect(() => {
    function onHash() { setHospitalName(parseHospitalFromHash()) }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    if (!hospitalKey) return
    let pollId

    async function pollRest() {
      try {
        const resp = await axios.get(`/api/kiosk/${encodeURIComponent(hospitalName)}/prealerts`)
        const rows = (resp.data?.prealerts || [])
          .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
          .slice(0, 20)
        setPrealerts(rows)
        setError(null)
      } catch (exc) {
        setError(exc?.response?.data?.detail || exc?.message || 'Polling backend failed.')
      }
    }

    // Use REST polling as primary — backend uses Admin SDK so Firestore security
    // rules don't block it, and it falls back to in-memory cache if Firestore is down.
    pollRest()
    pollId = setInterval(pollRest, 3000)

    return () => clearInterval(pollId)
  }, [hospitalKey, hospitalName])

  async function handleRespond(prealert, status, note) {
    // Optimistic update
    setPrealerts(prev => prev.map(p =>
      p.prealert_id === prealert.prealert_id
        ? { ...p, status, response_note: note, responded_at: new Date().toISOString() }
        : p
    ))
    try {
      await axios.post(`/api/prealerts/${prealert.prealert_id}/respond`, {
        status,
        note,
        responder: `kiosk:${hospitalKey}`,
      })
    } catch (exc) {
      setError(exc?.response?.data?.detail || exc?.message || 'Response failed — please retry.')
    }
  }

  const pending = prealerts.filter(p => p.status === 'pending')
  const resolved = prealerts.filter(p => p.status !== 'pending').slice(0, 6)

  if (!hospitalName) {
    return (
      <div className="min-h-screen grid place-items-center bg-[#06080e] text-slate-400 p-6">
        <div className="max-w-md text-center space-y-3">
          <p className="text-4xl">🏥</p>
          <p className="text-lg font-black text-white">RAPID Hospital Kiosk</p>
          <p className="text-sm text-slate-500">
            Open this page with <code className="bg-slate-800 px-1 rounded">#hospital?name=YourHospitalName</code>
            to receive incoming pre-alerts.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#06080e] text-slate-200">
      <header className="border-b border-slate-800 bg-slate-900/40 px-5 py-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-[0.2em] text-slate-500">RAPID Kiosk</p>
            <h1 className="text-xl font-black text-white">{hospitalName}</h1>
          </div>
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wide text-slate-500">Incoming</p>
            <p className="text-2xl font-black text-red-400">{pending.length}</p>
          </div>
        </div>
      </header>

      {error && (
        <div className="mx-5 mt-4 rounded-lg border border-amber-700 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
          {error}
        </div>
      )}

      <main className="p-5 space-y-3">
        {pending.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/30 p-8 text-center">
            <p className="text-3xl mb-2">🟢</p>
            <p className="text-sm font-bold text-slate-300">All clear — no incoming pre-alerts.</p>
            <p className="text-xs text-slate-500 mt-1">New pre-alerts will appear here instantly.</p>
          </div>
        )}

        {pending.map(p => (
          <PrealertCard key={p.prealert_id} prealert={p} onRespond={handleRespond} />
        ))}

        {resolved.length > 0 && (
          <div className="pt-4 border-t border-slate-800">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">
              Recent responses
            </p>
            <div className="space-y-2">
              {resolved.map(p => (
                <PrealertCard key={p.prealert_id} prealert={p} onRespond={handleRespond} />
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
