export const CONFIG_PIN_ENV = 'HELIO_CONFIG_SHA256'

const SHA256_HEX = /^[0-9a-f]{64}$/

/**
 * Normalize a pin value: trim, drop an optional `sha256:` prefix in any
 * case, lowercase; null unless what remains is 64 hex characters.
 */
export function normalizeConfigPin(raw: string): string | null {
  const trimmed = raw.trim()
  const unprefixed = /^sha256:/i.test(trimmed) ? trimmed.slice('sha256:'.length) : trimmed
  const hex = unprefixed.toLowerCase()
  return SHA256_HEX.test(hex) ? hex : null
}

export type ConfigPin =
  | { readonly status: 'unset' }
  | { readonly status: 'invalid'; readonly raw: string }
  | { readonly status: 'set'; readonly sha256: string }

/**
 * Read the pin from the environment. A variable that is present, an empty
 * string included, must normalize or the pin is invalid: a pin that failed
 * to compute must never start an unpinned proxy.
 */
export function readConfigPin(env: Record<string, string | undefined> = process.env): ConfigPin {
  const raw = env[CONFIG_PIN_ENV]
  if (raw === undefined) return { status: 'unset' }
  const sha256 = normalizeConfigPin(raw)
  return sha256 === null ? { status: 'invalid', raw } : { status: 'set', sha256 }
}
