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

/**
 * Story 7-4 AC #1 + AC #4 + AC #5 — RED-PHASE tests pour l'extension
 * onglet « Général » (D-5 — pas de duplication de View, ajout d'un 2e onglet).
 *
 * Régression baseline 5.5 (les 4 tests describe('SettingsAdminView (UI)')
 * ci-dessus) : doit rester verte. Story 7-4 = ADDITIVE.
 *
 * Couverture :
 *   1. Render onglet « Général » (TabId 'general') quand ?tab=general
 *   2. Fetch GET /api/admin/settings → liste 8 clés whitelist
 *   3. Formulaire rotation Zod côté SPA : `bp` int + `valid_from` ISO future
 *   4. Historique panel collapse/expand 10 dernières versions
 *   5. Régression onglet « Seuils » Story 5.5 reste accessible (D-5 préservation)
 */

interface ApiSettingActive {
  id: number
  key: string
  value: unknown
  valid_from: string
  valid_to: string | null
  notes: string | null
  created_at: string
  updated_by: { id: number; email_display_short: string | null } | null
  versions_count: number
}

function buildActiveItem(overrides: Partial<ApiSettingActive> = {}): ApiSettingActive {
  return {
    id: 1,
    key: 'vat_rate_default',
    value: { bp: 550 },
    valid_from: '2020-01-01T00:00:00Z',
    valid_to: null,
    notes: null,
    created_at: '2020-01-01T00:00:00Z',
    updated_by: { id: 9, email_display_short: 'admin' },
    versions_count: 1,
    ...overrides,
  }
}

