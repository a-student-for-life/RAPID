export function readBooleanEnv(value) {
  if (typeof value !== 'string') return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

const viteEnv = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : {}

export const AUTO_DEMO_ENABLED = readBooleanEnv(viteEnv.VITE_ENABLE_AUTO_DEMO)
