import React, { useEffect, useState } from 'react'

/**
 * Unified Scene Intelligence panel (F1 + F2 combined).
 *
 * Polls GET /api/scene-intel/{incidentId} every 3 s when an incident is active.
 * Shows crew scene photos + public (bystander) reports with thumbnails.
 * Provides a two-step "REROUTE WITH SCENE DATA" confirmation that calls onRerun.
 *
 * Returns null when there is no incidentId or no reports exist yet.
 */

const SEVERITY_TONE = {
  critical: 'border-red-700 bg-red-950/60 text-red-300',
  moderate: 'border-amber-700 bg-amber-950/60 text-amber-300',
  minor:    'border-green-700 bg-green-950/60 text-green-300',
}

const CALLSIGNS = {
  AMB_1: 'ALPHA-1', AMB_2: 'BRAVO-2', AMB_3: 'CHARLIE-3', AMB_4: 'DELTA-4', AMB_5: 'ECHO-5',
}

function unitLabel(unitId) {
  if (!unitId) return 'UNKNOWN'
  if (CALLSIGNS[unitId]) return CALLSIGNS[unitId]
  if (unitId.startsWith('bystander_')) return 'PUBLIC (linked)'
  return unitId.toUpperCase()
}

function ReportCard({ report, isBystander, incidentId, onLinked }) {
  const [busy, setBusy] = useState(false)

  const groups   = (report.patient_groups || []).filter(g => g.count > 0)
  const notes    = report.triage_notes   || report.triage?.triage_notes
  const hazards  = report.hazard_flags   || report.triage?.hazard_flags || []
  const confidence = report.triage?.confidence
  const label    = isBystander ? 'BYSTANDER' : unitLabel(report.unit_id)
  const isLinked = !isBystander && (report.unit_id || '').startsWith('bystander_')

  async function handleLink() {
    if (!incidentId) return
    setBusy(true)
    try {
      const reportId = report.id || report.report_id
      await fetch(`/api/scene-assessments/${incidentId}/inject`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report_id: reportId,
          triage:    report.triage || report,
          lat:       report.lat  ?? null,
          lon:       report.lon  ?? null,
          image_id:  report.image_id ?? null,
        }),
      })
      await fetch(`/api/bystander/reports/${reportId}/dismiss?reason=linked_to_incident`, {
        method: 'POST',
      })
      onLinked?.()
    } catch {}
    finally { setBusy(false) }
  }

  return (
    <div className={`rounded-lg border p-2.5 space-y-1.5 ${
      isBystander || isLinked
        ? 'border-purple-900/50 bg-purple-950/20'
        : 'border-slate-800 bg-slate-900/60'
    }`}>
      {/* Thumbnail + header */}
      <div className="flex items-center gap-2">
        {report.image_id ? (
          <img
            src={`/api/images/${report.image_id}`}
            alt="Scene"
            className="h-12 w-16 rounded object-cover shrink-0 border border-slate-700"
          />
        ) : (
          <div className={`h-12 w-16 rounded shrink-0 border flex items-center justify-center text-lg ${
            isBystander ? 'border-purple-800/40 bg-purple-950/30' : 'border-slate-700 bg-slate-800'
          }`}>
            {isBystander ? '📸' : '🚑'}
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 flex-wrap">
            <span className={`text-[10px] font-black uppercase ${
              isBystander || isLinked ? 'text-purple-300' : 'text-slate-300'
            }`}>{label}</span>
            {confidence && (
              <span className="text-[10px] text-slate-500">· {confidence} conf</span>
            )}
          </div>
          <div className="flex flex-wrap gap-1 mt-0.5">
            {groups.length > 0
              ? groups.map(g => (
                  <span
                    key={g.severity}
                    className={`text-[10px] px-1.5 py-0.5 rounded-full border font-bold ${SEVERITY_TONE[g.severity] || SEVERITY_TONE.minor}`}
                  >
                    {g.count} {g.severity}
                  </span>
                ))
              : <span className="text-[10px] text-slate-600">no casualties identified</span>
            }
          </div>
        </div>
      </div>

      {/* Notes */}
      {notes && (
        <p className="text-[11px] text-slate-400 leading-snug">{notes}</p>
      )}

      {/* Hazards */}
      {hazards.length > 0 && (
        <p className="text-[10px] text-red-400">⚠ {hazards.join(' · ')}</p>
      )}

      {/* Bystander-only fields */}
      {isBystander && (
        <>
          {(report.lat != null || report.lon != null) && (
            <p className="text-[10px] text-slate-500 font-mono">
              {report.lat?.toFixed(4)}, {report.lon?.toFixed(4)}
              {report.contact ? ` · ${report.contact}` : ''}
            </p>
          )}
          {incidentId && (
            <button
              type="button"
              disabled={busy}
              onClick={handleLink}
              className="w-full rounded-lg bg-purple-700 hover:bg-purple-600 disabled:opacity-40 py-1.5 text-[10px] font-black text-white transition-colors"
            >
              {busy ? '…' : '+ LINK TO INCIDENT'}
            </button>
          )}
        </>
      )}
    </div>
  )
}

export default function SceneIntelPanel({ incidentId, incidentLocation, onRerun }) {
  const [data,              setData]              = useState(null)
  const [rerouteConfirming, setRerouteConfirming] = useState(false)
  const [collapsed,         setCollapsed]         = useState(false)
  const [refreshTick,       setRefreshTick]       = useState(0)

  useEffect(() => {
    if (!incidentId) { setData(null); return }
    let cancelled = false

    async function poll() {
      try {
        const res = await fetch(`/api/scene-intel/${incidentId}`)
        if (!res.ok || cancelled) return
        setData(await res.json())
      } catch {}
    }

    poll()
    const id = setInterval(poll, 3000)
    return () => { cancelled = true; clearInterval(id) }
  }, [incidentId, refreshTick])

  if (!incidentId || !data || (data.aggregated?.report_count ?? 0) === 0) return null

  const { crew_reports = [], bystander_reports = [], aggregated } = data
  const totalCount  = aggregated.report_count || 0
  const hasPatients = (aggregated.consensus_patient_groups || []).some(g => g.count > 0)

  function handleRerouteClick() {
    if (!rerouteConfirming) {
      setRerouteConfirming(true)
      return
    }
    setRerouteConfirming(false)
    onRerun?.(aggregated, incidentLocation?.lat, incidentLocation?.lon)
  }

  return (
    <div className="shrink-0 border-t border-purple-900/40 bg-purple-950/10">

      {/* Collapsible header */}
      <button
        type="button"
        onClick={() => setCollapsed(v => !v)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-purple-950/20 transition-colors"
      >
        <span className="text-purple-400 text-sm">🔬</span>
        <span className="text-xs font-black text-purple-300 uppercase tracking-wide">
          Scene Intelligence
        </span>
        <span className="ml-1 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-purple-600 text-[10px] font-black text-white px-1 animate-pulse">
          {totalCount}
        </span>
        {aggregated.confidence && aggregated.confidence !== 'NONE' && (
          <span className={`text-[10px] font-bold ${
            aggregated.confidence === 'HIGH'   ? 'text-green-400' :
            aggregated.confidence === 'MEDIUM' ? 'text-amber-400' : 'text-slate-500'
          }`}>{aggregated.confidence}</span>
        )}
        {aggregated.total_estimated != null && (
          <span className="text-[10px] text-slate-500">
            · ~{aggregated.total_estimated} on scene
          </span>
        )}
        <span className="ml-auto text-[11px] text-slate-600">{collapsed ? '▸' : '▾'}</span>
      </button>

      {!collapsed && (
        <div className="px-4 pb-3 space-y-3 max-h-80 overflow-y-auto">

          {/* Crew reports */}
          {crew_reports.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">
                Crew Reports ({crew_reports.length})
              </p>
              {crew_reports.map((r, i) => (
                <ReportCard
                  key={r.unit_id || i}
                  report={r}
                  isBystander={false}
                  incidentId={null}
                />
              ))}
            </div>
          )}

          {/* Public / bystander reports */}
          {bystander_reports.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">
                Public Reports ({bystander_reports.length})
              </p>
              {bystander_reports.map(r => (
                <ReportCard
                  key={r.id || r.report_id}
                  report={r}
                  isBystander={true}
                  incidentId={incidentId}
                  onLinked={() => setRefreshTick(t => t + 1)}
                />
              ))}
            </div>
          )}

          {/* Aggregated hazards */}
          {aggregated.hazard_flags?.length > 0 && (
            <p className="text-xs text-red-400">⚠ {aggregated.hazard_flags.join(' · ')}</p>
          )}

          {/* Reroute action */}
          {onRerun && (
            rerouteConfirming ? (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] text-purple-300 font-bold">Confirm reroute?</span>
                <button
                  type="button"
                  onClick={handleRerouteClick}
                  className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-black transition-colors"
                >YES — REROUTE</button>
                <button
                  type="button"
                  onClick={() => setRerouteConfirming(false)}
                  className="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-400 text-xs font-bold hover:bg-slate-800 transition-colors"
                >Cancel</button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleRerouteClick}
                disabled={!hasPatients}
                title={!hasPatients ? 'Scene shows no patient counts — link a report with casualties first' : 'Re-run routing using scene-confirmed patient counts'}
                className="w-full rounded-lg bg-purple-700 hover:bg-purple-600 disabled:opacity-50 disabled:cursor-not-allowed py-2 text-xs font-black text-white transition-colors shadow shadow-purple-900/40"
              >
                🔄 REROUTE WITH SCENE DATA
              </button>
            )
          )}

          <p className="text-[10px] text-slate-600">
            Updates every 3 s · {crew_reports.length} crew + {bystander_reports.length} public
          </p>
        </div>
      )}
    </div>
  )
}
