import React, { useEffect, useState } from 'react'
import axios from 'axios'

const PATH_COLORS = {
  AI:       'text-green-400',
  groq:     'text-blue-400',
  gemini:   'text-blue-400',
  FALLBACK: 'text-amber-400',
}

const PATH_LABELS = {
  AI:       'Gemini AI',
  groq:     'Gemini AI',
  gemini:   'Gemini AI',
  FALLBACK: 'Fallback',
  fallback: 'Fallback',
}

export default function IncidentHistory({ refreshKey, onReplay }) {
  const [incidents, setIncidents] = useState([])
  const [loading, setLoading]     = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    axios.get('/api/incidents?limit=8')
      .then(r => { if (!cancelled) setIncidents(r.data.incidents || []) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [refreshKey])

  if (loading) {
    return (
      <div className="text-xs text-slate-600 py-2 text-center">Loading history…</div>
    )
  }

  if (incidents.length === 0) {
    return (
      <div className="text-xs text-slate-600 py-2 text-center">No incidents yet</div>
    )
  }

  return (
    <div className="space-y-1.5">
      {incidents.map(inc => {
        const ts  = inc.saved_at ? new Date(inc.saved_at).toLocaleTimeString() : '—'
        const cls = PATH_COLORS[inc.decision_path] || 'text-slate-400'
        const label = PATH_LABELS[inc.decision_path] || inc.decision_path
        return (
          <button
            key={inc.id}
            onClick={() => onReplay && onReplay(inc)}
            className="w-full text-left px-2.5 py-2 rounded border border-rapid-border bg-rapid-bg hover:border-blue-700 transition-colors group"
          >
            <div className="flex items-center justify-between">
              <span className={`text-xs font-bold ${cls}`}>{label}</span>
              <span className="text-xs text-slate-600">{ts}</span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              {inc.patient_count} patients · {inc.assignments?.length} assignments
            </p>
            <p className="text-xs text-slate-600 font-mono">
              {inc.lat?.toFixed(4)}, {inc.lon?.toFixed(4)}
            </p>
          </button>
        )
      })}
    </div>
  )
}
