export function buildCrewDispatchPayload({
  unitId,
  incidentId,
  assignment,
  hospital,
  contact,
  incidentLat,
  incidentLon,
}) {
  const specialties = Array.isArray(hospital?.specialties) ? hospital.specialties : []

  return {
    unit_id: unitId,
    incident_id: incidentId || '',
    hospital_name: assignment?.hospital || '',
    hospital_lat: hospital?.lat ?? 0,
    hospital_lon: hospital?.lon ?? 0,
    incident_lat: incidentLat ?? null,
    incident_lon: incidentLon ?? null,
    eta_minutes: hospital?.eta_minutes ?? null,
    patients_assigned: assignment?.patients_assigned ?? 0,
    severity: assignment?.severity || 'minor',
    injury_type: assignment?.injury_type ?? null,
    reason: assignment?.reason ?? '',
    available_icu: hospital?.capacity?.available_icu ?? null,
    trauma_centre: hospital?.trauma_centre ?? false,
    specialties,
    phone: contact?.phone ?? null,
    area: contact?.area ?? null,
  }
}
