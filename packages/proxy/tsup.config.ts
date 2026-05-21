import { defineConfig } from 'tsup'

export default defineConfig([
  // Library entry
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    target: 'node22',
    external: ['better-sqlite3'],
  },
  // CLI entry
  {
    entry: ['src/cli.ts'],
    format: ['esm'],
    dts: false,
    clean: false,
    target: 'node22',
    external: ['better-sqlite3'],
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
])
