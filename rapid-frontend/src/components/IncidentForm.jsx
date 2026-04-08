import React, { useState } from 'react'

const SEVERITIES = ['critical', 'moderate', 'minor']
const INJURY_TYPES = ['', 'burns', 'neuro', 'cardiac', 'ortho', 'trauma', 'general']

const SEVERITY_COLORS = {
  critical: 'border-red-500 text-red-400',
  moderate: 'border-amber-500 text-amber-400',
  minor:    'border-green-500 text-green-400',
}

export default function IncidentForm({ onSubmit, loading, initialValues }) {
  const [lat, setLat]   = useState(initialValues?.lat  ?? '19.0728')
  const [lon, setLon]   = useState(initialValues?.lon  ?? '72.8826')
  const [groups, setGroups] = useState(
    initialValues?.patients ?? [
      { severity: 'critical', count: 8,  injury_type: '' },
      { severity: 'moderate', count: 15, injury_type: '' },
      { severity: 'minor',    count: 12, injury_type: '' },
    ],
  )

  // Sync when initialValues change (demo scenario loaded)
  React.useEffect(() => {
    if (initialValues) {
      setLat(String(initialValues.lat))
      setLon(String(initialValues.lon))
      setGroups(
        initialValues.patients.map(p => ({
          ...p,
          injury_type: p.injury_type ?? '',
        })),
      )
    }
  }, [initialValues])

  function updateGroup(i, field, value) {
    setGroups(prev => prev.map((g, idx) => idx === i ? { ...g, [field]: value } : g))
  }

  function addGroup() {
    setGroups(prev => [...prev, { severity: 'moderate', count: 1, injury_type: '' }])
  }

  function removeGroup(i) {
    setGroups(prev => prev.filter((_, idx) => idx !== i))
  }

  function handleSubmit(e) {
    e.preventDefault()
    const payload = {
      lat: parseFloat(lat),
      lon: parseFloat(lon),
      patients: groups
        .filter(g => g.count > 0)
        .map(g => ({
          severity:    g.severity,
          count:       parseInt(g.count, 10),
          injury_type: g.injury_type || null,
        })),
    }
    onSubmit(payload)
  }

  const totalPatients = groups.reduce((s, g) => s + (parseInt(g.count, 10) || 0), 0)

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {/* Coordinates */}
      <div>
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
          Incident Location
        </p>
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="block text-xs text-slate-500 mb-1">Latitude</label>
            <input
              type="number"
              step="any"
              value={lat}
              onChange={e => setLat(e.target.value)}
              className="w-full bg-rapid-bg border border-rapid-border rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
              placeholder="19.0728"
              required
            />
          </div>
          <div className="flex-1">
            <label className="block text-xs text-slate-500 mb-1">Longitude</label>
            <input
              type="number"
              step="any"
              value={lon}
              onChange={e => setLon(e.target.value)}
              className="w-full bg-rapid-bg border border-rapid-border rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
              placeholder="72.8826"
              required
            />
          </div>
        </div>
      </div>

      {/* Patient groups */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
            Patient Groups
            <span className="ml-2 text-blue-400 font-bold">{totalPatients} total</span>
          </p>
          <button
            type="button"
            onClick={addGroup}
            className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
          >
            + Add group
          </button>
        </div>

        <div className="space-y-2">
          {groups.map((g, i) => (
            <div
              key={i}
              className={`flex gap-2 items-center p-2 rounded border ${SEVERITY_COLORS[g.severity]} bg-rapid-bg/50`}
            >
              {/* Severity */}
              <select
                value={g.severity}
                onChange={e => updateGroup(i, 'severity', e.target.value)}
                className="bg-rapid-bg border border-rapid-border rounded px-1 py-1 text-xs text-slate-200 focus:outline-none"
              >
                {SEVERITIES.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>

              {/* Count */}
              <input
                type="number"
                min="1"
                value={g.count}
                onChange={e => updateGroup(i, 'count', e.target.value)}
                className="w-14 bg-rapid-bg border border-rapid-border rounded px-1 py-1 text-xs text-center text-slate-200 focus:outline-none"
              />

              {/* Injury type */}
              <select
                value={g.injury_type}
                onChange={e => updateGroup(i, 'injury_type', e.target.value)}
                className="flex-1 bg-rapid-bg border border-rapid-border rounded px-1 py-1 text-xs text-slate-400 focus:outline-none"
              >
                <option value="">any injury</option>
                {INJURY_TYPES.filter(Boolean).map(t => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>

              {/* Remove */}
              {groups.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeGroup(i)}
                  className="text-slate-600 hover:text-red-400 text-xs transition-colors"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Submit */}
      <button
        type="submit"
        disabled={loading}
        className={`w-full py-2.5 rounded font-bold text-sm transition-all ${
          loading
            ? 'bg-blue-900 text-blue-300 cursor-not-allowed'
            : 'bg-blue-600 hover:bg-blue-500 text-white active:scale-95'
        }`}
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
            Dispatching…
          </span>
        ) : (
          '🚨 Dispatch RAPID'
        )}
      </button>
    </form>
  )
}
