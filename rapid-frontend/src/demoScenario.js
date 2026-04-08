/**
 * Pre-loaded demo scenario: Kurla Station train derailment, Mumbai
 * Coordinates: Kurla station (19.0728, 72.8826)
 *
 * Scenario: Express train derailment at peak hours.
 * Casualties: 35 total across 3 severity tiers with varied injury types.
 */
export const DEMO_SCENARIO = {
  label: 'Kurla Station Derailment',
  description: 'Express train derailment — 35 casualties, mixed injury types',
  lat: 19.0728,
  lon: 72.8826,
  patients: [
    { severity: 'critical', count: 2, injury_type: 'burns' },
    { severity: 'critical', count: 2, injury_type: 'neuro' },
    { severity: 'critical', count: 4, injury_type: 'trauma' },
    { severity: 'moderate', count: 15, injury_type: null },
    { severity: 'minor',    count: 12, injury_type: null },
  ],
}

/**
 * Alternate scenario: Dharavi building collapse
 */
export const SCENARIO_COLLAPSE = {
  label: 'Dharavi Building Collapse',
  description: 'Multi-storey collapse — crush injuries + entrapment',
  lat: 19.0422,
  lon: 72.8530,
  patients: [
    { severity: 'critical', count: 6, injury_type: 'ortho' },
    { severity: 'critical', count: 3, injury_type: 'trauma' },
    { severity: 'moderate', count: 20, injury_type: null },
    { severity: 'minor',    count: 10, injury_type: null },
  ],
}

export const ALL_SCENARIOS = [DEMO_SCENARIO, SCENARIO_COLLAPSE]
