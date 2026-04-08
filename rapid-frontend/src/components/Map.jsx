import React, { useEffect, useRef } from 'react'
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'

// Fix Leaflet default icon paths broken by Vite bundling
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

function incidentIcon() {
  return L.divIcon({
    className: '',
    html: '<div style="font-size:28px;line-height:1;filter:drop-shadow(0 0 6px #ef4444)">📍</div>',
    iconAnchor: [14, 28],
    popupAnchor: [0, -28],
  })
}

function hospitalIcon(score, isTopPick) {
  const color = score >= 70 ? '#10b981' : score >= 45 ? '#f59e0b' : '#ef4444'
  const ring  = isTopPick ? `box-shadow:0 0 0 2px ${color},0 0 12px ${color}` : ''
  return L.divIcon({
    className: '',
    html: `<div style="
      width:32px;height:32px;border-radius:50%;
      background:${color}22;border:2px solid ${color};
      display:flex;align-items:center;justify-content:center;
      font-size:14px;${ring};
      box-sizing:border-box;
    ">🏥</div>`,
    iconAnchor: [16, 16],
    popupAnchor: [0, -20],
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

// Inner component: manages ambulance animation imperatively via Leaflet API
function AmbulanceLayer({ incident, result }) {
  const map           = useMap()
  const markersRef    = useRef([])
  const animFrameRef  = useRef(null)

  useEffect(() => {
    // Clear previous ambulances
    markersRef.current.forEach(m => map.removeLayer(m))
    markersRef.current = []
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)

    if (!incident || !result?.assignments) return

    const ANIM_DURATION_MS = 12000 // 12s total animation regardless of real ETA

    const hosp_map = Object.fromEntries(
      (result.hospitals || []).map(h => [h.name, h])
    )

    // Create one ambulance per assignment
    const ambulances = result.assignments
      .filter(a => hosp_map[a.hospital])
      .map(a => {
        const target = hosp_map[a.hospital]
        const marker = L.marker(
          [incident.lat, incident.lon],
          { icon: ambulanceIcon(a.severity), zIndexOffset: 500 },
        ).addTo(map)
        marker.bindPopup(
          `<b>${a.patients_assigned} ${a.severity}</b><br>→ ${a.hospital}`,
        )
        return { marker, target, startedAt: Date.now() }
      })

    markersRef.current = ambulances.map(a => a.marker)

    function animate() {
      const now = Date.now()
      let allDone = true

      ambulances.forEach(({ marker, target, startedAt }) => {
        const t = Math.min(1, (now - startedAt) / ANIM_DURATION_MS)
        if (t < 1) allDone = false

        // Ease-in-out cubic
        const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

        const lat = incident.lat + (target.lat - incident.lat) * ease
        const lon = incident.lon + (target.lon - incident.lon) * ease
        marker.setLatLng([lat, lon])
      })

      if (!allDone) {
        animFrameRef.current = requestAnimationFrame(animate)
      }
    }

    animate()

    return () => {
      ambulances.forEach(({ marker }) => map.removeLayer(marker))
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    }
  }, [incident, result, map])

  return null
}

export default function RapidMap({ incident, result }) {
  const MUMBAI = [19.0728, 72.8826]

  const hospitals     = result?.hospitals || []
  const scores        = result?.scores    || []
  const topHospital   = scores[0]?.name

  const scoreMap = Object.fromEntries(scores.map(s => [s.name, s.composite_score]))

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

      {/* Incident pin */}
      {incident && (
        <Marker position={[incident.lat, incident.lon]} icon={incidentIcon()}>
          <Popup>
            <strong>Incident Site</strong><br />
            {incident.lat.toFixed(4)}, {incident.lon.toFixed(4)}
          </Popup>
        </Marker>
      )}

      {/* Hospital markers */}
      {hospitals.map(h => {
        const score     = scoreMap[h.name] ?? 50
        const isTopPick = h.name === topHospital
        return (
          <Marker
            key={h.id || h.name}
            position={[h.lat, h.lon]}
            icon={hospitalIcon(score, isTopPick)}
          >
            <Popup>
              <strong>{h.name}</strong><br />
              Score: {score}/100<br />
              {h.distance_km?.toFixed(1)} km away
            </Popup>
          </Marker>
        )
      })}

      {/* Animated ambulances */}
      {incident && result && (
        <AmbulanceLayer incident={incident} result={result} />
      )}
    </MapContainer>
  )
}
