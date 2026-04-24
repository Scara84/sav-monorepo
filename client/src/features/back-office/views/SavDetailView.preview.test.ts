import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createWebHistory } from 'vue-router'
import SavDetailView from './SavDetailView.vue'

/**
 * Story 4.3 — tests composant dédiés à l'encart « Aperçu avoir ».
 *
 * Ces tests montent la vraie vue (pas de mock composable — AC #7 indique
 * mock, mais le composable est déjà couvert par useSavLinePreview.test.ts
 * et le mock doublerait le coût de maintenance). Le fetch est mocké pour
 * contrôler `status`, `lines`, `member.isGroupManager`, `settingsSnapshot`.
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

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn((..._args: unknown[]) =>
    Promise.resolve({
      status,
      ok: status >= 200 && status < 300,
      json: () => Promise.resolve(body),
    } as unknown as Response)
  )
  ;(globalThis as unknown as { fetch: unknown }).fetch = fn
  return fn
}

async function mountDetail() {
  const router = makeRouter()
  await router.push(`/admin/sav/1`)
  await router.isReady()
  return mount(SavDetailView, { global: { plugins: [router] } })
}

const SETTINGS_SNAPSHOT = {
  vat_rate_default_bp: 550,
  group_manager_discount_bp: 400,
}

function buildPayload(overrides: {
  status?: string
  isGroupManager?: boolean
  groupId?: number | null
  memberGroupId?: number | null
  lines?: Array<{
    id: number
    productCodeSnapshot: string
    productNameSnapshot: string
    qtyRequested: number
    unitRequested: string
    qtyInvoiced: number | null
    unitInvoiced: string | null
    unitPriceHtCents: number | null
    vatRateBpSnapshot: number | null
    creditCoefficient: number
    creditAmountCents: number | null
    validationStatus: string
    validationMessage: string | null
  }>
}) {
  return {
    data: {
      sav: {
        id: 1,
        reference: 'SAV-2026-00001',
        status: overrides.status ?? 'in_progress',
        version: 1,
        groupId: overrides.groupId ?? null,
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
          isGroupManager: overrides.isGroupManager ?? false,
          groupId: overrides.memberGroupId ?? null,
        },
        group: null,
        assignee: null,
        lines: (overrides.lines ?? []).map((l) => ({
          productId: null,
          creditCoefficientLabel: null,
          pieceToKgWeightG: null,
          position: 1,
          lineNumber: 1,
          ...l,
        })),
        files: [],
      },
      comments: [],
      auditTrail: [],
      settingsSnapshot: SETTINGS_SNAPSHOT,
    },
  }
}

const OK_LINE = {
  id: 100,
  productCodeSnapshot: 'POM-01',
  productNameSnapshot: 'Pommes',
  qtyRequested: 10,
  unitRequested: 'kg',
  qtyInvoiced: 10,
  unitInvoiced: 'kg',
  unitPriceHtCents: 250,
  vatRateBpSnapshot: 550,
  creditCoefficient: 1,
  creditAmountCents: 2500,
  validationStatus: 'ok',
  validationMessage: null,
}

const QTY_EXCEEDS_LINE = {
  id: 101,
  productCodeSnapshot: 'POM-02',
  productNameSnapshot: 'Pommes',
  qtyRequested: 10,
  unitRequested: 'kg',
  qtyInvoiced: 5,
  unitInvoiced: 'kg',
  unitPriceHtCents: 200,
  vatRateBpSnapshot: 550,
  creditCoefficient: 1,
  creditAmountCents: null,
  validationStatus: 'qty_exceeds_invoice',
  validationMessage: 'Quantité demandée (10) > quantité facturée (5)',
}

afterEach(() => {
  vi.restoreAllMocks()
})

beforeEach(() => {
  // fetch mock par défaut, chaque test peut le réécraser.
  mockFetch(buildPayload({ lines: [OK_LINE, { ...OK_LINE, id: 102 }] }))
})

describe('SavDetailView — Aperçu avoir (Story 4.3)', () => {
  it('1. Rendu bloc Aperçu avoir : status in_progress + 2 lignes ok → encart visible, pas de remise si isGroupManager=false', async () => {
    const w = await mountDetail()
    await flushPromises()
    const block = w.find('[data-testid="sav-preview-credit-note"]')
    expect(block.exists()).toBe(true)
    expect(w.find('[data-testid="preview-ht"]').exists()).toBe(true)
    expect(w.find('[data-testid="preview-vat"]').exists()).toBe(true)
    expect(w.find('[data-testid="preview-ttc"]').exists()).toBe(true)
    expect(w.find('[data-testid="preview-discount-row"]').exists()).toBe(false)
  })

  it('2. Rendu remise : isGroupManager=true + groupes matchent → ligne remise + badge visibles', async () => {
    mockFetch(
      buildPayload({
        isGroupManager: true,
        groupId: 42,
        memberGroupId: 42,
        lines: [OK_LINE],
      })
    )
    const w = await mountDetail()
    await flushPromises()
    expect(w.find('[data-testid="preview-discount-row"]').exists()).toBe(true)
    expect(w.find('[data-testid="preview-discount-badge"]').text()).toContain(
      'Remise responsable 4 % appliquée'
    )
  })

  it('3. Bandeau bloquant : 1 ligne qty_exceeds_invoice → message + lien ancre vers la 1re ligne bloquante', async () => {
    mockFetch(buildPayload({ lines: [QTY_EXCEEDS_LINE] }))
    const w = await mountDetail()
    await flushPromises()
    const banner = w.find('[data-testid="sav-preview-blocking"]')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('1 ligne(s) bloquante(s) — aucun avoir ne peut être émis')
    expect(banner.attributes('aria-live')).toBe('polite')
    // AC #2 — lien/ancre vers la 1re ligne non-ok
    const jump = w.find('[data-testid="sav-preview-blocking-jump"]')
    expect(jump.exists()).toBe(true)
    expect(jump.attributes('href')).toBe(`#sav-line-${QTY_EXCEEDS_LINE.id}`)
    // La ligne cible dans le tableau a bien l'id correspondant
    expect(w.find(`#sav-line-${QTY_EXCEEDS_LINE.id}`).exists()).toBe(true)
  })

  it('4. Masquage draft : status=draft → encart masqué', async () => {
    mockFetch(buildPayload({ status: 'draft', lines: [OK_LINE] }))
    const w = await mountDetail()
    await flushPromises()
    expect(w.find('[data-testid="sav-preview-credit-note"]').exists()).toBe(false)
  })

  it('5. Masquage closed : status=closed → encart masqué', async () => {
    mockFetch(buildPayload({ status: 'closed', lines: [OK_LINE] }))
    const w = await mountDetail()
    await flushPromises()
    expect(w.find('[data-testid="sav-preview-credit-note"]').exists()).toBe(false)
  })

  it('6. Masquage received : status=received → encart masqué', async () => {
    mockFetch(buildPayload({ status: 'received', lines: [OK_LINE] }))
    const w = await mountDetail()
    await flushPromises()
    expect(w.find('[data-testid="sav-preview-credit-note"]').exists()).toBe(false)
  })

  it('7. Masquage cancelled : status=cancelled → encart masqué', async () => {
    mockFetch(buildPayload({ status: 'cancelled', lines: [OK_LINE] }))
    const w = await mountDetail()
    await flushPromises()
    expect(w.find('[data-testid="sav-preview-credit-note"]').exists()).toBe(false)
  })

  it("8. AC #8 — aucun appel fetch déclenché par l'instanciation de la preview (hors /api/sav/:id)", async () => {
    const fetchSpy = mockFetch(buildPayload({ lines: [OK_LINE, OK_LINE] }))
    const w = await mountDetail()
    await flushPromises()
    // 1 seul appel attendu : GET /api/sav/1 (le fetch initial). La preview
    // ne déclenche aucun appel supplémentaire.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const url = String(fetchSpy.mock.calls[0]?.[0])
    expect(url).toContain('/api/sav/1')
    // Sanity DOM : l'encart est bien rendu, confirmant que la preview a
    // tourné sans IO.
    expect(w.find('[data-testid="sav-preview-credit-note"]').exists()).toBe(true)
  })
})