describe('SettingsAdminView — Story 7-4 onglet Général (UI)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('AC #1 : navigue vers ?tab=general → onglet Général actif (D-5 hydrate)', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/admin/settings') && !url.includes('/history')) {
        // GET /api/admin/settings → liste active.
        return jsonResponse(200, {
          data: {
            items: [
              buildActiveItem({ key: 'vat_rate_default', value: { bp: 550 } }),
              buildActiveItem({ id: 2, key: 'company.legal_name', value: 'Fruitstock SAS' }),
            ],
          },
        })
      }
      // Threshold history call (régression onglet Seuils baseline 5.5).
      return jsonResponse(200, { data: { items: [] } })
    }) as unknown as typeof fetch

    const router = buildRouter()
    await router.push('/admin/settings?tab=general')
    const wrapper = mount(SettingsAdminView, { global: { plugins: [router] } })
    await flushPromises()

    // L'onglet Général est rendu (texte visible).
    expect(wrapper.text()).toContain('Général')
    // Au moins une des 8 clés whitelist apparaît.
    expect(wrapper.text()).toContain('vat_rate_default')
  })

  it('AC #1 : GET /api/admin/settings retourne 8 clés whitelist → liste rendue', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/admin/settings' || url.endsWith('/api/admin/settings')) {
        return jsonResponse(200, {
          data: {
            items: [
              buildActiveItem({ id: 1, key: 'vat_rate_default', value: { bp: 550 } }),
              buildActiveItem({ id: 2, key: 'group_manager_discount', value: { bp: 400 } }),
              buildActiveItem({
                id: 3,
                key: 'maintenance_mode',
                value: { enabled: false },
              }),
              buildActiveItem({ id: 4, key: 'company.legal_name', value: 'Fruitstock SAS' }),
              buildActiveItem({ id: 5, key: 'company.siret', value: '12345678901234' }),
              buildActiveItem({ id: 6, key: 'company.tva_intra', value: 'FR12345678901' }),
              buildActiveItem({
                id: 7,
                key: 'company.legal_mentions_short',
                value: 'Mentions légales courtes',
              }),
              buildActiveItem({
                id: 8,
                key: 'onedrive.pdf_folder_root',
                value: '/AvoirsPDF',
              }),
            ],
          },
        })
      }
      return jsonResponse(200, { data: { items: [] } })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const router = buildRouter()
    await router.push('/admin/settings?tab=general')
    const wrapper = mount(SettingsAdminView, { global: { plugins: [router] } })
    await flushPromises()

    // Le View doit avoir hit l'endpoint admin-settings-list au mount onglet général.
    const calledUrls = fetchMock.mock.calls.map((c) => String((c as [string])[0]))
    expect(
      calledUrls.some((u) => u.includes('/api/admin/settings') && !u.includes('/history'))
    ).toBe(true)
    // Au moins quelques clés whitelist visibles dans le DOM.
    expect(wrapper.text()).toContain('vat_rate_default')
    expect(wrapper.text()).toContain('company.legal_name')
  })

  it('AC #2 : formulaire rotation refuse valid_from rétroactif côté SPA (D-4)', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/admin/settings') && !url.includes('/history')) {
        return jsonResponse(200, {
          data: {
            items: [buildActiveItem({ key: 'vat_rate_default', value: { bp: 550 } })],
          },
        })
      }
      return jsonResponse(200, { data: { items: [] } })
    }) as unknown as typeof fetch

    const router = buildRouter()
    await router.push('/admin/settings?tab=general')
    const wrapper = mount(SettingsAdminView, { global: { plugins: [router] } })
    await flushPromises()

    // Le bouton Enregistrer rotation doit être présent pour vat_rate_default.
    // Validation côté SPA : tentative de saisir valid_from passé → bouton
    // disabled OU toast erreur INVALID_VALID_FROM.
    // On cherche un input datetime-local pour valid_from avec attribut min.
    const validFromInputs = wrapper.findAll<HTMLInputElement>('input[type="datetime-local"]')
    expect(validFromInputs.length).toBeGreaterThan(0)
    // Au moins un input doit avoir un attribut `min` (defensive D-4 client-side).
    const hasMin = validFromInputs.some((i) => i.attributes('min') !== undefined)
    expect(hasMin).toBe(true)
  })

  it('AC #4 : panel historique collapsible expand → fetch GET /:key/history?limit=10', async () => {
    let historyFetched = false
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/history')) {
        historyFetched = true
        // Vérifie défaut limit=10 (D-6).
        expect(url).toMatch(/limit=10/)
        return jsonResponse(200, {
          data: {
            items: [
              {
                id: 2,
                value: { bp: 600 },
                valid_from: '2026-07-01T00:00:00Z',
                valid_to: null,
                notes: 'Hausse TVA décret 2026',
                created_at: '2026-05-01T10:00:00Z',
                updated_by: { id: 9, email_display_short: 'admin' },
              },
              {
                id: 1,
                value: { bp: 550 },
                valid_from: '2020-01-01T00:00:00Z',
                valid_to: '2026-07-01T00:00:00Z',
                notes: null,
                created_at: '2020-01-01T00:00:00Z',
                updated_by: null,
              },
            ],
          },
        })
      }
      if (url.includes('/api/admin/settings') && !url.includes('/history')) {
        return jsonResponse(200, {
          data: {
            items: [
              buildActiveItem({
                key: 'vat_rate_default',
                value: { bp: 550 },
                versions_count: 2,
              }),
            ],
          },
        })
      }
      return jsonResponse(200, { data: { items: [] } })
    }) as unknown as typeof fetch

    const router = buildRouter()
    await router.push('/admin/settings?tab=general')
    const wrapper = mount(SettingsAdminView, { global: { plugins: [router] } })
    await flushPromises()

    // Click bouton historique pour vat_rate_default (lazy-fetch on first expand).
    const historyToggle = wrapper.find('[data-history-toggle="vat_rate_default"]')
    expect(historyToggle.exists()).toBe(true)
    await historyToggle.trigger('click')
    await flushPromises()
    expect(historyFetched).toBe(true)
    // Le panel rend les versions (au moins 'Hausse TVA' note visible).
    expect(wrapper.text()).toContain('Hausse TVA')
  })

  it('AC #5 D-5 régression : onglet "Seuils" Story 5.5 reste accessible quand on navigue vers ?tab=thresholds', async () => {
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
              updated_by: null,
            },
          ],
        },
      })
    ) as unknown as typeof fetch

    const router = buildRouter()
    // Navigue d'abord sur ?tab=general puis bascule vers ?tab=thresholds.
    await router.push('/admin/settings?tab=general')
    const wrapper = mount(SettingsAdminView, { global: { plugins: [router] } })
    await flushPromises()
    // Locate the Seuils tab et clique (D-5 préservation onglets thresholds Story 5.5).
    const seuilsTab = wrapper.findAll('button.tab').find((b) => b.text().includes('Seuils'))
    expect(seuilsTab).toBeDefined()
    if (seuilsTab) await seuilsTab.trigger('click')
    await flushPromises()
    // Le formulaire threshold de Story 5.5 doit être rendu (régression).
    expect(wrapper.find('#threshold-count').exists()).toBe(true)
    expect(wrapper.find('#threshold-days').exists()).toBe(true)
    expect(wrapper.find('#threshold-dedup').exists()).toBe(true)
  })
})
