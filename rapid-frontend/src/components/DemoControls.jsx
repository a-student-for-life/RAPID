import React from 'react'
import { ALL_SCENARIOS } from '../demoScenario.js'

export default function DemoControls({ onLoadScenario, onReset, forceFallback, onToggleFallback, hasResults }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Demo Controls</p>

      {/* Scenario buttons */}
      <div className="flex flex-col gap-1.5">
        {ALL_SCENARIOS.map((scenario, i) => (
          <button
            key={i}
            onClick={() => onLoadScenario(scenario)}
            className="w-full text-left px-3 py-2 rounded bg-rapid-surface border border-rapid-border hover:border-blue-500 transition-colors group"
          >
            <div className="flex items-center gap-2">
              <span className="text-base">{i === 0 ? '🚂' : '🏗️'}</span>
              <div>
                <p className="text-xs font-semibold text-slate-200 group-hover:text-blue-300 transition-colors">
                  {scenario.label}
                </p>
                <p className="text-xs text-slate-500">{scenario.description}</p>
              </div>
            </div>
          </button>
        ))}
      </div>

      {/* Fallback toggle */}
      <button
        onClick={onToggleFallback}
        className={`w-full px-3 py-2 rounded border text-xs font-semibold transition-all ${
          forceFallback
            ? 'bg-amber-900/40 border-amber-500 text-amber-300'
            : 'bg-rapid-surface border-rapid-border text-slate-400 hover:border-amber-500 hover:text-amber-300'
        }`}
      >
        {forceFallback ? '⚡ AI DISABLED — Fallback Active' : '⚡ Simulate AI Failure'}
      </button>

      {/* Reset */}
      {hasResults && (
        <button
          onClick={onReset}
          className="w-full px-3 py-1.5 rounded border border-rapid-border text-xs text-slate-500 hover:text-red-400 hover:border-red-800 transition-colors"
        >
          ✕ Reset
        </button>
      )}
    </div>
  )
}
