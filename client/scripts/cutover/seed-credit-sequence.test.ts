/**
 * Story 7-7 AC #1 — RED-PHASE tests for `scripts/cutover/seed-credit-sequence.sql`
 *
 * Strategy: pure-unit mocking approach (no live DB required) — the SQL script
 * exports a testable TypeScript wrapper `runSeedSequence(db, requestedValue)`.
 * In RED-phase this wrapper does not exist yet; tests fail because the
 * import resolves to undefined exports.
 *
 * 4 cases per AC #1 spec:
 *   Case 1 — seed initial   last_number=0  → 4567 : UPDATE OK + audit row inserted
 *   Case 2 — re-run same    last_number=4567 → 4567 : NOOP + ALREADY_SEEDED notice
 *   Case 3 — drift          last_number=4567 → 5000 : DRIFT_DETECTED exception
 *   Case 4 — seed after     real credit_note exists (last_number > 0, different) :
 *             DRIFT_DETECTED anti-overwrite post-prod
 *
 * Mock strategy: inject a fake `db` object with `.query()` / `.execute()`
 * that captures calls and returns configurable row state. The SQL logic is
 * exercised via the TS wrapper; the raw .sql file is validated for structural
 * content (header comment length, RAISE wording) separately.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SQL_SCRIPT_PATH = resolve(__dirname, 'seed-credit-sequence.sql')

// The TS wrapper does not exist yet in RED-phase → dynamic import to prevent
// static transform-time failure.
const TS_WRAPPER_PATH = './seed-credit-sequence'

// ---------------------------------------------------------------------------
// DB mock factory
// ---------------------------------------------------------------------------

interface DbRow {
  last_number: number
}

interface MockDb {
  /** Simulate the SELECT last_number … query */
  currentValue: number
  /** Capture UPDATE calls */
  updateCalls: Array<{ last_number: number }>
  /** Capture audit INSERT calls */
  auditInsertCalls: Array<Record<string, unknown>>
  /** If set, query throws this error */
  queryError: Error | null
}

function makeMockDb(currentValue: number): MockDb {
  return {
    currentValue,
    updateCalls: [],
    auditInsertCalls: [],
    queryError: null,
  }
}

// ---------------------------------------------------------------------------
// Structural tests (SQL file — can run without TS wrapper)
// ---------------------------------------------------------------------------

describe('seed-credit-sequence.sql — structure', () => {
  it('RED — SQL file exists at scripts/cutover/seed-credit-sequence.sql', () => {
    expect(existsSync(SQL_SCRIPT_PATH)).toBe(true)
  })

  it('RED — SQL header contains 15+ comment lines with required documentation', () => {
    if (!existsSync(SQL_SCRIPT_PATH)) {
      // File doesn't exist yet; test will fail cleanly via the check above.
      return
    }
    const src = readFileSync(SQL_SCRIPT_PATH, 'utf8')
    // Count comment lines (-- prefixed lines or lines within /* */)
    const commentLines = src.split('\n').filter((l) => l.trim().startsWith('--'))
    expect(commentLines.length).toBeGreaterThanOrEqual(15)

    // Required documentation content per AC #1(d)
    expect(src).toContain('SUPABASE_DB_URL')
    expect(src).toContain('LAST_CREDIT_NUMBER')
    expect(src).toMatch(/idempotent/i)
    expect(src).toMatch(/runbooks\/cutover/i)
    expect(src).toMatch(/UNE FOIS|une fois/i)
  })

  it('RED — SQL contains RAISE EXCEPTION DRIFT_DETECTED wording', () => {
    if (!existsSync(SQL_SCRIPT_PATH)) return
    const src = readFileSync(SQL_SCRIPT_PATH, 'utf8')
    expect(src).toContain('DRIFT_DETECTED')
  })

  it('RED — SQL contains RAISE NOTICE ALREADY_SEEDED wording', () => {
    if (!existsSync(SQL_SCRIPT_PATH)) return
    const src = readFileSync(SQL_SCRIPT_PATH, 'utf8')
    expect(src).toContain('ALREADY_SEEDED')
  })

  it('RED — SQL targets credit_number_sequence WHERE id = 1 (D-1 single-row lock)', () => {
    if (!existsSync(SQL_SCRIPT_PATH)) return
    const src = readFileSync(SQL_SCRIPT_PATH, 'utf8')
    expect(src).toMatch(/credit_number_sequence/)
    expect(src).toMatch(/WHERE\s+id\s*=\s*1/)
  })

  it('RED — SQL inserts audit_trail row with entity_type=credit_number_sequence + action=cutover_seed', () => {
    if (!existsSync(SQL_SCRIPT_PATH)) return
    const src = readFileSync(SQL_SCRIPT_PATH, 'utf8')
    expect(src).toMatch(/audit_trail/)
    expect(src).toMatch(/cutover_seed/)
    expect(src).toMatch(/credit_number_sequence/)
  })
})

