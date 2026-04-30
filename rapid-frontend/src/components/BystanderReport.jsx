import React, { useEffect, useRef, useState } from 'react'
import axios from 'axios'

/**
 * Public Bystander Report (F2)
 *
 * Hash route: #report
 * Mobile-first form: capture a photo, auto-geolocate, submit.
 * Backend runs Gemini vision to estimate casualties and hazards, writes
 * to Firestore `bystander_reports` where the dispatcher inbox picks it up.
 */

const SEVERITY_TONE = {
  critical: 'bg-red-950/50 border-red-700 text-red-300',
  moderate: 'bg-amber-950/50 border-amber-700 text-amber-300',
  minor:    'bg-green-950/50 border-green-700 text-green-300',
}

export default function BystanderReport() {
  const [photoFile, setPhotoFile] = useState(null)
  const [photoUrl, setPhotoUrl]   = useState(null)
  const [lat, setLat]         = useState(null)
  const [lon, setLon]         = useState(null)
  const [locStatus, setLocStatus] = useState('idle')  // idle | locating | ok | error
  const [locError, setLocError]   = useState(null)
  const [contact, setContact]     = useState('')
  const [notes, setNotes]         = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult]       = useState(null)
  const [error, setError]         = useState(null)

  const fileInputRef = useRef(null)

  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setLocStatus('error')
      setLocError('Geolocation not supported — enter coordinates manually.')
      return
    }
    setLocStatus('locating')
    navigator.geolocation.getCurrentPosition(
      pos => {
        setLat(pos.coords.latitude)
        setLon(pos.coords.longitude)
        setLocStatus('ok')
      },
      err => {
        setLocStatus('error')
        setLocError(err?.message || 'Location denied.')
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    )
  }, [])

  useEffect(() => {
    if (!photoFile) { setPhotoUrl(null); return }
    const url = URL.createObjectURL(photoFile)
    setPhotoUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [photoFile])

  function handlePhotoPick(event) {
    const file = event.target.files?.[0]
    if (file) setPhotoFile(file)
  }

  async function handleSubmit() {
    setError(null)
    if (!photoFile) { setError('Please attach a photo.'); return }
    if (lat == null || lon == null) { setError('Location is required.'); return }

    setSubmitting(true)
    try {
      const fd = new FormData()
      fd.append('image', photoFile)
      fd.append('lat', String(lat))
      fd.append('lon', String(lon))
      if (contact) fd.append('contact', contact)
      if (notes)   fd.append('notes',   notes)

      const resp = await axios.post('/api/bystander/report', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setResult(resp.data)
    } catch (exc) {
      setError(exc?.response?.data?.detail || exc?.message || 'Submission failed.')
    } finally {
      setSubmitting(false)
    }
  }

  function reset() {
    setPhotoFile(null)
    setContact('')
    setNotes('')
    setResult(null)
    setError(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  if (result) {
    const triage = result.triage || {}
    const groups = (triage.patient_groups || []).filter(g => g.count > 0)
    return (
      <div className="min-h-screen bg-[#06080e] text-slate-200 p-5">
        <div className="mx-auto max-w-md space-y-4">
          <div className="text-center">
            <p className="text-5xl">✅</p>
            <p className="mt-2 text-xl font-black text-white">Report received</p>
            <p className="text-sm text-slate-500">
              Dispatch reviewed report <span className="font-mono text-slate-400">{result.report_id.slice(0, 8)}</span>.
            </p>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500 mb-1">
              AI triage summary
            </p>
            <p className="text-sm text-slate-200 leading-relaxed">
              {triage.triage_notes || 'Triage notes not available.'}
            </p>
            {triage.estimated_casualties != null && (
              <p className="mt-2 text-xs text-slate-400">
                Estimated casualties: <span className="font-bold text-white">{triage.estimated_casualties}</span>
                {triage.confidence && <span className="ml-2">· confidence {triage.confidence}</span>}
              </p>
            )}
            {groups.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {groups.map(g => (
                  <span
                    key={g.severity}
                    className={`rounded-full border px-2 py-0.5 text-xs font-bold ${SEVERITY_TONE[g.severity] || SEVERITY_TONE.minor}`}
                  >
                    {g.count} {g.severity}
                  </span>
                ))}
              </div>
            )}
            {triage.hazard_flags?.length > 0 && (
              <p className="mt-2 text-xs text-red-400">
                ⚠ {triage.hazard_flags.join(' · ')}
              </p>
            )}
          </div>

          <p className="text-xs text-slate-500 text-center">
            A dispatcher will follow up if they need more info. Stay safe and keep distance from the scene.
          </p>
          <button
            type="button"
            onClick={reset}
            className="w-full rounded-xl border border-slate-700 py-3 text-sm font-black text-slate-300 hover:bg-slate-800"
          >
            Submit another report
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#06080e] text-slate-200 p-5">
      <div className="mx-auto max-w-md space-y-4">
        <header className="text-center">
          <p className="text-4xl">📸</p>
          <h1 className="text-xl font-black text-white mt-2">Bystander Report</h1>
          <p className="text-xs text-slate-500">
            Anonymous · Helps RAPID dispatch the right ambulance faster
          </p>
        </header>

        {/* Photo */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">
            Scene photo
          </p>
          {photoUrl ? (
            <div className="relative">
              <img src={photoUrl} alt="Scene" className="w-full rounded-lg border border-slate-700 object-cover max-h-64" />
              <button
                type="button"
                onClick={() => setPhotoFile(null)}
                className="absolute top-2 right-2 rounded-full bg-black/70 px-2.5 py-1 text-xs font-bold text-white"
              >
                ✕ Change
              </button>
            </div>
          ) : (
            <label className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-slate-700 py-10 cursor-pointer hover:bg-slate-800/40">
              <span className="text-3xl">📷</span>
              <span className="text-sm font-bold text-slate-300">Take a photo</span>
              <span className="text-xs text-slate-500">or upload from gallery</span>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={handlePhotoPick}
              />
            </label>
          )}
        </div>

        {/* Location */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">
            Your location
          </p>
          {locStatus === 'locating' && (
            <p className="text-sm text-slate-400">Getting GPS fix…</p>
          )}
          {locStatus === 'ok' && (
            <p className="text-sm text-green-400">
              📍 {lat.toFixed(5)}, {lon.toFixed(5)}
            </p>
          )}
          {locStatus === 'error' && (
            <div>
              <p className="text-xs text-amber-400 mb-1.5">{locError}</p>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="number"
                  step="0.00001"
                  placeholder="Latitude"
                  value={lat ?? ''}
                  onChange={e => setLat(e.target.value ? Number(e.target.value) : null)}
                  className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm"
                />
                <input
                  type="number"
                  step="0.00001"
                  placeholder="Longitude"
                  value={lon ?? ''}
                  onChange={e => setLon(e.target.value ? Number(e.target.value) : null)}
                  className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm"
                />
              </div>
            </div>
          )}
        </div>

        {/* Contact + notes */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3 space-y-2">
          <div>
            <label className="text-xs font-bold uppercase tracking-wide text-slate-500">
              Contact number (optional)
            </label>
            <input
              type="tel"
              inputMode="tel"
              value={contact}
              onChange={e => setContact(e.target.value)}
              placeholder="e.g. +91 98…"
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-xs font-bold uppercase tracking-wide text-slate-500">
              Notes (optional)
            </label>
            <textarea
              rows={2}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Anything dispatcher should know."
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm resize-none"
            />
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-red-800 bg-red-950/30 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting || !photoFile || lat == null || lon == null}
          className="w-full rounded-xl bg-red-600 py-4 text-base font-black text-white hover:bg-red-500 disabled:opacity-40"
        >
          {submitting ? 'Submitting…' : '🚨 SEND REPORT'}
        </button>

        <p className="text-[11px] text-slate-600 text-center leading-relaxed">
          If anyone is in immediate danger, call 108 (India) or your local emergency line first.
          This form supplements — it does not replace — a 108 call.
        </p>
      </div>
    </div>
  )
}
