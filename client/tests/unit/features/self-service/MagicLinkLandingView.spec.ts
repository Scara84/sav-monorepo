import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

/**
 * Story 6.2 — `MagicLinkLandingView.vue` (4 cas + edges).
 */

const routeMock: { query: Record<string, string | string[]> } = { query: {} }
const routerMock = { replace: vi.fn(), push: vi.fn() }

vi.mock('vue-router', () => ({
  useRoute: () => routeMock,
  useRouter: () => routerMock,
  RouterLink: defineComponent({
    props: { to: { type: [String, Object], required: true } },
    setup(props, { slots }) {
      return () =>
        h(
          'a',
          { href: typeof props.to === 'string' ? props.to : '#', 'data-test-link': 'true' },
          slots.default ? slots.default() : []
        )
    },
  }),
}))

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    headers: new Headers(),
  } as unknown as Response
}

const originalFetch = globalThis.fetch

describe('MagicLinkLandingView (Story 6.2)', () => {
  beforeEach(() => {
    routeMock.query = {}
    routerMock.replace.mockReset()
    routerMock.push.mockReset()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('AC#1 (a) token valide → POST /api/auth/magic-link/verify + router.replace("/monespace")', async () => {
    routeMock.query = { token: 'valid-jwt', redirect: '/monespace' }
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, { redirect: '/monespace', user: { sub: 42, type: 'member' } })
      )
    ) as typeof globalThis.fetch

    const MagicLinkLandingView = (
      await import('../../../../src/features/self-service/views/MagicLinkLandingView.vue')
    ).default
    const wrapper = mount(MagicLinkLandingView)
    await flushPromises()

    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/auth/magic-link/verify',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ token: 'valid-jwt', redirect: '/monespace' }),
      })
    )
    expect(routerMock.replace).toHaveBeenCalledWith('/monespace')
    expect(routerMock.push).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toMatch(/@/)
  })

  it('AC#2 (b) token expiré (LINK_EXPIRED) → message "Lien expiré ou déjà utilisé" + CTA RouterLink to="/"', async () => {
    routeMock.query = { token: 'expired-jwt' }
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse(401, { error: { code: 'LINK_EXPIRED' } }))
    ) as typeof globalThis.fetch

    const MagicLinkLandingView = (
      await import('../../../../src/features/self-service/views/MagicLinkLandingView.vue')
    ).default
    const wrapper = mount(MagicLinkLandingView)
    await flushPromises()

    expect(wrapper.text()).toContain('Lien expiré ou déjà utilisé')
    expect(wrapper.text()).toContain('Demander un nouveau lien')
    const cta = wrapper.find('[data-test="cta-new-link"]')
    expect(cta.exists()).toBe(true)
    expect(wrapper.text()).not.toMatch(/@/)
    expect(routerMock.replace).not.toHaveBeenCalled()
  })

  it('AC#2 token déjà consommé (LINK_CONSUMED) → même message non-PII que LINK_EXPIRED', async () => {
    routeMock.query = { token: 'consumed-jwt' }
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse(410, { error: { code: 'LINK_CONSUMED' } }))
    ) as typeof globalThis.fetch

    const MagicLinkLandingView = (
      await import('../../../../src/features/self-service/views/MagicLinkLandingView.vue')
    ).default
    const wrapper = mount(MagicLinkLandingView)
    await flushPromises()

    expect(wrapper.text()).toContain('Lien expiré ou déjà utilisé')
    expect(wrapper.text()).toContain('Demander un nouveau lien')
    expect(routerMock.replace).not.toHaveBeenCalled()
  })

  it("AC#14d (c) absence query.token → message d'erreur (pas de fetch ni redirect auto)", async () => {
    routeMock.query = {}
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as typeof globalThis.fetch

    const MagicLinkLandingView = (
      await import('../../../../src/features/self-service/views/MagicLinkLandingView.vue')
    ).default
    const wrapper = mount(MagicLinkLandingView)
    await flushPromises()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Lien expiré ou déjà utilisé')
    expect(routerMock.replace).not.toHaveBeenCalled()
  })

  it("AC#14d (d) UNAUTHENTICATED (signature invalide) → message d'erreur non-PII + CTA", async () => {
    routeMock.query = { token: 'tampered' }
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse(401, { error: { code: 'UNAUTHENTICATED' } }))
    ) as typeof globalThis.fetch

    const MagicLinkLandingView = (
      await import('../../../../src/features/self-service/views/MagicLinkLandingView.vue')
    ).default
    const wrapper = mount(MagicLinkLandingView)
    await flushPromises()

    expect(wrapper.text()).toContain('Lien expiré ou déjà utilisé')
    const cta = wrapper.find('[data-test="cta-new-link"]')
    expect(cta.exists()).toBe(true)
    expect(wrapper.text()).not.toMatch(/@/)
  })

  it('W109 (e) token dans le fragment URL (#token=...) → POST /verify et redirect — contrat backend issue.ts:buildMagicUrl', async () => {
    routeMock.query = {}
    const originalHash = window.location.hash
    window.location.hash = '#token=hash-jwt-from-email'

    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, { redirect: '/monespace', user: { sub: 9, type: 'member' } })
      )
    ) as typeof globalThis.fetch

    const replaceStateSpy = vi.spyOn(window.history, 'replaceState')

    try {
      const MagicLinkLandingView = (
        await import('../../../../src/features/self-service/views/MagicLinkLandingView.vue')
      ).default
      mount(MagicLinkLandingView)
      await flushPromises()

      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/auth/magic-link/verify',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ token: 'hash-jwt-from-email' }),
        })
      )
      expect(routerMock.replace).toHaveBeenCalledWith('/monespace')
      // history.replaceState appelé pour purger le token du fragment (anti back-button replay)
      expect(replaceStateSpy).toHaveBeenCalled()
    } finally {
      window.location.hash = originalHash
      replaceStateSpy.mockRestore()
    }
  })

  it("W109 (f) token dans le fragment ET la query → fragment l'emporte (path canonique email)", async () => {
    routeMock.query = { token: 'query-fallback' }
    const originalHash = window.location.hash
    window.location.hash = '#token=hash-canonical'

    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { redirect: '/monespace' }))
    ) as typeof globalThis.fetch

    try {
      const MagicLinkLandingView = (
        await import('../../../../src/features/self-service/views/MagicLinkLandingView.vue')
      ).default
      mount(MagicLinkLandingView)
      await flushPromises()

      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/auth/magic-link/verify',
        expect.objectContaining({
          body: expect.stringContaining('hash-canonical'),
        })
      )
      const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
      const firstCall = fetchSpy.mock.calls[0]
      const callBody = (firstCall?.[1] as { body?: string } | undefined)?.body ?? ''
      expect(callBody).not.toContain('query-fallback')
    } finally {
      window.location.hash = originalHash
    }
  })

  it('AC#1 redirect = celui retourné par le verify endpoint (PAS celui de la query) — anti open-redirect', async () => {
    routeMock.query = { token: 'valid', redirect: '//evil.com' }
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, { redirect: '/monespace', user: { sub: 1, type: 'member' } })
      )
    ) as typeof globalThis.fetch

    const MagicLinkLandingView = (
      await import('../../../../src/features/self-service/views/MagicLinkLandingView.vue')
    ).default
    mount(MagicLinkLandingView)
    await flushPromises()

    expect(routerMock.replace).toHaveBeenCalledWith('/monespace')
    expect(routerMock.replace).not.toHaveBeenCalledWith('//evil.com')
  })
})
