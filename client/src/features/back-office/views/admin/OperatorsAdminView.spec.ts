import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { invalidateCurrentUser } from '../../../../shared/composables/useCurrentUser'

/**
 * Story 7-3a AC #5 — RED-PHASE tests pour `OperatorsAdminView.vue`.
 * Vue attendue : client/src/features/back-office/views/admin/OperatorsAdminView.vue
 *
 * Smoke tests :
 *   1. Render liste — colonnes attendues + items chargés via mock fetch
 *   2. Formulaire création — submit POST avec body JSON
 *   3. Désactivation — confirm dialog + PATCH is_active=false
 */

const originalFetch = globalThis.fetch

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

// RED — module n'existe pas encore.
import OperatorsAdminView from './OperatorsAdminView.vue'

function buildRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div></div>' } },
      { path: '/admin/operators', name: 'admin-operators', component: OperatorsAdminView },
    ],
  })
}

describe('OperatorsAdminView (UI smoke)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    invalidateCurrentUser()
  })
  afterEach(() => {
    vi.useRealTimers()
    globalThis.fetch = originalFetch
  })

  it('charge la liste au mount + colonnes affichées (email, role, is_active)', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(200, {
        data: {
          items: [
            {
              id: 9,
              email: 'admin@fruitstock.fr',
              display_name: 'Admin',
              role: 'admin',
              is_active: true,
              azure_oid: '11111111-1111-4111-8111-111111111111',
              created_at: '2026-04-20T10:00:00Z',
            },
          ],
          total: 1,
          hasMore: false,
        },
      })
    ) as unknown as typeof fetch

    const router = buildRouter()
    await router.push('/admin/operators')
    const wrapper = mount(OperatorsAdminView, { global: { plugins: [router] } })
    await flushPromises()

    expect(wrapper.text()).toContain('admin@fruitstock.fr')
    expect(wrapper.text()).toMatch(/admin/i)
    // i18n FR-only V1 (D-12)
    expect(wrapper.text()).toMatch(/Opérateur|Email|Rôle|Actif/i)
  })

  it('formulaire création visible et soumission POST avec body correct', async () => {
    let postBody: unknown = null
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST' && url.includes('/api/admin/operators')) {
        postBody = init.body ? JSON.parse(String(init.body)) : null
        return jsonResponse(201, {
          data: {
            operator: {
              id: 200,
              email: 'created@x',
              display_name: 'Created',
              role: 'sav-operator',
              is_active: true,
              azure_oid: null,
              created_at: '2026-04-30T10:00:00Z',
            },
          },
        })
      }
      return jsonResponse(200, { data: { items: [], total: 0, hasMore: false } })
    }) as unknown as typeof fetch

    const router = buildRouter()
    await router.push('/admin/operators')
    const wrapper = mount(OperatorsAdminView, { global: { plugins: [router] } })
    await flushPromises()

    // Trigger create — form must expose data-test or specific input ids.
    const emailInput = wrapper.find<HTMLInputElement>('[data-test="operator-create-email"]')
    const nameInput = wrapper.find<HTMLInputElement>('[data-test="operator-create-display-name"]')
    const roleSelect = wrapper.find<HTMLSelectElement>('[data-test="operator-create-role"]')
    const submitBtn = wrapper.find('[data-test="operator-create-submit"]')

    expect(emailInput.exists()).toBe(true)
    expect(nameInput.exists()).toBe(true)
    expect(roleSelect.exists()).toBe(true)
    expect(submitBtn.exists()).toBe(true)

    await emailInput.setValue('created@x')
    await nameInput.setValue('Created')
    await roleSelect.setValue('sav-operator')
    await submitBtn.trigger('click')
    await flushPromises()

    expect(postBody).toMatchObject({
      email: 'created@x',
      display_name: 'Created',
      role: 'sav-operator',
    })
  })

  // Hardening W-7-3a-3 (CR E6) — formatDate doit guarder NaN pour created_at
  // null/invalide. `new Date('garbage')` retourne `Invalid Date` qui rend
  // "Invalid Date" en UI (moche). Le helper doit retourner '—' à la place.
  it('W-7-3a-3 : created_at invalide affiché comme "—" (pas "Invalid Date")', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(200, {
        data: {
          items: [
            {
              id: 9,
              email: 'admin@fruitstock.fr',
              display_name: 'Admin',
              role: 'admin',
              is_active: true,
              azure_oid: null,
              created_at: 'not-a-date',
            },
            {
              id: 10,
              email: 'sav@fruitstock.fr',
              display_name: 'Sav',
              role: 'sav-operator',
              is_active: true,
              azure_oid: null,
              created_at: '',
            },
          ],
          total: 2,
          hasMore: false,
        },
      })
    ) as unknown as typeof fetch

    const router = buildRouter()
    await router.push('/admin/operators')
    const wrapper = mount(OperatorsAdminView, { global: { plugins: [router] } })
    await flushPromises()

    expect(wrapper.text()).not.toContain('Invalid Date')
    // Les 2 lignes ont un created_at non-rendable → on doit voir le placeholder.
    expect(wrapper.text()).toContain('—')
  })

  // Hardening W-7-3a-5 (CR E7) — bouton Désactiver disabled pendant fetch
  // pour empêcher double-click → 2 PATCH simultanés.
  it("W-7-3a-5 : double-click sur Désactiver ne déclenche qu'un seul PATCH", async () => {
    let patchCallCount = 0
    let resolvePatch: ((value: Response) => void) | null = null
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'PATCH' && url.includes('/api/admin/operators/')) {
        patchCallCount += 1
        // Promise non résolue immédiatement → simule requête en cours
        return new Promise<Response>((resolve) => {
          resolvePatch = resolve
        })
      }
      return jsonResponse(200, {
        data: {
          items: [
            {
              id: 12,
              email: 'sav@x',
              display_name: 'Sav',
              role: 'sav-operator',
              is_active: true,
              azure_oid: null,
              created_at: '2026-04-20T10:00:00Z',
            },
          ],
          total: 1,
          hasMore: false,
        },
      })
    }) as unknown as typeof fetch

    const router = buildRouter()
    await router.push('/admin/operators')
    const wrapper = mount(OperatorsAdminView, { global: { plugins: [router] } })
    await flushPromises()

    const deactivateBtn = wrapper.find('[data-test="operator-deactivate-12"]')
    await deactivateBtn.trigger('click')
    const confirmBtn = wrapper.find('[data-test="operator-deactivate-confirm"]')
    // 1er click déclenche le PATCH (qui ne résout pas)
    await confirmBtn.trigger('click')
    // Le 2e click pendant la requête en cours doit être ignoré
    // (bouton :disabled pendant crud.loading.value === true).
    await confirmBtn.trigger('click')
    await flushPromises()

    expect(patchCallCount).toBe(1)
    // Cleanup : libère la promise
    if (resolvePatch !== null) {
      ;(resolvePatch as (value: Response) => void)(jsonResponse(200, { data: { operator: {} } }))
    }
    await flushPromises()
  })

  it('désactivation déclenche PATCH is_active=false', async () => {
    let patchBody: unknown = null
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'PATCH' && url.includes('/api/admin/operators/')) {
        patchBody = init.body ? JSON.parse(String(init.body)) : null
        return jsonResponse(200, {
          data: {
            operator: {
              id: 12,
              email: 'sav@x',
              display_name: 'Sav',
              role: 'sav-operator',
              is_active: false,
              azure_oid: null,
              created_at: '2026-04-20T10:00:00Z',
            },
          },
        })
      }
      return jsonResponse(200, {
        data: {
          items: [
            {
              id: 12,
              email: 'sav@x',
              display_name: 'Sav',
              role: 'sav-operator',
              is_active: true,
              azure_oid: null,
              created_at: '2026-04-20T10:00:00Z',
            },
          ],
          total: 1,
          hasMore: false,
        },
      })
    }) as unknown as typeof fetch

    const router = buildRouter()
    await router.push('/admin/operators')
    const wrapper = mount(OperatorsAdminView, { global: { plugins: [router] } })
    await flushPromises()

    const deactivateBtn = wrapper.find('[data-test="operator-deactivate-12"]')
    expect(deactivateBtn.exists()).toBe(true)
    await deactivateBtn.trigger('click')
    // confirm dialog
    const confirmBtn = wrapper.find('[data-test="operator-deactivate-confirm"]')
    expect(confirmBtn.exists()).toBe(true)
    await confirmBtn.trigger('click')
    await flushPromises()

    expect(patchBody).toMatchObject({ is_active: false })
  })

  it('masque self et fournit focus initial, trap Tab, Échap, restauration et libellé cible', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/auth/me')) {
        return jsonResponse(200, { user: { sub: 9, type: 'operator', role: 'admin' } })
      }
      return jsonResponse(200, {
        data: {
          items: [
            {
              id: 9,
              email: 'self@x',
              display_name: 'Self',
              role: 'admin',
              is_active: true,
              azure_oid: null,
              created_at: '2026-04-20T10:00:00Z',
            },
            {
              id: 12,
              email: 'other@x',
              display_name: 'Other',
              role: 'sav-operator',
              is_active: true,
              azure_oid: null,
              created_at: '2026-04-20T10:00:00Z',
            },
          ],
          total: 2,
          hasMore: false,
        },
      })
    }) as unknown as typeof fetch

    const router = buildRouter()
    await router.push('/admin/operators')
    const wrapper = mount(OperatorsAdminView, {
      attachTo: document.body,
      global: { plugins: [router] },
    })
    await flushPromises()

    expect(wrapper.find('[data-test="operator-password-9"]').exists()).toBe(false)
    const trigger = wrapper.get('[data-test="operator-password-12"]')
    expect(trigger.attributes('aria-label')).toContain('other@x')
    await trigger.trigger('click')
    await flushPromises()

    const dialog = wrapper.get('[role="dialog"]')
    const passwordInput = wrapper.get<HTMLInputElement>('[data-test="operator-password-input"]')
    const submit = wrapper.get<HTMLButtonElement>('[data-test="operator-password-submit"]')
    expect(dialog.attributes('aria-describedby')).toBe('password-dialog-target')
    expect(wrapper.get('#password-dialog-target').text()).toContain('other@x')
    expect(document.activeElement).toBe(passwordInput.element)

    submit.element.focus()
    await submit.trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(passwordInput.element)
    passwordInput.element.focus()
    await passwordInput.trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(submit.element)

    await passwordInput.trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(document.activeElement).toBe(trigger.element)
    wrapper.unmount()
  })

  it('rejette blanc et confirmation différente sans appel réseau PUT', async () => {
    let putCalls = 0
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/auth/me')) {
        return jsonResponse(200, { user: { sub: 9, type: 'operator', role: 'admin' } })
      }
      if (init?.method === 'PUT') putCalls += 1
      return jsonResponse(200, {
        data: {
          items: [
            {
              id: 12,
              email: 'other@x',
              display_name: 'Other',
              role: 'sav-operator',
              is_active: true,
              azure_oid: null,
              created_at: '2026-04-20T10:00:00Z',
            },
          ],
          total: 1,
          hasMore: false,
        },
      })
    }) as unknown as typeof fetch
    const router = buildRouter()
    await router.push('/admin/operators')
    const wrapper = mount(OperatorsAdminView, { global: { plugins: [router] } })
    await flushPromises()
    await wrapper.get('[data-test="operator-password-12"]').trigger('click')

    const form = wrapper.get<HTMLFormElement>('form.password-dialog')
    expect(form.attributes('novalidate')).toBeDefined()
    form.element.requestSubmit()
    await flushPromises()
    expect(putCalls).toBe(0)
    expect(wrapper.get('[role="alert"]').text()).toContain('12 et 128')

    await wrapper.get('[data-test="operator-password-input"]').setValue('            ')
    await wrapper.get('[data-test="operator-password-confirmation"]').setValue('            ')
    form.element.requestSubmit()
    await flushPromises()
    expect(putCalls).toBe(0)

    await wrapper.get('[data-test="operator-password-input"]').setValue('long-password')
    await wrapper.get('[data-test="operator-password-confirmation"]').setValue('different-one')
    form.element.requestSubmit()
    await flushPromises()
    expect(putCalls).toBe(0)
    expect(wrapper.get('[role="alert"]').text()).toContain('ne correspondent pas')
  })

  it('empêche double PUT puis nettoie les secrets après succès', async () => {
    let putCalls = 0
    let resolvePut: ((response: Response) => void) | null = null
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/auth/me')) {
        return jsonResponse(200, { user: { sub: 9, type: 'operator', role: 'admin' } })
      }
      if (init?.method === 'PUT') {
        putCalls += 1
        return new Promise<Response>((resolve) => {
          resolvePut = resolve
        })
      }
      return jsonResponse(200, {
        data: {
          items: [
            {
              id: 12,
              email: 'other@x',
              display_name: 'Other',
              role: 'sav-operator',
              is_active: true,
              azure_oid: null,
              created_at: '2026-04-20T10:00:00Z',
            },
          ],
          total: 1,
          hasMore: false,
        },
      })
    }) as unknown as typeof fetch
    const router = buildRouter()
    await router.push('/admin/operators')
    const wrapper = mount(OperatorsAdminView, { global: { plugins: [router] } })
    await flushPromises()
    await wrapper.get('[data-test="operator-password-12"]').trigger('click')
    await wrapper.get('[data-test="operator-password-input"]').setValue('long-password')
    await wrapper.get('[data-test="operator-password-confirmation"]').setValue('long-password')
    const submit = wrapper.get('[data-test="operator-password-submit"]')
    await submit.trigger('submit')
    await submit.trigger('submit')
    await flushPromises()
    expect(putCalls).toBe(1)
    expect(submit.attributes('disabled')).toBeDefined()
    ;(resolvePut as unknown as (response: Response) => void)(
      jsonResponse(200, { data: { passwordUpdatedAt: '2026-08-10T12:00:00Z' } })
    )
    await flushPromises()
    expect(wrapper.find('[data-test="operator-password-input"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Mot de passe mis à jour.')
  })

  it('annulation interrompt la requête et nettoie immédiatement les secrets', async () => {
    let aborted = false
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/auth/me')) {
        return jsonResponse(200, { user: { sub: 9, type: 'operator', role: 'admin' } })
      }
      if (init?.method === 'PUT') {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            aborted = true
            reject(new DOMException('Aborted', 'AbortError'))
          })
        })
      }
      return jsonResponse(200, {
        data: {
          items: [
            {
              id: 12,
              email: 'other@x',
              display_name: 'Other',
              role: 'sav-operator',
              is_active: true,
              azure_oid: null,
              created_at: '2026-04-20T10:00:00Z',
            },
          ],
          total: 1,
          hasMore: false,
        },
      })
    }) as unknown as typeof fetch
    const router = buildRouter()
    await router.push('/admin/operators')
    const wrapper = mount(OperatorsAdminView, { global: { plugins: [router] } })
    await flushPromises()
    await wrapper.get('[data-test="operator-password-12"]').trigger('click')
    await wrapper.get('[data-test="operator-password-input"]').setValue('long-password')
    await wrapper.get('[data-test="operator-password-confirmation"]').setValue('long-password')
    await wrapper.get('[data-test="operator-password-submit"]').trigger('submit')
    await wrapper.get('[data-test="operator-password-cancel"]').trigger('click')
    await flushPromises()
    expect(aborted).toBe(true)
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    await wrapper.get('[data-test="operator-password-12"]').trigger('click')
    expect(
      wrapper.get<HTMLInputElement>('[data-test="operator-password-input"]').element.value
    ).toBe('')
  })

  it('timeout interrompt la requête, vide les secrets et affiche une erreur neutre', async () => {
    vi.useFakeTimers()
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/auth/me')) {
        return jsonResponse(200, { user: { sub: 9, type: 'operator', role: 'admin' } })
      }
      if (init?.method === 'PUT') {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError'))
          )
        })
      }
      return jsonResponse(200, {
        data: {
          items: [
            {
              id: 12,
              email: 'other@x',
              display_name: 'Other',
              role: 'sav-operator',
              is_active: true,
              azure_oid: null,
              created_at: '2026-04-20T10:00:00Z',
            },
          ],
          total: 1,
          hasMore: false,
        },
      })
    }) as unknown as typeof fetch
    const router = buildRouter()
    await router.push('/admin/operators')
    const wrapper = mount(OperatorsAdminView, { global: { plugins: [router] } })
    await flushPromises()
    await wrapper.get('[data-test="operator-password-12"]').trigger('click')
    await wrapper.get('[data-test="operator-password-input"]').setValue('long-password')
    await wrapper.get('[data-test="operator-password-confirmation"]').setValue('long-password')
    await wrapper.get('[data-test="operator-password-submit"]').trigger('submit')
    await vi.advanceTimersByTimeAsync(15_000)
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('expiré')
    expect(wrapper.get('[role="alert"]').text()).toContain('résultat est incertain')
    expect(wrapper.get('[role="alert"]').text()).toContain('vérifiez avant de réessayer')
    expect(
      wrapper.get<HTMLInputElement>('[data-test="operator-password-input"]').element.value
    ).toBe('')
  })
})
