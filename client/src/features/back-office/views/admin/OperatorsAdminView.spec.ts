import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'

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
  })
  afterEach(() => {
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
})
