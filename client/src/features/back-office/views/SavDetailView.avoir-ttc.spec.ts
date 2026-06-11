/**
 * Story V1.11 AC#5 — colonne « Avoir TTC » dans la table « Lignes du SAV »
 * de SavDetailView.
 *
 * RED PHASE (TDD) — tests `it(...)` jusqu'à activation par
 * l'implémenteur. Une fois activés, ils DOIVENT échouer contre le code
 * actuel (`<th>Avoir</th>`, cellule = `formatEur(l.creditAmountCents)` HT).
 *
 * Pattern : mount réel SavDetailView + mock fetch (calque
 * `SavDetailView.preview.test.ts` story 4.3). Aucun mock du composable
 * `useSavLinePreview` (la story porte sur le rendu d'une cellule existante,
 * pas sur la logique de preview).
 *
 * Discriminant anti-régression (AC#7) :
 *   ligne HT=2500 cents (25,00 €) + TVA 5,5% → cellule Avoir TTC=26,38 €
 *   (2500 × 1.055 = 2637.5 → 2638 cents half-up).
 *   Si la cellule affichait HT, l'assertion `26,38` échouerait.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createWebHistory } from 'vue-router'
import SavDetailView from './SavDetailView.vue'

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
  await router.push('/admin/sav/1')
  await router.isReady()
  return mount(SavDetailView, { global: { plugins: [router] } })
}

const SETTINGS_SNAPSHOT = {
  vat_rate_default_bp: 550,
  group_manager_discount_bp: 400,
}

type FixtureLine = {
  id: number
  productCodeSnapshot: string
  productNameSnapshot: string
  qtyRequested: number
  unitRequested: string
  qtyInvoiced: number | null
  unitInvoiced: string | null
  unitPriceTtcCents: number | null
  vatRateBpSnapshot: number | null
  creditCoefficient: number
  creditAmountCents: number | null
  validationStatus: string
  validationMessage: string | null
}

function buildPayload(lines: FixtureLine[]) {
  return {
    data: {
      sav: {
        id: 1,
        reference: 'SAV-2026-00001',
        status: 'in_progress',
        version: 1,
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
        lines: lines.map((l) => ({
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

const OK_LINE_HT_2500_TVA_550: FixtureLine = {
  id: 100,
  productCodeSnapshot: 'POM-01',
  productNameSnapshot: 'Pommes',
  qtyRequested: 10,
  unitRequested: 'kg',
  qtyInvoiced: 10,
  unitInvoiced: 'kg',
  unitPriceTtcCents: 250,
  vatRateBpSnapshot: 550, // TVA 5,5 %
  creditCoefficient: 1,
  creditAmountCents: 2500, // HT — discriminant : TTC attendu = 2638 cents
  validationStatus: 'ok',
  validationMessage: null,
}

const NULL_VAT_LINE: FixtureLine = {
  ...OK_LINE_HT_2500_TVA_550,
  id: 101,
  vatRateBpSnapshot: null,
}

const NULL_CREDIT_LINE: FixtureLine = {
  ...OK_LINE_HT_2500_TVA_550,
  id: 102,
  creditAmountCents: null,
}

afterEach(() => {
  vi.restoreAllMocks()
})

beforeEach(() => {
  mockFetch(buildPayload([OK_LINE_HT_2500_TVA_550]))
})

describe('V1.11 AC#5 — SavDetailView colonne Avoir TTC', () => {
  it('le <th> de la colonne avoir affiche `Avoir TTC` (et non `Avoir`)', async () => {
    const w = await mountDetail()
    await flushPromises()
    const headers = w.findAll('.lines-table thead th').map((th) => th.text())
    expect(headers).toContain('Avoir TTC')
    expect(headers).not.toContain('Avoir')
  })

  it('la cellule Avoir affiche le TTC (HT=2500 + TVA 5,5% → 26,38 €) — discriminant W16', async () => {
    const w = await mountDetail()
    await flushPromises()
    // La ligne 100 a sav-line-100 comme id, on cible le <tbody> arbitrage row
    const row = w.find('#sav-line-100')
    expect(row.exists()).toBe(true)
    const html = row.html()
    // Cellule Avoir TTC = 26,38 € (vue mountée → HTML brut où l'espace
    // insécable U+00A0 est encodé en entité `&nbsp;`).
    expect(html).toMatch(/26,38(?:&nbsp;|[\s  ])*€/)
    // Discriminant anti-faux-vert : la valeur HT brute (25,00 €) ne doit
    // PAS apparaître seule dans la colonne Avoir.
    expect(html).not.toMatch(/Avoir[\s\S]{0,200}25,00(?:&nbsp;|[\s  ])*€[\s\S]{0,50}<\/td>/)
  })

  it('vatRateBpSnapshot=null → cellule Avoir = `—` (pattern ghost line)', async () => {
    mockFetch(buildPayload([NULL_VAT_LINE]))
    const w = await mountDetail()
    await flushPromises()
    const row = w.find('#sav-line-101')
    expect(row.exists()).toBe(true)
    // La cellule Avoir doit contenir `—` quand on ne peut pas calculer le TTC
    expect(row.html()).toContain('—')
  })

  it('creditAmountCents=null → cellule Avoir = `—` (cohérence avec PDF ghost line)', async () => {
    mockFetch(buildPayload([NULL_CREDIT_LINE]))
    const w = await mountDetail()
    await flushPromises()
    const row = w.find('#sav-line-102')
    expect(row.exists()).toBe(true)
    expect(row.html()).toContain('—')
  })

  it('boundary half-up exact (CR M1) : HT=1900 + TVA 5,5% → 20,05 €', async () => {
    // Discriminant formule entière (CR M1) — la formule flottante naïve
    // `Math.round(1900 * (1 + 550/10000))` renvoyait 2004 (= 20,04 €) à
    // cause de 2004.4999... ; la formule entière renvoie 2005 (= 20,05 €).
    const line: FixtureLine = {
      ...OK_LINE_HT_2500_TVA_550,
      id: 104,
      creditAmountCents: 1900,
      vatRateBpSnapshot: 550,
    }
    mockFetch(buildPayload([line]))
    const w = await mountDetail()
    await flushPromises()
    const row = w.find('#sav-line-104')
    expect(row.exists()).toBe(true)
    expect(row.html()).toMatch(/20,05(?:&nbsp;|[\s  ])*€/)
    // Anti-régression float : 20,04 € NE doit PAS apparaître dans la ligne
    expect(row.html()).not.toMatch(/20,04(?:&nbsp;|[\s  ])*€/)
  })

  it('vatRateBpSnapshot=0 → cellule Avoir TTC = HT (TVA neutre, pas `—`)', async () => {
    const line: FixtureLine = { ...OK_LINE_HT_2500_TVA_550, id: 103, vatRateBpSnapshot: 0 }
    mockFetch(buildPayload([line]))
    const w = await mountDetail()
    await flushPromises()
    const row = w.find('#sav-line-103')
    expect(row.exists()).toBe(true)
    expect(row.html()).toMatch(/25,00(?:&nbsp;|[\s  ])*€/)
  })
})
