import React, { useEffect, useRef, useState } from 'react'
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import {
  APIProvider,
  Map as GMap,
  AdvancedMarker,
  useMap as useGMap,
} from '@vis.gl/react-google-maps'

// Fix Leaflet default icon paths broken by Vite bundling
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

const GMAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || ''

// ── Shared helpers ─────────────────────────────────────────────────────────────

function scoreColor(score) {
  if (score >= 70) return '#10b981'
  if (score >= 45) return '#f59e0b'
  return '#ef4444'
}

// ═══════════════════════════════════════════════════════════════════════════════
// LEAFLET IMPLEMENTATION (OSS fallback — zero cost, always available)
// ═══════════════════════════════════════════════════════════════════════════════

function incidentIconLeaflet(critical = 0, moderate = 0, minor = 0) {
  const hasTags = critical > 0 || moderate > 0 || minor > 0
  const tags = hasTags
    ? `<div style="display:flex;gap:3px;margin-top:3px;justify-content:center">
        ${critical > 0 ? `<span style="background:#ef4444;color:#fff;font-size:9px;font-weight:900;padding:1px 4px;border-radius:3px">R ${critical}</span>` : ''}
        ${moderate > 0 ? `<span style="background:#f59e0b;color:#fff;font-size:9px;font-weight:900;padding:1px 4px;border-radius:3px">Y ${moderate}</span>` : ''}
        ${minor > 0 ? `<span style="background:#10b981;color:#fff;font-size:9px;font-weight:900;padding:1px 4px;border-radius:3px">G ${minor}</span>` : ''}
      </div>`
    : ''
  return L.divIcon({
    className: '',
    html: `<div style="text-align:center">
      <div style="font-size:28px;line-height:1;filter:drop-shadow(0 0 6px #ef4444)">📍</div>
      ${tags}
    </div>`,
    iconAnchor: [14, 28],
    popupAnchor: [0, -28],
  })
}

