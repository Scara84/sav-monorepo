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

// ISO UTC regex used by multiple V1.x-B tests.
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

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

/**
 * Story V1.x-B — 4 cas régression + lock-in.
 *
 * AC#1 (lock-in): payload SPA valid_from = UTC ISO (Z suffix) — déjà satisfait
 *   Story 7.4 W-7-4-3, ce test est un verrou régression.
 * AC#3: formatDateTime() rendu Heure Paris indépendamment du browser TZ.
 * AC#4 cas 1: badge « En attente d'effet » sur row valid_from > now().
 * AC#4 cas 2: badge « Actif maintenant » sur row valid_from <= now() ET valid_to=null.
 *
 * Convention test: vi.useFakeTimers() + vi.setSystemTime() pour contrôler Date.now()
 * dans les assertions de badging. TZ browser non-mockée explicitement — le test
 * assert sur la string affichée en Heure Paris via timeZone:'Europe/Paris' (AC#3).
 */
describe('SettingsAdminView — V1.x-B régression timezone + badges (UI)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.useRealTimers()
  })

  /**
   * V1.x-B AC#1 LOCK-IN — payload POST valid_from contient bien le suffixe 'Z'
   * après conversion toISOString(). Regex /^\d{4}-...-Z$/ assert format UTC.
   *
   * Rationale: `<input type="datetime-local">` produit YYYY-MM-DDTHH:mm (sans TZ).
   * W-7-4-3 fait `new Date(form.validFrom).toISOString()` → UTC ISO avec Z.
   * Ce test ÉCHOUE si une refacto future retire la conversion toISOString().
   */
  it('V1.x-B AC#1 LOCK-IN : onRotate() envoie valid_from avec suffixe Z (UTC ISO non ambigu)', async () => {
    // Figer le temps pour un valid_from futur prévisible.
    const FROZEN_NOW = new Date('2026-05-07T13:00:00.000Z') // 15:00 Paris été (UTC+2)
    vi.useFakeTimers()
    vi.setSystemTime(FROZEN_NOW)

    let capturedBody: Record<string, unknown> | null = null
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      // PATCH rotate pour company.legal_name — capturer le body.
      if (method === 'PATCH' && url.includes('company.legal_name')) {
        capturedBody = JSON.parse(String(init!.body)) as Record<string, unknown>
        return jsonResponse(200, {
          data: buildActiveItem({ key: 'company.legal_name', value: 'Fruitstock SAS' }),
        })
      }
      // GET /api/admin/settings (liste active onglet général).
      if (
        url.endsWith('/api/admin/settings') ||
        (url.includes('/api/admin/settings') && method === 'GET' && !url.includes('/history'))
      ) {
        return jsonResponse(200, {
          data: {
            items: [buildActiveItem({ key: 'company.legal_name', value: 'Fruitstock SAS' })],
          },
        })
      }
      return jsonResponse(200, { data: { items: [] } })
    }) as unknown as typeof fetch

    const router = buildRouter()
    await router.push('/admin/settings?tab=general')
    const wrapper = mount(SettingsAdminView, { global: { plugins: [router] } })
    await flushPromises()

    // Simuler une valeur valid_from locale (comme produite par formatLocalDateTimeInput).
    // now + 1h en heure locale Paris été = 2026-05-07T16:00 local
    // → new Date('2026-05-07T16:00').toISOString() = '2026-05-07T14:00:00.000Z' (UTC)
    const localValidFrom = '2026-05-07T16:00'
    const validFromInput = wrapper.find<HTMLInputElement>(`#valid-from-company\\.legal_name`)
    // W-VxB-4 L-1 fix: fail-fast if selector is broken (don't silently skip setValue).
    expect(validFromInput.exists()).toBe(true)
    await validFromInput.setValue(localValidFrom)

    // Trouver le formulaire rotate pour company.legal_name et soumettre.
    const rotateForm = wrapper
      .findAll('form.rotate-form')
      .find((f) => f.find('input[type="datetime-local"]').exists())
    expect(rotateForm).toBeDefined()
    if (rotateForm) {
      await rotateForm.trigger('submit')
      await flushPromises()
    }

    // Assert que le body POST a bien un valid_from avec suffixe Z.
    expect(capturedBody).not.toBeNull()
    if (capturedBody !== null) {
      const validFromSent = capturedBody['valid_from'] as string
      expect(typeof validFromSent).toBe('string')
      // LOCK-IN : doit se terminer par 'Z' (UTC ISO non ambigu).
      expect(validFromSent.endsWith('Z')).toBe(true)
      // Pattern strict ISO 8601 UTC.
      expect(validFromSent).toMatch(ISO_UTC_RE)
    }
  })

  /**
   * V1.x-B AC#3 — formatDateTime() rendu Heure Paris.
   *
   * Fixture: valid_from='2026-05-07T15:38:00.000Z' (UTC).
   * En heure Paris été (UTC+2): 17:38. En heure NYC (UTC-4): 11:38.
   *
   * Ce test ÉCHOUE tant que formatDateTime() n'a pas `timeZone: 'Europe/Paris'`.
   * Après fix Step 3, le DOM doit afficher '17:38' indépendamment de la TZ
   * du process test (Vitest tourne en UTC sur CI).
   *
   * Note: on ne mock pas process.env.TZ — on asset directement sur le rendu
   * DOM qui doit toujours être Heure Paris grâce à l'option timeZone explicite.
   */
  it('V1.x-B AC#3 : formatDateTime() rendu Heure Paris (17:38) — indépendant browser TZ', async () => {
    // UTC 15:38 = 17:38 Paris été.
    const UTC_ISO = '2026-05-07T15:38:00.000Z'

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/admin/settings') && !url.includes('/history')) {
        return jsonResponse(200, {
          data: {
            items: [
              buildActiveItem({
                key: 'company.legal_name',
                value: 'Fruitstock SAS',
                valid_from: UTC_ISO,
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

    const domText = wrapper.text()
    // Heure Paris été 17:38 doit être présente dans le DOM.
    expect(domText).toContain('17:38')
    // W-VxB-5 L-3 fix: scoper la négation sur .setting-current pour éviter
    // un faux-positif global (ex: '15:38' dans un autre champ non lié).
    const settingCurrentEl = wrapper.find('.setting-current')
    expect(settingCurrentEl.exists()).toBe(true)
    // Le conteneur de la valeur active ne doit pas afficher l'heure UTC brute 15:38.
    expect(settingCurrentEl.text()).not.toContain('15:38')
  })

  /**
   * V1.x-B AC#4 cas 1 — badge « En attente d'effet » sur row valid_from > now().
   *
   * Figer now à 2026-05-07T13:00:00Z. Row active avec valid_from 2 heures dans
   * le futur (15:00Z). Badge [data-testid="badge-pending"] doit être présent.
   *
   * Ce test ÉCHOUE tant que le template ne contient pas le badge v-if.
   */
  it("V1.x-B AC#4 cas 1 : badge « En attente d'effet » sur row valid_from > now()", async () => {
    const FROZEN_NOW = new Date('2026-05-07T13:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(FROZEN_NOW)

    // Row dont valid_from est dans le futur par rapport au now figé.
    const FUTURE_ISO = '2026-05-07T15:00:00.000Z' // +2h depuis FROZEN_NOW

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/admin/settings') && !url.includes('/history')) {
        return jsonResponse(200, {
          data: {
            items: [
              buildActiveItem({
                key: 'company.legal_name',
                value: 'Fruitstock SAS',
                valid_from: FUTURE_ISO,
                valid_to: null,
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

    // Badge « En attente d'effet » présent (valid_from future strict).
    const badgePending = wrapper.find('[data-testid="badge-pending"]')
    expect(badgePending.exists()).toBe(true)
    expect(badgePending.text()).toContain("En attente d'effet")

    // Badge « Actif maintenant » absent pour cette row.
    const badgeActive = wrapper.find('[data-testid="badge-active"]')
    expect(badgeActive.exists()).toBe(false)
  })

  /**
   * V1.x-B AC#4 cas 2 — badge « Actif maintenant » sur row valid_from <= now()
   * ET valid_to = null.
   *
   * Figer now à 2026-05-07T16:00:00Z. Row active avec valid_from 1h dans le passé.
   * Badge [data-testid="badge-active"] doit être présent.
   * Badge [data-testid="badge-pending"] doit être absent.
   *
   * Ce test ÉCHOUE tant que le template ne contient pas le badge v-else-if.
   */
  it('V1.x-B AC#4 cas 2 : badge « Actif maintenant » sur row valid_from <= now()', async () => {
    const FROZEN_NOW = new Date('2026-05-07T16:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(FROZEN_NOW)

    // Row dont valid_from est dans le passé par rapport au now figé.
    const PAST_ISO = '2026-05-07T15:00:00.000Z' // -1h depuis FROZEN_NOW

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/admin/settings') && !url.includes('/history')) {
        return jsonResponse(200, {
          data: {
            items: [
              buildActiveItem({
                key: 'company.legal_name',
                value: 'Fruitstock SAS',
                valid_from: PAST_ISO,
                valid_to: null,
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

    // Badge « Actif maintenant » présent (valid_from passé, valid_to null).
    const badgeActive = wrapper.find('[data-testid="badge-active"]')
    expect(badgeActive.exists()).toBe(true)
    expect(badgeActive.text()).toContain('Actif maintenant')

    // Badge « En attente d'effet » absent pour cette row.
    const badgePending = wrapper.find('[data-testid="badge-pending"]')
    expect(badgePending.exists()).toBe(false)
  })

  /**
   * W-VxB-2 — Hardening Round 1 — badges sur history-panel rows (AC#4).
   *
   * Fixture : 3 rows history pour vat_rate_default :
   *   - row future (valid_to=null, valid_from > now) → history-badge-pending
   *   - row active (valid_to=null, valid_from <= now) → history-badge-active
   *   - row fermée (valid_to != null)                → aucun badge
   *
   * Utilise vi.useFakeTimers() + vi.setSystemTime() pour contrôler Date.now().
   */
  it('W-VxB-2 : badges présents sur history-panel rows (pending / active / fermée)', async () => {
    const FROZEN_NOW = new Date('2026-05-07T14:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(FROZEN_NOW)

    const FUTURE_ISO = '2026-05-07T16:00:00.000Z' // +2h, pending
    const PAST_ISO = '2026-05-07T12:00:00.000Z' // -2h, active
    const CLOSED_FROM = '2026-01-01T00:00:00.000Z'
    const CLOSED_TO = '2026-04-01T00:00:00.000Z' // fermée

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/admin/settings') && !url.includes('/history')) {
        return jsonResponse(200, {
          data: {
            items: [
              buildActiveItem({
                key: 'vat_rate_default',
                value: { bp: 600 },
                valid_from: FUTURE_ISO,
                valid_to: null,
                versions_count: 3,
              }),
            ],
          },
        })
      }
      if (url.includes('/history')) {
        return jsonResponse(200, {
          data: {
            items: [
              // row future (pending)
              {
                id: 3,
                value: { bp: 600 },
                valid_from: FUTURE_ISO,
                valid_to: null,
                notes: 'Hausse future',
                created_at: FUTURE_ISO,
                updated_by: { id: 9, email_display_short: 'admin' },
              },
              // row active (actif maintenant)
              {
                id: 2,
                value: { bp: 575 },
                valid_from: PAST_ISO,
                valid_to: null,
                notes: null,
                created_at: PAST_ISO,
                updated_by: null,
              },
              // row fermée (historique — pas de badge)
              {
                id: 1,
                value: { bp: 550 },
                valid_from: CLOSED_FROM,
                valid_to: CLOSED_TO,
                notes: null,
                created_at: CLOSED_FROM,
                updated_by: null,
              },
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

    // Expand history panel
    const historyToggle = wrapper.find('[data-history-toggle="vat_rate_default"]')
    expect(historyToggle.exists()).toBe(true)
    await historyToggle.trigger('click')
    await flushPromises()

    // Badge pending présent sur row future
    const badgePending = wrapper.find('[data-testid="history-badge-pending"]')
    expect(badgePending.exists()).toBe(true)
    expect(badgePending.text()).toContain("En attente d'effet")

    // Badge active présent sur row passée (valid_to=null, valid_from <= now)
    const badgeActive = wrapper.find('[data-testid="history-badge-active"]')
    expect(badgeActive.exists()).toBe(true)
    expect(badgeActive.text()).toContain('Actif maintenant')

    // Aucun badge sur la row fermée (valid_to != null) — on vérifie que les
    // badges sont exactement 1 chacun (pas de troisième badge).
    expect(wrapper.findAll('[data-testid="history-badge-pending"]')).toHaveLength(1)
    expect(wrapper.findAll('[data-testid="history-badge-active"]')).toHaveLength(1)
  })

  /**
   * W-VxB-3 — Hardening Round 1 — réactivité du hint valid-from-preview (AC#3).
   *
   * Vérifie que le hint live `.valid-from-preview` se met à jour de façon réactive
   * quand l'admin modifie l'input datetime-local, sans fake timers (test réactivité,
   * pas de badging).
   */
  it('W-VxB-3 : hint .valid-from-preview réactif à la saisie dans input datetime-local', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/admin/settings') && !url.includes('/history')) {
        return jsonResponse(200, {
          data: {
            items: [
              buildActiveItem({
                key: 'company.legal_name',
                value: 'Fruitstock SAS',
                valid_from: '2026-01-01T00:00:00.000Z',
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

    // Trouver l'input datetime-local pour company.legal_name
    const input = wrapper.find<HTMLInputElement>(`#valid-from-company\\.legal_name`)
    expect(input.exists()).toBe(true)

    // Saisir une valeur dans l'input.
    // Using a date string that includes ':00' minutes so the Paris rendering will
    // always contain ':00' regardless of the test-runner TZ (UTC on CI or Paris locally).
    const INPUT_VALUE = '2026-06-15T10:00'
    await input.setValue(INPUT_VALUE)
    await wrapper.vm.$nextTick()

    // Le hint .valid-from-preview doit refleter la nouvelle valeur.
    const preview = wrapper.find('.valid-from-preview')
    expect(preview.exists()).toBe(true)
    // Compute the expected Paris time dynamically (TZ-agnostic across CI UTC / local Paris).
    const expectedParisTime = new Date(INPUT_VALUE).toLocaleString('fr-FR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Paris',
    })
    expect(preview.text()).toContain(expectedParisTime)
  })
})
