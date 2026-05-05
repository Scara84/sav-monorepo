/**
 * Story V1.3 AC #6(e) — Test de la fonction `assertColdStartHealthy` du smoke-test
 *
 * Test type: UNIT (mock fetch, assert behavior)
 *
 * Couvre les comportements de la fonction assertColdStartHealthy(previewUrl) :
 *   (i)  HTTP 401 sur /api/sav → smoke OK (auth manquante = attendu sans token)
 *   (ii) HTTP 401 sur /api/credit-notes → smoke OK
 *   (iii) HTTP 500 sur /api/sav → smoke FAIL + log SMOKE_COLDSTART_FAIL|api/sav|500
 *   (iv) HTTP 500 sur /api/credit-notes → smoke FAIL + log SMOKE_COLDSTART_FAIL|api/credit-notes|500
 *
 * Pattern : importe `assertColdStartHealthy` depuis scripts/cutover/smoke-test.ts
 * et mock `http.get` (via l'interface HttpClient) pour simuler les réponses.
 *
 * Note AC #6(e) story : le log format est `SMOKE_COLDSTART_FAIL|api/sav|500`.
 */
import { describe, it, expect, vi } from 'vitest'

// Import the exported function from smoke-test.ts (will fail RED until function is added)
import type { HttpClient, StepResult } from '../../../scripts/cutover/smoke-test'

/**
 * Type for the assertColdStartHealthy result — step result or throw.
 * The function is expected to be exported from smoke-test.ts after V1.3 implementation.
 */

describe('assertColdStartHealthy — smoke-test cold-start step (AC #6(e))', () => {
  /**
   * Creates a minimal HttpClient mock with configurable status codes per path.
   */
  function makeHttpMock(statusByPath: Record<string, number>): HttpClient {
    return {
      get: vi.fn(async (url: string) => {
        // Find matching path suffix
        const matchedPath = Object.keys(statusByPath).find((p) => url.endsWith(p))
        const status = matchedPath !== undefined ? statusByPath[matchedPath] : 200
        return { status, data: null }
      }),
      post: vi.fn(),
      patch: vi.fn(),
    } as unknown as HttpClient
  }

  it('(i) /api/sav returns 401 → step PASS (auth absente = expected)', async () => {
    // This test will fail RED until assertColdStartHealthy is exported from smoke-test.ts
    // and the cold-start step is wired into runSmokeTest.
    const { assertColdStartHealthy } = (await import(
      '../../../scripts/cutover/smoke-test'
    )) as unknown as {
      assertColdStartHealthy: (previewUrl: string, http: HttpClient) => Promise<StepResult>
    }

    const http = makeHttpMock({
      '/api/sav': 401,
      '/api/credit-notes': 401,
    })
    const result = await assertColdStartHealthy('https://preview.vercel.app', http)
    expect(result.status).toBe('PASS')
  })

  it('(ii) both endpoints return 401 → step PASS', async () => {
    const { assertColdStartHealthy } = (await import(
      '../../../scripts/cutover/smoke-test'
    )) as unknown as {
      assertColdStartHealthy: (previewUrl: string, http: HttpClient) => Promise<StepResult>
    }

    const http = makeHttpMock({
      '/api/sav': 401,
      '/api/credit-notes': 401,
    })
    const result = await assertColdStartHealthy('https://preview.vercel.app', http)
    expect(result.status).toBe('PASS')
    // Both endpoints must have been checked
    expect((http.get as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2)
  })

  it('(iii) /api/sav returns 500 → step FAIL + log SMOKE_COLDSTART_FAIL|api/sav|500', async () => {
    const { assertColdStartHealthy } = (await import(
      '../../../scripts/cutover/smoke-test'
    )) as unknown as {
      assertColdStartHealthy: (previewUrl: string, http: HttpClient) => Promise<StepResult>
    }

    const http = makeHttpMock({
      '/api/sav': 500,
      '/api/credit-notes': 401,
    })
    const result = await assertColdStartHealthy('https://preview.vercel.app', http)
    expect(result.status).toBe('FAIL')
    expect(result.reason).toMatch(/SMOKE_COLDSTART_FAIL\|api\/sav\|500/)
  })

  it('(iv) /api/credit-notes returns 500 → step FAIL + log SMOKE_COLDSTART_FAIL|api/credit-notes|500', async () => {
    const { assertColdStartHealthy } = (await import(
      '../../../scripts/cutover/smoke-test'
    )) as unknown as {
      assertColdStartHealthy: (previewUrl: string, http: HttpClient) => Promise<StepResult>
    }

    const http = makeHttpMock({
      '/api/sav': 401,
      '/api/credit-notes': 500,
    })
    const result = await assertColdStartHealthy('https://preview.vercel.app', http)
    expect(result.status).toBe('FAIL')
    expect(result.reason).toMatch(/SMOKE_COLDSTART_FAIL\|api\/credit-notes\|500/)
  })

  it('(v) non-500 error codes (200 = misconfigured, 404 = not found) → step PASS (only 500 is cold-start crash indicator)', async () => {
    const { assertColdStartHealthy } = (await import(
      '../../../scripts/cutover/smoke-test'
    )) as unknown as {
      assertColdStartHealthy: (previewUrl: string, http: HttpClient) => Promise<StepResult>
    }

    // 200 without auth means no auth middleware — unusual but NOT a crash.
    // The assertion is specifically "not 500", not "must be 401".
    const http = makeHttpMock({
      '/api/sav': 200,
      '/api/credit-notes': 401,
    })
    const result = await assertColdStartHealthy('https://preview.vercel.app', http)
    expect(result.status).toBe('PASS')
  })
})
