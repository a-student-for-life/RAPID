import React from 'react'
import {
  RadarChart, PolarGrid, PolarAngleAxis, Radar,
  ResponsiveContainer, Tooltip,
} from 'recharts'

const DECISION_PATH_CONFIG = {
  AI: {
    label: 'Gemini AI',
    color: 'text-green-400',
    border: 'border-green-600',
    bg: 'bg-green-950/30',
    icon: '✦',
  },
  FALLBACK: {
    label: 'Deterministic Fallback',
    color: 'text-amber-400',
    border: 'border-amber-600',
    bg: 'bg-amber-950/30',
    icon: '⚡',
  },
}

function buildRadarData(scores) {
  if (!scores || scores.length === 0) return []

  const avg = {
    ETA:      scores.reduce((s, h) => s + h.sub_scores.eta,      0) / scores.length,
    Capacity: scores.reduce((s, h) => s + h.sub_scores.capacity, 0) / scores.length,
    Trauma:   scores.reduce((s, h) => s + h.sub_scores.trauma,   0) / scores.length,
    Blood:    scores.reduce((s, h) => s + h.sub_scores.blood,     0) / scores.length,
  }

  return Object.entries(avg).map(([subject, value]) => ({
    subject,
    value: Math.round(value),
    fullMark: 100,
  }))
}

export default function GeminiReasoningPanel({ result, elapsed }) {
  if (!result) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-6 text-slate-600">
        <p className="text-3xl mb-2">✦</p>
        <p className="text-sm">AI reasoning will appear here after dispatch</p>
      </div>
    )
  }

  const config = DECISION_PATH_CONFIG[result.decision_path] || DECISION_PATH_CONFIG.FALLBACK
  const radarData = buildRadarData(result.scores)
  const topHospital = result.scores?.[0]

  return (
    <div className="h-full flex flex-col gap-3 overflow-y-auto p-1">
      {/* Decision path badge */}
      <div className={`flex items-center gap-2 px-3 py-2 rounded border ${config.border} ${config.bg}`}>
        <span className={`text-lg ${config.color}`}>{config.icon}</span>
        <div>
          <p className={`text-sm font-bold ${config.color}`}>{config.label}</p>
          <p className="text-xs text-slate-500">
            {result.incident_id?.slice(0, 8)} · {elapsed}s response
          </p>
        </div>
        <div className="ml-auto text-right">
          <p className="text-xs text-slate-500">Hospitals evaluated</p>
          <p className="text-sm font-bold text-slate-300">{result.scores?.length ?? 0}</p>
        </div>
      </div>

      {/* Reasoning text */}
      {result.reasoning && (
        <div className="px-3 py-2 rounded bg-rapid-surface border border-rapid-border">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
            Clinical Reasoning
          </p>
          <p className="text-sm text-slate-300 leading-relaxed">{result.reasoning}</p>
        </div>
      )}

      {/* Radar chart */}
      {radarData.length > 0 && (
        <div className="px-3 py-2 rounded bg-rapid-surface border border-rapid-border">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
            System-wide Score Distribution
          </p>
          <ResponsiveContainer width="100%" height={160}>
            <RadarChart data={radarData} margin={{ top: 5, right: 15, bottom: 5, left: 15 }}>
              <PolarGrid stroke="#2d3148" />
              <PolarAngleAxis
                dataKey="subject"
                tick={{ fill: '#94a3b8', fontSize: 11 }}
              />
              <Radar
                name="Avg"
                dataKey="value"
                stroke="#3b82f6"
                fill="#3b82f6"
                fillOpacity={0.25}
              />
              <Tooltip
                contentStyle={{ background: '#1a1d2e', border: '1px solid #2d3148', fontSize: 12 }}
                formatter={v => [`${v}/100`]}
              />
            </RadarChart>
          </ResponsiveContainer>
          <div className="flex gap-4 justify-center mt-1">
            {radarData.map(d => (
              <div key={d.subject} className="text-center">
                <p className="text-xs text-slate-500">{d.subject}</p>
                <p className="text-sm font-bold text-blue-400">{d.value}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Top hospital highlight */}
      {topHospital && (
        <div className="px-3 py-2 rounded bg-rapid-surface border border-green-900">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
            Top Ranked Hospital
          </p>
          <div className="flex items-center gap-2">
            <span className="text-2xl font-black text-green-400">
              {topHospital.composite_score}
            </span>
            <div>
              <p className="text-sm font-semibold text-slate-200">{topHospital.name}</p>
              <p className="text-xs text-slate-500">composite score out of 100</p>
            </div>
          </div>
        </div>
      )}

      {/* Warnings */}
      {result.warnings?.length > 0 && (
        <div className="px-3 py-2 rounded bg-red-950/30 border border-red-900">
          <p className="text-xs font-semibold text-red-400 uppercase tracking-wide mb-1">
            Warnings
          </p>
          {result.warnings.map((w, i) => (
            <p key={i} className="text-xs text-red-300 leading-relaxed">⚠ {w}</p>
          ))}
        </div>
      )}

      {/* Data confidence legend */}
      <div className="px-3 py-2 rounded bg-rapid-surface border border-rapid-border">
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1.5">
          Data Confidence
        </p>
        <div className="flex gap-3 flex-wrap">
          {[
            { label: 'OSM', desc: 'OpenStreetMap — real location',   color: 'text-blue-400 border-blue-800' },
            { label: 'SIM', desc: 'Simulated — deterministic seed',   color: 'text-amber-400 border-amber-800' },
            { label: 'EST', desc: 'Estimated — haversine + speed',    color: 'text-slate-400 border-slate-700' },
          ].map(b => (
            <div key={b.label} className="flex items-center gap-1.5">
              <span className={`text-xs px-1 rounded border font-mono ${b.color}`}>{b.label}</span>
              <span className="text-xs text-slate-500">{b.desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
