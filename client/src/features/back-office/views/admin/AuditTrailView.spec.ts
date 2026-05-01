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

/**
 * Story 7-5 AC #1 + #3 + #6 — RED-PHASE smoke UI tests pour AuditTrailView.
 *
 * Couverture (3 cas) :
 *   1. Render filtres + table : input/select pour entity_type whitelist,
 *      input actor `operator:42`, datepickers from/to, table avec ligne
 *      par entry.
 *   2. Click « Voir diff » → expand panel collapsible (D-5 pattern
 *      `expandedDiff[id]` cohérent 7-4 history panel).
 *   3. Render badge actor email PII-masked (`actor_email_short` retourné
 *      par le handler).
 *
 * RED tant que :
 *   - AuditTrailView.vue n'existe pas
 *   - Composable useAdminAuditTrail.ts n'existe pas
 *   - Composant AuditDiffPanel.vue n'existe pas
 */

import AuditTrailView from './AuditTrailView.vue'

function buildRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div></div>' } },
      { path: '/admin/audit-trail', name: 'admin-audit-trail', component: AuditTrailView },
    ],
  })
}

interface ApiAuditTrailItem {
  id: number
  entity_type: string
  entity_id: number
  action: string
  actor_operator_id: number | null
  actor_email_short: string | null
  actor_member_id: number | null
  actor_member_label: string | null
  actor_system: string | null
  diff: Record<string, unknown> | null
  notes: string | null
  created_at: string
}

function buildItem(overrides: Partial<ApiAuditTrailItem> = {}): ApiAuditTrailItem {
  return {
    id: 1,
    entity_type: 'sav',
    entity_id: 1,
    action: 'created',
    actor_operator_id: 9,
    actor_email_short: 'admin',
    actor_member_id: null,
    actor_member_label: null,
    actor_system: null,
    diff: { before: null, after: { id: 1, status: 'nouveau' } },
    notes: null,
    created_at: '2026-04-15T10:00:00Z',
    ...overrides,
  }
}

describe('AuditTrailView (UI smoke — Story 7-5)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('AC #1 : render formulaire filtres + table avec entries au mount', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(200, {
        data: {
          items: [
            buildItem({ id: 100, entity_type: 'sav', action: 'created' }),
            buildItem({
              id: 101,
              entity_type: 'setting',
              action: 'rotated',
              diff: {
                key: 'vat_rate_default',
                before: { value: { bp: 550 } },
                after: { value: { bp: 600 } },
              },
            }),
          ],
          nextCursor: null,
        },
      })
    ) as unknown as typeof fetch

    const router = buildRouter()
    await router.push('/admin/audit-trail')
    const wrapper = mount(AuditTrailView, { global: { plugins: [router] } })
    await flushPromises()

    // Formulaire filtres présent.
    expect(wrapper.find('select[data-filter-entity-type], #filter-entity-type').exists()).toBe(true)
    expect(wrapper.find('input[data-filter-actor], #filter-actor').exists()).toBe(true)
    expect(wrapper.find('input[data-filter-from], #filter-from').exists()).toBe(true)
    expect(wrapper.find('input[data-filter-to], #filter-to').exists()).toBe(true)

    // Table avec 2 lignes.
    const rows = wrapper.findAll('table tbody tr')
    expect(rows.length).toBeGreaterThanOrEqual(2)
    // Au moins l'action + entity_type visibles.
    expect(wrapper.text()).toContain('sav')
    expect(wrapper.text()).toContain('rotated')
  })

  it('AC #3 D-5 : click "Voir diff" sur une ligne → panel diff expand inline (collapsible state)', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(200, {
        data: {
          items: [
            buildItem({
              id: 200,
              entity_type: 'setting',
              action: 'rotated',
              diff: {
                key: 'vat_rate_default',
                before: { value: { bp: 550 }, valid_from: '2020-01-01T00:00:00Z' },
                after: { value: { bp: 600 }, valid_from: '2026-07-01T00:00:00Z' },
              },
            }),
          ],
          nextCursor: null,
        },
      })
    ) as unknown as typeof fetch

    const router = buildRouter()
    await router.push('/admin/audit-trail')
    const wrapper = mount(AuditTrailView, { global: { plugins: [router] } })
    await flushPromises()

    // Avant click, panel diff n'est pas visible.
    expect(wrapper.find('[data-diff-panel="200"]').exists()).toBe(false)

    // Click bouton « Voir diff ».
    const diffToggle = wrapper.find('[data-diff-toggle="200"]')
    expect(diffToggle.exists()).toBe(true)
    await diffToggle.trigger('click')
    await flushPromises()

    // Panel diff visible + contient la valeur after (bp=600).
    const panel = wrapper.find('[data-diff-panel="200"]')
    expect(panel.exists()).toBe(true)
    expect(panel.text()).toContain('600')
  })

  it('AC #1 : badge actor affiche email_short PII-masked (cohérent 5.5 shortEmail)', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(200, {
        data: {
          items: [
            buildItem({
              id: 300,
              actor_operator_id: 9,
              actor_email_short: 'admin',
            }),
          ],
          nextCursor: null,
        },
      })
    ) as unknown as typeof fetch

    const router = buildRouter()
    await router.push('/admin/audit-trail')
    const wrapper = mount(AuditTrailView, { global: { plugins: [router] } })
    await flushPromises()

    // Le badge acteur affiche 'admin' (et PAS l'email complet).
    expect(wrapper.text()).toContain('admin')
    expect(wrapper.text()).not.toContain('admin@fruitstock.fr')
  })
})
