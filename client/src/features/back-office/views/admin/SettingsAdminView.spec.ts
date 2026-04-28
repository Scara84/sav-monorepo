import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'

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

import SettingsAdminView from './SettingsAdminView.vue'

function buildRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div></div>' } },
      { path: '/admin/settings', name: 'admin-settings', component: SettingsAdminView },
    ],
  })
}

describe('SettingsAdminView (UI)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("charge l'historique au mount + affiche valeurs courantes", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(200, {
        data: {
          items: [
            {
              id: 1,
              value: { count: 5, days: 7, dedup_hours: 24 },
              valid_from: '2026-04-20T10:00:00Z',
              valid_to: null,
              notes: null,
              created_at: '2026-04-20T10:00:00Z',
              updated_by: { id: 9, email_display_short: 'admin' },
            },
          ],
        },
      })
    ) as unknown as typeof fetch

    const router = buildRouter()
    await router.push('/admin/settings')
    const wrapper = mount(SettingsAdminView, { global: { plugins: [router] } })
    await flushPromises()

    expect(wrapper.text()).toContain('Seuils')
    expect(wrapper.text()).toContain('Seuil alerte produit')
    const inputCount = wrapper.find<HTMLInputElement>('#threshold-count')
    expect(inputCount.element.value).toBe('5')
    const inputDays = wrapper.find<HTMLInputElement>('#threshold-days')
    expect(inputDays.element.value).toBe('7')
    const inputDedup = wrapper.find<HTMLInputElement>('#threshold-dedup')
    expect(inputDedup.element.value).toBe('24')
  })

  it('Click Enregistrer → PATCH appelé avec body correct + toast success', async () => {
    let calls = 0
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1
      const url = String(input)
      if (url.includes('/history')) {
        return jsonResponse(200, {
          data: {
            items: [
              {
                id: 1,
                value: { count: 5, days: 7, dedup_hours: 24 },
                valid_from: '2026-04-20T10:00:00Z',
                valid_to: null,
                notes: null,
                created_at: '2026-04-20T10:00:00Z',
                updated_by: null,
              },
            ],
          },
        })
      }
      // PATCH
      expect(init?.method).toBe('PATCH')
      const body = JSON.parse(String(init?.body)) as { count: number }
      expect(body.count).toBe(8)
      return jsonResponse(200, {
        data: {
          id: 99,
          key: 'threshold_alert',
          value: { count: 8, days: 14, dedup_hours: 48 },
          valid_from: '2026-04-28T10:00:00Z',
          valid_to: null,
          updated_by: 9,
          notes: 'tighten',
          created_at: '2026-04-28T10:00:00Z',
        },
      })
    }) as unknown as typeof fetch

    const router = buildRouter()
    await router.push('/admin/settings')
    const wrapper = mount(SettingsAdminView, { global: { plugins: [router] } })
    await flushPromises()
    expect(calls).toBe(1) // history mount

    // Modifier les valeurs et soumettre.
    await wrapper.find<HTMLInputElement>('#threshold-count').setValue('8')
    await wrapper.find<HTMLInputElement>('#threshold-days').setValue('14')
    await wrapper.find<HTMLInputElement>('#threshold-dedup').setValue('48')
    await wrapper.find<HTMLInputElement>('#threshold-notes').setValue('tighten')
    await wrapper.find('form.form').trigger('submit')
    await flushPromises()

    expect(calls).toBeGreaterThanOrEqual(2)
    const toast = wrapper.find('.toast.success')
    expect(toast.exists()).toBe(true)
    expect(toast.text()).toContain('Seuils enregistrés')
  })

  it('PATCH 403 ROLE_NOT_ALLOWED → toast erreur FR', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/history')) {
        return jsonResponse(200, {
          data: {
            items: [
              {
                id: 1,
                value: { count: 5, days: 7, dedup_hours: 24 },
                valid_from: '2026-04-20T10:00:00Z',
                valid_to: null,
                notes: null,
                created_at: '2026-04-20T10:00:00Z',
                updated_by: null,
              },
            ],
          },
        })
      }
      expect(init?.method).toBe('PATCH')
      return jsonResponse(403, {
        error: { code: 'FORBIDDEN', details: { code: 'ROLE_NOT_ALLOWED' } },
      })
    }) as unknown as typeof fetch

    const router = buildRouter()
    await router.push('/admin/settings')
    const wrapper = mount(SettingsAdminView, { global: { plugins: [router] } })
    await flushPromises()
    await wrapper.find('form.form').trigger('submit')
    await flushPromises()

    const toast = wrapper.find('.toast.error')
    expect(toast.exists()).toBe(true)
    expect(toast.text()).toContain('administrateurs')
  })

  it('Historique rendu avec dates + auteur', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(200, {
        data: {
          items: [
            {
              id: 2,
              value: { count: 8, days: 14, dedup_hours: 48 },
              valid_from: '2026-04-28T10:00:00Z',
              valid_to: null,
              notes: 'tightening',
              created_at: '2026-04-28T10:00:00Z',
              updated_by: { id: 9, email_display_short: 'admin' },
            },
            {
              id: 1,
              value: { count: 5, days: 7, dedup_hours: 24 },
              valid_from: '2026-04-20T10:00:00Z',
              valid_to: '2026-04-28T10:00:00Z',
              notes: null,
              created_at: '2026-04-20T10:00:00Z',
              updated_by: null,
            },
          ],
        },
      })
    ) as unknown as typeof fetch

    const router = buildRouter()
    await router.push('/admin/settings')
    const wrapper = mount(SettingsAdminView, { global: { plugins: [router] } })
    await flushPromises()

    const rows = wrapper.findAll('table.history-table tbody tr')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.text()).toContain('admin')
    expect(rows[0]!.text()).toContain('tightening')
    // Active row badge
    expect(rows[0]!.classes()).toContain('active')
  })
})
