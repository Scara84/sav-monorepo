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
    await wrapper.get('form.create-form').trigger('submit')
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

  it('relit CAR-55 après modification et identifie le nom refusé sans annoncer de réussite', async () => {
    let savedName = 'Carotte témoin'
    let reject = false
    const methods: string[] = []
    globalThis.fetch = vi.fn(async (_input, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET')
      const row = { id: 55, code: 'CAR-55', default_unit: 'kg', deleted_at: null }
      if (init?.method === 'PATCH') {
        const patch = JSON.parse(String(init.body))
        expect(Object.keys(patch)).toEqual(['name_fr'])
        if (reject)
          return jsonResponse(400, {
            error: { details: { code: 'INVALID_BODY', issues: [{ field: 'name_fr' }] } },
          })
        savedName = patch.name_fr
        return jsonResponse(200, { data: { product: { ...row, name_fr: savedName } } })
      }
      return jsonResponse(200, { data: { items: [{ ...row, name_fr: savedName }], total: 1 } })
    })
    const wrapper = mount(CatalogAdminView)
    await flushPromises()
    await wrapper.get('#product-edit-55').trigger('click')
    await wrapper.get('#product-edit-name').setValue('Carotte témoin modifiée')
    await wrapper.get('#product-edit-name').trigger('keydown.enter')
    await flushPromises()
    expect(methods).toEqual(['GET', 'PATCH', 'GET'])
    expect(
      wrapper
        .get('tbody tr')
        .findAll('td')
        .slice(0, 3)
        .map((cell) => cell.text())
    ).toEqual(['CAR-55', 'Carotte témoin modifiée', 'kg'])

    expect(wrapper.find('.toast.success').exists()).toBe(true)
    expect(wrapper.get<HTMLFormElement>('form').element.checkValidity()).toBe(false)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.toast.success').exists()).toBe(false)
    reject = true
    await wrapper.get('#product-edit-55').trigger('click')
    await wrapper.get('#product-edit-name').setValue('Refusée')
    await wrapper.get('#product-edit-name').trigger('keydown.enter')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Nom français')
    expect(wrapper.find('.toast.success').exists()).toBe(false)
    await wrapper.get('#product-edit-name').trigger('keydown.esc')
    expect(wrapper.get('tbody tr').text()).toContain('Carotte témoin modifiée')
  })

  it('ne confirme pas une relecture remplacée par un filtre et nomme les filtres refusés', async () => {
    let finishRead!: (value: Response) => void
    let finishFilter!: (value: Response) => void
    const row = { id: 55, code: 'CAR-55', default_unit: 'kg', deleted_at: null, name_fr: 'Carotte' }
    const rows = jsonResponse(200, { data: { items: [row], total: 1 } })
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce(jsonResponse(200, { data: { product: row } }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishRead = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishFilter = resolve
          })
      )
    const wrapper = mount(CatalogAdminView)
    await flushPromises()
    await wrapper.get('#product-edit-55').trigger('click')
    await wrapper.get('#product-edit-name').setValue('Carotte nouvelle')
    await wrapper.get('#product-edit-name').trigger('keydown.enter')
    await flushPromises()
    expect(wrapper.get('#prod-search').attributes('maxlength')).toBe('100')
    expect(wrapper.get('#prod-supplier').attributes('maxlength')).toBe('32')
    await wrapper.get('#prod-search').setValue('filtre')
    await flushPromises()
    finishRead(rows)
    await flushPromises()
    expect(wrapper.find('.toast.success').exists()).toBe(false)
    finishFilter(
      jsonResponse(400, {
        error: {
          details: { code: 'INVALID_PARAMS', issues: [{ field: 'q' }, { field: 'supplier_code' }] },
        },
      })
    )
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Recherche, Fournisseur')
    expect(wrapper.find('.toast.success').exists()).toBe(false)
  })
})
