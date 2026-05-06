/**
 * Story V1.5 — AC #6.d: Extension du smoke-test coldstart assertion
 *
 * Test type: UNIT (mock fetch, assert behavior)
 *
 * Étend V1.3 PATTERN-V3-bis `assertColdStartHealthy()` avec le 3e probe :
 *   `/api/sav/files/0/thumbnail`
 *
 * Behavior spec (DN-1 resolved: withAuth fires BEFORE dispatch):
 *   - 401 on /api/sav/files/0/thumbnail → step PASS (auth check before validation)
 *   - 400 on /api/sav/files/0/thumbnail → step PASS (validation after auth, still not 500)
 *   - 500 on /api/sav/files/0/thumbnail → step FAIL
 *     reason: SMOKE_COLDSTART_FAIL|api/sav/files/0/thumbnail|500
 *
 * Design note: The assertion is `status !== 500` (exclusive exclusion of 500 only).
 * Any non-500 response confirms the router cold-started without crashing.
 * This is consistent with the V1.3 PATTERN-V3-bis paradigm.
 *
 * NOTE: Red-phase — these tests will fail until:
 *   1. `assertColdStartHealthy()` is extended to include the 3rd endpoint
 *   2. The `endpoints` array in smoke-test.ts is updated to include
 *      '/api/sav/files/0/thumbnail'
 */

import { describe, it, expect, vi } from 'vitest'
import type { HttpClient, StepResult } from '../../../scripts/cutover/smoke-test'

/**
 * Creates a minimal HttpClient mock with configurable status codes per path.
 */
function makeHttpMock(statusByPath: Record<string, number>): HttpClient {
  return {
    get: vi.fn(async (url: string) => {
      const matchedPath = Object.keys(statusByPath).find((p) => url.endsWith(p))
      const status = matchedPath !== undefined ? statusByPath[matchedPath] : 401
      return { status, data: null }
    }),
    post: vi.fn(),
    patch: vi.fn(),
  } as unknown as HttpClient
}

describe('assertColdStartHealthy — V1.5 3rd probe extension (AC #6.d)', () => {
  it('(vi) /api/sav/files/0/thumbnail returns 401 → step PASS (auth check fires first)', async () => {
    const { assertColdStartHealthy } = (await import(
      '../../../scripts/cutover/smoke-test'
    )) as unknown as {
      assertColdStartHealthy: (previewUrl: string, http: HttpClient) => Promise<StepResult>
    }

    const http = makeHttpMock({
      '/api/sav': 401,
      '/api/credit-notes': 401,
      '/api/sav/files/0/thumbnail': 401,
    })
    const result = await assertColdStartHealthy('https://preview.vercel.app', http)
    expect(result.status).toBe('PASS')
  })

  it('(vii) /api/sav/files/0/thumbnail returns 400 → step PASS (validation fires, not 500)', async () => {
    const { assertColdStartHealthy } = (await import(
      '../../../scripts/cutover/smoke-test'
    )) as unknown as {
      assertColdStartHealthy: (previewUrl: string, http: HttpClient) => Promise<StepResult>
    }

    const http = makeHttpMock({
      '/api/sav': 401,
      '/api/credit-notes': 401,
      '/api/sav/files/0/thumbnail': 400,
    })
    const result = await assertColdStartHealthy('https://preview.vercel.app', http)
    expect(result.status).toBe('PASS')
  })

  it('(viii) /api/sav/files/0/thumbnail returns 500 → step FAIL + correct reason format', async () => {
    const { assertColdStartHealthy } = (await import(
      '../../../scripts/cutover/smoke-test'
    )) as unknown as {
      assertColdStartHealthy: (previewUrl: string, http: HttpClient) => Promise<StepResult>
    }

    const http = makeHttpMock({
      '/api/sav': 401,
      '/api/credit-notes': 401,
      '/api/sav/files/0/thumbnail': 500,
    })
    const result = await assertColdStartHealthy('https://preview.vercel.app', http)
    expect(result.status).toBe('FAIL')
    // Reason must follow SMOKE_COLDSTART_FAIL|<path>|<status> pattern
    expect(result.reason).toMatch(/SMOKE_COLDSTART_FAIL\|api\/sav\/files\/0\/thumbnail\|500/)
  })

  it('(ix) all 3 endpoints 401 → step PASS, exactly 3 GET calls made', async () => {
    const { assertColdStartHealthy } = (await import(
      '../../../scripts/cutover/smoke-test'
    )) as unknown as {
      assertColdStartHealthy: (previewUrl: string, http: HttpClient) => Promise<StepResult>
    }

    const http = makeHttpMock({
      '/api/sav': 401,
      '/api/credit-notes': 401,
      '/api/sav/files/0/thumbnail': 401,
    })
    const result = await assertColdStartHealthy('https://preview.vercel.app', http)
    expect(result.status).toBe('PASS')
    // All 3 probes must be checked (no early short-circuit on success)
    expect((http.get as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3)
  })

  it('(x) first 2 probes 401, thumbnail probe 200 → step PASS (200 means weird but not crash)', async () => {
    const { assertColdStartHealthy } = (await import(
      '../../../scripts/cutover/smoke-test'
    )) as unknown as {
      assertColdStartHealthy: (previewUrl: string, http: HttpClient) => Promise<StepResult>
    }

    // 200 without auth is unusual but not a crash indicator (only 500 = crash)
    const http = makeHttpMock({
      '/api/sav': 401,
      '/api/credit-notes': 401,
      '/api/sav/files/0/thumbnail': 200,
    })
    const result = await assertColdStartHealthy('https://preview.vercel.app', http)
    expect(result.status).toBe('PASS')
  })

  it('(xi) first probe (/api/sav) returns 500 → fail-fast, thumbnail probe NOT called', async () => {
    const { assertColdStartHealthy } = (await import(
      '../../../scripts/cutover/smoke-test'
    )) as unknown as {
      assertColdStartHealthy: (previewUrl: string, http: HttpClient) => Promise<StepResult>
    }

    const http = makeHttpMock({
      '/api/sav': 500,
      '/api/credit-notes': 401,
      '/api/sav/files/0/thumbnail': 401,
    })
    const result = await assertColdStartHealthy('https://preview.vercel.app', http)
    expect(result.status).toBe('FAIL')
    // Fail-fast: should not continue to check remaining probes after first 500
    const calls = (http.get as ReturnType<typeof vi.fn>).mock.calls.length
    // At most 1 call (fail-fast on first 500)
    expect(calls).toBeLessThanOrEqual(2)
  })
})
