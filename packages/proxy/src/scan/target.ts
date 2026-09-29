import { isNamedConfig, upstreamNameSchema, upstreamSchema } from '../config/schema.js'
import type { HelioConfig, SingularHelioConfig } from '../config/schema.js'
import { StartupError } from '../startup-error.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The transports `helio scan` can drive; the same vocabulary as `upstream.transport`. */
export type ScanTransport = SingularHelioConfig['upstream']['transport']

/**
 * What `--upstream <value>` names, told apart by shape before any config is
 * read: an http(s) URL with a scheme, an upstream entry name, or neither.
 */
export type UpstreamArgument =
  | { readonly kind: 'url'; readonly url: URL }
  | { readonly kind: 'name'; readonly name: string }
  | { readonly kind: 'invalid'; readonly message: string }

/** A loaded config as scan needs it: the validated object and the file text as parsed, before interpolation. */
export interface ScanConfigInput {
  readonly path: string
  readonly loaded: HelioConfig
  /** `yaml.load` of the raw file text: anchors and merge keys resolved, every `${VAR}` intact. */
  readonly raw: unknown
}

export interface ResolveScanTargetInput {
  /** The `--upstream` value as typed, if any. */
  readonly upstream?: string
  /** The `--transport` value as typed, if any. */
  readonly transport?: string
  /** The config, when one was loaded (see `scanNeedsConfig`). */
  readonly config?: ScanConfigInput
}

/** The one door a scan run connects to, resolved before anything connects. */
export interface ScanTarget {
  /** The entry handed to the forwarder factory; an http(s) `url` is the stripped, normalized href. */
  readonly upstream: SingularHelioConfig['upstream']
  /** The door name on a named config; undefined for a singular config or a bare URL. */
  readonly upstreamName: string | undefined
  readonly transport: ScanTransport
  /**
   * What the report calls the target: the normalized href for a bare URL; for a
   * config entry, the URL as written in the file (userinfo removed, `${VAR}`
   * intact) or the raw `command` of a stdio entry.
   */
  readonly label: string
  readonly source: 'argument' | 'config'
  readonly configPath: string | undefined
  /** True when a username or password was removed from the URL before connecting. */
  readonly credentialDropped: boolean
  /** The entry as written in the file, before interpolation; undefined for a bare URL. */
  readonly rawUpstream: unknown
}

// ---------------------------------------------------------------------------
// Argument shape
// ---------------------------------------------------------------------------

const TRANSPORTS: ReadonlyArray<ScanTransport> = ['streamable-http', 'sse', 'stdio']

const STDIO_NEEDS_CONFIG =
  'Error: a stdio upstream needs a config: put command and args under upstream: in helio.yaml and run helio scan -c <config>'

function isHttpUrl(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:'
}

/**
 * Classify the `--upstream` value. A value containing `://` that parses as an
 * http(s) URL is a URL target (the `://` test comes first: `new URL('https:crm')`
 * would otherwise parse as `https://crm/`); a value in the upstream-name charset
 * is an entry name; anything else is refused before any config is read.
 */
export function classifyUpstreamArgument(value: string): UpstreamArgument {
  if (value.includes('://')) {
    try {
      const url = new URL(value)
      if (isHttpUrl(url)) return { kind: 'url', url }
    } catch {
      // Not a URL: falls through to the refusal below.
    }
  } else if (upstreamNameSchema.safeParse(value).success) {
    return { kind: 'name', name: value }
  }
  return {
    kind: 'invalid',
    message:
      `Error: "${value}" is not an http(s) URL or an upstream name. ` +
      'A URL needs a scheme, for example http://localhost:8080/mcp.',
  }
}

/**
 * Whether the run reads a config file: always, except for a bare URL target
 * when `-c` was not passed explicitly, so a `helio.yaml` in the working
 * directory never turns into a silent coverage claim.
 */
export function scanNeedsConfig(
  argument: UpstreamArgument | undefined,
  configExplicit: boolean,
): boolean {
  return argument?.kind === 'url' ? configExplicit : true
}

// ---------------------------------------------------------------------------
// URL handling
// ---------------------------------------------------------------------------

/**
 * Remove userinfo from a URL string textually, by the authority rule: the
 * authority is the run after `://` and before the first `/`, `?` or `#`, and
 * userinfo is that span through its last `@`. Used on the raw file string, so
 * a `${VAR}` placeholder survives (a placeholder never contains `@`) and an
 * `@` in the path or the query is left alone.
 */
