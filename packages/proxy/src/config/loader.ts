import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
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
  return interpolateTracked(value, env, [], undefined)
}

/**
 * The walker behind `interpolateEnvVars`. When `out` is given, every dotted
 * path whose string value had at least one substitution is pushed onto it in
 * document order, so a caller can tell a value that came from the file apart
 * from one that came from the environment.
 */
function interpolateTracked(
  value: unknown,
  env: Record<string, string | undefined>,
  path: readonly string[],
  out: string[] | undefined,
): unknown {
  if (typeof value === 'string') {
    let substitutions = 0
    const result = value.replace(ENV_VAR_PATTERN, (_match, varName: string) => {
      const envValue = env[varName]
      if (envValue === undefined) {
        throw new ConfigError(`Environment variable "${varName}" is not set`)
      }
      substitutions += 1
      return envValue
    })
    if (substitutions > 0 && out !== undefined) out.push(path.join('.'))
    return result
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => interpolateTracked(item, env, [...path, String(index)], out))
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        interpolateTracked(v, env, [...path, k], out),
      ]),
    )
  }
  return value
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

/** A validated configuration together with facts about the file it came from. */
export interface LoadedConfig {
  readonly config: HelioConfig
  /** Lowercase hex SHA-256 of the file bytes as read, before parsing and interpolation. */
  readonly sha256: string
  /** Dotted paths whose string value had at least one `${VAR}` substituted, in document order. */
  readonly interpolatedPaths: readonly string[]
}

/**
 * Load, interpolate, and validate a configuration file, and report the file
 * hash and the interpolated paths alongside the result.
 *
 * @param filePath - Path to the YAML configuration file.
 * @param env - Environment variables for interpolation (defaults to `process.env`).
 * @throws {ConfigError} On file read error, YAML parse error, missing env var, or validation failure.
 */
export async function loadConfigWithMeta(
  filePath: string,
  env?: Record<string, string | undefined>,
): Promise<LoadedConfig> {
  // 1. Read file and hash its bytes as read, before parsing and interpolation
  let bytes: Buffer
  try {
    bytes = await readFile(filePath)
  } catch {
    throw new ConfigError(`Cannot read config file: ${filePath}`)
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const raw = bytes.toString('utf-8')

  // 2. Parse YAML
  let parsed: unknown
  try {
    parsed = yaml.load(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new ConfigError(`YAML parse error in ${filePath}: ${message}`)
  }

  // 3. Interpolate environment variables, recording which paths were substituted
  const interpolatedPaths: string[] = []
  const interpolated = interpolateTracked(parsed, env ?? process.env, [], interpolatedPaths)

  // 4. Validate with Zod
  const result = helioConfigSchema.safeParse(interpolated)
  if (!result.success) {
    // A root-level issue (e.g. an unrecognized top-level key) has an empty
    // zod path, which would render as a bare ": message" line. Label it here
    // rather than in formatZodErrors, which also shapes API error responses.
    const details = formatZodErrors(result.error).map((d) =>
      d.path === '' ? { ...d, path: '(top level)' } : d,
    )
    const count = details.length
    throw new ConfigError(
      `Invalid configuration (${String(count)} error${count === 1 ? '' : 's'})`,
      details,
    )
  }

  return { config: result.data, sha256, interpolatedPaths }
}

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
  return (await loadConfigWithMeta(filePath, env)).config
}
