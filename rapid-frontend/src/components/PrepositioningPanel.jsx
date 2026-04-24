import React, { useEffect, useState } from 'react'
import axios from 'axios'

/**
 * Predictive Pre-positioning (F4)
 *
 * Polls /api/prepositioning/suggestions to surface hot zones derived from
 * recent incidents and idle-unit move recommendations. Collapsible to keep
 * the sidebar tidy.
 */

const UNIT_CALLSIGN = {
  AMB_1: 'ALPHA-1', AMB_2: 'BRAVO-2', AMB_3: 'CHARLIE-3', AMB_4: 'DELTA-4', AMB_5: 'ECHO-5',
}

const CONFIDENCE_TONE = {
  high:   'border-green-700 bg-green-950/40 text-green-300',
  medium: 'border-amber-700 bg-amber-950/40 text-amber-300',
  low:    'border-slate-700 bg-slate-900/40 text-slate-400',
}

export default function PrepositioningPanel({ basePosition }) {
  const [data, setData]       = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  const [expanded, setExpanded] = useState(false)
  const [acknowledged, setAcknowledged] = useState(() => new Set())

  async function refresh() {
    try {
      const params = new URLSearchParams()
      if (basePosition?.lat != null) params.set('base_lat', String(basePosition.lat))
      if (basePosition?.lon != null) params.set('base_lon', String(basePosition.lon))
      const url = `/api/prepositioning/suggestions${params.toString() ? '?' + params.toString() : ''}`
      const resp = await axios.get(url)
      setData(resp.data)
      setError(null)
    } catch (exc) {
      setError(exc?.response?.data?.detail || exc?.message || 'Pre-positioning unavailable.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 30_000)
    return () => clearInterval(id)
  }, [basePosition?.lat, basePosition?.lon])

  if (loading && !data) {
    return <div className="text-xs text-slate-500">Loading pre-positioning…</div>
  }

  const suggestions = (data?.suggestions || []).filter(s => !acknowledged.has(s.unit_id))
  const hotzones = data?.hotzones || []

  // Hide entirely until at least one incident has been processed
  if (!loading && !error && (data?.incidents_considered || 0) === 0) {
    return null
  }

  return (
    <div className="rounded-lg border border-rapid-border bg-rapid-surface/60 p-3">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-base">📡</span>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
            Pre-positioning
          </p>
          {suggestions.length > 0 && (
            <span className="ml-1 min-w-[20px] px-1.5 rounded-full bg-amber-600 text-white text-[10px] font-black text-center">
              {suggestions.length}
            </span>
          )}
        </div>
        <span className="text-xs text-slate-500">{expanded ? '▾' : '▸'}</span>
      </button>

      {error && <p className="mt-1.5 text-[11px] text-amber-400">{error}</p>}

      {!expanded && (
        <p className="mt-1.5 text-xs text-slate-600">
          {data?.incidents_considered || 0} incidents · {hotzones.length} hot zone{hotzones.length !== 1 ? 's' : ''}
        </p>
      )}

      {expanded && (
        <div className="mt-2 space-y-2">
          {/* Hot zones summary */}
          {hotzones.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Hot zones</p>
              <div className="space-y-1">
                {hotzones.slice(0, 3).map((hz, i) => (
                  <div key={i} className="rounded border border-slate-800 bg-slate-900/50 px-2 py-1.5 text-[11px]">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-slate-400">
                        {hz.lat.toFixed(3)}, {hz.lon.toFixed(3)}
                      </span>
                      <span className="font-bold text-orange-400">
                        {hz.incident_count} hits
                      </span>
                    </div>
                    {Object.keys(hz.severity_mix || {}).length > 0 && (
                      <p className="mt-0.5 text-[10px] text-slate-500">
                        {Object.entries(hz.severity_mix).map(([k, v]) => `${v} ${k}`).join(' · ')}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Suggestions */}
          {suggestions.length === 0 && (
            <p className="text-xs text-slate-600">No moves recommended right now.</p>
          )}
          {suggestions.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-1 mt-2">
                Suggested moves
              </p>
              <div className="space-y-2">
                {suggestions.map(s => {
                  const tone = CONFIDENCE_TONE[s.confidence] || CONFIDENCE_TONE.low
                  const callsign = UNIT_CALLSIGN[s.unit_id] || s.unit_id
                  return (
                    <div key={s.unit_id} className={`rounded-lg border px-2.5 py-2 text-[11px] ${tone}`}>
                      <div className="flex items-center justify-between">
                        <span className="font-black">{callsign}</span>
                        <span className="text-[10px] uppercase">{s.confidence} conf</span>
                      </div>
                      <p className="mt-0.5 text-slate-300 leading-snug">
                        Move ~{s.distance_km} km → hot zone with {s.incident_count} recent incident(s).
                      </p>
                      <p className="mt-0.5 font-mono text-[10px] text-slate-500">
                        → {s.target_lat.toFixed(4)}, {s.target_lon.toFixed(4)}
                      </p>
                      <button
                        type="button"
                        onClick={() => setAcknowledged(prev => new Set(prev).add(s.unit_id))}
                        className="mt-1.5 w-full rounded bg-slate-800 hover:bg-slate-700 px-2 py-1 text-[10px] font-bold text-slate-300"
                      >
                        Acknowledge
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