export function stripUserinfoTextually(raw: string): string {
  const schemeEnd = raw.indexOf('://')
  if (schemeEnd === -1) return raw
  const start = schemeEnd + 3
  const stop = /[/?#]/.exec(raw.slice(start))
  const end = stop === null ? raw.length : start + stop.index
  const authority = raw.slice(start, end)
  const at = authority.lastIndexOf('@')
  if (at === -1) return raw
  return raw.slice(0, start) + authority.slice(at + 1) + raw.slice(end)
}

/**
 * The href scan connects with, labels and stores: a copy of the URL with
 * username and password cleared, normalized by WHATWG parsing. `fetch` refuses
 * a URL that carries credentials and never sends them, so nothing is lost.
 */
function stripCredentials(url: URL): { readonly href: string; readonly dropped: boolean } {
  const copy = new URL(url.href)
  const dropped = copy.username !== '' || copy.password !== ''
  copy.username = ''
  copy.password = ''
  return { href: copy.href, dropped }
}

function parseTransportOption(value: string | undefined): ScanTransport | undefined {
  if (value === undefined) return undefined
  const found = TRANSPORTS.find((transport) => transport === value)
  if (found === undefined) {
    throw new StartupError(
      `Error: --transport must be streamable-http, sse or stdio (got "${value}")`,
    )
  }
  return found
}

// ---------------------------------------------------------------------------
// Raw document access
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function readString(record: unknown, key: string): string | undefined {
  const value = asRecord(record)?.[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * The scanned entry as written in the file: `upstream:` on a singular config,
 * or the `upstreams:` item whose `name` matches on a named one. The validated
 * config has already refused duplicate names, so the first match is the entry.
 */
export function selectRawUpstream(raw: unknown, name: string | undefined): unknown {
  const document = asRecord(raw)
  if (name === undefined) return document?.['upstream']
  const list = document?.['upstreams']
  if (!Array.isArray(list)) return undefined
  return list.find((entry) => readString(entry, 'name') === name)
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function namesOf(loaded: HelioConfig): string {
  return isNamedConfig(loaded) ? loaded.upstreams.map((entry) => entry.name).join(', ') : ''
}

/**
 * Resolve the one target of a scan run from `--upstream`, `--transport` and
 * the loaded config, if any. Every refusal is one `StartupError` line, thrown
 * before anything connects; a URL that will reach `fetch` is parsed here, and
 * one that does not parse or is not http(s) is refused naming the field, never
 * the value, so a credential in the file cannot reach an error message.
 */
export function resolveScanTarget(input: ResolveScanTargetInput): ScanTarget {
  const transport = parseTransportOption(input.transport)
  const argument =
    input.upstream === undefined ? undefined : classifyUpstreamArgument(input.upstream)
  if (argument?.kind === 'invalid') throw new StartupError(argument.message)

  if (argument?.kind === 'url') {
    if (input.config !== undefined && isNamedConfig(input.config.loaded)) {
      throw new StartupError(
        `Error: "${input.upstream ?? ''}" is not an entry in this config. ` +
          `Pass --upstream <name> (one of: ${namesOf(input.config.loaded)}).`,
      )
    }
    if (transport === 'stdio') throw new StartupError(STDIO_NEEDS_CONFIG)
    const { href, dropped } = stripCredentials(argument.url)
    const upstream = upstreamSchema.parse({ url: href, transport: transport ?? 'streamable-http' })
    return {
      upstream,
      upstreamName: undefined,
      transport: upstream.transport,
      label: href,
      source: 'argument',
      configPath: input.config?.path,
      credentialDropped: dropped,
      rawUpstream: undefined,
    }
  }

  if (input.config === undefined) {
    throw new Error('helio scan: a config target needs a loaded config')
  }
  if (transport !== undefined) {
    throw new StartupError('Error: --transport applies only with --upstream <url>')
  }
  const { loaded, raw, path } = input.config
  let entry: SingularHelioConfig['upstream']
  let name: string | undefined
  let field: string
  if (isNamedConfig(loaded)) {
    if (argument === undefined) {
      throw new StartupError(
        `Error: this config names its upstreams; pass --upstream <name> (one of: ${namesOf(loaded)})`,
      )
    }
    const found = loaded.upstreams.find((candidate) => candidate.name === argument.name)
    if (found === undefined) {
      throw new StartupError(
        `Error: no upstream named "${argument.name}" in ${path} (one of: ${namesOf(loaded)})`,
      )
    }
    entry = found
    name = argument.name
    field = `upstreams[${name}].url`
  } else {
    if (argument !== undefined) {
      throw new StartupError('Error: this config has a single upstream; drop --upstream')
    }
    entry = loaded.upstream
    name = undefined
    field = 'upstream.url'
  }
  const rawUpstream = selectRawUpstream(raw, name)

  if (entry.transport === 'stdio') {
    return {
      upstream: entry,
      upstreamName: name,
      transport: 'stdio',
      label: readString(rawUpstream, 'command') ?? entry.command ?? '',
      source: 'config',
      configPath: path,
      credentialDropped: false,
      rawUpstream,
    }
  }

  let parsed: URL
  try {
    parsed = new URL(entry.url ?? '')
  } catch {
    throw new StartupError(`Error: ${field} is not an http(s) URL`)
  }
  if (!isHttpUrl(parsed)) throw new StartupError(`Error: ${field} is not an http(s) URL`)
  const { href, dropped } = stripCredentials(parsed)
  const rawUrl = readString(rawUpstream, 'url')
  return {
    upstream: { ...entry, url: href },
    upstreamName: name,
    transport: entry.transport,
    label: stripUserinfoTextually(rawUrl ?? href),
    source: 'config',
    configPath: path,
    credentialDropped: dropped,
    rawUpstream,
  }
}
