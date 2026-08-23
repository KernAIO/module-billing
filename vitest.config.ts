import { defineConfig } from 'vitest/config'

// `passWithNoTests` so a copy of this package that has not written its first test yet still reports a
// green `pnpm test` for the whole workspace instead of failing on "no test files found".
export default defineConfig({ test: { include: ['src/**/*.test.ts'], passWithNoTests: true } })
