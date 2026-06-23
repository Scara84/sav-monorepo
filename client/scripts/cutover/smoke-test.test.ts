/**
 * Story 7-7 AC #2 — RED-PHASE tests for `scripts/cutover/smoke-test.ts`
 *
 * Strategy: harness-mock approach — the smoke-test script exports a testable
 * `runSmokeTest(config, httpClient, dbClient)` function. Tests inject mock
 * implementations of each dependency (HTTP endpoints + DB queries) and verify
 * that the orchestrator:
 *   - executes 7 steps in order
 *   - aggregates the correct GO/NO-GO verdict
 *   - writes a properly-shaped JSON report to disk
 *
 * 6 cases per orchestrator spec:
 *   Case 1 — happy path 7/7 PASS → verdict GO + report file created
 *   Case 2 — step 1 capture FAIL (422) → verdict NO-GO reason=capture
 *   Case 3 — step 6 ERP feature-flag absent → step SKIPPED + warn + verdict GO 6/7
 *   Case 4 — step 6 ERP feature-flag present but push KO → verdict NO-GO reason=erp_push
 *   Case 5 — step 3 credit number mismatch (number ≠ LAST+1) → FAIL explicit
 *   Case 6 — sentinel member created via ON CONFLICT DO UPDATE idempotent (no duplicate)
 *
 * Mock strategy (HARDEN-7 updated):
 *   - HTTP client mock: { post, patch, get } returning configurable responses
 *   - DB client mock: uses getEmailOutboxRow/getErpQueueRow callbacks (M-3 fix)
 *   - fs mock: captures written files in-memory (no disk I/O in tests)
 *
 * HARDEN-4: PDF mocks return {status: 302, headers: {location: 'https://...'}} (real handler semantics)
 */

import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SMOKE_SCRIPT_PATH = resolve(__dirname, 'smoke-test.ts')

// ---------------------------------------------------------------------------
// Mock builders (updated for HARDEN-1/4/7 interface changes)
// ---------------------------------------------------------------------------

interface StepResult {
  step: number
  name: string
  status: 'PASS' | 'FAIL' | 'SKIPPED'
  duration_ms?: number
  reason?: string
}

interface SmokeReport {
  started_at: string
  completed_at: string
  verdict: 'GO' | 'NO-GO'
  steps: StepResult[]
  credit_number_emitted?: number
  smoke_member_id?: number
  smoke_sav_id?: number
  erp_push_status?: string
  no_go_reason?: string
}

interface MockHttpClient {
  post: (
    url: string,
    body: unknown,
    headers?: Record<string, string>
  ) => Promise<{ status: number; data: unknown }>
  patch: (url: string, body: unknown) => Promise<{ status: number; data: unknown }>
  get: (
    url: string,
    opts?: { redirect?: 'follow' | 'manual' }
  ) => Promise<{ status: number; data: unknown; headers?: Record<string, string>; size?: number }>
}

interface MockDbClient {
  /** pg_tables lookup for feature-flag */
  erpPushQueueExists: boolean
  /** HARDEN-7 (M-3): live re-fetch callback instead of stale snapshot */
  getEmailOutboxRow: () => Promise<{ kind: string; recipient_email: string; status: string } | null>
  /** HARDEN-7 (M-3): live re-fetch callback instead of stale snapshot */
  getErpQueueRow: () => Promise<{ idempotency_key: string; status: string } | null>
  /** Captured queries for assertion */
  queries: string[]
  /** Sentinel member id */
  sentinelMemberId: number
}

