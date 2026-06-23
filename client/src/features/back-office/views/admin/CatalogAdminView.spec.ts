import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'

/**
 * Story 7-3b AC #5 — RED-PHASE smoke tests pour `CatalogAdminView.vue`.
 * Vue attendue : client/src/features/back-office/views/admin/CatalogAdminView.vue
 *
 * Smoke tests :
 *   1. Render liste — colonnes attendues + items chargés via mock fetch
 *   2. Formulaire création — submit POST avec body JSON validé Zod (D-2 + D-5)
 *   3. Soft-delete — confirm dialog + DELETE
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
import CatalogAdminView from './CatalogAdminView.vue'

function buildRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div></div>' } },
      { path: '/admin/catalog', name: 'admin-catalog', component: CatalogAdminView },
    ],
  })
}

describe('CatalogAdminView (UI smoke)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('charge la liste au mount + colonnes affichées (code, name_fr, default_unit, origin)', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(200, {
        data: {
          items: [
            {
              id: 500,
              code: 'TOM-RAP-1',
              name_fr: 'Tomate Raphael',
              name_en: 'Raphael Tomato',
              name_es: 'Tomate Raphael',
              vat_rate_bp: 550,
              default_unit: 'kg',
              piece_weight_grams: null,
              tier_prices: [{ tier: 1, price_ht_cents: 250 }],
              supplier_code: 'rufino',
              origin: 'ES',
              created_at: '2026-04-30T10:00:00Z',
              updated_at: '2026-04-30T10:00:00Z',
              deleted_at: null,
            },
          ],
          total: 1,
          hasMore: false,
        },
      })
    ) as unknown as typeof fetch

    const router = buildRouter()
    await router.push('/admin/catalog')
    const wrapper = mount(CatalogAdminView, { global: { plugins: [router] } })
    await flushPromises()

    expect(wrapper.text()).toContain('TOM-RAP-1')
    expect(wrapper.text()).toContain('Tomate Raphael')
    // i18n FR-only V1 (D-12) — labels colonnes attendus
    expect(wrapper.text()).toMatch(/Code|Nom|Unité|Origine/i)
    // origin badge
    expect(wrapper.text()).toContain('ES')
  })

  it('formulaire création visible et soumission POST avec body D-2 + D-5 valides', async () => {
    let postBody: unknown = null
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST' && url.includes('/api/admin/products')) {
        postBody = init.body ? JSON.parse(String(init.body)) : null
        return jsonResponse(201, {
          data: {
            product: {
              id: 600,
              code: 'POM-GAL-1',
              name_fr: 'Pomme Gala',
              name_en: null,
              name_es: null,
              vat_rate_bp: 550,
              default_unit: 'kg',
              piece_weight_grams: null,
              tier_prices: [{ tier: 1, price_ht_cents: 180 }],
              supplier_code: 'rufino',
              origin: 'FR',
              created_at: '2026-04-30T11:00:00Z',
              updated_at: '2026-04-30T11:00:00Z',
              deleted_at: null,
            },
          },
        })
      }
      return jsonResponse(200, { data: { items: [], total: 0, hasMore: false } })
    }) as unknown as typeof fetch

    const router = buildRouter()
    await router.push('/admin/catalog')
    const wrapper = mount(CatalogAdminView, { global: { plugins: [router] } })
    await flushPromises()

    const codeInput = wrapper.find<HTMLInputElement>('[data-test="product-create-code"]')
    const nameInput = wrapper.find<HTMLInputElement>('[data-test="product-create-name-fr"]')
    const unitSelect = wrapper.find<HTMLSelectElement>('[data-test="product-create-default-unit"]')
    const originInput = wrapper.find<HTMLInputElement>('[data-test="product-create-origin"]')
    const submitBtn = wrapper.find('[data-test="product-create-submit"]')

    expect(codeInput.exists()).toBe(true)
    expect(nameInput.exists()).toBe(true)
    expect(unitSelect.exists()).toBe(true)
    expect(originInput.exists()).toBe(true)
    expect(submitBtn.exists()).toBe(true)

    await codeInput.setValue('POM-GAL-1')
    await nameInput.setValue('Pomme Gala')
    await unitSelect.setValue('kg')
    await originInput.setValue('FR')
    await submitBtn.trigger('click')
    await flushPromises()

    expect(postBody).toMatchObject({
      code: 'POM-GAL-1',
      name_fr: 'Pomme Gala',
      default_unit: 'kg',
      origin: 'FR',
    })
    // D-2 : tier_prices présent et non-vide
    const body = postBody as { tier_prices?: Array<{ tier: number }> }
    expect(Array.isArray(body.tier_prices)).toBe(true)
    expect((body.tier_prices ?? []).length).toBeGreaterThanOrEqual(1)
  })

  it('soft-delete déclenche DELETE après confirm dialog', async () => {
    let deleteCalled = false
    let deleteUrl = ''
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'DELETE' && url.includes('/api/admin/products/')) {
        deleteCalled = true
        deleteUrl = url
        return jsonResponse(200, {
          data: {
            product: {
              id: 500,
              code: 'TOM-RAP-1',
              name_fr: 'Tomate Raphael',
              name_en: null,
              name_es: null,
              vat_rate_bp: 550,
              default_unit: 'kg',
              piece_weight_grams: null,
              tier_prices: [{ tier: 1, price_ht_cents: 250 }],
              supplier_code: 'rufino',
              origin: 'ES',
              created_at: '2026-04-30T10:00:00Z',
              updated_at: '2026-04-30T13:00:00Z',
              deleted_at: '2026-04-30T13:00:00Z',
            },
          },
        })
      }
      return jsonResponse(200, {
        data: {
          items: [
            {
              id: 500,
              code: 'TOM-RAP-1',
              name_fr: 'Tomate Raphael',
              name_en: null,
              name_es: null,
              vat_rate_bp: 550,
              default_unit: 'kg',
              piece_weight_grams: null,
              tier_prices: [{ tier: 1, price_ht_cents: 250 }],
              supplier_code: 'rufino',
              origin: 'ES',
              created_at: '2026-04-30T10:00:00Z',
              updated_at: '2026-04-30T10:00:00Z',
              deleted_at: null,
            },
          ],
          total: 1,
          hasMore: false,
        },
      })
    }) as unknown as typeof fetch

    const router = buildRouter()
    await router.push('/admin/catalog')
    const wrapper = mount(CatalogAdminView, { global: { plugins: [router] } })
    await flushPromises()

    const deleteBtn = wrapper.find('[data-test="product-delete-500"]')
    expect(deleteBtn.exists()).toBe(true)
    await deleteBtn.trigger('click')
    const confirmBtn = wrapper.find('[data-test="product-delete-confirm"]')
    expect(confirmBtn.exists()).toBe(true)
    await confirmBtn.trigger('click')
    await flushPromises()

    expect(deleteCalled).toBe(true)
    expect(deleteUrl).toContain('/500')
  })
})
