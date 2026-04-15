/**
 * Static contact lookup for the 6 known Mumbai hospitals.
 * Phone numbers are real public numbers for these institutions.
 */
export const HOSPITAL_CONTACTS = {
  'KEM':        { phone: '+91-22-2410-7000', area: 'Parel' },
  'Lokmanya':   { phone: '+91-22-2404-3009', area: 'Sion' },
  'Rajawadi':   { phone: '+91-22-2501-7777', area: 'Ghatkopar' },
  'Bhabha':     { phone: '+91-22-2642-4444', area: 'Bandra' },
  'Wockhardt':  { phone: '+91-22-6787-8787', area: 'Mulund' },
  'Kokilaben':  { phone: '+91-22-3066-6666', area: 'Andheri' },
}

/**
 * Fuzzy match: checks if any contact key appears in the hospital name.
 * Returns {phone, area} or null.
 */
export function getContact(hospitalName) {
  if (!hospitalName) return null
  const lower = hospitalName.toLowerCase()
  for (const [key, val] of Object.entries(HOSPITAL_CONTACTS)) {
    if (lower.includes(key.toLowerCase())) return val
  }
  return null
}