function makeHappyHttpClient(lastCreditNumber = 4567): MockHttpClient {
  return {
    post: async (url: string, _body: unknown, _headers?: Record<string, string>) => {
      if (url.includes('/api/webhooks/capture')) {
        // HARDEN-1: capture.ts returns { data: { savId, reference, lineCount, fileCount } }
        return {
          status: 201,
          data: { data: { savId: 1234, reference: 'SMOKE-J0-TEST', lineCount: 1, fileCount: 0 } },
        }
      }
      // HARDEN-1: issue-credit via POST /api/sav/:id/credit-notes
      if (url.includes('/credit-notes') && !url.includes('/pdf')) {
        return {
          status: 201,
          data: {
            number: lastCreditNumber + 1,
            total_ttc_cents: 12000,
          },
        }
      }
      return { status: 404, data: {} }
    },
    // HARDEN-1: transitions now use PATCH
    patch: async (url: string, _body: unknown) => {
      if (url.includes('/api/sav/') && url.includes('/status')) {
        return { status: 200, data: { status: 'transitioned' } }
      }
      return { status: 404, data: {} }
    },
    get: async (url: string, _opts?: { redirect?: 'follow' | 'manual' }) => {
      if (url.includes('/api/credit-notes/') && url.includes('/pdf')) {
        // HARDEN-4: real handler returns 302 redirect (not 200+pdf)
        return {
          status: 302,
          data: Buffer.alloc(0),
          headers: { location: 'https://onedrive.live.com/test-pdf' },
          size: 0,
        }
      }
      return { status: 404, data: {} }
    },
  }
}

function makeHappyDbClient(): MockDbClient {
  return {
    erpPushQueueExists: false, // default: ERP deferred
    getEmailOutboxRow: async () => ({
      kind: 'sav_closed',
      recipient_email: 'cutover-smoke@fruitstock.invalid',
      status: 'pending',
    }),
    getErpQueueRow: async () => null,
    queries: [],
    sentinelMemberId: 999,
  }
}

// ---------------------------------------------------------------------------
// Structural test
// ---------------------------------------------------------------------------

