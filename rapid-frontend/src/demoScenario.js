/**
 * Pre-loaded demo scenario: Kurla Station train derailment, Mumbai
 * Coordinates: Kurla station (19.0728, 72.8826)
 */
export const DEMO_SCENARIO = {
  icon: '🚂',
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
  icon: '🏗️',
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

/**
 * BKC Chemical Plant Fire — burn + respiratory MCI
 * Bandra–Kurla Complex: Mumbai's financial district, hosts pharma/industrial plants
 * 40 patients → triggers MCI threshold (>30)
 */
export const SCENARIO_BKC_FIRE = {
  icon: '🔥',
  label: 'BKC Chemical Plant Fire',
  description: 'Industrial fire — burn injuries + respiratory casualties, 40 patients',
  lat: 19.0596,
  lon: 72.8656,
  patients: [
    { severity: 'critical', count: 5, injury_type: 'burns'  },
    { severity: 'critical', count: 3, injury_type: 'trauma' },
    { severity: 'moderate', count: 18, injury_type: null     },
    { severity: 'minor',    count: 14, injury_type: null     },
  ],
}

/**
 * Versova Coastal Flood — monsoon surge, pediatric casualties
 * Versova: real coastal fishing village on Mumbai's northwest shore, flood-prone
 * 50 patients → triggers MCI on both thresholds
 */
export const SCENARIO_VERSOVA_FLOOD = {
  icon: '🌊',
  label: 'Versova Coastal Flood',
  description: 'Flash flood surge — mixed casualties including pediatric, 50 patients',
  lat: 19.1328,
  lon: 72.8100,
  patients: [
    { severity: 'critical', count: 4,  injury_type: 'trauma'  },
    { severity: 'critical', count: 6,  injury_type: 'general' },
    { severity: 'moderate', count: 22, injury_type: null       },
    { severity: 'minor',    count: 18, injury_type: null       },
  ],
}

/**
 * Chembur Refinery Explosion — ONGC Mumbai complex, polytrauma MCI
 * ONGC complex actually located at ~19.0522, 72.9005 in Chembur
 * 50 patients, 15 critical across 3 specialty types → max routing complexity
 */
export const SCENARIO_CHEMBUR_BLAST = {
  icon: '💥',
  label: 'Chembur Refinery Explosion',
  description: 'ONGC complex blast — polytrauma, burns, neuro, 50 patients',
  lat: 19.0522,
  lon: 72.9005,
  patients: [
    { severity: 'critical', count: 8,  injury_type: 'trauma' },
    { severity: 'critical', count: 4,  injury_type: 'burns'  },
    { severity: 'critical', count: 3,  injury_type: 'neuro'  },
    { severity: 'moderate', count: 25, injury_type: null      },
    { severity: 'minor',    count: 10, injury_type: null      },
  ],
}

export const ALL_SCENARIOS = [
  DEMO_SCENARIO,
  SCENARIO_COLLAPSE,
  SCENARIO_BKC_FIRE,
  SCENARIO_VERSOVA_FLOOD,
  SCENARIO_CHEMBUR_BLAST,
]