// ---------------------------------------------------------------------------
// TS wrapper behavioural tests
// ---------------------------------------------------------------------------

describe('runSeedSequence() TS wrapper — D-1 idempotence contract', () => {
  it('Case 1 — seed initial (last_number=0 → 4567): UPDATE OK + audit row inserted', async () => {
    type SeedMod = {
      runSeedSequence: (
        db: MockDb,
        requestedValue: number,
        operator?: string
      ) => Promise<{ action: 'seeded' | 'noop'; lastNumber: number; auditInserted: boolean }>
    }
    const mod = (await import(/* @vite-ignore */ TS_WRAPPER_PATH)) as SeedMod
    expect(typeof mod.runSeedSequence).toBe('function')

    const db = makeMockDb(0)
    const result = await mod.runSeedSequence(db, 4567, 'test-operator')

    expect(result.action).toBe('seeded')
    expect(result.lastNumber).toBe(4567)
    expect(result.auditInserted).toBe(true)
  })

  it('Case 2 — re-run same value (4567 → 4567): NOOP + no error + action=noop', async () => {
    type SeedMod = {
      runSeedSequence: (
        db: MockDb,
        requestedValue: number,
        operator?: string
      ) => Promise<{ action: 'seeded' | 'noop'; lastNumber: number; auditInserted: boolean }>
    }
    const mod = (await import(/* @vite-ignore */ TS_WRAPPER_PATH)) as SeedMod
    expect(typeof mod.runSeedSequence).toBe('function')

    const db = makeMockDb(4567)
    const result = await mod.runSeedSequence(db, 4567, 'test-operator')

    expect(result.action).toBe('noop')
    expect(result.lastNumber).toBe(4567)
    // Idempotent re-run: no UPDATE, no new audit row
    expect(result.auditInserted).toBe(false)
  })

  it('Case 3 — drift (last_number=4567 → requested=5000): throws DRIFT_DETECTED', async () => {
    type SeedMod = {
      runSeedSequence: (
        db: MockDb,
        requestedValue: number,
        operator?: string
      ) => Promise<{ action: 'seeded' | 'noop'; lastNumber: number; auditInserted: boolean }>
    }
    const mod = (await import(/* @vite-ignore */ TS_WRAPPER_PATH)) as SeedMod
    expect(typeof mod.runSeedSequence).toBe('function')

    const db = makeMockDb(4567)

    await expect(mod.runSeedSequence(db, 5000, 'test-operator')).rejects.toThrow(/DRIFT_DETECTED/)
  })

  it('Case 4 — seed after real credit_note exists (last_number=1200, requested=4567): DRIFT_DETECTED anti-overwrite', async () => {
    // Simulates post-prod accidental re-run where last_number has been updated
    // by real RPC issue_credit_number after initial cutover.
    type SeedMod = {
      runSeedSequence: (
        db: MockDb,
        requestedValue: number,
        operator?: string
      ) => Promise<{ action: 'seeded' | 'noop'; lastNumber: number; auditInserted: boolean }>
    }
    const mod = (await import(/* @vite-ignore */ TS_WRAPPER_PATH)) as SeedMod
    expect(typeof mod.runSeedSequence).toBe('function')

    // last_number > 0 AND ≠ requested → DRIFT_DETECTED regardless
    const db = makeMockDb(1200)

    await expect(mod.runSeedSequence(db, 4567, 'test-operator')).rejects.toThrow(/DRIFT_DETECTED/)
  })
})
