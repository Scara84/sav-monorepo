import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createWebHistory } from 'vue-router'
import SavDetailView from './SavDetailView.vue'

/**
 * Story 3.6b — tests composant édition inline lignes + bouton Valider.
 *
 * 8 scénarios TC-01..08 de l'AC #11.
 */

function makeRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/admin/sav', name: 'admin-sav-list', component: { template: '<div/>' } },
      { path: '/admin/sav/:id', name: 'admin-sav-detail', component: SavDetailView },
    ],
  })
}

interface FetchCall {
  url: string
  method: string
  body: unknown
}

function makeFetchController(detailPayload: unknown) {
  const calls: FetchCall[] = []
  const responsesByPattern: Array<{
    match: (url: string, method: string) => boolean
    response: { status: number; body: unknown }
  }> = []

  const fn = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    let body: unknown = null
    if (init?.body && typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    calls.push({ url, method, body })

    const match = responsesByPattern.find((r) => r.match(url, method))
    if (match) {
      return Promise.resolve({
        status: match.response.status,
        ok: match.response.status >= 200 && match.response.status < 300,
        json: () => Promise.resolve(match.response.body),
      } as unknown as Response)
    }
    // default : GET detail
    if (method === 'GET') {
      return Promise.resolve({
        status: 200,
        ok: true,
        json: () => Promise.resolve(detailPayload),
      } as unknown as Response)
    }
    return Promise.resolve({
      status: 500,
      ok: false,
      json: () => Promise.resolve({ error: { message: 'unexpected' } }),
    } as unknown as Response)
  })
  ;(globalThis as unknown as { fetch: unknown }).fetch = fn

  return {
    calls,
    fn,
    onceFor(
      match: (url: string, method: string) => boolean,
      response: { status: number; body: unknown }
    ) {
      responsesByPattern.push({ match, response })
    },
  }
}

async function mountDetail() {
  const router = makeRouter()
  await router.push('/admin/sav/1')
  await router.isReady()
  return mount(SavDetailView, { global: { plugins: [router] } })
}

const SETTINGS_SNAPSHOT = {
  vat_rate_default_bp: 550,
  group_manager_discount_bp: 400,
}

type LineOverride = {
  id?: number
  lineNumber?: number | null
  position?: number
  productCodeSnapshot?: string
  productNameSnapshot?: string
  qtyRequested?: number
  unitRequested?: string
  qtyInvoiced?: number | null
  unitInvoiced?: string | null
  unitPriceHtCents?: number | null
  vatRateBpSnapshot?: number | null
  creditCoefficient?: number
  creditCoefficientLabel?: string | null
  pieceToKgWeightG?: number | null
  creditAmountCents?: number | null
  validationStatus?: string
  validationMessage?: string | null
}

function line(overrides: LineOverride = {}) {
  return {
    id: 100,
    productId: null,
    lineNumber: 1,
    position: 1,
    productCodeSnapshot: 'POM-01',
    productNameSnapshot: 'Pommes',
    qtyRequested: 10,
    unitRequested: 'kg',
    qtyInvoiced: 10,
    unitInvoiced: 'kg',
    unitPriceHtCents: 250,
    vatRateBpSnapshot: 550,
    creditCoefficient: 1,
    creditCoefficientLabel: null,
    pieceToKgWeightG: null,
    creditAmountCents: 2500,
    validationStatus: 'ok',
    validationMessage: null,
    ...overrides,
  }
}

