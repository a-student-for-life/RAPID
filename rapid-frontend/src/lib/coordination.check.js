import assert from 'node:assert/strict'

import { readBooleanEnv } from './appConfig.js'
import { buildCrewDispatchPayload } from './dispatchPayload.js'
import { buildRerouteConfirmationMessage, getConsensusPatientGroups, hasSceneConsensus } from './sceneIntel.js'
import { recommendUnitForAssignment } from './unitRecommendation.js'

function run() {
  assert.equal(readBooleanEnv('true'), true)
  assert.equal(readBooleanEnv('YES'), true)
  assert.equal(readBooleanEnv('0'), false)
  assert.equal(readBooleanEnv(undefined), false)

  const summary = {
    report_count: 2,
    confidence: 'MEDIUM',
    total_estimated: 5,
    hazard_flags: ['fuel leak'],
    consensus_patient_groups: [
      { severity: 'critical', count: 2, injury_type: 'trauma' },
      { severity: 'moderate', count: 2, injury_type: null },
      { severity: 'minor', count: 1, injury_type: null },
    ],
  }

  assert.deepEqual(getConsensusPatientGroups(summary).map(group => group.count), [2, 2, 1])
  assert.equal(hasSceneConsensus(summary), true)
  const rerouteMessage = buildRerouteConfirmationMessage(summary, [
    { severity: 'critical', patients_assigned: 1 },
    { severity: 'moderate', patients_assigned: 3 },
  ])
  assert.match(rerouteMessage, /Reports received: 2/)
  assert.match(rerouteMessage, /critical: 1 -> 2/)
  assert.match(rerouteMessage, /Hazards: fuel leak/)

  const recommendation = recommendUnitForAssignment(
    { severity: 'critical', patients_assigned: 2, injury_type: 'trauma' },
    { AMB_1: null, AMB_2: { status: 'transporting' }, AMB_3: null },
  )
  assert.equal(recommendation.unitId, 'AMB_1')
  assert.match(recommendation.reason, /critical transport/i)

  const payload = buildCrewDispatchPayload({
    unitId: 'AMB_1',
    incidentId: 'inc_123',
    assignment: {
      hospital: 'City General',
      patients_assigned: 2,
      severity: 'critical',
      injury_type: 'trauma',
      reason: 'Closest trauma destination.',
    },
    hospital: {
      lat: 19.1,
      lon: 72.9,
      eta_minutes: 12,
      trauma_centre: true,
      specialties: ['trauma', 'neuro'],
      capacity: { available_icu: 8 },
    },
    contact: { phone: '1234567890', area: 'Central' },
    incidentLat: 19.0,
    incidentLon: 72.8,
  })

  assert.equal(payload.available_icu, 8)
  assert.equal(payload.trauma_centre, true)
  assert.deepEqual(payload.specialties, ['trauma', 'neuro'])
  assert.equal(payload.phone, '1234567890')

  console.log('coordination checks passed')
}

run()
