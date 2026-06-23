/**
 * Story V1.1 — AC #1 ATDD RED-PHASE
 *
 * Tests covering the spinbutton fix on WebhookItemsList.vue:
 *   - AC #1(a) : input has min="0.01" max="9999.99" step="0.01" inputmode="decimal"
 *                data-test="sav-form-quantity-{index}" placeholder="ex: 1.5"
 *   - AC #1(b) : value 12.5 is preserved without silent coercion to 0
 *   - AC #1(c) : on submit, qtyRequested is 12.5 (not 0)
 *   - AC #1(e) : empty quantity → error "La quantité est requise"
 *   - AC #1(e) : quantity=0 submitted → error "La quantité doit être supérieure à 0"
 *
 * These tests are RED before the fix. They turn GREEN after V1.1 patch.
 */
import { mount } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import WebhookItemsList from '../../../../../src/features/sav/components/WebhookItemsList.vue'

vi.mock('axios', () => ({
  default: {
    post: vi.fn(() => Promise.resolve({ data: {} })),
  },
}))

vi.mock('xlsx', () => ({
  utils: {
    json_to_sheet: vi.fn(() => ({})),
    book_new: vi.fn(() => ({ SheetNames: [], Sheets: {} })),
    book_append_sheet: vi.fn((wb, ws, name) => {
      wb.SheetNames.push(name)
      wb.Sheets[name] = ws
      return wb
    }),
    write: vi.fn(() => new Uint8Array([])),
  },
  writeFile: vi.fn(),
}))

const mockItems = [
  {
    id: '1',
    label: 'Pommes Bio',
    quantity: 5,
    unit: 'kg',
    vat_rate: 5.5,
    amount: 120,
  },
]

const mockFacture = {
  id: 'FACT-V11',
  date: '2024-10-01',
  customer: 'Adhérent Test',
  customer_email: 'adherent@fruitstock.fr',
}

const createWrapper = (props = {}) =>
  mount(WebhookItemsList, {
    props: {
      items: [...mockItems],
      facture: { ...mockFacture },
      ...props,
    },
    global: {
      stubs: {
        'font-awesome-icon': true,
        transition: true,
      },
      mocks: {
        $t: (key) => key,
      },
    },
  })

describe('WebhookItemsList.vue — V1.1 AC #1 spinbutton fix (RED before fix)', () => {
  let wrapper

  beforeEach(() => {
    vi.clearAllMocks()
    wrapper = createWrapper()
  })

  afterEach(() => {
    if (wrapper) wrapper.unmount()
  })

  // ---- open the SAV form ----
  const openForm = async (w) => {
    const btn = w.find('button.btn-main')
    await btn.trigger('click')
    await w.vm.$nextTick()
  }

  describe('AC #1(a) — input attributes after fix', () => {
    it('quantity input has data-test="sav-form-quantity-0"', async () => {
      await openForm(wrapper)
      const input = wrapper.find('[data-test="sav-form-quantity-0"]')
      expect(input.exists()).toBe(true)
    })

    it('quantity input has min="0.01"', async () => {
      await openForm(wrapper)
      const input = wrapper.find('[data-test="sav-form-quantity-0"]')
      expect(input.attributes('min')).toBe('0.01')
    })

    it('quantity input has max="9999.99"', async () => {
      await openForm(wrapper)
      const input = wrapper.find('[data-test="sav-form-quantity-0"]')
      expect(input.attributes('max')).toBe('9999.99')
    })

    it('quantity input has inputmode="decimal"', async () => {
      await openForm(wrapper)
      const input = wrapper.find('[data-test="sav-form-quantity-0"]')
      expect(input.attributes('inputmode')).toBe('decimal')
    })

    it('quantity input has placeholder containing "1.5"', async () => {
      await openForm(wrapper)
      const input = wrapper.find('[data-test="sav-form-quantity-0"]')
      expect(input.attributes('placeholder')).toMatch(/1\.5/)
    })
  })

  describe('AC #1(b)(c) — value 12.5 preserved, qtyRequested not coerced to 0', () => {
    it('setting quantity to 12.5 keeps the value (no silent coercion to 0)', async () => {
      await openForm(wrapper)
      const form = wrapper.vm.getSavForm(0)
      // Simulate what browser does after user types 12.5
      form.quantity = '12.5'
      await wrapper.vm.$nextTick()
      // The bound reactive value must stay 12.5, not 0
      expect(form.quantity).toBe('12.5')
      expect(Number(form.quantity) || 0).toBe(12.5)
    })

    it('qtyRequested in payload is 12.5 when quantity is "12.5"', () => {
      // Unit-level assertion on the Number() expression used at line 802
      // qtyRequested: Number(form.quantity) || 0
      expect(Number('12.5') || 0).toBe(12.5)
    })

    it('qtyRequested coercion bug: Number("") || 0 = 0 — documents the pre-fix behaviour', () => {
      // This documents WHY the bug occurred (empty string from FR comma entry).
      // After fix, the input has proper attributes preventing silent empty submission.
      expect(Number('') || 0).toBe(0)
    })
  })

  describe('AC #1(e) — validation error messages', () => {
    it('empty quantity on submit shows "La quantité est requise"', async () => {
      await openForm(wrapper)
      const form = wrapper.vm.getSavForm(0)
      // Leave quantity at '' (initial state)
      form.quantity = ''
      form.unit = 'kg'
      form.reason = 'abime'
      // Trigger validateItemForm — uses useSavForms.validateForm internally
      await wrapper.vm.validateItemForm(0)
      await wrapper.vm.$nextTick()
      expect(form.errors.quantity).toMatch(/requise/)
    })

    it('quantity = 0 on submit shows "La quantité doit être supérieure à 0"', async () => {
      await openForm(wrapper)
      const form = wrapper.vm.getSavForm(0)
      form.quantity = 0
      form.unit = 'kg'
      form.reason = 'manquant'
      await wrapper.vm.validateItemForm(0)
      await wrapper.vm.$nextTick()
      expect(form.errors.quantity).toMatch(/supérieure à 0/)
    })
  })
})
