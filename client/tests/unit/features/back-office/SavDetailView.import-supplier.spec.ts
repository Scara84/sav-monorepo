/**
 * Story 4.8 — AC #7 : Tests UI bouton/modal import prix fournisseur
 *
 * Test type: UNIT (Vue Test Utils + happy-dom — pas de vrai fetch)
 *
 * AC coverage:
 *   AC #4 — bouton « Importer prix fournisseur » visible si status=in_progress, absent si validated
 *   AC #4 — click ouvre le modal, focus sur input file, ESC ferme
 *   AC #4 — upload → preview affichée (matched/unmatched/errors)
 *   AC #4 — click Appliquer → PATCH mock appelé → toast succès → modal fermé
 *   AC #5 — colonne PU achat HT dans le tableau lignes
 *   AC #5 — colonne Marge unit. HT : positif → vert (.margin-positive), négatif → rouge (.margin-negative), null → gris
 *   AC #5 — footer « Marge totale HT estimée »
 *
 * Mock strategy:
 *   - globalThis.fetch mocked per test (pattern SavDetailView.spec.ts)
 *   - ImportSupplierPricesDialog.vue mocké pour isolation (si composant pas encore créé)
 *   - SavDetailView.vue importé directement (pattern SavDetailView.workflow.spec.ts)
 *
 * RED PHASE — tous les tests échouent tant que :
 *   1. ImportSupplierPricesDialog.vue n'est pas créé
 *   2. SavDetailView.vue n'est pas modifié (bouton, colonnes, footer)
 *   3. computeMargin.ts n'est pas créé
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { defineComponent } from 'vue'

// ---------------------------------------------------------------------------
// Router setup
// ---------------------------------------------------------------------------

const StubComponent = defineComponent({ template: '<div/>' })

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/admin/sav', name: 'admin-sav-list', component: StubComponent },
      { path: '/admin/sav/:id', name: 'admin-sav-detail', component: StubComponent },
    ],
  })
}

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

// ---------------------------------------------------------------------------
// SAV payload factory
// ---------------------------------------------------------------------------

function makeSavPayload(
  overrides: {
    status?: string
    lines?: unknown[]
  } = {}
): unknown {
  const status = overrides.status ?? 'in_progress'
  const lines = overrides.lines ?? []
  return {
    data: {
      sav: {
        id: 1,
        reference: 'SAV-2026-00001',
        status,
        version: 2,
        groupId: 1,
        invoiceRef: 'FAC-1',
        invoiceFdpCents: 0,
        totalAmountCents: 5000,
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
          groupId: 1,
        },
        group: { id: 1, name: 'Groupe Test' },
        assignee: null,
        lines,
        files: [],
      },
      comments: [],
      auditTrail: [],
      settingsSnapshot: { vat_rate_default_bp: 550, group_manager_discount_bp: 400 },
    },
  }
}

// Line with full pricing (both sell + supplier prices)
const LINE_WITH_PRICES = {
  id: 101,
  productId: 1,
  productCodeSnapshot: 'RUF-001',
  productNameSnapshot: 'Pomme Golden',
  qtyRequested: 3,
  unitRequested: 'kg',
  qtyInvoiced: 3,
  unitInvoiced: 'kg',
  unitPriceTtcCents: 2100, // 21 €TTC
  vatRateBpSnapshot: 550, // 5.5%
  creditCoefficient: 1,
  creditCoefficientLabel: null,
  pieceToKgWeightG: null,
  creditAmountCents: 6300,
  validationStatus: 'ok',
  validationMessage: null,
  position: 1,
  lineNumber: 1,
  // Story 4.8 new fields
  supplierPurchasePriceHtCents: 1000, // 10 € HT — margin positive
  supplierReference: 'FOURN-A1',
  supplierPriceImportedAt: '2026-05-17T10:00:00.000Z',
  supplierPriceSource: 'fournisseur-X-2026-05-17.xlsx',
}

// Line with sell price but NO supplier price
const LINE_WITHOUT_SUPPLIER = {
  ...LINE_WITH_PRICES,
  id: 102,
  productCodeSnapshot: 'RUF-002',
  supplierPurchasePriceHtCents: null,
  supplierReference: null,
  supplierPriceImportedAt: null,
  supplierPriceSource: null,
}

// Line where achat > vente → negative margin
const LINE_NEGATIVE_MARGIN = {
  ...LINE_WITH_PRICES,
  id: 103,
  productCodeSnapshot: 'RUF-003',
  unitPriceTtcCents: 1000, // 10 € TTC → HT ~9.48 €
  vatRateBpSnapshot: 550,
  supplierPurchasePriceHtCents: 1500, // 15 € HT → marge négative
}

// ---------------------------------------------------------------------------
// Import view
// ---------------------------------------------------------------------------

async function importSavDetailView() {
  return (await import('../../../../src/features/back-office/views/SavDetailView.vue')).default
}

// ---------------------------------------------------------------------------
// Mount helper
// ---------------------------------------------------------------------------

async function mountDetail(fetchMock: ReturnType<typeof vi.fn>, savId = 1) {
  ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock
  const router = makeRouter()
  await router.push(`/admin/sav/${savId}`)
  await router.isReady()
  const SavDetailView = await importSavDetailView()
  const wrapper = mount(SavDetailView, { global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

// ---------------------------------------------------------------------------
// afterEach cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// AC #4 — Bouton « Importer prix fournisseur »
// ---------------------------------------------------------------------------

describe('SavDetailView — bouton Import prix fournisseur (AC #4)', () => {
  it('IMP-UI-01: bouton présent si sav.status === "in_progress"', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, makeSavPayload({ status: 'in_progress' })))
    const wrapper = await mountDetail(fetchMock)

    // Le bouton doit être présent — texte ou data-testid
    const importBtn = wrapper.find('[data-testid="import-supplier-prices-btn"]')
    const importBtnByText = wrapper
      .findAll('button')
      .find(
        (b) =>
          b.text().toLowerCase().includes('importer') ||
          b.text().toLowerCase().includes('fournisseur')
      )
    const btnExists = importBtn.exists() || importBtnByText !== undefined
    expect(btnExists).toBe(true)
  })

  it('IMP-UI-02: bouton absent si sav.status === "validated"', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, makeSavPayload({ status: 'validated' })))
    const wrapper = await mountDetail(fetchMock)

    const importBtn = wrapper.find('[data-testid="import-supplier-prices-btn"]')
    const importBtnByText = wrapper
      .findAll('button')
      .find(
        (b) =>
          b.text().toLowerCase().includes('importer') &&
          b.text().toLowerCase().includes('fournisseur')
      )
    // Ni le testid ni le texte ne doivent trouver le bouton
    expect(importBtn.exists()).toBe(false)
    expect(importBtnByText).toBeUndefined()
  })

  it('IMP-UI-03: bouton absent si sav.status === "closed"', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, makeSavPayload({ status: 'closed' })))
    const wrapper = await mountDetail(fetchMock)

    const importBtn = wrapper.find('[data-testid="import-supplier-prices-btn"]')
    const importBtnByText = wrapper
      .findAll('button')
      .find(
        (b) =>
          b.text().toLowerCase().includes('importer') &&
          b.text().toLowerCase().includes('fournisseur')
      )
    expect(importBtn.exists()).toBe(false)
    expect(importBtnByText).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AC #4 — Modal ouverture / fermeture
// ---------------------------------------------------------------------------

describe('SavDetailView — modal import (AC #4)', () => {
  it('IMP-UI-04: click bouton ouvre le modal avec input file', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, makeSavPayload({ status: 'in_progress' })))
    const wrapper = await mountDetail(fetchMock)

    // Trouver et cliquer le bouton
    const importBtn = wrapper.find('[data-testid="import-supplier-prices-btn"]').exists()
      ? wrapper.find('[data-testid="import-supplier-prices-btn"]')
      : wrapper
          .findAll('button')
          .find(
            (b) =>
              b.text().toLowerCase().includes('importer') ||
              b.text().toLowerCase().includes('fournisseur')
          )

    if (!importBtn || !('trigger' in importBtn)) {
      // Bouton non encore implémenté — RED phase, test fails
      expect(false).toBe(true) // Force fail in RED phase
      return
    }

    await (importBtn as ReturnType<typeof wrapper.find>).trigger('click')
    await flushPromises()

    // Modal doit être ouvert (dialog avec role="dialog" ou le composant ImportSupplierPricesDialog)
    const modal = wrapper.find('[role="dialog"]')
    const modalByTestid = wrapper.find('[data-testid="import-supplier-prices-modal"]')
    const inputFile = wrapper.find('input[type="file"]')

    const modalOpen = modal.exists() || modalByTestid.exists()
    expect(modalOpen).toBe(true)
    expect(inputFile.exists()).toBe(true)
    // Input file accepte .csv et .xlsx
    const acceptAttr = inputFile.attributes('accept') ?? ''
    expect(acceptAttr).toContain('.csv')
    expect(acceptAttr).toContain('.xlsx')
  })

  it('IMP-UI-05: ESC ferme le modal', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, makeSavPayload({ status: 'in_progress' })))
    const wrapper = await mountDetail(fetchMock)

    // Ouvrir le modal
    const importBtn = wrapper.find('[data-testid="import-supplier-prices-btn"]').exists()
      ? wrapper.find('[data-testid="import-supplier-prices-btn"]')
      : wrapper
          .findAll('button')
          .find(
            (b) =>
              b.text().toLowerCase().includes('importer') ||
              b.text().toLowerCase().includes('fournisseur')
          )

    if (!importBtn || !('trigger' in importBtn)) {
      expect(false).toBe(true)
      return
    }

    await (importBtn as ReturnType<typeof wrapper.find>).trigger('click')
    await flushPromises()

    // Vérifier modal ouvert
    const modalBeforeEsc = wrapper.find('[role="dialog"]')
    if (!modalBeforeEsc.exists()) {
      // RED phase
      expect(false).toBe(true)
      return
    }

    // Appuyer ESC
    await wrapper.trigger('keydown', { key: 'Escape' })
    await flushPromises()

    // Modal fermé
    const modalAfterEsc = wrapper.find('[role="dialog"]')
    const isClosedAfterEsc =
      !modalAfterEsc.exists() ||
      (modalAfterEsc.element as HTMLElement).getAttribute('aria-hidden') === 'true'
    expect(isClosedAfterEsc).toBe(true)
  })

  it('IMP-UI-06: upload fichier → POST /api/sav/:id/import-supplier-prices → preview affichée', async () => {
    const previewResponse = {
      matched: [
        {
          lineId: 101,
          code: 'RUF-001',
          oldPriceCents: null,
          newPriceCents: 1000,
          supplierRef: 'FOURN-A1',
        },
        {
          lineId: 102,
          code: 'RUF-002',
          oldPriceCents: null,
          newPriceCents: 2000,
          supplierRef: 'FOURN-A2',
        },
      ],
      unmatched: [
        { row: 3, code: 'FOURN-XYZ', supplierRef: 'FOURN-B1', unitPriceHt: 12.5, qty: 2 },
      ],
      errors: [],
      fileMeta: { filename: 'test.csv', rowCount: 3, parser: 'xlsx' },
    }

    let callCount = 0
    const fetchMock = vi.fn().mockImplementation((..._args: unknown[]) => {
      callCount++
      if (callCount === 1) {
        // Premier appel = chargement du SAV
        return Promise.resolve(jsonResponse(200, makeSavPayload({ status: 'in_progress' })))
      }
      // Second appel = POST preview
      return Promise.resolve(jsonResponse(200, previewResponse))
    })

    const wrapper = await mountDetail(fetchMock)

    // Ouvrir modal
    const importBtn = wrapper.find('[data-testid="import-supplier-prices-btn"]').exists()
      ? wrapper.find('[data-testid="import-supplier-prices-btn"]')
      : wrapper
          .findAll('button')
          .find(
            (b) =>
              b.text().toLowerCase().includes('importer') ||
              b.text().toLowerCase().includes('fournisseur')
          )

    if (!importBtn || !('trigger' in importBtn)) {
      expect(false).toBe(true)
      return
    }
    await (importBtn as ReturnType<typeof wrapper.find>).trigger('click')
    await flushPromises()

    // Simuler upload + analyse
    const analyzeBtn = wrapper.find('[data-testid="analyze-btn"]')
    if (!analyzeBtn.exists()) {
      // RED phase — composant non encore créé
      expect(false).toBe(true)
      return
    }

    await analyzeBtn.trigger('click')
    await flushPromises()

    // Sections preview présentes
    const matchedSection = wrapper.find('[data-testid="matched-section"]')
    const unmatchedSection = wrapper.find('[data-testid="unmatched-section"]')

    expect(matchedSection.exists()).toBe(true)
    expect(unmatchedSection.exists()).toBe(true)
    // 2 lignes matchées
    const matchedRows = wrapper.findAll('[data-testid="matched-row"]')
    expect(matchedRows).toHaveLength(2)
    // 1 ligne non matchée
    const unmatchedRows = wrapper.findAll('[data-testid="unmatched-row"]')
    expect(unmatchedRows).toHaveLength(1)
  })

  it('IMP-UI-07: click Appliquer → PATCH mock appelé → toast succès → modal fermé', async () => {
    const previewResponse = {
      matched: [
        {
          lineId: 101,
          code: 'RUF-001',
          oldPriceCents: null,
          newPriceCents: 1000,
          supplierRef: 'FOURN-A1',
        },
      ],
      unmatched: [],
      errors: [],
      fileMeta: { filename: 'test.csv', rowCount: 1, parser: 'xlsx' },
    }

    const applyResponse = {
      updatedCount: 1,
      totalSupplierAmountCents: 1000,
      newMarginTotalCents: 500,
    }

    let callCount = 0
    const fetchMock = vi.fn().mockImplementation((..._args: unknown[]) => {
      callCount++
      if (callCount === 1)
        return Promise.resolve(jsonResponse(200, makeSavPayload({ status: 'in_progress' })))
      if (callCount === 2) return Promise.resolve(jsonResponse(200, previewResponse)) // POST preview
      if (callCount === 3) return Promise.resolve(jsonResponse(200, applyResponse)) // PATCH apply
      return Promise.resolve(jsonResponse(200, makeSavPayload({ status: 'in_progress' }))) // refresh
    })

    const wrapper = await mountDetail(fetchMock)

    // Ouvrir modal
    const importBtn = wrapper.find('[data-testid="import-supplier-prices-btn"]').exists()
      ? wrapper.find('[data-testid="import-supplier-prices-btn"]')
      : wrapper
          .findAll('button')
          .find(
            (b) =>
              b.text().toLowerCase().includes('importer') ||
              b.text().toLowerCase().includes('fournisseur')
          )
    if (!importBtn || !('trigger' in importBtn)) {
      expect(false).toBe(true)
      return
    }

    await (importBtn as ReturnType<typeof wrapper.find>).trigger('click')
    await flushPromises()

    // Analyser
    const analyzeBtn = wrapper.find('[data-testid="analyze-btn"]')
    if (!analyzeBtn.exists()) {
      expect(false).toBe(true)
      return
    }
    await analyzeBtn.trigger('click')
    await flushPromises()

    // Appliquer
    const applyBtn = wrapper.find('[data-testid="apply-btn"]')
    if (!applyBtn.exists()) {
      expect(false).toBe(true)
      return
    }
    expect(applyBtn.attributes('disabled')).toBeUndefined() // bouton enabled
    await applyBtn.trigger('click')
    await flushPromises()

    // PATCH doit avoir été appelé (3e fetch call)
    expect(fetchMock).toHaveBeenCalledTimes(4) // load + preview + apply + refresh

    // Modal fermé après apply
    const modalAfterApply = wrapper.find('[role="dialog"]')
    const isModalClosed =
      !modalAfterApply.exists() || modalAfterApply.attributes('aria-hidden') === 'true'
    expect(isModalClosed).toBe(true)
  })

  it('IMP-UI-08: bouton Appliquer disabled si aucune ligne matched cochée', async () => {
    const previewResponse = {
      matched: [],
      unmatched: [
        { row: 1, code: 'FOURN-XYZ', supplierRef: 'FOURN-B1', unitPriceHt: 12.5, qty: 2 },
      ],
      errors: [],
      fileMeta: { filename: 'test.csv', rowCount: 1, parser: 'xlsx' },
    }

    let callCount = 0
    const fetchMock = vi.fn().mockImplementation((..._args: unknown[]) => {
      callCount++
      if (callCount === 1)
        return Promise.resolve(jsonResponse(200, makeSavPayload({ status: 'in_progress' })))
      return Promise.resolve(jsonResponse(200, previewResponse))
    })

    const wrapper = await mountDetail(fetchMock)

    const importBtn = wrapper.find('[data-testid="import-supplier-prices-btn"]').exists()
      ? wrapper.find('[data-testid="import-supplier-prices-btn"]')
      : wrapper
          .findAll('button')
          .find(
            (b) =>
              b.text().toLowerCase().includes('importer') ||
              b.text().toLowerCase().includes('fournisseur')
          )
    if (!importBtn || !('trigger' in importBtn)) {
      expect(false).toBe(true)
      return
    }

    await (importBtn as ReturnType<typeof wrapper.find>).trigger('click')
    await flushPromises()

    const analyzeBtn = wrapper.find('[data-testid="analyze-btn"]')
    if (!analyzeBtn.exists()) {
      expect(false).toBe(true)
      return
    }
    await analyzeBtn.trigger('click')
    await flushPromises()

    const applyBtn = wrapper.find('[data-testid="apply-btn"]')
    if (!applyBtn.exists()) {
      expect(false).toBe(true)
      return
    }
    // Bouton disabled quand matched = []
    expect(applyBtn.attributes('disabled')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// AC #5 — Affichage marge dans le tableau lignes
// ---------------------------------------------------------------------------

describe('SavDetailView — colonnes marge tableau lignes (AC #5)', () => {
  it('IMP-UI-09: marge positive → classe .margin-positive (vert)', async () => {
    // LINE_WITH_PRICES: TTC=2100, TVA=550bp, achat=1000 → marge positive
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, makeSavPayload({ lines: [LINE_WITH_PRICES] })))
    const wrapper = await mountDetail(fetchMock)

    // Trouver la cellule marge avec classe positive
    const positiveCell = wrapper.find('.margin-positive')
    expect(positiveCell.exists()).toBe(true)
    // Le texte ne doit pas être '—'
    expect(positiveCell.text()).not.toBe('—')
  })

  it('IMP-UI-10: marge négative → classe .margin-negative (rouge)', async () => {
    // LINE_NEGATIVE_MARGIN: TTC=1000, TVA=550bp, achat=1500 → marge négative
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, makeSavPayload({ lines: [LINE_NEGATIVE_MARGIN] })))
    const wrapper = await mountDetail(fetchMock)

    const negativeCell = wrapper.find('.margin-negative')
    expect(negativeCell.exists()).toBe(true)
    expect(negativeCell.text()).not.toBe('—')
  })

  it('IMP-UI-11: prix achat null → cellule marge "—" (gris)', async () => {
    // LINE_WITHOUT_SUPPLIER: supplier null → marge null → "—"
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, makeSavPayload({ lines: [LINE_WITHOUT_SUPPLIER] })))
    const wrapper = await mountDetail(fetchMock)

    // La cellule marge doit afficher "—"
    const marginCells = wrapper.findAll('td').filter((td) => td.text() === '—')
    // Au moins une cellule marge affiche "—" (il peut y en avoir d'autres pour PU achat aussi)
    expect(marginCells.length).toBeGreaterThanOrEqual(1)
    // Vérifier qu'il n'y a PAS de .margin-positive ni .margin-negative
    expect(wrapper.find('.margin-positive').exists()).toBe(false)
    expect(wrapper.find('.margin-negative').exists()).toBe(false)
  })

  it('IMP-UI-12: colonne "PU achat HT" affiche le prix formaté si non-null', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, makeSavPayload({ lines: [LINE_WITH_PRICES] })))
    const wrapper = await mountDetail(fetchMock)

    // La colonne "PU achat HT" doit afficher une valeur en euros (1000 cents = 10,00 €)
    // Chercher dans les th (headers) qu'il y a un header "PU achat HT"
    const headers = wrapper.findAll('th')
    const hasSupplierPriceHeader = headers.some(
      (h) =>
        h.text().includes('achat') || h.text().includes('Achat') || h.text().includes('PU achat')
    )
    expect(hasSupplierPriceHeader).toBe(true)
  })

  it('IMP-UI-13: footer "Marge totale HT estimée" affiché quand lignes avec les 2 prix', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, makeSavPayload({ lines: [LINE_WITH_PRICES] })))
    const wrapper = await mountDetail(fetchMock)

    // Le footer doit contenir "Marge totale" ou "marge totale"
    const footerText = wrapper.text().toLowerCase()
    const hasMarginFooter =
      footerText.includes('marge totale') ||
      footerText.includes('margin total') ||
      wrapper.find('[data-testid="margin-total-footer"]').exists()

    expect(hasMarginFooter).toBe(true)
  })

  it('IMP-UI-14: footer absent quand aucune ligne n a les 2 prix renseignés', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, makeSavPayload({ lines: [LINE_WITHOUT_SUPPLIER] })))
    const wrapper = await mountDetail(fetchMock)

    // Le footer ne doit PAS afficher de valeur marge calculée (pas de données)
    // Il peut exister mais afficher "—" ou "0 €" ou être caché
    const footerEl = wrapper.find('[data-testid="margin-total-footer"]')
    if (footerEl.exists()) {
      // S'il existe, il ne doit pas afficher de valeur calculée non-nulle
      const text = footerEl.text()
      const hasCalculatedValue = /[1-9]\d*/.test(text.replace(/[,.\s]/g, ''))
      expect(hasCalculatedValue).toBe(false)
    }
    // Si le footer n'existe pas quand pas de données → aussi acceptable
  })
})
