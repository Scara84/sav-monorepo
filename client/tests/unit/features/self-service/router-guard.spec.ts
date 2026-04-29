import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRouter, createMemoryHistory } from 'vue-router'
import { defineComponent } from 'vue'

/**
 * Story 6.2 — guard Vue `requiresAuth: 'magic-link'`.
 *
 * On extrait la logique du guard dans une factory locale pour la tester
 * indépendamment de `src/router/index.js` (qui charge tout l'app + import.meta.env).
 */

const Stub = defineComponent({ template: '<div>stub</div>' })

function buildRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'Home', component: Stub },
      {
        path: '/monespace',
        component: Stub,
        meta: { requiresAuth: 'magic-link' },
        children: [{ path: '', name: 'member-sav-list', component: Stub }],
      },
      {
        path: '/monespace/auth',
        name: 'magic-link-landing',
        component: Stub,
        meta: { requiresAuth: false },
      },
    ],
  })
}

// Guard logic — copy of src/router/index.js Story 6.2 guard (kept in sync).
function attachMagicLinkGuard(router: ReturnType<typeof buildRouter>) {
  router.beforeEach(async (to) => {
    const requiresMagicLink = to.matched.some((r) => r.meta?.requiresAuth === 'magic-link')
    if (!requiresMagicLink) return true
    try {
      const res = await fetch('/api/auth/me', {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) return { path: '/', query: { reason: 'session_expired' } }
      const body = (await res.json()) as { user?: { type?: string } }
      const user = body && typeof body === 'object' ? body.user : null
      if (!user || user.type !== 'member') {
        return { path: '/', query: { reason: 'session_expired' } }
      }
      return true
    } catch {
      return { path: '/', query: { reason: 'session_expired' } }
    }
  })
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    headers: new Headers(),
  } as unknown as Response
}

const originalFetch = globalThis.fetch

describe('router guard — requiresAuth: "magic-link" (Story 6.2)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('AC#12 navigation vers /monespace sans cookie → fetch /api/auth/me → 401 → redirect /?reason=session_expired', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse(401, { error: { code: 'UNAUTHENTICATED' } }))
    ) as typeof globalThis.fetch
    const router = buildRouter()
    attachMagicLinkGuard(router)
    await router.push('/monespace')
    expect(router.currentRoute.value.path).toBe('/')
    expect(router.currentRoute.value.query['reason']).toBe('session_expired')
  })

  it('AC#12 navigation vers /monespace avec cookie member valide → fetch /api/auth/me → 200 → laisse passer', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { user: { sub: 42, type: 'member', scope: 'self' } }))
    ) as typeof globalThis.fetch
    const router = buildRouter()
    attachMagicLinkGuard(router)
    await router.push('/monespace')
    expect(router.currentRoute.value.path).toBe('/monespace')
  })

  it('AC#12 navigation vers /monespace avec cookie operator → user.type !== "member" → redirect /?reason=session_expired', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { user: { sub: 7, type: 'operator' } }))
    ) as typeof globalThis.fetch
    const router = buildRouter()
    attachMagicLinkGuard(router)
    await router.push('/monespace')
    expect(router.currentRoute.value.path).toBe('/')
    expect(router.currentRoute.value.query['reason']).toBe('session_expired')
  })

  it('AC#12 navigation vers /monespace/auth (meta.requiresAuth: false) → guard skip, pas de fetch /api/auth/me', async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as typeof globalThis.fetch
    const router = buildRouter()
    attachMagicLinkGuard(router)
    await router.push('/monespace/auth?token=abc')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('AC#12 group-manager (type=member, role=group-manager) → autorisé sur /monespace (Story 6.5 forward-compat)', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, {
          user: { sub: 5, type: 'member', role: 'group-manager', scope: 'group' },
        })
      )
    ) as typeof globalThis.fetch
    const router = buildRouter()
    attachMagicLinkGuard(router)
    await router.push('/monespace')
    expect(router.currentRoute.value.path).toBe('/monespace')
  })
})
