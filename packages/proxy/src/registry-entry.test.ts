/**
 * The MCP registry entry (issue #403): `packages/proxy/server.json` and the
 * `mcpName` line in the proxy's manifest, which is the registry's proof that
 * the npm package belongs to the server name.
 *
 * Every pin here is load-bearing because `mcp-publisher validate` accepts the
 * drifted value: it checks the JSON against the schema and that every
 * `{variable}` in the URL names an argument, and nothing else. A renamed
 * server, a second package, a public `remotes` entry, a required environment
 * variable, an `sse` transport, a `choices` list on the positional argument or
 * a `default` on `--config` all stay valid and all change what a client spawns
 * or connects to. The transport URL is pinned against the config schema's
 * `listen` defaults, so a changed default fails here before it reaches the
 * registry. The `--config` placeholder is read from the built CLI's help text,
 * so a renamed default config file fails here too.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { helioConfigSchema, isSingularConfig } from './config/schema.js'

const require = createRequire(import.meta.url)

interface ProxyManifest {
  readonly name: string
  readonly version: string
  readonly description: string
  readonly mcpName?: string
  readonly repository: { readonly directory: string }
}

interface RegistryArgument {
  readonly type: string
  readonly [field: string]: unknown
}

interface RegistryPackage {
  readonly registryType: string
  readonly registryBaseUrl: string
  readonly identifier: string
  readonly version: string
  readonly runtimeHint: string
  readonly transport: {
    readonly type: string
    readonly url: string
    readonly [field: string]: unknown
  }
  readonly packageArguments: readonly RegistryArgument[]
  readonly [field: string]: unknown
}

interface RegistryEntry {
  readonly $schema: string
  readonly name: string
  readonly title: string
  readonly description: string
  readonly websiteUrl: string
  readonly repository: { readonly url: string; readonly source: string; readonly subfolder: string }
  readonly version: string
  readonly packages: readonly RegistryPackage[]
  readonly [field: string]: unknown
}

const pkg = require('../package.json') as ProxyManifest

const SERVER_JSON_PATH = join(import.meta.dirname, '../server.json')
const CLI_PATH = join(import.meta.dirname, '../dist/cli.js')

const REGISTRY_NAME = 'so.helio/helio'
const SCHEMA_URL = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json'
const START_DESCRIPTION = 'Start the proxy; it reads helio.yaml from the working directory'
const CONFIG_DESCRIPTION = 'Path to helio.yaml (default: helio.yaml in the working directory)'

/** Read the committed entry as bytes and as JSON (the bytes pin the formatting). */
function readEntry(): { readonly raw: string; readonly entry: RegistryEntry } {
  const raw = readFileSync(SERVER_JSON_PATH, 'utf-8')
  return { raw, entry: JSON.parse(raw) as RegistryEntry }
}

/** The `listen` defaults as the config schema applies them to a minimal config. */
function listenDefaults(): { readonly host: string; readonly port: number } {
  const config = helioConfigSchema.parse({
    version: '1',
    upstream: { url: 'http://127.0.0.1:1/mcp' },
    dashboard: { enabled: false },
  })
  if (!isSingularConfig(config)) throw new Error('expected a singular config')
  return { host: config.listen.host, port: config.listen.port }
}

/** The default config file name as `helio start --help` prints it. */
function cliDefaultConfigName(): string {
  const help = execFileSync('node', [CLI_PATH, 'start', '--help'], { encoding: 'utf-8' })
  const name = /--config <path>[^\n]*\(default: "([^"]+)"\)/.exec(help)?.[1]
  if (name === undefined) {
    throw new Error(`helio start --help does not print the --config default:\n${help}`)
  }
  return name
}

