/**
 * Story V1.3 HARDEN-2 — Integration test: assertColdStartHealthy wired into runSmokeTest
 *
 * Verifies that runSmokeTest() invokes assertColdStartHealthy as Step 0
 * (before any business step) and short-circuits with verdict='NO-GO' when the
 * cold-start check fails.
 *
 * AC HARDEN-2 requires:
 *   (a) verdict === 'NO-GO' when cold-start returns 500
 *   (b) the cold-start step is present in steps[] with status FAIL and a
 *       reason matching SMOKE_COLDSTART_FAIL|api/sav|<status>
 *   (c) NO subsequent business steps were attempted — only the cold-start
 *       HTTP calls were made (fail-fast on first 500)
 */
import { describe, it, expect, vi } from 'vitest'
import type {
  HttpClient,
  DbClient,
  SmokeConfig,
  SmokeReport,
} from '../../../scripts/cutover/smoke-test'

// ---------------------------------------------------------------------------
// Minimal mock helpers
// ---------------------------------------------------------------------------

function makeMinimalDbClient(): DbClient {
  return {
    erpPushQueueExists: false,
    getEmailOutboxRow: vi.fn(async () => null),
    getErpQueueRow: vi.fn(async () => null),
    queries: [],
    sentinelMemberId: 1,
  }
}

function makeSmokeConfig(): SmokeConfig {
  return {
    lastCreditNumber: 100,
    smokeEmail: 'test@smoke.invalid',
    baseUrl: 'https://preview.test.vercel.app',
  }
}

/** Creates an HttpClient that returns 500 on /api/sav and 401 on everything else. */
function makeHttpClientWith500OnSav(): HttpClient {
  let callCount = 0
  return {
    get: vi.fn(async (url: string) => {
      callCount++
      if (url.endsWith('/api/sav')) return { status: 500, data: null }
      return { status: 401, data: null }
    }),
    post: vi.fn(async () => {
      throw new Error('post should not be called')
    }),
    patch: vi.fn(async () => {
      throw new Error('patch should not be called')
    }),
    _getCallCount: () => callCount,
  } as unknown as HttpClient
}

/** Creates an HttpClient that returns 500 on /api/credit-notes and 401 on /api/sav. */
function makeHttpClientWith500OnCreditNotes(): HttpClient {
  return {
    get: vi.fn(async (url: string) => {
      if (url.endsWith('/api/sav')) return { status: 401, data: null }
      if (url.endsWith('/api/credit-notes')) return { status: 500, data: null }
      return { status: 401, data: null }
    }),
    post: vi.fn(async () => {
      throw new Error('post should not be called')
    }),
    patch: vi.fn(async () => {
      throw new Error('patch should not be called')
    }),
  } as unknown as HttpClient
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSmokeTest() — cold-start integration (HARDEN-2)', () => {
  it('(a) verdict === NO-GO when /api/sav returns 500', async () => {
    const { runSmokeTest } = await import('../../../scripts/cutover/smoke-test')

    const http = makeHttpClientWith500OnSav()
    const db = makeMinimalDbClient()
    const config = makeSmokeConfig()

    // writeReport is injected as no-op to avoid filesystem writes in unit tests
    const writeReport = vi.fn()

    const report: SmokeReport = await runSmokeTest(config, http, db, writeReport)

    expect(report.verdict).toBe('NO-GO')
  })

  it('(b) cold-start step is present in steps[] with status FAIL and correct reason', async () => {
    const { runSmokeTest } = await import('../../../scripts/cutover/smoke-test')

    const http = makeHttpClientWith500OnSav()
    const db = makeMinimalDbClient()
    const config = makeSmokeConfig()
    const writeReport = vi.fn()

    const report: SmokeReport = await runSmokeTest(config, http, db, writeReport)

    // cold-start step must exist
    const coldStartStep = report.steps.find((s) => s.name === 'cold_start_healthy')
    expect(coldStartStep).toBeDefined()
    expect(coldStartStep?.status).toBe('FAIL')
    // reason must contain the SMOKE_COLDSTART_FAIL pattern
    expect(coldStartStep?.reason).toMatch(/SMOKE_COLDSTART_FAIL\|api\/sav\|500/)
  })

  it('(c) NO subsequent steps attempted — only cold-start GET calls were made', async () => {
    const { runSmokeTest } = await import('../../../scripts/cutover/smoke-test')

    const http = makeHttpClientWith500OnSav()
    const db = makeMinimalDbClient()
    const config = makeSmokeConfig()
    const writeReport = vi.fn()

    const report: SmokeReport = await runSmokeTest(config, http, db, writeReport)

    // Only the cold-start step should be in steps — no business steps (step 1..7)
    const businessSteps = report.steps.filter((s) => s.step > 0)
    expect(businessSteps).toHaveLength(0)

    // POST (capture step 1) must NOT have been called
    expect((http.post as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)

    // Only GET calls should have happened (cold-start check), at most 2
    // (api/sav returns 500 → fail-fast, may or may not check api/credit-notes)
    const getCalls = (http.get as ReturnType<typeof vi.fn>).mock.calls
    expect(getCalls.length).toBeLessThanOrEqual(2)
    expect(getCalls.length).toBeGreaterThanOrEqual(1)
  })

  it('(d) /api/credit-notes 500 also triggers NO-GO with correct reason', async () => {
    const { runSmokeTest } = await import('../../../scripts/cutover/smoke-test')

    const http = makeHttpClientWith500OnCreditNotes()
    const db = makeMinimalDbClient()
    const config = makeSmokeConfig()
    const writeReport = vi.fn()

    const report: SmokeReport = await runSmokeTest(config, http, db, writeReport)

    expect(report.verdict).toBe('NO-GO')
    const coldStartStep = report.steps.find((s) => s.name === 'cold_start_healthy')
    expect(coldStartStep?.status).toBe('FAIL')
    expect(coldStartStep?.reason).toMatch(/SMOKE_COLDSTART_FAIL\|api\/credit-notes\|500/)
  })

  it('(e) both endpoints 401 → no short-circuit, business steps proceed normally', async () => {
    const { runSmokeTest } = await import('../../../scripts/cutover/smoke-test')

    // All GET return 401, POST return a valid capture response so step 1 passes
    const http: HttpClient = {
      get: vi.fn(async (_url: string) => ({ status: 401, data: null })),
      post: vi.fn(async () => ({
        status: 201,
        data: { data: { savId: 42, reference: 'SMOKE-REF', lineCount: 1, fileCount: 0 } },
      })),
      patch: vi.fn(async () => ({ status: 200, data: {} })),
    }

    const db = makeMinimalDbClient()
    const config = makeSmokeConfig()
    const writeReport = vi.fn()

    const report: SmokeReport = await runSmokeTest(config, http, db, writeReport)

    // Cold-start step must PASS
    const coldStartStep = report.steps.find((s) => s.name === 'cold_start_healthy')
    expect(coldStartStep?.status).toBe('PASS')

    // Business steps must have started (step 1 capture must be in steps)
    const captureStep = report.steps.find((s) => s.name === 'capture')
    expect(captureStep).toBeDefined()
  })
})
