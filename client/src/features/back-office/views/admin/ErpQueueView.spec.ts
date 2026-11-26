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
 * Story 7-5 AC #5 + #6 — RED-PHASE smoke UI tests pour ErpQueueView.
 *
 * Couverture (2 cas) :
 *   1. Mode (a) D-10 feature-flag : 503 ERP_QUEUE_NOT_PROVISIONED →
 *      placeholder banner « File ERP non provisionnée » + lien doc Story 7-1.
 *      Aucune erreur console (404 silencieux côté UX).
 *   2. Mode (b) D-10 actif : table pushes failed + bouton « Retenter » par
 *      ligne failed.
 *
 * RED tant que :
 *   - ErpQueueView.vue n'existe pas
 *   - Composable useAdminErpQueue.ts n'existe pas (gère 503 → featureAvailable=false)
 */

import ErpQueueView from './ErpQueueView.vue'

function buildRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div></div>' } },
      { path: '/admin/erp-queue', name: 'admin-erp-queue', component: ErpQueueView },
    ],
  })
}

describe('ErpQueueView (UI smoke — Story 7-5 D-10 feature-flag)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('AC #5 D-10 mode (a) : 503 ERP_QUEUE_NOT_PROVISIONED → placeholder banner visible', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(503, {
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message:
            "La file ERP n'est pas encore provisionnée — Story 7-1 en attente du contrat ERP Fruitstock",
          details: { code: 'ERP_QUEUE_NOT_PROVISIONED' },
        },
      })
    ) as unknown as typeof fetch

    const router = buildRouter()
    await router.push('/admin/erp-queue')
    const wrapper = mount(ErpQueueView, { global: { plugins: [router] } })
    await flushPromises()

    // Le banner placeholder D-10 doit être visible.
    expect(wrapper.text()).toContain('File ERP')
    // Le banner mentionne la Story 7-1 OU le mot "provisionnée".
    expect(wrapper.text().toLowerCase()).toMatch(/provisionn[ée]e|story 7-1/)
    // Le bouton Retenter ne doit PAS apparaître en mode (a).
    expect(wrapper.find('[data-retry-push]').exists()).toBe(false)
    // La table de pushes ne doit pas être affichée (rien à montrer).
    expect(wrapper.findAll('table tbody tr').length).toBe(0)
  })

  it('AC #5 D-10 mode (b) : table pushes failed + bouton "Retenter" par ligne', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(200, {
        data: {
          items: [
            {
              id: 901,
              sav_id: 1,
              sav_reference: 'SAV-2026-0001',
              status: 'failed',
              attempts: 3,
              last_error: 'timeout: ERP /push 504',
              last_attempt_at: '2026-04-30T08:00:00Z',
              next_retry_at: null,
              scheduled_at: '2026-04-30T07:00:00Z',
              created_at: '2026-04-30T06:00:00Z',
              updated_at: '2026-04-30T08:00:00Z',
            },
            {
              id: 902,
              sav_id: 2,
              sav_reference: 'SAV-2026-0002',
              status: 'failed',
              attempts: 5,
              last_error: 'invalid_signature',
              last_attempt_at: '2026-04-30T09:00:00Z',
              next_retry_at: null,
              scheduled_at: '2026-04-30T07:30:00Z',
              created_at: '2026-04-30T06:30:00Z',
              updated_at: '2026-04-30T09:00:00Z',
            },
          ],
          nextCursor: null,
        },
      })
    ) as unknown as typeof fetch

    const router = buildRouter()
    await router.push('/admin/erp-queue')
    const wrapper = mount(ErpQueueView, { global: { plugins: [router] } })
    await flushPromises()

    // Pas de banner placeholder en mode (b).
    expect(wrapper.text().toLowerCase()).not.toContain('non provisionnée')

    // Table avec 2 lignes failed.
    const rows = wrapper.findAll('table tbody tr')
    expect(rows.length).toBeGreaterThanOrEqual(2)

    // Bouton Retenter présent par ligne failed (data-attribute discoverable).
    const retryButtons = wrapper.findAll('[data-retry-push]')
    expect(retryButtons.length).toBeGreaterThanOrEqual(2)

    // Le payload n'est PAS exposé dans le DOM (defense-in-depth privacy D-10).
    expect(wrapper.text()).not.toContain('signature')
    expect(wrapper.text()).not.toContain('idempotency_key')
  })
  it('relit la file après un non-provisionnement et distingue panne, vide et échec', async () => {
    const requests: string[] = []
    const failed = {
      id: 12,
      sav_id: 3,
      sav_reference: 'SAV-TEMOIN',
      status: 'failed',
      attempts: 4,
      last_error: null,
    }
    const responses = [
      jsonResponse(503, { error: { details: { code: 'ERP_QUEUE_NOT_PROVISIONED' } } }),
      jsonResponse(503, { error: { message: 'Service indisponible' } }),
      jsonResponse(200, { data: { items: [] } }),
      jsonResponse(200, { data: { items: [failed] } }),
      jsonResponse(500, { error: { message: 'Relance refusée' } }),
      jsonResponse(200, { data: {} }),
    ]
    globalThis.fetch = async (input, init) => {
      requests.push((init?.method ?? 'GET') + ' ' + String(input))
      return responses.shift()!
    }
    const wrapper = mount(ErpQueueView)
    await flushPromises()
    expect(wrapper.get('.banner-placeholder').text()).toContain('non provisionnée')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Service indisponible')
    expect(wrapper.find('.banner-placeholder').exists()).toBe(false)
    await wrapper.get('#filter-status').setValue('pending')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(requests.at(-1)).toContain('status=pending')
    expect(wrapper.get('.filter-summary').text()).toContain('En attente')
    expect(wrapper.text()).toContain('Aucune synchronisation')
    await wrapper.get('#filter-status').setValue('failed')
    expect(wrapper.get('.filter-summary').text()).toContain('En attente')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('tbody tr').text()).toContain('SAV-TEMOIN')
    expect(wrapper.get('tbody tr').findAll('td')[2]!.text()).toBe('4')
    expect(requests.every((req) => req.startsWith('GET '))).toBe(true)
    await wrapper.get('[data-retry-push]').trigger('click')
    await flushPromises()
    expect(wrapper.get('.toast.error').text()).toContain('Relance refusée')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    await wrapper.get('[data-retry-push]').trigger('click')
    await flushPromises()
    expect(wrapper.get('.toast.success [role="status"]').text()).toContain('replanifiée')
    await wrapper.get('.toast button').trigger('click')
    expect(wrapper.find('.toast').exists()).toBe(false)
    expect(requests.filter((req) => req.startsWith('POST '))).toEqual(
      Array(2).fill('POST /api/admin/erp-queue/12/retry')
    )
    wrapper.unmount()
  })
  it.each([{}, { data: { items: {} } }])('signale un contenu de file incomplet', async (body) => {
    globalThis.fetch = async () => jsonResponse(200, body)
    const wrapper = mount(ErpQueueView)
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Réponse ERP incomplète')
    expect(wrapper.text()).not.toContain('Aucune synchronisation')
  })
})