describe('registry entry (issue #403)', () => {
  it('declares the registry name as mcpName in the proxy manifest', () => {
    expect(pkg.mcpName).toBe(REGISTRY_NAME)
  })

  describe('server.json', () => {
    it('is the 2025-12-11 schema shape with the name, title, site and repository pinned', () => {
      const { entry } = readEntry()
      expect(entry.$schema).toBe(SCHEMA_URL)
      expect(entry.name).toBe(REGISTRY_NAME)
      expect(entry.name).toBe(pkg.mcpName)
      expect(entry.title).toBe('Helio')
      expect(entry.websiteUrl).toBe('https://www.helio.so')
      expect(entry.repository).toEqual({
        url: 'https://github.com/gethelio/helio',
        source: 'github',
        subfolder: pkg.repository.directory,
      })
    })

    it('carries the package description, within the registry cap of 100 characters', () => {
      const { entry } = readEntry()
      expect(entry.description).toBe(pkg.description)
      expect(entry.description.length).toBeLessThanOrEqual(100)
    })

    it('keeps the server version, the package version and the manifest version equal', () => {
      const { entry } = readEntry()
      expect(entry.version).toBe(pkg.version)
      expect(entry.packages[0]?.version).toBe(pkg.version)
    })

    it('lists exactly one package: the npm proxy, spawned with npx over streamable-http', () => {
      const { entry } = readEntry()
      expect(entry.packages).toHaveLength(1)
      const [proxy] = entry.packages
      expect(proxy?.registryType).toBe('npm')
      expect(proxy?.registryBaseUrl).toBe('https://registry.npmjs.org')
      expect(proxy?.identifier).toBe(pkg.name)
      expect(proxy?.runtimeHint).toBe('npx')
      expect(proxy?.transport.type).toBe('streamable-http')
    })

    it('points the client at the listen defaults from the config schema', () => {
      const { entry } = readEntry()
      const { host, port } = listenDefaults()
      expect(entry.packages[0]?.transport.url).toBe(`http://${host}:${String(port)}/mcp`)
    })

    it('names no {variable} in the URL that is not an argument', () => {
      const { entry } = readEntry()
      const [proxy] = entry.packages
      const argumentNames = new Set(
        (proxy?.packageArguments ?? []).flatMap((arg) =>
          [arg.name, arg.valueHint].filter((v): v is string => typeof v === 'string'),
        ),
      )
      const variables = [...(proxy?.transport.url ?? '').matchAll(/\{([^}]+)\}/g)]
        .map((m) => m[1])
        .filter((v): v is string => typeof v === 'string')
      for (const variable of variables) {
        expect(argumentNames.has(variable), `{${variable}} names no argument`).toBe(true)
      }
    })

    it('spawns the positional start argument first, as a plain word', () => {
      const { entry } = readEntry()
      const args = entry.packages[0]?.packageArguments ?? []
      expect(args).toHaveLength(2)
      const [start] = args
      expect(start?.type).toBe('positional')
      expect(start?.value).toBe('start')
      expect(start?.description).toBe(START_DESCRIPTION)
      expect(start?.choices).toBeUndefined()
      expect(start?.isRepeated).not.toBe(true)
      expect(start?.format === undefined || start.format === 'string').toBe(true)
    })

    it('offers --config as an optional file path whose placeholder is the CLI default', () => {
      const { entry } = readEntry()
      const [, config] = entry.packages[0]?.packageArguments ?? []
      expect(config?.type).toBe('named')
      expect(config?.name).toBe('--config')
      expect(config?.placeholder).toBe(cliDefaultConfigName())
      expect(config?.format).toBe('filepath')
      expect(config?.isRequired).toBe(false)
      expect(config?.description).toBe(CONFIG_DESCRIPTION)
      expect(config?.choices).toBeUndefined()
      expect(config?.isRepeated).not.toBe(true)
      expect(config?.default).toBeUndefined()
      expect(config?.value).toBeUndefined()
    })

    it('carries no remote, icon, metadata, environment, runtime argument, hash or header', () => {
      const { entry } = readEntry()
      expect(entry.remotes).toBeUndefined()
      expect(entry.icons).toBeUndefined()
      expect(entry._meta).toBeUndefined()
      const [proxy] = entry.packages
      expect(proxy?.environmentVariables).toBeUndefined()
      expect(proxy?.runtimeArguments).toBeUndefined()
      expect(proxy?.fileSha256).toBeUndefined()
      expect(proxy?.transport.headers).toBeUndefined()
    })

    it('is written as two-space JSON with a trailing newline, the shape the release stamp rewrites', () => {
      const { raw, entry } = readEntry()
      expect(raw).toBe(JSON.stringify(entry, null, 2) + '\n')
    })
  })
})
