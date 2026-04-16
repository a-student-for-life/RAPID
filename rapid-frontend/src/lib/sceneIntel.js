const SEVERITY_ORDER = ['critical', 'moderate', 'minor']

export function getConsensusPatientGroups(summary) {
  return summary?.consensus_patient_groups || summary?.patient_groups || []
}

export function summarizeAssignments(assignments = []) {
  return assignments.reduce((acc, assignment) => {
    const severity = assignment?.severity
    if (!severity) return acc
    acc[severity] = (acc[severity] || 0) + (assignment?.patients_assigned || 0)
    return acc
  }, {})
}

export function hasSceneConsensus(summary) {
  return getConsensusPatientGroups(summary).some(group => (group?.count || 0) > 0)
}

export function buildRerouteConfirmationMessage(summary, assignments = []) {
  const consensus = getConsensusPatientGroups(summary)
  const current = summarizeAssignments(assignments)

  const lines = [
    'Confirm reroute using scene-confirmed counts?',
    '',
    `Reports received: ${summary?.report_count || 0}`,
    `Confidence: ${summary?.confidence || 'UNKNOWN'}`,
  ]

  if (summary?.total_estimated != null) {
    lines.push(`Estimated on scene: ~${summary.total_estimated}`)
  }

  lines.push('', 'Current dispatch -> scene consensus:')

  for (const severity of SEVERITY_ORDER) {
    const currentCount = current[severity] || 0
    const consensusCount = consensus.find(group => group?.severity === severity)?.count || 0
    lines.push(`- ${severity}: ${currentCount} -> ${consensusCount}`)
  }

  if (summary?.hazard_flags?.length) {
    lines.push('', `Hazards: ${summary.hazard_flags.join(' · ')}`)
  }

  return lines.join('\n')
}
