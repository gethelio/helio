import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StartupError } from '../startup-error.js'
import { cannotWriteFrom, cannotWriteLine, writeOrRefuse } from './write-or-refuse.js'

describe('writeOrRefuse', () => {
  it('writes the content as UTF-8', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'helio-write-or-refuse-'))
    const path = join(dir, 'out.txt')
    try {
      await writeOrRefuse(path, 'héllo\n')
      expect(readFileSync(path, 'utf-8')).toBe('héllo\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a path under a missing directory with a StartupError naming the path and the code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'helio-write-or-refuse-'))
    const path = join(dir, 'missing', 'out.txt')
    try {
      const err: unknown = await writeOrRefuse(path, 'x').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(StartupError)
      expect((err as StartupError).message).toBe(`Error: cannot write ${path} (ENOENT).`)
      expect(existsSync(join(dir, 'missing'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('cannotWriteLine', () => {
  it('prints the path as given and the code, with a trailing period', () => {
    expect(cannotWriteLine('missing/r.json', 'ENOTDIR')).toBe(
      'Error: cannot write missing/r.json (ENOTDIR).',
    )
  })
})

describe('cannotWriteFrom', () => {
  it('reads the code off an errno error', () => {
    const err = Object.assign(new Error('denied'), { code: 'EACCES' })
    expect(cannotWriteFrom('a/b', err)).toBe('Error: cannot write a/b (EACCES).')
  })

  it('falls back to unknown error when the thrown value carries no code', () => {
    expect(cannotWriteFrom('a/b', new Error('boom'))).toBe(
      'Error: cannot write a/b (unknown error).',
    )
  })
})