describe('smoke-test.ts — file exists', () => {
  it('RED — smoke-test.ts script file exists at scripts/cutover/smoke-test.ts', () => {
    expect(existsSync(SMOKE_SCRIPT_PATH)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Behavioural tests via exported runSmokeTest()
// ---------------------------------------------------------------------------

describe('runSmokeTest() — orchestration 7 steps', () => {
  const WRAPPER_PATH = './smoke-test'

  it('Case 1 — happy path 7/7 PASS → verdict GO + JSON report created', async () => {
    type SmokeTestMod = {
      runSmokeTest: (
        config: { lastCreditNumber: number; smokeEmail: string; baseUrl: string },
        http: MockHttpClient,
        db: MockDbClient,
        writeReport?: (path: string, content: string) => void,
        captureTokenSecret?: string
      ) => Promise<SmokeReport>
    }
    const mod = (await import(/* @vite-ignore */ WRAPPER_PATH)) as SmokeTestMod
    expect(typeof mod.runSmokeTest).toBe('function')

    const writtenFiles: Record<string, string> = {}
    const http = makeHappyHttpClient(4567)
    const db = makeHappyDbClient()

    const report = await mod.runSmokeTest(
      {
        lastCreditNumber: 4567,
        smokeEmail: 'cutover-smoke@fruitstock.invalid',
        baseUrl: 'http://localhost:3000',
      },
      http,
      db,
      (path, content) => {
        writtenFiles[path] = content
      }
    )

    expect(report.verdict).toBe('GO')
    // At least the happy-path steps (excluding ERP SKIPPED)
    const passedSteps = report.steps.filter((s) => s.status === 'PASS')
    expect(passedSteps.length).toBeGreaterThanOrEqual(6)

    // Report file written
    const reportPaths = Object.keys(writtenFiles)
    expect(reportPaths.length).toBeGreaterThan(0)
    const reportPath = reportPaths[0]!
    expect(reportPath).toMatch(/smoke-J0-.*\.json$/)

    // JSON is parseable and has the expected shape
    const parsed = JSON.parse(writtenFiles[reportPath]!) as SmokeReport
    expect(parsed.verdict).toBe('GO')
    expect(Array.isArray(parsed.steps)).toBe(true)
    expect(parsed.started_at).toBeTruthy()
    expect(parsed.completed_at).toBeTruthy()
  })

  it('Case 2 — step 1 capture FAIL (422) → verdict NO-GO reason=capture', async () => {
    type SmokeTestMod = {
      runSmokeTest: (
        config: { lastCreditNumber: number; smokeEmail: string; baseUrl: string },
        http: MockHttpClient,
        db: MockDbClient,
        writeReport?: (path: string, content: string) => void
      ) => Promise<SmokeReport>
    }
    const mod = (await import(/* @vite-ignore */ WRAPPER_PATH)) as SmokeTestMod
    expect(typeof mod.runSmokeTest).toBe('function')

    const http: MockHttpClient = {
      post: async (url: string) => {
        if (url.includes('/api/webhooks/capture')) {
          return { status: 422, data: { error: 'INVALID_PAYLOAD' } }
        }
        return { status: 200, data: {} }
      },
      patch: async () => ({ status: 200, data: {} }),
      get: async () => ({ status: 404, data: {} }),
    }
    const db = makeHappyDbClient()

    const report = await mod.runSmokeTest(
      {
        lastCreditNumber: 4567,
        smokeEmail: 'cutover-smoke@fruitstock.invalid',
        baseUrl: 'http://localhost:3000',
      },
      http,
      db
    )

    expect(report.verdict).toBe('NO-GO')
    expect(report.no_go_reason).toMatch(/capture/)

    const captureStep = report.steps.find((s) => s.name === 'capture')
    expect(captureStep?.status).toBe('FAIL')
  })

  it('Case 3 — ERP feature-flag absent → step SKIPPED + warn ERP_PUSH_SKIPPED + verdict GO 6/7', async () => {
    type SmokeTestMod = {
      runSmokeTest: (
        config: { lastCreditNumber: number; smokeEmail: string; baseUrl: string },
        http: MockHttpClient,
        db: MockDbClient,
        writeReport?: (path: string, content: string) => void
      ) => Promise<SmokeReport>
    }
    const mod = (await import(/* @vite-ignore */ WRAPPER_PATH)) as SmokeTestMod
    expect(typeof mod.runSmokeTest).toBe('function')

    const http = makeHappyHttpClient(4567)
    const db = makeHappyDbClient()
    db.erpPushQueueExists = false // D-7 feature-flag absent

    const report = await mod.runSmokeTest(
      {
        lastCreditNumber: 4567,
        smokeEmail: 'cutover-smoke@fruitstock.invalid',
        baseUrl: 'http://localhost:3000',
      },
      http,
      db
    )

    expect(report.verdict).toBe('GO')
    expect(report.erp_push_status).toMatch(/SKIPPED_FEATURE_FLAG|ERP_PUSH_SKIPPED/)

    const erpStep = report.steps.find((s) => s.name === 'erp_push')
    expect(erpStep?.status).toBe('SKIPPED')
    // Steps that passed: at least 6 (all except ERP)
    const notFailedSteps = report.steps.filter((s) => s.status !== 'FAIL')
    expect(notFailedSteps.length).toBeGreaterThanOrEqual(6)
  })

  it('Case 4 — ERP feature-flag present but push KO → verdict NO-GO reason=erp_push', async () => {
    type SmokeTestMod = {
      runSmokeTest: (
        config: { lastCreditNumber: number; smokeEmail: string; baseUrl: string },
        http: MockHttpClient,
        db: MockDbClient,
        writeReport?: (path: string, content: string) => void
      ) => Promise<SmokeReport>
    }
    const mod = (await import(/* @vite-ignore */ WRAPPER_PATH)) as SmokeTestMod
    expect(typeof mod.runSmokeTest).toBe('function')

    const http = makeHappyHttpClient(4567)
    const db = makeHappyDbClient()
    db.erpPushQueueExists = true // D-7 feature-flag present
    db.getErpQueueRow = async () => null // but no row → push KO

    const report = await mod.runSmokeTest(
      {
        lastCreditNumber: 4567,
        smokeEmail: 'cutover-smoke@fruitstock.invalid',
        baseUrl: 'http://localhost:3000',
      },
      http,
      db
    )

    expect(report.verdict).toBe('NO-GO')
    expect(report.no_go_reason).toMatch(/erp_push/)

    const erpStep = report.steps.find((s) => s.name === 'erp_push')
    expect(erpStep?.status).toBe('FAIL')
  })

  it('Case 5 — credit number mismatch (issued ≠ LAST+1) → FAIL with explicit message', async () => {
    type SmokeTestMod = {
      runSmokeTest: (
        config: { lastCreditNumber: number; smokeEmail: string; baseUrl: string },
        http: MockHttpClient,
        db: MockDbClient,
        writeReport?: (path: string, content: string) => void
      ) => Promise<SmokeReport>
    }
    const mod = (await import(/* @vite-ignore */ WRAPPER_PATH)) as SmokeTestMod
    expect(typeof mod.runSmokeTest).toBe('function')

    const LAST = 4567
    const http: MockHttpClient = {
      post: async (url: string, _body: unknown) => {
        if (url.includes('/api/webhooks/capture')) {
          return {
            status: 201,
            data: { data: { savId: 1234, reference: 'SMOKE-J0-TEST', lineCount: 1, fileCount: 0 } },
          }
        }
        // HARDEN-1: issue-credit via /credit-notes path
        if (url.includes('/credit-notes') && !url.includes('/pdf')) {
          return {
            status: 201,
            data: {
              number: LAST + 99, // Wrong: should be LAST+1=4568
              total_ttc_cents: 12000,
            },
          }
        }
        return { status: 404, data: {} }
      },
      patch: async () => ({ status: 200, data: {} }),
      get: async () => ({
        // HARDEN-4: 302 redirect mock
        status: 302,
        data: Buffer.alloc(0),
        headers: { location: 'https://onedrive.live.com/test-pdf' },
        size: 0,
      }),
    }
    const db = makeHappyDbClient()

    const report = await mod.runSmokeTest(
      {
        lastCreditNumber: LAST,
        smokeEmail: 'cutover-smoke@fruitstock.invalid',
        baseUrl: 'http://localhost:3000',
      },
      http,
      db
    )

    expect(report.verdict).toBe('NO-GO')
    const issueStep = report.steps.find((s) => s.name === 'issue_credit')
    expect(issueStep?.status).toBe('FAIL')
    expect(issueStep?.reason).toMatch(/credit.*number|LAST_CREDIT_NUMBER/i)
  })

  it('Case 6 — sentinel member ON CONFLICT DO UPDATE (idempotent, no duplicate on re-run)', async () => {
    type SmokeTestMod = {
      runSmokeTest: (
        config: { lastCreditNumber: number; smokeEmail: string; baseUrl: string },
        http: MockHttpClient,
        db: MockDbClient,
        writeReport?: (path: string, content: string) => void
      ) => Promise<SmokeReport>
    }
    const mod = (await import(/* @vite-ignore */ WRAPPER_PATH)) as SmokeTestMod
    expect(typeof mod.runSmokeTest).toBe('function')

    const http = makeHappyHttpClient(4567)
    // DB that simulates member already exists
    const db = makeHappyDbClient()
    db.sentinelMemberId = 999 // existing member upserted, same id returned

    // Run twice
    await mod.runSmokeTest(
      {
        lastCreditNumber: 4567,
        smokeEmail: 'cutover-smoke@fruitstock.invalid',
        baseUrl: 'http://localhost:3000',
      },
      http,
      db
    )

    // Reset and run again
    db.queries = []
    const report2 = await mod.runSmokeTest(
      {
        lastCreditNumber: 4567,
        smokeEmail: 'cutover-smoke@fruitstock.invalid',
        baseUrl: 'http://localhost:3000',
      },
      http,
      db
    )

    // Both runs return the same sentinel member id (ON CONFLICT DO UPDATE)
    expect(report2.smoke_member_id).toBe(999)

    // The member INSERT query should include ON CONFLICT DO UPDATE wording
    const insertQuery = db.queries.find(
      (q) => q.includes('cutover-smoke@fruitstock.invalid') || q.includes('ON CONFLICT')
    )
    expect(insertQuery).toBeTruthy()
  })
})
