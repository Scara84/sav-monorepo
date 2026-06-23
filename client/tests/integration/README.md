# Integration Tests — PATTERN-H15-A

Story H-15 introduces integration tests against a real Postgres database.
These tests complement unit tests (which mock Supabase) by exercising the
actual PG layer — including CHECK constraints, triggers, and RPC bodies.

## Why integration tests?

The bug that triggered H-15 (`source='webhook'` violating a CHECK constraint)
was invisible to Vitest mocked tests. The mock never exercises the PG CHECK
constraint. Only a real DB run catches these violations.

See memory: `feedback_test_integration_gap.md` — this directory is the structural
fix for that gap.

## Pre-requisites

**Option A — Local Supabase (recommended, DN-2=C)**

1. Docker running
2. Supabase CLI installed (`supabase ^2.92.1` already in devDependencies)
3. Start local stack:
   ```sh
   npx supabase start
   ```
4. Apply migrations:
   ```sh
   npx supabase db reset
   ```
5. Local credentials are printed by `supabase start` (URL + service_role key)
6. Configure the RGPD anonymize salt GUC (required by `admin_anonymize_member`
   RPC — Story 7-6 D-10 fail-fast; the anonymize integration tests fail with
   `RGPD_SALT_NOT_CONFIGURED` without it). **Re-run after every `db reset`** —
   the reset recreates the database, wiping ALTER DATABASE settings:
   ```sh
   psql "postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres" \
     -c "ALTER DATABASE postgres SET app.rgpd_anonymize_salt = 'local-integration-test-salt';"
   ```
   (`supabase_admin` is required — the `postgres` role lacks the privilege.)

**Option B — Preview / remote DB**

Set environment variables pointing to a real Supabase project:

- `SUPABASE_URL` (e.g. `https://viwgyrqpyryagzgvnfoi.supabase.co`)
- `SUPABASE_SERVICE_ROLE_KEY` (service_role JWT — NOT the anon key)

WARNING: never commit real keys. Use `.env.local` (gitignored) or CI secrets.

## How to run

```sh
# From the client/ directory:
npm run test:integration
```

This runs Vitest with `vitest.config.integration.ts` (separate from unit config):

- Timeout: 30s per test (DB calls can be slow)
- Pool: forks (isolated DB connections between tests)
- Includes: `tests/integration/**/*.spec.ts`

## Excluded from default npm test

Integration tests are excluded from `npm test` (the default unit runner) to avoid
blocking daily development when a local Supabase instance is unavailable.

The `tests/integration/**` glob is explicitly excluded in `vitest.config.js`.

Integration tests are run:

- Manually by developers after applying migrations
- In dedicated CI jobs that provision a local Supabase instance

## Test structure

```
tests/integration/
  rpc/
    capture-sav-from-webhook.spec.ts   — H-15 root test (PATTERN-H15-A)
  README.md                            — this file
```

Convention: `tests/integration/<domain>/<feature>.spec.ts`

## Isolation / cleanup

Tests use:

- Unique email per run: `test+${Date.now()}@h15.local`
- Cleanup via `DELETE FROM sav WHERE id = ...` (CASCADE handles sav_files + sav_lines)
- `skipIf(!HAS_DB)` guard — tests skip gracefully when env vars are absent

## Skip behaviour

If `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` are not set, the test suite
skips automatically with `describe.skipIf(!HAS_DB)(...)`. No false failures.

## AC#4.5 — False-positive note

The companion audit script `client/scripts/audit-check-constraints.mjs` skips
variable-based INSERT values (e.g. `source: v_source`). This is documented
behavior — static analysis cannot resolve runtime variable values.