function hospitalIconLeaflet(score, isTopPick) {
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

function agencyIconLeaflet(type) {
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

function ambulanceIconLeaflet(severity) {
  const emoji = severity === 'critical' ? '🚑' : severity === 'moderate' ? '🚐' : '🚗'
  return L.divIcon({
    className: 'ambulance-icon',
    html: `<span style="font-size:22px;line-height:1">${emoji}</span>`,
    iconAnchor: [11, 11],
  })
}

function LeafletClickHandler({ onLocationSelect }) {
  useMapEvents({
    click(e) {
      if (onLocationSelect) onLocationSelect({ lat: e.latlng.lat, lon: e.latlng.lng })
    },
  })
  return null
}

function LeafletAmbulanceLayer({ incident, result }) {
  const map          = useMap()
  const markersRef   = useRef([])
  const animFrameRef = useRef(null)

  useEffect(() => {
    markersRef.current.forEach(m => map.removeLayer(m))
    markersRef.current = []
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    if (!incident || !result?.assignments) return

    const ANIM_DURATION_MS = 12000
    const hospMap = Object.fromEntries((result.hospitals || []).map(h => [h.name, h]))

    const ambulances = result.assignments
      .filter(a => hospMap[a.hospital])
      .map(a => {
        const target = hospMap[a.hospital]
        const marker = L.marker(
          [incident.lat, incident.lon],
          { icon: ambulanceIconLeaflet(a.severity), zIndexOffset: 500 },
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
        const ease = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3) / 2
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

function LeafletMapView({ incident, hospitals, scores, agencies, result, assignedCount, assignedNames, scoreMap, topName, onLocationSelect }) {
  const MUMBAI = [19.0728, 72.8826]
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
      <LeafletClickHandler onLocationSelect={onLocationSelect} />

      {incident && (() => {
        const asgns = result?.assignments || []
        const critical = asgns.filter(a => a.severity === 'critical').reduce((s, a) => s + (a.patients_assigned ?? 0), 0)
        const moderate = asgns.filter(a => a.severity === 'moderate').reduce((s, a) => s + (a.patients_assigned ?? 0), 0)
        const minor    = asgns.filter(a => a.severity === 'minor').reduce((s, a) => s + (a.patients_assigned ?? 0), 0)
        return (
          <Marker position={[incident.lat, incident.lon]} icon={incidentIconLeaflet(critical, moderate, minor)}>
            <Popup>
              <strong>Incident Site</strong><br />
              {incident.lat.toFixed(4)}, {incident.lon.toFixed(4)}<br />
              {critical > 0 && <span style={{ color: '#ef4444' }}>🔴 {critical} critical · </span>}
              {moderate > 0 && <span style={{ color: '#f59e0b' }}>🟡 {moderate} moderate · </span>}
              {minor > 0 && <span style={{ color: '#10b981' }}>🟢 {minor} minor</span>}
              <br /><span style={{ fontSize: '11px', color: '#888' }}>Click map to reposition</span>
            </Popup>
          </Marker>
        )
      })()}

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

      {hospitals.map(h => (
        <Marker
          key={h.id || h.name}
          position={[h.lat, h.lon]}
          icon={hospitalIconLeaflet(scoreMap[h.name] ?? 50, h.name === topName)}
        >
          <Popup>
            <strong>{h.name}</strong><br />
            Score: <b>{scoreMap[h.name] ?? '?'}/100</b><br />
            {h.distance_km?.toFixed(1)} km away<br />
            {assignedNames.has(h.name) && (
              <span style={{ color: '#10b981', fontWeight: 'bold' }}>
                ✓ {assignedCount[h.name]} patients assigned
              </span>
            )}
          </Popup>
        </Marker>
      ))}

      {agencies.map(agency => (
        <Marker
          key={agency.id}
          position={[agency.lat, agency.lon]}
          icon={agencyIconLeaflet(agency.type)}
        >
          <Popup>
            <strong>{agency.name}</strong><br />
            {agency.type === 'fire_station' ? '🚒 Fire Station' : '👮 Police Station'}<br />
            {agency.distance_km} km from incident
          </Popup>
        </Marker>
      ))}

      {incident && result && <LeafletAmbulanceLayer incident={incident} result={result} />}
    </MapContainer>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// GOOGLE MAPS IMPLEMENTATION (primary — uses $200/month renewable credit)
// ═══════════════════════════════════════════════════════════════════════════════

function GmapsPolylinesLayer({ incident, hospitals, scoreMap, assignedCount, assignedNames }) {
  const map = useGMap()
  const linesRef = useRef([])

  useEffect(() => {
    linesRef.current.forEach(l => l.setMap(null))
    linesRef.current = []
    if (!map || !incident || !hospitals.length) return

    hospitals.forEach(h => {
      const score    = scoreMap[h.name] ?? 50
      const assigned = assignedNames.has(h.name)
      const count    = assignedCount[h.name] || 0
      const line = new google.maps.Polyline({
        path: [
          { lat: incident.lat, lng: incident.lon },
          { lat: h.lat, lng: h.lon },
        ],
        strokeColor:   assigned ? scoreColor(score) : '#475569',
        strokeWeight:  assigned ? Math.max(2, Math.min(5, count * 0.3 + 2)) : 1,
        strokeOpacity: assigned ? 0.7 : 0.3,
        icons: assigned ? undefined : [{
          icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 3 },
          offset: '0', repeat: '18px',
        }],
        map,
      })
      linesRef.current.push(line)
    })

    return () => linesRef.current.forEach(l => l.setMap(null))
  }, [map, incident, hospitals, scoreMap, assignedCount, assignedNames])

  return null
}

function GmapsAmbulanceLayer({ incident, result }) {
  const map = useGMap()
  const markersRef   = useRef([])
  const animFrameRef = useRef(null)

  useEffect(() => {
    markersRef.current.forEach(m => { m.map = null })
    markersRef.current = []
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    if (!map || !incident || !result?.assignments) return

    const ANIM_DURATION_MS = 12000
    const hospMap = Object.fromEntries((result.hospitals || []).map(h => [h.name, h]))

    const ambulances = result.assignments
      .filter(a => hospMap[a.hospital])
      .map(a => {
        const target = hospMap[a.hospital]
        const emoji  = a.severity === 'critical' ? '🚑' : a.severity === 'moderate' ? '🚐' : '🚗'
        const el     = document.createElement('div')
        el.style.cssText = 'font-size:22px;line-height:1;cursor:default'
        el.textContent   = emoji

        try {
          const marker = new google.maps.marker.AdvancedMarkerElement({
            map,
            position: { lat: incident.lat, lng: incident.lon },
            content:  el,
            title:    `${a.patients_assigned} ${a.severity} → ${a.hospital}`,
          })
          return { marker, target, startedAt: Date.now() }
        } catch (err) {
          console.warn('[RAPID] AdvancedMarkerElement failed:', err?.message)
          return null
        }
      })
      .filter(Boolean)

    markersRef.current = ambulances.map(a => a.marker)

    function animate() {
      const now = Date.now()
      let allDone = true
      ambulances.forEach(({ marker, target, startedAt }) => {
        const t    = Math.min(1, (now - startedAt) / ANIM_DURATION_MS)
        if (t < 1) allDone = false
        const ease = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2, 3) / 2
        marker.position = {
          lat: incident.lat + (target.lat - incident.lat) * ease,
          lng: incident.lon + (target.lon - incident.lon) * ease,
        }
      })
      if (!allDone) animFrameRef.current = requestAnimationFrame(animate)
    }
    animate()

    return () => {
      ambulances.forEach(({ marker }) => { marker.map = null })
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    }
  }, [map, incident, result])

  return null
}

function GmapsMapView({ incident, hospitals, scores, agencies, result, assignedCount, assignedNames, scoreMap, topName, onLocationSelect }) {
  const MUMBAI = { lat: 19.0728, lng: 72.8826 }
  const [activePopup, setActivePopup] = useState(null)

  function handleMapClick(e) {
    if (onLocationSelect && e.detail?.latLng) {
      onLocationSelect({ lat: e.detail.latLng.lat, lon: e.detail.latLng.lng })
    }
    setActivePopup(null)
  }

  return (
    <GMap
      defaultCenter={incident ? { lat: incident.lat, lng: incident.lon } : MUMBAI}
      defaultZoom={12}
      gestureHandling="greedy"
      disableDefaultUI={false}
      mapId="rapid-dispatch-map"
      style={{ width: '100%', height: '100%' }}
      onClick={handleMapClick}
    >
      {/* Polylines */}
      <GmapsPolylinesLayer
        incident={incident}
        hospitals={hospitals}
        scoreMap={scoreMap}
        assignedCount={assignedCount}
        assignedNames={assignedNames}
      />

      {/* Incident pin with triage tag overlay */}
      {incident && (() => {
        const asgns = result?.assignments || []
        const critical = asgns.filter(a => a.severity === 'critical').reduce((s, a) => s + (a.patients_assigned ?? 0), 0)
        const moderate = asgns.filter(a => a.severity === 'moderate').reduce((s, a) => s + (a.patients_assigned ?? 0), 0)
        const minor    = asgns.filter(a => a.severity === 'minor').reduce((s, a) => s + (a.patients_assigned ?? 0), 0)
        const hasTags  = critical > 0 || moderate > 0 || minor > 0
        return (
          <AdvancedMarker
            position={{ lat: incident.lat, lng: incident.lon }}
            onClick={() => setActivePopup('incident')}
          >
            <div style={{ textAlign: 'center', cursor: 'pointer' }}>
              <div style={{ fontSize: '28px', lineHeight: 1, filter: 'drop-shadow(0 0 6px #ef4444)' }}>📍</div>
              {hasTags && (
                <div style={{ display: 'flex', gap: '3px', marginTop: '3px', justifyContent: 'center' }}>
                  {critical > 0 && <span style={{ background: '#ef4444', color: '#fff', fontSize: '9px', fontWeight: 900, padding: '1px 4px', borderRadius: '3px' }}>R {critical}</span>}
                  {moderate > 0 && <span style={{ background: '#f59e0b', color: '#fff', fontSize: '9px', fontWeight: 900, padding: '1px 4px', borderRadius: '3px' }}>Y {moderate}</span>}
                  {minor > 0 && <span style={{ background: '#10b981', color: '#fff', fontSize: '9px', fontWeight: 900, padding: '1px 4px', borderRadius: '3px' }}>G {minor}</span>}
                </div>
              )}
              {activePopup === 'incident' && (
                <div style={{
                  position: 'absolute', bottom: '40px', left: '50%', transform: 'translateX(-50%)',
                  background: '#1e293b', border: '1px solid #334155', borderRadius: '6px',
                  padding: '8px 10px', whiteSpace: 'nowrap', zIndex: 10,
                  fontSize: '12px', color: '#e2e8f0', pointerEvents: 'none',
                }}>
                  <strong>Incident Site</strong><br />
                  {incident.lat.toFixed(4)}, {incident.lon.toFixed(4)}<br />
                  {hasTags && <span>{critical > 0 ? `🔴 ${critical} · ` : ''}{moderate > 0 ? `🟡 ${moderate} · ` : ''}{minor > 0 ? `🟢 ${minor}` : ''}</span>}
                </div>
              )}
            </div>
          </AdvancedMarker>
        )
      })()}

      {/* Hospital markers */}
      {hospitals.map(h => {
        const score   = scoreMap[h.name] ?? 50
        const color   = scoreColor(score)
        const isTop   = h.name === topName
        const ring    = isTop ? `box-shadow:0 0 0 2px ${color},0 0 12px ${color}` : ''
        const assigned = assignedNames.has(h.name)
        return (
          <AdvancedMarker
            key={h.id || h.name}
            position={{ lat: h.lat, lng: h.lon }}
            onClick={() => setActivePopup(h.name)}
          >
            <div style={{
              width: '32px', height: '32px', borderRadius: '50%',
              background: `${color}22`, border: `2px solid ${color}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '14px', boxSizing: 'border-box', cursor: 'pointer',
              ...(isTop ? { boxShadow: `0 0 0 2px ${color},0 0 12px ${color}` } : {}),
            }}>
              🏥
            </div>
            {activePopup === h.name && (
              <div style={{
                position: 'absolute', bottom: '40px', left: '50%', transform: 'translateX(-50%)',
                background: '#1e293b', border: '1px solid #334155', borderRadius: '6px',
                padding: '8px 10px', whiteSpace: 'nowrap', zIndex: 10,
                fontSize: '12px', color: '#e2e8f0', pointerEvents: 'none',
              }}>
                <strong>{h.name}</strong><br />
                Score: <b>{score}/100</b> · {h.distance_km?.toFixed(1)} km<br />
                {assigned && <span style={{ color: '#10b981' }}>✓ {assignedCount[h.name]} patients assigned</span>}
              </div>
            )}
          </AdvancedMarker>
        )
      })}

      {/* Agency markers */}
      {agencies.map(agency => (
        <AdvancedMarker
          key={agency.id}
          position={{ lat: agency.lat, lng: agency.lon }}
          onClick={() => setActivePopup(agency.id)}
        >
          <div style={{
            width: '28px', height: '28px', borderRadius: '6px',
            background: '#1e293b', border: '1.5px solid #64748b',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '14px', boxSizing: 'border-box', cursor: 'pointer',
          }}>
            {agency.type === 'fire_station' ? '🚒' : '👮'}
          </div>
          {activePopup === agency.id && (
            <div style={{
              position: 'absolute', bottom: '36px', left: '50%', transform: 'translateX(-50%)',
              background: '#1e293b', border: '1px solid #334155', borderRadius: '6px',
              padding: '8px 10px', whiteSpace: 'nowrap', zIndex: 10,
              fontSize: '12px', color: '#e2e8f0', pointerEvents: 'none',
            }}>
              <strong>{agency.name}</strong><br />
              {agency.type === 'fire_station' ? '🚒 Fire Station' : '👮 Police Station'}<br />
              {agency.distance_km} km from incident
            </div>
          )}
        </AdvancedMarker>
      ))}

      {/* Animated ambulances */}
      {incident && result && <GmapsAmbulanceLayer incident={incident} result={result} />}
    </GMap>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT — routes to Google Maps or Leaflet based on key availability
// ═══════════════════════════════════════════════════════════════════════════════

export default function RapidMap({ incident, result, onLocationSelect }) {
  const hospitals = result?.hospitals || []
  const scores    = result?.scores    || []
  const agencies  = result?.agencies  || []

  const scoreMap = Object.fromEntries(scores.map(s => [s.name, s.composite_score]))
  const topName  = scores[0]?.name

  const assignedCount = {}
  ;(result?.assignments || []).forEach(a => {
    assignedCount[a.hospital] = (assignedCount[a.hospital] || 0) + a.patients_assigned
  })
  const assignedNames = new Set(Object.keys(assignedCount))

  const sharedProps = {
    incident, hospitals, scores, agencies, result,
    assignedCount, assignedNames, scoreMap, topName,
    onLocationSelect,
  }

  if (GMAPS_KEY) {
    return (
      <APIProvider apiKey={GMAPS_KEY} libraries={['marker']}>
        <GmapsMapView {...sharedProps} />
      </APIProvider>
    )
  }

  return <LeafletMapView {...sharedProps} />
}
