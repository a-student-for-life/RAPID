import React, { useEffect, useRef } from 'react'
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'

// Fix Leaflet default icon paths broken by Vite bundling
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function scoreColor(score) {
  if (score >= 70) return '#10b981'
  if (score >= 45) return '#f59e0b'
  return '#ef4444'
}

function incidentIcon() {
  return L.divIcon({
    className: '',
    html: '<div style="font-size:28px;line-height:1;filter:drop-shadow(0 0 6px #ef4444)">📍</div>',
    iconAnchor: [14, 28],
    popupAnchor: [0, -28],
  })
}

function hospitalIcon(score, isTopPick) {
  const color = scoreColor(score)
  const ring  = isTopPick ? `box-shadow:0 0 0 2px ${color},0 0 12px ${color}` : ''
  return L.divIcon({
    className: '',
    html: `<div style="
      width:32px;height:32px;border-radius:50%;
      background:${color}22;border:2px solid ${color};
      display:flex;align-items:center;justify-content:center;
      font-size:14px;${ring};box-sizing:border-box;
    ">🏥</div>`,
    iconAnchor: [16, 16],
    popupAnchor: [0, -20],
  })
}

function agencyIcon(type) {
  const emoji = type === 'fire_station' ? '🚒' : '👮'
  return L.divIcon({
    className: '',
    html: `<div style="
      width:28px;height:28px;border-radius:6px;
      background:#1e293b;border:1.5px solid #64748b;
      display:flex;align-items:center;justify-content:center;
      font-size:14px;box-sizing:border-box;
    ">${emoji}</div>`,
    iconAnchor: [14, 14],
    popupAnchor: [0, -16],
  })
}

function ambulanceIcon(severity) {
  const emoji = severity === 'critical' ? '🚑' : severity === 'moderate' ? '🚐' : '🚗'
  return L.divIcon({
    className: 'ambulance-icon',
    html: `<span style="font-size:22px;line-height:1">${emoji}</span>`,
    iconAnchor: [11, 11],
  })
}

// ── Click-to-place handler ────────────────────────────────────────────────────
function ClickHandler({ onLocationSelect }) {
  useMapEvents({
    click(e) {
      if (onLocationSelect) {
        onLocationSelect({ lat: e.latlng.lat, lon: e.latlng.lng })
      }
    },
  })
  return null
}

// ── Ambulance animation ───────────────────────────────────────────────────────
function AmbulanceLayer({ incident, result }) {
  const map          = useMap()
  const markersRef   = useRef([])
  const animFrameRef = useRef(null)

  useEffect(() => {
    markersRef.current.forEach(m => map.removeLayer(m))
    markersRef.current = []
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)

    if (!incident || !result?.assignments) return

    const ANIM_DURATION_MS = 12000

    const hospMap = Object.fromEntries(
      (result.hospitals || []).map(h => [h.name, h])
    )

    const ambulances = result.assignments
      .filter(a => hospMap[a.hospital])
      .map(a => {
        const target = hospMap[a.hospital]
        const marker = L.marker(
          [incident.lat, incident.lon],
          { icon: ambulanceIcon(a.severity), zIndexOffset: 500 },
        ).addTo(map)
        marker.bindPopup(`<b>${a.patients_assigned} ${a.severity}</b><br>→ ${a.hospital}`)
        return { marker, target, startedAt: Date.now() }
      })

    markersRef.current = ambulances.map(a => a.marker)

    function animate() {
      const now = Date.now()
      let allDone = true
      ambulances.forEach(({ marker, target, startedAt }) => {
        const t    = Math.min(1, (now - startedAt) / ANIM_DURATION_MS)
        if (t < 1) allDone = false
        const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
        marker.setLatLng([
          incident.lat + (target.lat - incident.lat) * ease,
          incident.lon + (target.lon - incident.lon) * ease,
        ])
      })
      if (!allDone) animFrameRef.current = requestAnimationFrame(animate)
    }

    animate()

    return () => {
      ambulances.forEach(({ marker }) => map.removeLayer(marker))
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    }
  }, [incident, result, map])

  return null
}

// ── Main component ────────────────────────────────────────────────────────────
export default function RapidMap({ incident, result, onLocationSelect }) {
  const MUMBAI    = [19.0728, 72.8826]
  const hospitals = result?.hospitals || []
  const scores    = result?.scores    || []
  const agencies  = result?.agencies  || []

  const scoreMap = Object.fromEntries(scores.map(s => [s.name, s.composite_score]))
  const topName  = scores[0]?.name

  // Build assigned-count lookup for polyline weight
  const assignedCount = {}
  ;(result?.assignments || []).forEach(a => {
    assignedCount[a.hospital] = (assignedCount[a.hospital] || 0) + a.patients_assigned
  })
  const assignedNames = new Set(Object.keys(assignedCount))

  return (
    <MapContainer
      center={incident ? [incident.lat, incident.lon] : MUMBAI}
      zoom={12}
      className="w-full h-full"
      style={{ minHeight: '100%' }}
    >
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
      />

      {/* Click to reposition incident */}
      <ClickHandler onLocationSelect={onLocationSelect} />

      {/* Incident pin */}
      {incident && (
        <Marker position={[incident.lat, incident.lon]} icon={incidentIcon()}>
          <Popup>
            <strong>Incident Site</strong><br />
            {incident.lat.toFixed(4)}, {incident.lon.toFixed(4)}<br />
            <span style={{ fontSize: '11px', color: '#888' }}>Click map to reposition</span>
          </Popup>
        </Marker>
      )}

      {/* Polylines: incident → each hospital */}
      {incident && hospitals.map(h => {
        const score    = scoreMap[h.name] ?? 50
        const assigned = assignedNames.has(h.name)
        const count    = assignedCount[h.name] || 0
        return (
          <Polyline
            key={`line-${h.id || h.name}`}
            positions={[[incident.lat, incident.lon], [h.lat, h.lon]]}
            color={assigned ? scoreColor(score) : '#475569'}
            weight={assigned ? Math.max(2, Math.min(5, count * 0.3 + 2)) : 1}
            opacity={assigned ? 0.7 : 0.25}
            dashArray={assigned ? undefined : '5,8'}
          />
        )
      })}

      {/* Hospital markers */}
      {hospitals.map(h => {
        const score    = scoreMap[h.name] ?? 50
        const isTop    = h.name === topName
        const assigned = assignedNames.has(h.name)
        return (
          <Marker
            key={h.id || h.name}
            position={[h.lat, h.lon]}
            icon={hospitalIcon(score, isTop)}
          >
            <Popup>
              <strong>{h.name}</strong><br />
              Score: <b>{score}/100</b><br />
              {h.distance_km?.toFixed(1)} km away<br />
              {assigned && (
                <span style={{ color: '#10b981', fontWeight: 'bold' }}>
                  ✓ {assignedCount[h.name]} patients assigned
                </span>
              )}
            </Popup>
          </Marker>
        )
      })}

      {/* Agency markers (fire stations, police) */}
      {agencies.map(agency => (
        <Marker
          key={agency.id}
          position={[agency.lat, agency.lon]}
          icon={agencyIcon(agency.type)}
        >
          <Popup>
            <strong>{agency.name}</strong><br />
            {agency.type === 'fire_station' ? '🚒 Fire Station' : '👮 Police Station'}<br />
            {agency.distance_km} km from incident
          </Popup>
        </Marker>
      ))}

      {/* Animated ambulances */}
      {incident && result && (
        <AmbulanceLayer incident={incident} result={result} />
      )}
    </MapContainer>
  )
}
