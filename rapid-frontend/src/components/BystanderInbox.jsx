import React, { useEffect, useState } from 'react'
import axios from 'axios'

/**
 * Bystander Inbox (dispatcher side, F2)
 *
 * Polls /api/bystander/reports?status=new every 10s. One-click "dispatch"
 * converts a report into a full incident by calling the supplied onPromote
 * handler (which will run through the normal incident pipeline).
 */

const SEVERITY_TONE = {
  critical: 'border-red-700 bg-red-950/60 text-red-300',
  moderate: 'border-amber-700 bg-amber-950/60 text-amber-300',
  minor:    'border-green-700 bg-green-950/60 text-green-300',
}

export default function BystanderInbox({ onPromote, activeIncidentId }) {
  const [reports, setReports] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  const [expanded, setExpanded] = useState(false)
  const [busyIds, setBusyIds]   = useState(new Set())

  async function refresh() {
    try {
      const resp = await axios.get('/api/bystander/reports?status=new&limit=10')
      setReports(resp.data?.reports || [])
      setError(null)
    } catch (exc) {
      setError(exc?.response?.data?.detail || exc?.message || 'Inbox unavailable.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 10_000)
    return () => clearInterval(id)
  }, [])

  async function handlePromote(report) {
    setBusyIds(prev => new Set(prev).add(report.id))
    try {
      const result = await onPromote?.(report)
      const incidentId = result?.incident_id
      if (incidentId) {
        await axios.post(`/api/bystander/reports/${report.id}/promote`, { incident_id: incidentId })
      } else {
        // Dispatch was triggered but we don't have the incident_id yet (SSE
        // callback completes after this returns). Mark the report as handled
        // so the inbox stops showing it; audit trail still has the dispatch.
        await axios.post(`/api/bystander/reports/${report.id}/dismiss?reason=dispatched`)
      }
      await refresh()
    } catch (exc) {
      setError(exc?.response?.data?.detail || exc?.message || 'Promote failed.')
    } finally {
      setBusyIds(prev => {
        const next = new Set(prev)
        next.delete(report.id)
        return next
      })
    }
  }

  async function handleDismiss(report) {
    setBusyIds(prev => new Set(prev).add(report.id))
    try {
      await axios.post(`/api/bystander/reports/${report.id}/dismiss`)
      await refresh()
    } catch (exc) {
      setError(exc?.response?.data?.detail || exc?.message || 'Dismiss failed.')
    } finally {
      setBusyIds(prev => {
        const next = new Set(prev)
        next.delete(report.id)
        return next
      })
    }
  }

  async function handleAddToSceneIntel(report) {
    if (!activeIncidentId) return
    setBusyIds(prev => new Set(prev).add(report.id))
    try {
      await axios.post(`/api/scene-assessments/${activeIncidentId}/inject`, {
        report_id: report.id,
        triage: report.triage,
        lat: report.lat,
        lon: report.lon,
      })
      await axios.post(`/api/bystander/reports/${report.id}/dismiss?reason=added_to_scene_intel`)
      await refresh()
    } catch (exc) {
      setError(exc?.response?.data?.detail || exc?.message || 'Failed to add to scene intel.')
    } finally {
      setBusyIds(prev => { const next = new Set(prev); next.delete(report.id); return next })
    }
  }

  if (loading && reports.length === 0) {
    return <div className="text-xs text-slate-500">Loading inbox…</div>
  }

  const count = reports.length

  return (
    <div className="rounded-lg border border-rapid-border bg-rapid-surface/60 p-3">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-base">📸</span>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
            Bystander Inbox
          </p>
          {count > 0 && (
            <span className="ml-1 min-w-[20px] px-1.5 rounded-full bg-red-600 text-white text-[10px] font-black text-center animate-pulse">
              {count}
            </span>
          )}
        </div>
        <span className="text-xs text-slate-500">{expanded ? '▾' : '▸'}</span>
      </button>

      {error && (
        <p className="mt-1.5 text-[11px] text-amber-400">{error}</p>
      )}

      {!expanded && count === 0 && (
        <p className="mt-1.5 text-xs text-slate-600">No new public reports.</p>
      )}

      {expanded && (
        <div className="mt-2 space-y-2 max-h-72 overflow-y-auto">
          {count === 0 && (
            <p className="text-xs text-slate-600">No new public reports.</p>
          )}
          {reports.map(r => {
            const triage = r.triage || {}
            const groups = (triage.patient_groups || []).filter(g => g.count > 0)
            const busy = busyIds.has(r.id)
            return (
              <div key={r.id} className="rounded-lg border border-slate-800 bg-slate-900/60 p-2.5 space-y-1.5">
                <div className="flex items-center gap-1.5 flex-wrap">
                  {groups.map(g => (
                    <span
                      key={g.severity}
                      className={`text-[10px] px-1.5 py-0.5 rounded-full border font-bold ${SEVERITY_TONE[g.severity] || SEVERITY_TONE.minor}`}
                    >
                      {g.count} {g.severity}
                    </span>
                  ))}
                  {triage.confidence && (
                    <span className="text-[10px] text-slate-500">· {triage.confidence} conf</span>
                  )}
                </div>

                {triage.triage_notes && (
                  <p className="text-xs text-slate-300 leading-snug">{triage.triage_notes}</p>
                )}

                {triage.hazard_flags?.length > 0 && (
                  <p className="text-[10px] text-red-400">⚠ {triage.hazard_flags.join(' · ')}</p>
                )}

                <p className="text-[10px] text-slate-500 font-mono">
                  {r.lat?.toFixed(4)}, {r.lon?.toFixed(4)}
                  {r.contact ? ` · ${r.contact}` : ''}
                </p>

                <div className="flex gap-1.5 pt-1 flex-wrap">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handlePromote(r)}
                    className="flex-1 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 py-1.5 text-[11px] font-black text-white"
                  >
                    {busy ? '…' : 'DISPATCH'}
                  </button>
                  {activeIncidentId && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleAddToSceneIntel(r)}
                      title="Inject this photo's triage into the active incident's scene intel to enable re-routing"
                      className="flex-1 rounded-lg bg-purple-700 hover:bg-purple-600 disabled:opacity-40 py-1.5 text-[11px] font-black text-white"
                    >
                      {busy ? '…' : '+ SCENE INTEL'}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => handleDismiss(r)}
                    className="rounded-lg border border-slate-700 px-2 py-1.5 text-[11px] font-bold text-slate-400 hover:bg-slate-800 disabled:opacity-40"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
