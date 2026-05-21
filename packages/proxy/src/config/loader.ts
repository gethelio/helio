import { readFile } from 'node:fs/promises'
import yaml from 'js-yaml'
import { helioConfigSchema } from './schema.js'
import type { HelioConfig } from './schema.js'
import { formatZodErrors } from '../util/format-zod-errors.js'

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/** Structured error for configuration loading failures. */
export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly details?: ReadonlyArray<{ path: string; message: string }>,
  ) {
    super(message)
    this.name = 'ConfigError'
  }
}

// ---------------------------------------------------------------------------
// Environment variable interpolation
// ---------------------------------------------------------------------------

const ENV_VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/**
 * Recursively walk a parsed YAML value and replace `${VAR_NAME}` patterns
 * in string values with the corresponding environment variable.
 *
 * @param value - The parsed YAML value to interpolate.
 * @param env - Environment variables to use (defaults to `process.env`).
 */
export function interpolateEnvVars(
  value: unknown,
  env: Record<string, string | undefined> = process.env,
): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_VAR_PATTERN, (_match, varName: string) => {
      const envValue = env[varName]
      if (envValue === undefined) {
        throw new ConfigError(`Environment variable "${varName}" is not set`)
      }
      return envValue
    })
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateEnvVars(item, env))
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        interpolateEnvVars(v, env),
      ]),
    )
  }
  return value
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

/**
 * Load and validate a `helio.yaml` configuration file.
 *
 * Pipeline: read file → parse YAML → interpolate env vars → validate with Zod.
 *
 * @param filePath - Path to the YAML configuration file.
 * @param env - Optional environment variables for `${VAR}` interpolation.
 * @returns The fully validated and defaulted configuration object.
 * @throws {ConfigError} On file read error, YAML parse error, missing env var, or validation failure.
 */
export async function loadConfig(
  filePath: string,
  env?: Record<string, string | undefined>,
): Promise<HelioConfig> {
  // 1. Read file
  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch {
    throw new ConfigError(`Cannot read config file: ${filePath}`)
  }

  // 2. Parse YAML
  let parsed: unknown
  try {
    parsed = yaml.load(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new ConfigError(`YAML parse error in ${filePath}: ${message}`)
  }

  // 3. Interpolate environment variables
  const interpolated = interpolateEnvVars(parsed, env)

  // 4. Validate with Zod
  const result = helioConfigSchema.safeParse(interpolated)
  if (!result.success) {
    const details = formatZodErrors(result.error)
    const count = details.length
    throw new ConfigError(
      `Invalid configuration (${String(count)} error${count === 1 ? '' : 's'})`,
      details,
    )
  }

  return result.data
}
