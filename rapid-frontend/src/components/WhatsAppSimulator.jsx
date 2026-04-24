import React, { useEffect, useMemo, useState } from 'react'

/**
 * Mission Comms (F3) — reads crew status from localStorage so it shows
 * real data without needing Firestore. Updates every 2 s and on storage events.
 */

const UNITS = ['AMB_1', 'AMB_2', 'AMB_3', 'AMB_4', 'AMB_5']

const UNIT_CALLSIGN = {
  AMB_1: 'ALPHA-1', AMB_2: 'BRAVO-2', AMB_3: 'CHARLIE-3', AMB_4: 'DELTA-4', AMB_5: 'ECHO-5',
}

function formatTime(iso) {
  if (!iso) return ''
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
  catch { return '' }
}

function buildCrewMessages(crewDoc) {
  if (!crewDoc) return []
  const callsign = UNIT_CALLSIGN[crewDoc.unit_id] || crewDoc.unit_id
  const msgs = []
  if (crewDoc.dispatched_at) {
    msgs.push({
      from: 'dispatch',
      ts: crewDoc.dispatched_at,
      text: `🚑 RAPID Dispatch → ${callsign}\n` +
            `${crewDoc.patients_assigned} ${crewDoc.severity} patient${crewDoc.patients_assigned > 1 ? 's' : ''}` +
            (crewDoc.injury_type ? ` (${crewDoc.injury_type})` : '') +
            `\nDest: ${crewDoc.hospital_name}` +
            (crewDoc.eta_minutes != null ? ` · ETA ${Number(crewDoc.eta_minutes).toFixed(0)} min` : ''),
    })
  }
  if (crewDoc.acknowledged_at) {
    msgs.push({ from: 'crew', ts: crewDoc.acknowledged_at, text: `${callsign}: Copy. Rolling now. 🟢` })
  }
  if (crewDoc.on_scene_at) {
    msgs.push({ from: 'crew', ts: crewDoc.on_scene_at, text: `${callsign}: On scene. Assessing patients. 🔶` })
  }
  if (crewDoc.transporting_at) {
    msgs.push({ from: 'crew', ts: crewDoc.transporting_at, text: `${callsign}: Loaded and transporting to ${crewDoc.hospital_name}. 🚑` })
  }
  if (crewDoc.closed_at) {
    msgs.push({ from: 'crew', ts: crewDoc.closed_at, text: `${callsign}: Handover complete. ${crewDoc.patients_assigned} patient${crewDoc.patients_assigned > 1 ? 's' : ''} delivered. Returning to standby. ✅` })
  }
  return msgs
}

export default function WhatsAppSimulator({ incidentId, assignments = [], onClose }) {
  const [crewDocs, setCrewDocs] = useState({})

  useEffect(() => {
    function readFromStorage() {
      const next = {}
      UNITS.forEach(unitId => {
        try {
          const raw = localStorage.getItem(`rapid_crew_${unitId}`)
          if (!raw) return
          const doc = JSON.parse(raw)
          if (doc && (!incidentId || doc.incident_id === incidentId)) {
            next[unitId] = doc
          }
        } catch {}
      })
      setCrewDocs(next)
    }

    readFromStorage()
    const id = setInterval(readFromStorage, 2000)
    window.addEventListener('storage', readFromStorage)
    return () => {
      clearInterval(id)
      window.removeEventListener('storage', readFromStorage)
    }
  }, [incidentId])

  const messages = useMemo(() => {
    const all = []
    Object.values(crewDocs).forEach(doc => all.push(...buildCrewMessages(doc)))

    // Fallback: no dispatched crew yet — show initial dispatch notifications from routing result
    if (all.length === 0 && assignments.length > 0) {
      const now = new Date().toISOString()
      assignments.forEach((a, i) => {
        const unitId = `AMB_${i + 1}`
        const callsign = UNIT_CALLSIGN[unitId] || unitId
        all.push({
          from: 'dispatch',
          ts: now,
          text: `🚑 RAPID Dispatch → ${callsign}\n${a.patients_assigned} ${a.severity} patient${a.patients_assigned > 1 ? 's' : ''}` +
                (a.injury_type ? ` (${a.injury_type})` : '') +
                `\nDest: ${a.hospital}`,
        })
      })
    }

    return all.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''))
  }, [crewDocs, assignments])

  const dispatched = Object.values(crewDocs).filter(d => d?.status && d.status !== 'standby')
  const closed = dispatched.filter(d => d.status === 'closed').length

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div
        className="relative mx-auto flex h-[85vh] max-h-[780px] w-full max-w-[380px] flex-col overflow-hidden rounded-[36px] border-4 border-slate-900 bg-[#0b141a] shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Phone notch */}
        <div className="absolute left-1/2 top-2 h-5 w-24 -translate-x-1/2 rounded-full bg-slate-950" />

        {/* Header */}
        <div className="flex items-center gap-3 bg-[#128c7e] px-4 pt-8 pb-3 text-white">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-2 py-0.5 text-xl font-bold hover:bg-white/10"
            aria-label="Close"
          >
            ←
          </button>
          <div className="h-9 w-9 rounded-full bg-white/20 grid place-items-center text-lg">🚑</div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-bold">RAPID Mission Comms</p>
            <p className="text-[11px] text-white/70">
              {dispatched.length > 0
                ? `${dispatched.length} unit${dispatched.length > 1 ? 's' : ''} active · ${closed} closed`
                : incidentId ? `INC-${String(incidentId).slice(0, 8).toUpperCase()}` : 'No active incident'}
            </p>
          </div>
          <span className="text-[11px] font-bold opacity-80">LIVE</span>
        </div>

        {/* Messages */}
        <div
          className="flex-1 overflow-y-auto px-3 py-3 space-y-2"
          style={{
            backgroundColor: '#0b141a',
            backgroundImage: 'radial-gradient(rgba(255,255,255,0.03) 1px, transparent 1px)',
            backgroundSize: '20px 20px',
          }}
        >
          {messages.length === 0 && (
            <div className="mt-10 text-center text-xs text-slate-500 space-y-1">
              <p>No crew dispatched yet.</p>
              <p className="text-slate-600">Open Command Center → dispatch a unit to see live comms here.</p>
            </div>
          )}

          {messages.map((m, i) => {
            const isOutbound = m.from === 'dispatch'
            const align = isOutbound ? 'items-end' : 'items-start'
            const bubbleTone = isOutbound
              ? 'bg-[#005c4b] text-slate-100 rounded-br-sm'
              : 'bg-[#202c33] text-slate-100 rounded-bl-sm'
            return (
              <div key={i} className={`flex flex-col ${align}`}>
                <div className={`max-w-[85%] whitespace-pre-line rounded-2xl px-3 py-2 text-[13px] leading-snug ${bubbleTone}`}>
                  {m.text}
                </div>
                <p className="mt-0.5 text-[10px] text-slate-600">{formatTime(m.ts)}</p>
              </div>
            )
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 bg-[#1f2c33] px-3 py-2 text-slate-500">
          <span className="text-xl">🚑</span>
          <span className="flex-1 truncate rounded-full bg-[#2a3942] px-3 py-2 text-xs italic text-slate-500">
            Live crew status · updates every 2 s
          </span>
          <span className="text-xl">📡</span>
        </div>
      </div>
    </div>
  )
}
