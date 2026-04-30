import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * W113 Stage 4 — Integration smoke test against live-DB schema snapshot.
 *
 * Runs `scripts/audit-handler-schema.mjs` as a CI gate. The script parses
 * every PostgREST `from('table').select(...)` call in `api/_lib` and
 * cross-references each column against an information_schema snapshot.
 *
 * If a handler references a column/table that does not exist in the DB
 * (W110/W111-style bugs), the audit exits non-zero → this test fails.
 *
 * Update procedure when schema changes :
 *   1. Apply migration on the DB.
 *   2. Re-run the dump query :
 *        SELECT table_name, jsonb_agg(column_name ORDER BY ordinal_position)
 *        FROM information_schema.columns WHERE table_schema='public' GROUP BY 1;
 *   3. Update the SCHEMA constant in scripts/audit-handler-schema.mjs.
 *   4. Re-run this test.
 */
describe('Handler/Schema drift audit (W113)', () => {
  it('all api/_lib handlers reference only columns present in the schema snapshot', () => {
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = dirname(__filename)
    const scriptPath = resolve(__dirname, '../../../scripts/audit-handler-schema.mjs')

    let stdout = ''
    let exitCode = 0
    try {
      stdout = execFileSync('node', [scriptPath], {
        encoding: 'utf8',
        cwd: resolve(__dirname, '../../..'),
      })
    } catch (err) {
      const e = err as { status: number; stdout: string }
      exitCode = e.status ?? 1
      stdout = e.stdout ?? ''
    }

    if (exitCode !== 0) {
      throw new Error(
        `Drift audit failed (exit ${exitCode}). Drifted handlers/columns :\n\n${stdout}\n\n` +
          'Either fix the SELECT expression to match the DB schema, or update the SCHEMA snapshot ' +
          'in scripts/audit-handler-schema.mjs after applying a migration.'
      )
    }

    expect(stdout).toContain('No drift detected')
  })
})
