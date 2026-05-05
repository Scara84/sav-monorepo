/**
 * Story V1.1 — AC #2 ATDD RED-PHASE
 *
 * Tests covering the spinbutton fix on CatalogAdminView.vue Tier 1 input:
 *   - AC #2(a) : input has max="99999999" step="1" inputmode="numeric"
 *                data-test="product-create-tier1" placeholder="ex: 350"
 *   - AC #2(b) : value 1500 is preserved; payload tier_prices[0].price_ht_cents === 1500
 *
 * These tests are RED before the fix. They turn GREEN after V1.1 patch.
 *
 * Mock strategy:
 *   - vi.mock useAdminCrud — returns a spy on `create` so we can capture payload.
 *   - global.fetch mocked via vitest setup.js (returns ok: true).
 *   - No MSAL / router dependencies in CatalogAdminView (it only uses useAdminCrud).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import CatalogAdminView from '../../../../../../src/features/back-office/views/admin/CatalogAdminView.vue'

// --- Mock useAdminCrud ---
const mockCreate = vi.fn()
const mockList = vi.fn()
const mockUpdate = vi.fn()
const mockRemove = vi.fn()

vi.mock('../../../../../../src/features/back-office/composables/useAdminCrud', () => ({
  useAdminCrud: () => ({
    items: ref([]),
    total: ref(0),
    loading: ref(false),
    error: ref(null),
    list: mockList,
    create: mockCreate,
    update: mockUpdate,
    remove: mockRemove,
  }),
}))

describe('CatalogAdminView.vue — V1.1 AC #2 Tier 1 spinbutton fix (RED before fix)', () => {
  let wrapper: VueWrapper<unknown>

  beforeEach(() => {
    vi.clearAllMocks()
    mockCreate.mockResolvedValue({ id: 99, code: 'TEST', name_fr: 'Test', tier_prices: [] })
    mockList.mockResolvedValue(undefined)
    wrapper = mount(CatalogAdminView, {
      global: {
        stubs: {
          'font-awesome-icon': true,
          transition: true,
          RouterLink: true,
        },
      },
    })
  })

  afterEach(() => {
    if (wrapper) wrapper.unmount()
  })

  describe('AC #2(a) — Tier 1 input attributes after fix', () => {
    it('tier1 input has data-test="product-create-tier1"', () => {
      const input = wrapper.find('[data-test="product-create-tier1"]')
      expect(input.exists()).toBe(true)
    })

    it('tier1 input has max="99999999"', () => {
      const input = wrapper.find('[data-test="product-create-tier1"]')
      expect(input.attributes('max')).toBe('99999999')
    })

    it('tier1 input has step="1"', () => {
      const input = wrapper.find('[data-test="product-create-tier1"]')
      expect(input.attributes('step')).toBe('1')
    })

    it('tier1 input has inputmode="numeric"', () => {
      const input = wrapper.find('[data-test="product-create-tier1"]')
      expect(input.attributes('inputmode')).toBe('numeric')
    })

    it('tier1 input has placeholder containing "350"', () => {
      const input = wrapper.find('[data-test="product-create-tier1"]')
      expect(input.attributes('placeholder')).toMatch(/350/)
    })
  })

  describe('AC #2(b) — value 1500 preserved, payload correct', () => {
    it('saisie 1500 dans tier1 → payload tier_prices[0].price_ht_cents === 1500', async () => {
      // Fill required fields (code + name_fr are required by onCreateSubmit)
      const codeInput = wrapper.find('[data-test="product-create-code"]')
      await codeInput.setValue('POMA')

      const nameInput = wrapper.find('[data-test="product-create-name-fr"]')
      await nameInput.setValue('Pommes Bio')

      // Fill Tier 1
      const tier1Input = wrapper.find('[data-test="product-create-tier1"]')
      await tier1Input.setValue('1500')

      // Submit the form
      await wrapper.find('[data-test="product-create-submit"]').trigger('click')
      await wrapper.vm.$nextTick()

      expect(mockCreate).toHaveBeenCalledOnce()
      const payload = mockCreate.mock.calls[0]?.[0] as {
        tier_prices: Array<{ tier: number; price_ht_cents: number }>
      }
      expect(payload.tier_prices[0]?.price_ht_cents).toBe(1500)
    })
  })
})
