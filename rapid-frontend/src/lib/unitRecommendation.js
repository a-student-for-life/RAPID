export const UNIT_PROFILES = {
  AMB_1: { callsign: 'ALPHA-1', role: 'als', specialties: ['critical', 'cardiac', 'trauma'] },
  AMB_2: { callsign: 'BRAVO-2', role: 'bls', specialties: ['minor', 'moderate'] },
  AMB_3: { callsign: 'CHARLIE-3', role: 'specialist', specialties: ['neuro', 'burns', 'ortho', 'trauma'] },
  AMB_4: { callsign: 'DELTA-4', role: 'mci', specialties: ['critical', 'multi'] },
  AMB_5: { callsign: 'ECHO-5', role: 'pediatric', specialties: ['paediatric', 'pediatric', 'minor'] },
}

const ROLE_BASE_SCORE = {
  als: 85,
  bls: 55,
  specialist: 78,
  mci: 72,
  pediatric: 60,
}

export function isUnitAvailable(unitDoc) {
  return !unitDoc || ['closed', 'standby'].includes(unitDoc.status)
}

export function recommendUnitForAssignment(assignment, unitDocs = {}) {
  const candidates = Object.entries(UNIT_PROFILES)
    .filter(([unitId]) => isUnitAvailable(unitDocs[unitId]))
    .map(([unitId, profile]) => ({
      unitId,
      profile,
      score: scoreUnit(profile, assignment),
    }))
    .sort((left, right) => right.score - left.score || left.unitId.localeCompare(right.unitId))

  if (!candidates.length) {
    return { unitId: 'AMB_1', reason: 'No standby units found — check unit statuses or use RESET UNITS if data is stale.' }
  }

  const best = candidates[0]
  return {
    unitId: best.unitId,
    reason: describeRecommendation(best.profile, assignment),
  }
}

function scoreUnit(profile, assignment = {}) {
  const severity = assignment?.severity || 'minor'
  const injuryType = String(assignment?.injury_type || '').toLowerCase()
  const patientsAssigned = assignment?.patients_assigned || 0

  let score = ROLE_BASE_SCORE[profile.role] || 50

  if (severity === 'critical') score += profile.role === 'als' ? 25 : 0
  if (severity === 'critical') score += profile.role === 'specialist' ? 18 : 0
  if (severity === 'critical' && patientsAssigned >= 4) score += profile.role === 'mci' ? 28 : 0
  if (severity === 'moderate') score += profile.role === 'bls' ? 12 : 0
  if (severity === 'minor') score += profile.role === 'bls' ? 20 : 0
  if (patientsAssigned >= 6) score += profile.role === 'mci' ? 30 : 0

  if (injuryType && profile.specialties.includes(injuryType)) score += 18
  if (injuryType && injuryType === 'trauma' && profile.role === 'als') score += 10
  if (injuryType && injuryType === 'cardiac' && profile.role === 'als') score += 12
  if (injuryType && ['neuro', 'burns', 'ortho'].includes(injuryType) && profile.role === 'specialist') score += 14

  return score
}

function describeRecommendation(profile, assignment = {}) {
  const severity = assignment?.severity || 'minor'
  const injuryType = assignment?.injury_type

  if (profile.role === 'mci' && (assignment?.patients_assigned || 0) >= 6) {
    return 'Recommended for larger patient loads and mass-casualty coordination.'
  }
  if (profile.role === 'als' && severity === 'critical') {
    return 'Recommended for critical transport with advanced life support coverage.'
  }
  if (profile.role === 'specialist' && injuryType) {
    return `Recommended for ${injuryType} routing and specialist response coverage.`
  }
  if (profile.role === 'bls') {
    return 'Recommended for lower-acuity transport while higher-acuity units stay free.'
  }
  return 'Recommended based on current role fit and available unit coverage.'
}
