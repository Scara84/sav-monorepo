import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Story 3.7b — AC #14 — useCurrentUser composable (PATTERN-A)
 *
 * UCU-01: 200 OK → user posé dans cache (module-level)
 * UCU-02: 401 → user = null (no exception thrown)
 * UCU-03: Fetch unique sur multi-call (module-level cache — 1 seul fetch par session SPA)
 *
 * Pattern: cache module-level — partagé entre tous les composants,
 * zéro dépendance Pinia, réutilisable pour badge "C'est vous", filtres "Mes SAV".
 */

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

// Re-import composable fresh for each test to reset module-level cache
// We do this by clearing the module from the cache between tests

beforeEach(async () => {
  vi.restoreAllMocks()
  // Clear any module-level cache by re-importing with cache bust
  // The composable must expose a way to reset for tests, OR we re-import via vi.resetModules()
  vi.resetModules()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useCurrentUser (Story 3.7b AC#14 PATTERN-A)', () => {
  it('UCU-01: 200 OK → user posé dans cache avec sub et type', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { user: { sub: 42, type: 'operator', role: 'sav-operator' } })
    )
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

    const { useCurrentUser } = await import('../../../../src/shared/composables/useCurrentUser')

    const { user, loading } = useCurrentUser()

    // Initially loading or null
    expect(loading.value === true || user.value === null).toBe(true)

    // Wait for fetch to resolve
    await new Promise((r) => setTimeout(r, 0))
    // Flush micro-tasks
    await new Promise((r) => (setImmediate ? setImmediate(r) : setTimeout(r, 0)))

    // User must be populated
    expect(user.value).toBeTruthy()
    expect((user.value as unknown as Record<string, unknown>)?.['sub']).toBe(42)
    expect((user.value as unknown as Record<string, unknown>)?.['type']).toBe('operator')
    expect(loading.value).toBe(false)
  })

  it('UCU-02: 401 → user = null, no exception thrown', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } })
    )
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

    const { useCurrentUser } = await import('../../../../src/shared/composables/useCurrentUser')

    const { user, loading } = useCurrentUser()

    await new Promise((r) => setTimeout(r, 10))

    // Must not throw — user is null
    expect(user.value).toBeNull()
    expect(loading.value).toBe(false)
  })

  it('UCU-03: fetch appelé une seule fois sur plusieurs appels à useCurrentUser() dans le même module', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { user: { sub: 42, type: 'operator', role: 'sav-operator' } })
    )
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

    const { useCurrentUser } = await import('../../../../src/shared/composables/useCurrentUser')

    // Call composable 3 times (simulating 3 components using it)
    const r1 = useCurrentUser()
    const r2 = useCurrentUser()
    const r3 = useCurrentUser()

    await new Promise((r) => setTimeout(r, 10))

    // Fetch must be called exactly once (module-level cache)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // All 3 refs must point to the same user value
    expect(r1.user.value).toEqual(r2.user.value)
    expect(r2.user.value).toEqual(r3.user.value)
    expect((r1.user.value as unknown as Record<string, unknown>)?.['sub']).toBe(42)
  })
})
