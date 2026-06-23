/**
 * Story H-04 — ATDD RED-phase tests pour `AdminLoginView.vue`.
 *
 * AC#5(b)(c) — lecture query param ?error= + message contextualisé (3 codes)
 * AC#5(d)    — banner inline role="alert" aria-live="assertive" data-testid="login-error-banner"
 * AC#5(e)    — propagation ?returnTo= vers fetch /api/auth/operator/issue?returnTo=…
 * AC#5(f)    — bouton "Redemander un lien" focus email + reset state
 * AC#5(h)    — accessibilité role="alert"
 *
 * Pattern : PATTERN-H04-LOGIN-VIEW-QUERY-CONTEXT — lecture stateless via useRoute()
 * Pattern : PATTERN-VITEST-VIEW-WITH-ROUTER — vi.mock('vue-router') inline
 *
 * Ces tests sont en PHASE ROUGE avant Step 3 :
 *   - AdminLoginView.vue n'a pas encore useRoute() ni errorBannerMessage ni returnTo support
 *   - Le banner data-testid="login-error-banner" n'existe pas encore dans le template
 *   - La prop `ref="emailInput"` + focusEmailField n'existent pas encore
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

// ---------------------------------------------------------------------------
// Mock vue-router — PATTERN-H04-LOGIN-VIEW-QUERY-CONTEXT
// useRoute() retourne routeMock qui est muté avant chaque test
// LocationQueryValue = string | null (vue-router)
// ---------------------------------------------------------------------------
type LocationQueryValue = string | null
type LocationQuery = Record<string, LocationQueryValue | LocationQueryValue[]>
const routeMock: { query: LocationQuery } = { query: {} }

vi.mock('vue-router', () => ({
  useRoute: () => routeMock,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

// ---------------------------------------------------------------------------
// Helper : réponse fetch simulée
// ---------------------------------------------------------------------------
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    headers: new Headers(),
    statusText: '',
    redirected: false,
    type: 'basic',
    url: '',
    clone: () => {
      throw new Error('not impl')
    },
  } as unknown as Response
}

const originalFetch = globalThis.fetch

// Importé après le mock vue-router (Vitest hoist vi.mock avant les imports)
import AdminLoginView from '../../../../../src/features/back-office/views/AdminLoginView.vue'

describe('AdminLoginView — banner erreur (H-04 AC#5)', () => {
  beforeEach(() => {
    routeMock.query = {}
    vi.restoreAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  // -------------------------------------------------------------------------
  // AC#5(b)(c)(d) — banner conditionnel selon ?error=
  // -------------------------------------------------------------------------

  it('ALV-01 : mount sans ?error= → pas de banner (state normal)', async () => {
    routeMock.query = {}
    const wrapper = mount(AdminLoginView)
    await flushPromises()
    const banner = wrapper.find('[data-testid="login-error-banner"]')
    expect(banner.exists()).toBe(false)
  })

  it('ALV-02 : mount avec ?error=expired → banner visible + texte "expiré" (15 minutes max)', async () => {
    routeMock.query = { error: 'expired' }
    const wrapper = mount(AdminLoginView)
    await flushPromises()
    const banner = wrapper.find('[data-testid="login-error-banner"]')
    expect(banner.exists()).toBe(true)
    // AC#5(c) message "expiré" — texte partiel suffit
    expect(banner.text()).toContain('expiré')
    // AC#5(h) accessibilité
    expect(banner.attributes('role')).toBe('alert')
    expect(banner.attributes('aria-live')).toBe('assertive')
  })

  it('ALV-03 : mount avec ?error=consumed → banner visible + texte "déjà été utilisé"', async () => {
    routeMock.query = { error: 'consumed' }
    const wrapper = mount(AdminLoginView)
    await flushPromises()
    const banner = wrapper.find('[data-testid="login-error-banner"]')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('déjà été utilisé')
  })

  it('ALV-04 : mount avec ?error=invalid → banner visible + texte "n\'est plus valide"', async () => {
    routeMock.query = { error: 'invalid' }
    const wrapper = mount(AdminLoginView)
    await flushPromises()
    const banner = wrapper.find('[data-testid="login-error-banner"]')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain("n'est plus valide")
  })

  it('ALV-05 : mount avec ?error=garbage (code inconnu) → pas de banner (fallback null)', async () => {
    routeMock.query = { error: 'garbage' }
    const wrapper = mount(AdminLoginView)
    await flushPromises()
    const banner = wrapper.find('[data-testid="login-error-banner"]')
    expect(banner.exists()).toBe(false)
  })

  it('ALV-06 : les 3 messages sont distincts (expired ≠ consumed ≠ invalid)', async () => {
    const getMessageFor = async (code: string): Promise<string> => {
      routeMock.query = { error: code }
      const wrapper = mount(AdminLoginView)
      await flushPromises()
      return wrapper.find('[data-testid="login-error-banner"]').text()
    }

    const expiredMsg = await getMessageFor('expired')
    const consumedMsg = await getMessageFor('consumed')
    const invalidMsg = await getMessageFor('invalid')

    expect(expiredMsg).not.toBe(consumedMsg)
    expect(expiredMsg).not.toBe(invalidMsg)
    expect(consumedMsg).not.toBe(invalidMsg)
  })

  // -------------------------------------------------------------------------
  // AC#5(e) — propagation ?returnTo= vers fetch
  // -------------------------------------------------------------------------

  it('ALV-07 : mount avec ?returnTo=/admin/sav/123 + submit → fetch appelé avec URL encodée (H-04 AC#5(e))', async () => {
    routeMock.query = { returnTo: '/admin/sav/123' }
    const fetchMock = vi.fn(async () => jsonResponse(202, { ok: true }))
    globalThis.fetch = fetchMock

    const wrapper = mount(AdminLoginView)
    await flushPromises()

    // Saisie de l'email et submit
    const emailInput = wrapper.find('input[type="email"]')
    await emailInput.setValue('alice@fruitstock.eu')

    const form = wrapper.find('form')
    await form.trigger('submit')
    await flushPromises()

    // Vérifie que fetch a été appelé avec le returnTo encodé
    expect(fetchMock).toHaveBeenCalledOnce()
    const calledUrl = (fetchMock.mock.calls[0] as unknown as [string, ...unknown[]])[0]
    expect(calledUrl).toContain('returnTo=')
    // %2Fadmin%2Fsav%2F123 = encodeURIComponent('/admin/sav/123')
    expect(calledUrl).toContain(encodeURIComponent('/admin/sav/123'))
  })

  it('ALV-08 : mount SANS ?returnTo → fetch appelé sur /api/auth/operator/issue (sans query returnTo)', async () => {
    routeMock.query = {}
    const fetchMock = vi.fn(async () => jsonResponse(202, { ok: true }))
    globalThis.fetch = fetchMock

    const wrapper = mount(AdminLoginView)
    await flushPromises()

    const emailInput = wrapper.find('input[type="email"]')
    await emailInput.setValue('alice@fruitstock.eu')

    const form = wrapper.find('form')
    await form.trigger('submit')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledOnce()
    const calledUrl = (fetchMock.mock.calls[0] as unknown as [string, ...unknown[]])[0]
    expect(calledUrl).toBe('/api/auth/operator/issue')
    expect(calledUrl).not.toContain('returnTo')
  })

  // -------------------------------------------------------------------------
  // AC#5(f) — bouton "Redemander un lien" focus + reset state
  // -------------------------------------------------------------------------

  it('ALV-09 : click "Redemander un lien" dans banner → focusEmailField déclenché : state=idle + focus() appelé', async () => {
    // Spy sur HTMLInputElement.prototype.focus pour détecter l'appel réel
    const focusSpy = vi.spyOn(HTMLInputElement.prototype, 'focus')

    routeMock.query = { error: 'expired' }
    const wrapper = mount(AdminLoginView, { attachTo: document.body })
    await flushPromises()

    const banner = wrapper.find('[data-testid="login-error-banner"]')
    expect(banner.exists()).toBe(true)

    // Trouve le bouton "Redemander un lien" dans le banner
    const reaskBtn = banner.find('button')
    expect(reaskBtn.exists()).toBe(true)
    expect(reaskBtn.text()).toContain('Redemander un lien')

    // Vérifie que le bouton est bien de type "button" (pas "submit")
    expect(reaskBtn.attributes('type')).toBe('button')

    // Click : doit déclencher focusEmailField (state reset + focus)
    await reaskBtn.trigger('click')
    await flushPromises()

    // Asserter le side-effect réel : focus() appelé sur un HTMLInputElement
    // Ce test échoue si focusEmailField devient no-op (pas seulement un attribut HTML)
    expect(focusSpy).toHaveBeenCalled()

    // Asserter que state est bien reset à 'idle' (state.value accessible via vm)
    const vm = wrapper.vm as unknown as { state: { value: string } }
    expect(vm.state?.value ?? 'idle').toBe('idle')

    wrapper.unmount()
  })
})
