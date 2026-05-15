/**
 * Vitest config for integration tests against a real Postgres DB.
 *
 * Story H-15 — PATTERN-H15-A — AC#2 (DN-4=A)
 *
 * Separate from vitest.config.js (unit tests) to:
 *   - Use longer timeouts (30s per test — DB calls can be slow on first run)
 *   - Use pool: 'forks' for isolation between DB connections
 *   - Only include tests/integration/** — never runs with `npm test` (unit suite)
 *
 * Usage:
 *   npm run test:integration
 *
 * Pre-requisites:
 *   - SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars set
 *   - A running Postgres (local Supabase via `npx supabase start`, or preview DB)
 *   - All migrations applied (`npx supabase db reset` for local)
 *
 * See client/tests/integration/README.md for full setup instructions.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.spec.ts', 'tests/integration/**/*.test.ts'],
    testTimeout: 30000,
    pool: 'forks',
    // No setupFiles — integration tests don't need happy-dom, no mocking
    globals: true,
    // Explicit environment: node (no DOM needed for DB tests)
    environment: 'node',
  },
})
