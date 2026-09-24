import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    css: false,
    // Run every dashboard test in a zone that is not UTC (BST in summer), so a
    // formatter that reads local components cannot pass on a UTC runner.
    env: { TZ: 'Europe/London' },
  },
})
