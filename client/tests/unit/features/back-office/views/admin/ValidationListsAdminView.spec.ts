/**
 * Story V1.1 — AC #3 ATDD RED-PHASE
 *
 * Tests covering the spinbutton fix on ValidationListsAdminView.vue Ordre inputs:
 *   - AC #3(a) create input: max="9999" step="1" inputmode="numeric"
 *              data-test="validation-list-create-sort-order"
 *   - AC #3(b) value 42 preserved; payload sort_order === 42
 *   - AC #3(c) edit input: also gets max="9999" step="1" inputmode="numeric"
 *
 * These tests are RED before the fix. They turn GREEN after V1.1 patch.
 *
 * Mock strategy:
 *   - vi.mock useAdminCrud — spy on `create`.
 *   - global.fetch mocked via setup.js (returns ok: true, data: { lists: {} }).
 *   - The component calls refresh() on mount via fetch — setup.js fetch mock returns {}.
 *     We override fetch here to return a proper shape so the component doesn't error out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import ValidationListsAdminView from '../../../../../../src/features/back-office/views/admin/ValidationListsAdminView.vue'

// --- Mock useAdminCrud ---
const mockCreate = vi.fn()
const mockUpdate = vi.fn()

vi.mock('../../../../../../src/features/back-office/composables/useAdminCrud', () => ({
  useAdminCrud: () => ({
    items: ref([]),
    total: ref(0),
    loading: ref(false),
    error: ref(null),
    list: vi.fn(),
    create: mockCreate,
    update: mockUpdate,
    remove: vi.fn(),
  }),
}))

// Override global fetch to return empty lists so refresh() succeeds
const fetchMock = vi.fn(() =>
  Promise.resolve({
    ok: true,
    json: () =>
      Promise.resolve({
        data: { lists: { sav_cause: [], bon_type: [], unit: [] } },
      }),
  })
)

describe('ValidationListsAdminView.vue — V1.1 AC #3 Ordre spinbutton fix (RED before fix)', () => {
  let wrapper: VueWrapper<unknown>

  beforeEach(() => {
    vi.clearAllMocks()
    mockCreate.mockResolvedValue({
      id: 1,
      list_code: 'sav_cause',
      value: 'test',
      sort_order: 42,
      is_active: true,
    })
    global.fetch = fetchMock as unknown as typeof fetch

    wrapper = mount(ValidationListsAdminView, {
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

  describe('AC #3(a) — create sort-order input attributes after fix', () => {
    it('create sort-order input has data-test="validation-list-create-sort-order"', () => {
      const input = wrapper.find('[data-test="validation-list-create-sort-order"]')
      expect(input.exists()).toBe(true)
    })

    it('create sort-order input has max="9999"', () => {
      const input = wrapper.find('[data-test="validation-list-create-sort-order"]')
      expect(input.attributes('max')).toBe('9999')
    })

    it('create sort-order input has step="1"', () => {
      const input = wrapper.find('[data-test="validation-list-create-sort-order"]')
      expect(input.attributes('step')).toBe('1')
    })

    it('create sort-order input has inputmode="numeric"', () => {
      const input = wrapper.find('[data-test="validation-list-create-sort-order"]')
      expect(input.attributes('inputmode')).toBe('numeric')
    })
  })

  describe('AC #3(b) — value 42 preserved, payload sort_order === 42', () => {
    it('saisie 42 dans sort_order → payload sort_order === 42', async () => {
      // Fill required "Valeur" field
      const valueInput = wrapper.find('[data-test="validation-list-create-value"]')
      await valueInput.setValue('Abimé')

      // Fill sort_order
      const sortInput = wrapper.find('[data-test="validation-list-create-sort-order"]')
      await sortInput.setValue('42')

      // Submit via form submit event (form uses @submit.prevent, not @click on button)
      await wrapper.find('form.create-form').trigger('submit')
      await wrapper.vm.$nextTick()

      expect(mockCreate).toHaveBeenCalledOnce()
      const payload = mockCreate.mock.calls[0][0] as { sort_order: number }
      expect(payload.sort_order).toBe(42)
    })
  })

  describe('AC #3(c) — edit sort-order input: max="9999" step="1" inputmode="numeric"', () => {
    it('edit sort-order input template contains max="9999" when rendered (static attribute check)', () => {
      // The edit input is conditionally rendered only when editingId !== null.
      // We verify the template source constraint via a static check:
      // set editingId to a known id to show the edit row.

      // Inject an entry into the lists ref so the table renders
      const vm = wrapper.vm as unknown as {
        lists: {
          sav_cause: Array<{
            id: number
            list_code: string
            value: string
            value_es: string | null
            sort_order: number
            is_active: boolean
          }>
        }
        editingId: number | null
        editForm: { value_es: string; sort_order: number }
      }

      vm.lists.sav_cause = [
        {
          id: 7,
          list_code: 'sav_cause',
          value: 'Abimé',
          value_es: null,
          sort_order: 10,
          is_active: true,
        },
      ]
      vm.editingId = 7
      vm.editForm = { value_es: '', sort_order: 10 }
      return wrapper.vm.$nextTick().then(() => {
        const editInput = wrapper.find('[data-test="validation-list-edit-sort-order-7"]')
        expect(editInput.exists()).toBe(true)
        expect(editInput.attributes('max')).toBe('9999')
        expect(editInput.attributes('step')).toBe('1')
        expect(editInput.attributes('inputmode')).toBe('numeric')
      })
    })
  })
})
