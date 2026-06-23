import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'

/**
 * Story 7-3c AC #5 — RED-PHASE tests pour `ValidationListsAdminView.vue`.
 * Vue attendue : client/src/features/back-office/views/admin/ValidationListsAdminView.vue
 *
 * Smoke tests :
 *   1. Render groupé par list_code (sav_cause, bon_type, unit) + items chargés
 *   2. Formulaire ajout — submit POST avec body JSON (list_code, value, value_es)
 *   3. Désactivation soft (D-8) — confirm dialog + PATCH is_active=false
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
import ValidationListsAdminView from './ValidationListsAdminView.vue'

function buildRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div></div>' } },
      {
        path: '/admin/validation-lists',
        name: 'admin-validation-lists',
        component: ValidationListsAdminView,
      },
    ],
  })
}

describe('ValidationListsAdminView (UI smoke)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('charge la liste au mount + rendu groupé par list_code (sav_cause, bon_type, unit)', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(200, {
        data: {
          lists: {
            sav_cause: [
              {
                id: 1,
                list_code: 'sav_cause',
                value: 'Abîmé',
                value_es: 'estropeado',
                sort_order: 100,
                is_active: true,
                created_at: '2026-04-20T10:00:00Z',
                updated_at: '2026-04-20T10:00:00Z',
              },
            ],
            bon_type: [
              {
                id: 2,
                list_code: 'bon_type',
                value: 'AVOIR',
                value_es: 'ABONO',
                sort_order: 100,
                is_active: true,
                created_at: '2026-04-20T10:00:00Z',
                updated_at: '2026-04-20T10:00:00Z',
              },
            ],
            unit: [
              {
                id: 3,
                list_code: 'unit',
                value: 'kg',
                value_es: null,
                sort_order: 100,
                is_active: true,
                created_at: '2026-04-20T10:00:00Z',
                updated_at: '2026-04-20T10:00:00Z',
              },
            ],
          },
        },
      })
    ) as unknown as typeof fetch

    const router = buildRouter()
    await router.push('/admin/validation-lists')
    const wrapper = mount(ValidationListsAdminView, { global: { plugins: [router] } })
    await flushPromises()

    // Les 3 valeurs doivent apparaître dans le rendu (groupage côté UI).
    expect(wrapper.text()).toContain('Abîmé')
    expect(wrapper.text()).toContain('AVOIR')
    expect(wrapper.text()).toContain('kg')
    // i18n FR-only V1 (D-12) : un libellé/section pour chaque list_code.
    expect(wrapper.text()).toMatch(/Causes|Cause SAV|sav_cause/i)
    expect(wrapper.text()).toMatch(/Types|bon_type/i)
    expect(wrapper.text()).toMatch(/Unités|unit/i)
  })

  it('formulaire ajout visible et soumission POST avec body correct', async () => {
    let postBody: unknown = null
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST' && url.includes('/api/admin/validation-lists')) {
        postBody = init.body ? JSON.parse(String(init.body)) : null
        return jsonResponse(201, {
          data: {
            entry: {
              id: 800,
              list_code: 'sav_cause',
              value: 'Périmé',
              value_es: 'caducado',
              sort_order: 100,
              is_active: true,
              created_at: '2026-04-30T10:00:00Z',
              updated_at: '2026-04-30T10:00:00Z',
            },
          },
        })
      }
      return jsonResponse(200, { data: { lists: { sav_cause: [], bon_type: [], unit: [] } } })
    }) as unknown as typeof fetch

    const router = buildRouter()
    await router.push('/admin/validation-lists')
    const wrapper = mount(ValidationListsAdminView, { global: { plugins: [router] } })
    await flushPromises()

    const listCodeSelect = wrapper.find<HTMLSelectElement>(
      '[data-test="validation-list-create-list-code"]'
    )
    const valueInput = wrapper.find<HTMLInputElement>('[data-test="validation-list-create-value"]')
    const valueEsInput = wrapper.find<HTMLInputElement>(
      '[data-test="validation-list-create-value-es"]'
    )
    const submitBtn = wrapper.find('[data-test="validation-list-create-submit"]')

    expect(listCodeSelect.exists()).toBe(true)
    expect(valueInput.exists()).toBe(true)
    expect(valueEsInput.exists()).toBe(true)
    expect(submitBtn.exists()).toBe(true)

    await listCodeSelect.setValue('sav_cause')
    await valueInput.setValue('Périmé')
    await valueEsInput.setValue('caducado')
    // Hardening W-7-3c-1 : `@click` doublon retiré du bouton submit. La
    // soumission passe uniquement par l'event 'submit' du form (sémantique
    // HTML standard `<button type="submit">`). On déclenche directement
    // l'event submit sur le form pour tester le comportement.
    await wrapper.find('form.create-form').trigger('submit.prevent')
    await flushPromises()

    expect(postBody).toMatchObject({
      list_code: 'sav_cause',
      value: 'Périmé',
      value_es: 'caducado',
    })
  })

  it('désactivation déclenche confirm dialog + PATCH is_active=false (D-8 soft-delete)', async () => {
    let patchBody: unknown = null
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'PATCH' && url.includes('/api/admin/validation-lists/')) {
        patchBody = init.body ? JSON.parse(String(init.body)) : null
        return jsonResponse(200, {
          data: {
            entry: {
              id: 1,
              list_code: 'sav_cause',
              value: 'Abîmé',
              value_es: 'estropeado',
              sort_order: 100,
              is_active: false,
              created_at: '2026-04-20T10:00:00Z',
              updated_at: '2026-04-30T11:00:00Z',
            },
          },
        })
      }
      return jsonResponse(200, {
        data: {
          lists: {
            sav_cause: [
              {
                id: 1,
                list_code: 'sav_cause',
                value: 'Abîmé',
                value_es: 'estropeado',
                sort_order: 100,
                is_active: true,
                created_at: '2026-04-20T10:00:00Z',
                updated_at: '2026-04-20T10:00:00Z',
              },
            ],
            bon_type: [],
            unit: [],
          },
        },
      })
    }) as unknown as typeof fetch

    const router = buildRouter()
    await router.push('/admin/validation-lists')
    const wrapper = mount(ValidationListsAdminView, { global: { plugins: [router] } })
    await flushPromises()

    const deactivateBtn = wrapper.find('[data-test="validation-list-deactivate-1"]')
    expect(deactivateBtn.exists()).toBe(true)
    await deactivateBtn.trigger('click')
    const confirmBtn = wrapper.find('[data-test="validation-list-deactivate-confirm"]')
    expect(confirmBtn.exists()).toBe(true)
    await confirmBtn.trigger('click')
    await flushPromises()

    // D-8 : pas de DELETE physique — soft-delete via PATCH is_active=false.
    expect(patchBody).toMatchObject({ is_active: false })
  })

  // Hardening Round 1 — régression CR adversarial 3-layer.

  it('Hardening W-7-3c-1 : un seul POST émis sur clic submit (pas de doublon @click + @submit)', async () => {
    let postCount = 0
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST' && url.includes('/api/admin/validation-lists')) {
        postCount += 1
        return jsonResponse(201, {
          data: {
            entry: {
              id: 900,
              list_code: 'sav_cause',
              value: 'Périmé',
              value_es: 'caducado',
              sort_order: 100,
              is_active: true,
            },
          },
        })
      }
      return jsonResponse(200, { data: { lists: { sav_cause: [], bon_type: [], unit: [] } } })
    }) as unknown as typeof fetch

    const router = buildRouter()
    await router.push('/admin/validation-lists')
    const wrapper = mount(ValidationListsAdminView, { global: { plugins: [router] } })
    await flushPromises()

    const valueInput = wrapper.find<HTMLInputElement>('[data-test="validation-list-create-value"]')
    await valueInput.setValue('Périmé')
    // Click direct sur le bouton submit. Avec le `@click` doublon retiré,
    // seul l'event 'submit' du form se déclenche → 1 seul POST.
    const submitBtn = wrapper.find('[data-test="validation-list-create-submit"]')
    await submitBtn.trigger('click')
    // On simule aussi l'event submit (cohérent avec le comportement HTML
    // d'un click sur button type=submit qui submit le form). Si le code
    // avait un `@click` doublon, on aurait 2 calls (click handler + submit
    // event) — actuellement 1.
    await wrapper.find('form.create-form').trigger('submit.prevent')
    await flushPromises()

    expect(postCount).toBe(1)
  })

  it('Hardening W-7-3c-2 : mode édition row-inline + PATCH value_es+sort_order via UI', async () => {
    let patchBody: unknown = null
    let patchCount = 0
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'PATCH' && url.includes('/api/admin/validation-lists/')) {
        patchCount += 1
        patchBody = init.body ? JSON.parse(String(init.body)) : null
        return jsonResponse(200, {
          data: {
            entry: {
              id: 42,
              list_code: 'sav_cause',
              value: 'Abîmé',
              value_es: 'dañado',
              sort_order: 50,
              is_active: true,
            },
          },
        })
      }
      return jsonResponse(200, {
        data: {
          lists: {
            sav_cause: [
              {
                id: 42,
                list_code: 'sav_cause',
                value: 'Abîmé',
                value_es: 'estropeado',
                sort_order: 100,
                is_active: true,
              },
            ],
            bon_type: [],
            unit: [],
          },
        },
      })
    }) as unknown as typeof fetch

    const router = buildRouter()
    await router.push('/admin/validation-lists')
    const wrapper = mount(ValidationListsAdminView, { global: { plugins: [router] } })
    await flushPromises()

    // Bouton "Modifier" présent.
    const editBtn = wrapper.find('[data-test="validation-list-edit-42"]')
    expect(editBtn.exists()).toBe(true)
    await editBtn.trigger('click')

    // Inputs d'édition value_es + sort_order apparaissent.
    const editEs = wrapper.find<HTMLInputElement>('[data-test="validation-list-edit-value-es-42"]')
    const editSort = wrapper.find<HTMLInputElement>(
      '[data-test="validation-list-edit-sort-order-42"]'
    )
    expect(editEs.exists()).toBe(true)
    expect(editSort.exists()).toBe(true)

    await editEs.setValue('dañado')
    await editSort.setValue('50')

    const saveBtn = wrapper.find('[data-test="validation-list-edit-save-42"]')
    expect(saveBtn.exists()).toBe(true)
    await saveBtn.trigger('click')
    await flushPromises()

    expect(patchCount).toBe(1)
    expect(patchBody).toMatchObject({
      value_es: 'dañado',
      sort_order: 50,
    })
  })
})