function buildPayload(overrides: { status?: string; version?: number; lines?: LineOverride[] }) {
  return {
    data: {
      sav: {
        id: 1,
        reference: 'SAV-2026-00001',
        status: overrides.status ?? 'in_progress',
        version: overrides.version ?? 1,
        groupId: null,
        invoiceRef: 'FAC-1',
        invoiceFdpCents: 0,
        totalAmountCents: 0,
        tags: [],
        assignedTo: null,
        receivedAt: '2026-03-01T00:00:00.000Z',
        takenAt: null,
        validatedAt: null,
        closedAt: null,
        cancelledAt: null,
        member: {
          id: 10,
          firstName: 'Jean',
          lastName: 'Dubois',
          email: 'j@d.com',
          isGroupManager: false,
          groupId: null,
        },
        group: null,
        assignee: null,
        lines: (overrides.lines ?? [line()]).map((l) => line(l)),
        files: [],
      },
      comments: [],
      auditTrail: [],
      settingsSnapshot: SETTINGS_SNAPSHOT,
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SavDetailView — édition inline lignes (Story 3.6b)', () => {
  beforeEach(() => {
    // Évite que window.confirm bloque les tests.
    vi.stubGlobal('confirm', () => true)
  })

  it('TC-01 : clic Éditer ligne → inputs visibles (qty, unit, prix, coef)', async () => {
    makeFetchController(buildPayload({ lines: [line({ id: 100 })] }))
    const w = await mountDetail()
    await flushPromises()

    expect(w.find('[data-testid="edit-line-100"]').exists()).toBe(true)
    await w.find('[data-testid="edit-line-100"]').trigger('click')

    expect(w.find('[data-testid="edit-qty-requested-100"]').exists()).toBe(true)
    expect(w.find('[data-testid="save-line-100"]').exists()).toBe(true)
  })

  it('TC-02 : Enter sur input → PATCH déclenché avec patch diff', async () => {
    const ctrl = makeFetchController(buildPayload({ lines: [line({ id: 100, qtyRequested: 10 })] }))
    ctrl.onceFor((url, m) => m === 'PATCH' && url.includes('/api/sav/1/lines/100'), {
      status: 200,
      body: { data: { savId: 1, lineId: 100, version: 2, validationStatus: 'ok' } },
    })
    const w = await mountDetail()
    await flushPromises()

    await w.find('[data-testid="edit-line-100"]').trigger('click')
    const input = w.find('[data-testid="edit-qty-requested-100"]')
    await input.setValue('12')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    const patchCall = ctrl.calls.find((c) => c.method === 'PATCH')
    expect(patchCall).toBeTruthy()
    expect(patchCall?.body).toMatchObject({
      qtyRequested: 12,
      version: 1,
    })
  })

  it('TC-03 : Esc sur input → annule, aucun PATCH émis', async () => {
    const ctrl = makeFetchController(buildPayload({ lines: [line({ id: 100 })] }))
    const w = await mountDetail()
    await flushPromises()

    await w.find('[data-testid="edit-line-100"]').trigger('click')
    const input = w.find('[data-testid="edit-qty-requested-100"]')
    await input.setValue('999')
    await input.trigger('keydown', { key: 'Escape' })
    await flushPromises()

    // Retour au mode lecture : pas d'input visible
    expect(w.find('[data-testid="edit-qty-requested-100"]').exists()).toBe(false)
    const patchCall = ctrl.calls.find((c) => c.method === 'PATCH')
    expect(patchCall).toBeFalsy()
  })

  it('TC-04 : ligne to_calculate en édition → champ « Poids unité (g) » visible', async () => {
    makeFetchController(
      buildPayload({
        lines: [
          line({
            id: 100,
            validationStatus: 'to_calculate',
            unitRequested: 'kg',
            unitInvoiced: 'piece',
            pieceToKgWeightG: null,
          }),
        ],
      })
    )
    const w = await mountDetail()
    await flushPromises()

    await w.find('[data-testid="edit-line-100"]').trigger('click')
    expect(w.find('[data-testid="edit-piece-to-kg-weight-g"]').exists()).toBe(true)
  })

  it('TC-05 : ligne qty_exceeds_invoice → badge avec title=validationMessage', async () => {
    makeFetchController(
      buildPayload({
        lines: [
          line({
            id: 100,
            validationStatus: 'qty_exceeds_invoice',
            validationMessage: 'Quantité demandée (10) > quantité facturée (5)',
          }),
        ],
      })
    )
    const w = await mountDetail()
    await flushPromises()

    const badge = w.find('.validation-badge')
    expect(badge.exists()).toBe(true)
    expect(badge.attributes('title')).toBe('Quantité demandée (10) > quantité facturée (5)')
    expect(badge.text()).toBe('qty_exceeds_invoice')
  })

  it('TC-06 : bouton Valider disabled si 1+ ligne non-ok', async () => {
    makeFetchController(
      buildPayload({
        lines: [line({ id: 100 }), line({ id: 101, validationStatus: 'unit_mismatch' })],
      })
    )
    const w = await mountDetail()
    await flushPromises()

    const btn = w.find('[data-testid="sav-validate-btn"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('disabled')).toBeDefined()
  })

  it('TC-07 : bouton Valider enabled si toutes lignes ok + status in_progress → clic → PATCH /status', async () => {
    const ctrl = makeFetchController(
      buildPayload({ lines: [line({ id: 100 }), line({ id: 101 })] })
    )
    ctrl.onceFor((url, m) => m === 'PATCH' && url.includes('/api/sav/1/status'), {
      status: 200,
      body: { data: { savId: 1, status: 'validated', version: 2 } },
    })

    const w = await mountDetail()
    await flushPromises()

    const btn = w.find('[data-testid="sav-validate-btn"]')
    expect(btn.attributes('disabled')).toBeUndefined()
    await btn.trigger('click')
    await flushPromises()

    const patchStatusCall = ctrl.calls.find(
      (c) => c.method === 'PATCH' && c.url.includes('/api/sav/1/status')
    )
    expect(patchStatusCall).toBeTruthy()
    expect(patchStatusCall?.body).toMatchObject({ status: 'validated', version: 1 })
  })

  it('TC-08 : 409 VERSION_CONFLICT au save ligne → toast + refresh auto', async () => {
    const ctrl = makeFetchController(buildPayload({ lines: [line({ id: 100 })] }))
    ctrl.onceFor((url, m) => m === 'PATCH' && url.includes('/api/sav/1/lines/100'), {
      status: 409,
      body: {
        error: {
          code: 'CONFLICT',
          message: 'Version périmée',
          details: { code: 'VERSION_CONFLICT', currentVersion: 5 },
        },
      },
    })

    const w = await mountDetail()
    await flushPromises()

    await w.find('[data-testid="edit-line-100"]').trigger('click')
    const input = w.find('[data-testid="edit-qty-requested-100"]')
    await input.setValue('15')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    const toast = w.find('[data-testid="sav-toast"]')
    expect(toast.exists()).toBe(true)
    expect(toast.text()).toContain('Rechargez')

    // Refresh auto : au moins un 2e GET /api/sav/1
    const detailGets = ctrl.calls.filter((c) => c.method === 'GET' && c.url.includes('/api/sav/1'))
    expect(detailGets.length).toBeGreaterThanOrEqual(2)
  })

  it('TC-09 : clic Supprimer → DELETE appelé + refresh', async () => {
    const ctrl = makeFetchController(buildPayload({ lines: [line({ id: 100 })] }))
    ctrl.onceFor((url, m) => m === 'DELETE' && url.includes('/api/sav/1/lines/100'), {
      status: 200,
      body: { data: { savId: 1, version: 2 } },
    })

    const w = await mountDetail()
    await flushPromises()

    await w.find('[data-testid="delete-line-100"]').trigger('click')
    await flushPromises()

    const deleteCall = ctrl.calls.find(
      (c) => c.method === 'DELETE' && c.url.includes('/api/sav/1/lines/100')
    )
    expect(deleteCall).toBeTruthy()
    expect(deleteCall?.body).toMatchObject({ version: 1 })
  })

  it('TC-10 : bouton Ajouter ligne → modal ouvert + submit → POST', async () => {
    const ctrl = makeFetchController(buildPayload({ lines: [line({ id: 100 })] }))
    ctrl.onceFor((url, m) => m === 'POST' && url.includes('/api/sav/1/lines'), {
      status: 201,
      body: { data: { savId: 1, lineId: 200, version: 2, validationStatus: 'ok' } },
    })

    const w = await mountDetail()
    await flushPromises()

    await w.find('[data-testid="sav-add-line-btn"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="add-line-dialog"]').exists()).toBe(true)

    // Remplir et soumettre (trigger sur le form, pas sur le bouton — jsdom-safe)
    await w.find('#add-line-code').setValue('P-NEW')
    await w.find('#add-line-name').setValue('Nouveau produit')
    await w.find('#add-line-qty').setValue('3')
    await w.find('[data-testid="add-line-dialog"] form').trigger('submit.prevent')
    await flushPromises()

    const postCall = ctrl.calls.find(
      (c) => c.method === 'POST' && c.url.includes('/api/sav/1/lines')
    )
    expect(postCall).toBeTruthy()
    expect(postCall?.body).toMatchObject({
      productCodeSnapshot: 'P-NEW',
      productNameSnapshot: 'Nouveau produit',
      qtyRequested: 3,
      unitRequested: 'kg',
      version: 1,
    })
  })
})
