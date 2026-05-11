import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createWebHistory } from 'vue-router'
import SavDetailView from '../../../../src/features/back-office/views/SavDetailView.vue'

/**
 * Story V1.9-B — Split UX 3 rows par ligne SAV : motif demande exposé + arbitrage opérateur.
 *
 * Tests S-01..S-05 : V1.9-A mis à jour pour 3 rows + testid renommé (DN-2 → Option A)
 *   sav-line-{id}-validation-row  →  sav-line-{id}-arbitration-row  (5 occurrences, breaking)
 *
 * Tests S-06..S-10 : nouveaux V1.9-B
 *   S-06 : motif visible (reason-pill) + fallback stub gris
 *   S-07 : édition Row 3 arbitrage (inputs qtyArbitrated / unitArbitrated)
 *   S-08 : awaiting_arbitration badge + data-blocking
 *   S-09 : pre-fill draft arbitrage = invoiced quand qtyArbitrated IS NULL
 *   S-10 : Row 2 100% read-only en mode édition (AC#4.2)
 *
 * AC couverts :
 *   AC#3 — layout 3 rows + motif (S-01..S-03, S-06)
 *   AC#4 — édition Row1/Row3 vs Row2 read-only (S-03, S-07, S-09, S-10)
 *   AC#5 — sélecteurs préservés + renommés (S-01..S-05)
 *   AC#6 — anti-régression scroll-to-blocking + edit-extra-row (S-04, S-05)
 *   AC#7 — tests Vitest 3 rows + arbitrage + cause (S-06..S-10)
 *
 * RED-phase : S-01..S-10 doivent ECHOUER avant la refacto template SavDetailView.vue V1.9-B.
 * En particulier :
 *   - S-01..S-03/S-05 : testid arbitration-row absent (template encore V1.9-A validation-row)
 *   - S-06 : reason-pill absent (champ requestReason non-projeté)
 *   - S-07 : inputs edit-qty-arbitrated-{id} absents
 *   - S-08 : badge awaiting_arbitration absent (ValidationStatus enum non étendu)
 *   - S-09 : pre-fill draft pas encore implémenté
 *   - S-10 : Row 2 invoiced-row absente (nouvelle tr)
 *
 * DN-2 audit grep Step 2 ATDD — résultat :
 *   grep -rn "sav-line-.*-validation-row"
 *   → 4 occurrences dans ce fichier (S-01..S-03/S-05 V1.9-A) + 1 dans SavDetailView.vue
 *   → toutes mises à jour ci-dessous vers arbitration-row (breaking DN-2 Option A)
 */

// ---------------------------------------------------------------------------
// Helpers — same mount pattern as SavDetailView.edit.spec.ts
// ---------------------------------------------------------------------------

function makeRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/admin/sav', name: 'admin-sav-list', component: { template: '<div/>' } },
      { path: '/admin/sav/:id', name: 'admin-sav-detail', component: SavDetailView },
    ],
  })
}

function mockFetch(body: unknown) {
  const fn = vi.fn((..._args: unknown[]) =>
    Promise.resolve({
      status: 200,
      ok: true,
      json: () => Promise.resolve(body),
    } as unknown as Response)
  )
  ;(globalThis as unknown as { fetch: unknown }).fetch = fn
  return fn
}

async function mountDetail(options: { attachToBody?: boolean } = {}) {
  const router = makeRouter()
  await router.push('/admin/sav/1')
  await router.isReady()
  const mountOptions: Parameters<typeof mount>[1] = { global: { plugins: [router] } }
  if (options.attachToBody) {
    mountOptions.attachTo = document.body
  }
  return mount(SavDetailView, mountOptions)
}

const SETTINGS_SNAPSHOT = {
  vat_rate_default_bp: 550,
  group_manager_discount_bp: 400,
}

/**
 * Helper étendu V1.9-B pour produire un objet ligne complet.
 * Accepte les nouveaux champs : qtyArbitrated, unitArbitrated, requestReason, requestComment.
 * (AC#7.11 — helper étendu)
 */
function makeLine(
  overrides: Partial<{
    id: number
    lineNumber: number | null
    position: number
    productCodeSnapshot: string
    productNameSnapshot: string
    qtyRequested: number
    unitRequested: string
    qtyInvoiced: number | null
    unitInvoiced: string | null
    qtyArbitrated: number | null
    unitArbitrated: string | null
    requestReason: string | null
    requestComment: string | null
    unitPriceTtcCents: number | null
    vatRateBpSnapshot: number | null
    creditCoefficient: number
    creditCoefficientLabel: string | null
    pieceToKgWeightG: number | null
    creditAmountCents: number | null
    validationStatus: string
    validationMessage: string | null
    supplierPurchasePriceHtCents: number | null
    supplierReference: string | null
    supplierPriceImportedAt: string | null
    supplierPriceSource: string | null
  }> = {}
) {
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
    // V1.9-B nouveaux champs (nullable, NULL par défaut → bandeau awaiting)
    qtyArbitrated: null,
    unitArbitrated: null,
    requestReason: null,
    requestComment: null,
    unitPriceTtcCents: 250,
    vatRateBpSnapshot: 550,
    creditCoefficient: 1,
    creditCoefficientLabel: null,
    pieceToKgWeightG: null,
    creditAmountCents: 2500,
    validationStatus: 'ok',
    validationMessage: null,
    supplierPurchasePriceHtCents: null,
    supplierReference: null,
    supplierPriceImportedAt: null,
    supplierPriceSource: null,
    ...overrides,
  }
}

/**
 * Helper to build a full payload for SavDetailView mount.
 */
function makeSavWithLines(
  lines: ReturnType<typeof makeLine>[],
  overrides: { status?: string; version?: number } = {}
) {
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
        lines,
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

// ---------------------------------------------------------------------------
// S-01 (UPDATED V1.9-B) : Layout 3 <tr> dans chaque <tbody class="sav-line-group">
// AC#3.1, AC#5.1, AC#5.3
// ---------------------------------------------------------------------------

describe('V1.9-B S-01 — Layout: 2 <tbody class="sav-line-group"> avec 3 <tr> chacun', () => {
  it('SAV avec 2 lignes → 2 <tbody class="sav-line-group"> rendus, chacun avec 3 <tr>', async () => {
    // qtyArbitrated=10 (= invoiced) → pas d'awaiting_arbitration, status=ok
    mockFetch(
      makeSavWithLines([
        makeLine({ id: 100, qtyArbitrated: 10, unitArbitrated: 'kg', validationStatus: 'ok' }),
        makeLine({
          id: 101,
          lineNumber: 2,
          productCodeSnapshot: 'BAN-02',
          productNameSnapshot: 'Bananes',
          qtyArbitrated: 10,
          unitArbitrated: 'kg',
          validationStatus: 'ok',
        }),
      ])
    )
    const w = await mountDetail()
    await flushPromises()

    // AC#3.1 — chaque ligne SAV dans un <tbody class="sav-line-group">
    const groups = w.findAll('tbody.sav-line-group')
    expect(groups).toHaveLength(2)

    // V1.9-B : chaque groupe contient exactement 3 <tr> (request + invoiced + arbitration)
    // (edit-extra-row absent car pas en mode édition + validationStatus=ok)
    expect(groups[0]!.findAll('tr')).toHaveLength(3)
    expect(groups[1]!.findAll('tr')).toHaveLength(3)

    // AC#5.1 — id="sav-line-{id}" reste sur <tbody> (preserved V1.9-A)
    expect(w.find('#sav-line-100').element.tagName.toLowerCase()).toBe('tbody')
    expect(w.find('#sav-line-101').element.tagName.toLowerCase()).toBe('tbody')

    // AC#5.1 — request-row preserved
    expect(w.find('[data-testid="sav-line-100-request-row"]').exists()).toBe(true)
    expect(w.find('[data-testid="sav-line-101-request-row"]').exists()).toBe(true)

    // AC#5.3 — nouveaux testids invoiced-row
    expect(w.find('[data-testid="sav-line-100-invoiced-row"]').exists()).toBe(true)
    expect(w.find('[data-testid="sav-line-101-invoiced-row"]').exists()).toBe(true)

    // AC#5.2 — RENOMMÉ: arbitration-row (breaking V1.9-A validation-row)
    expect(w.find('[data-testid="sav-line-100-arbitration-row"]').exists()).toBe(true)
    expect(w.find('[data-testid="sav-line-101-arbitration-row"]').exists()).toBe(true)

    // AC#5.2 — ancien testid validation-row doit être ABSENT (breaking confirmed)
    expect(w.find('[data-testid="sav-line-100-validation-row"]').exists()).toBe(false)
    expect(w.find('[data-testid="sav-line-101-validation-row"]').exists()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// S-02 (UPDATED V1.9-B) : Contenu Row 1 (request) / Row 2 (invoiced) / Row 3 (arbitration)
// AC#3.1, AC#3.2, AC#3.3
// ---------------------------------------------------------------------------

describe('V1.9-B S-02 — Contenu Row 1 (request) / Row 2 (invoiced) / Row 3 (arbitration)', () => {
  it('Row 1 : qtyRequested + colspan=8 context ; Row 2 : qtyInvoiced read-only ; Row 3 : badge + boutons', async () => {
    mockFetch(
      makeSavWithLines([
        makeLine({
          id: 100,
          qtyRequested: 10,
          unitRequested: 'kg',
          qtyInvoiced: 10,
          unitInvoiced: 'kg',
          qtyArbitrated: 10,
          unitArbitrated: 'kg',
          validationStatus: 'ok',
          requestReason: null,
        }),
      ])
    )
    const w = await mountDetail()
    await flushPromises()

    const requestRow = w.find('[data-testid="sav-line-100-request-row"]')
    const invoicedRow = w.find('[data-testid="sav-line-100-invoiced-row"]')
    const arbitrationRow = w.find('[data-testid="sav-line-100-arbitration-row"]')

    // AC#3.1 Row 1 — classe sav-line-request
    expect(requestRow.classes()).toContain('sav-line-request')
    // AC#3.1 Row 1 — qtyRequested + unitRequested
    expect(requestRow.text()).toContain('10')
    expect(requestRow.text()).toContain('kg')
    // AC#3.1 Row 1 — colspan=8 context cell
    const contextCell = requestRow.find('td.line-request-context')
    expect(contextCell.exists()).toBe(true)
    expect(contextCell.attributes('colspan')).toBe('8')
    // AC#3.3 — fallback stub quand requestReason IS NULL
    expect(contextCell.text()).toContain('Demande adhérent')

    // AC#3.1 Row 2 — classe sav-line-invoiced (NEW V1.9-B)
    expect(invoicedRow.classes()).toContain('sav-line-invoiced')
    // Row 2 affiche qtyInvoiced read-only
    expect(invoicedRow.text()).toContain('10')
    // Pas d'input dans Row 2 (read-only)
    expect(invoicedRow.findAll('input')).toHaveLength(0)

    // AC#3.1 Row 3 — classe sav-line-arbitration (RENOMMÉ from sav-line-validation)
    expect(arbitrationRow.classes()).toContain('sav-line-arbitration')
    // AC#3.1 Row 3 — badge validationStatus
    const badge = arbitrationRow.find('.validation-badge')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('ok')

    // AC#5.1 — boutons Éditer/Supprimer dans Row 3 (pas Row 1 ni Row 2)
    expect(arbitrationRow.find('[data-testid="edit-line-100"]').exists()).toBe(true)
    expect(arbitrationRow.find('[data-testid="delete-line-100"]').exists()).toBe(true)
    expect(requestRow.find('[data-testid="edit-line-100"]').exists()).toBe(false)
    expect(invoicedRow.find('[data-testid="edit-line-100"]').exists()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// S-03 (UPDATED V1.9-B) : Mode édition — inputs Row 1 + Row 3, Row 2 read-only
// AC#4.1, AC#4.2, AC#4.3, AC#5.1, AC#5.3
// ---------------------------------------------------------------------------

describe('V1.9-B S-03 — Mode édition in_progress : Row 1 + Row 3 éditables, Row 2 read-only', () => {
  it('clic edit-line-{id} → inputs Row 1 (qtyRequested/unitRequested) + Row 3 (qtyArbitrated/unitArbitrated) ; Row 2 0 inputs', async () => {
    mockFetch(
      makeSavWithLines([makeLine({ id: 100, qtyArbitrated: 10, unitArbitrated: 'kg' })], {
        status: 'in_progress',
      })
    )
    const w = await mountDetail()
    await flushPromises()

    await w.find('[data-testid="edit-line-100"]').trigger('click')

    const requestRow = w.find('[data-testid="sav-line-100-request-row"]')
    const invoicedRow = w.find('[data-testid="sav-line-100-invoiced-row"]')
    const arbitrationRow = w.find('[data-testid="sav-line-100-arbitration-row"]')

    // AC#4.1 — Row 1 : inputs qtyRequested + unitRequested (V1.x-B preserved)
    expect(requestRow.find('[data-testid="edit-qty-requested-100"]').exists()).toBe(true)
    expect(requestRow.find('[data-testid="edit-unit-requested-100"]').exists()).toBe(true)

    // AC#4.2 — Row 2 : 0 input (100% read-only) — contrat D-3 "invoice reflète Pennylane"
    expect(invoicedRow.findAll('input')).toHaveLength(0)
    expect(invoicedRow.findAll('select')).toHaveLength(0)

    // AC#4.3 — Row 3 : nouveaux inputs arbitrage (AC#5.3 testids)
    expect(arbitrationRow.find('[data-testid="edit-qty-arbitrated-100"]').exists()).toBe(true)
    expect(arbitrationRow.find('[data-testid="edit-unit-arbitrated-100"]').exists()).toBe(true)

    // AC#5.1 — bouton Enregistrer preserved (Row 3)
    expect(arbitrationRow.find('[data-testid="save-line-100"]').exists()).toBe(true)

    // Confirmation négative : Éditer/Supprimer absents en mode édition
    expect(w.find('[data-testid="edit-line-100"]').exists()).toBe(false)
    expect(w.find('[data-testid="delete-line-100"]').exists()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// S-04 (UPDATED V1.9-B) : edit-extra-row dans même <tbody> quand to_calculate
// AC#4.6 — preserved Story 3.6 + V1.9-A
// ---------------------------------------------------------------------------

describe('V1.9-B S-04 — edit-extra-row dans même <tbody> quand to_calculate (preserved)', () => {
  it('validationStatus=to_calculate + édition → <tr class="edit-extra-row"> dans <tbody class="sav-line-group">', async () => {
    mockFetch(
      makeSavWithLines(
        [
          makeLine({
            id: 100,
            validationStatus: 'to_calculate',
            unitRequested: 'kg',
            unitInvoiced: 'piece',
            pieceToKgWeightG: null,
            qtyArbitrated: null,
            unitArbitrated: null,
          }),
        ],
        { status: 'in_progress' }
      )
    )
    const w = await mountDetail()
    await flushPromises()

    await w.find('[data-testid="edit-line-100"]').trigger('click')

    // AC#4.6 — edit-extra-row visible avec input edit-piece-to-kg-weight-g
    const extraRow = w.find('tr.edit-extra-row')
    expect(extraRow.exists()).toBe(true)
    expect(extraRow.find('[data-testid="edit-piece-to-kg-weight-g"]').exists()).toBe(true)

    // AC#3.1 edit-extra-row est dans le même <tbody class="sav-line-group"> (4e tr)
    const tbodyGroup = w.find('tbody.sav-line-group')
    expect(tbodyGroup.find('tr.edit-extra-row').exists()).toBe(true)

    // Colspan = 12 preserved
    const td = extraRow.find('td')
    expect(td.attributes('colspan')).toBe('12')
  })
})

// ---------------------------------------------------------------------------
// S-05 (UPDATED V1.9-B) : data-blocking sur <tbody> + scroll-to-blocking preserved
// AC#6.1 — ancre <tbody> preserved 3.6b avec 3 <tr>
// ---------------------------------------------------------------------------

describe('V1.9-B S-05 — data-blocking sur <tbody> + scrollIntoView cible le <tbody> (3 rows)', () => {
  it('validationStatus!=ok → <tbody> data-blocking="true" ; getElementById retourne <tbody>', async () => {
    const scrollIntoViewMock = vi.fn()

    mockFetch(
      makeSavWithLines([
        makeLine({
          id: 100,
          validationStatus: 'unit_mismatch',
          validationMessage: 'Unité incohérente',
          unitRequested: 'kg',
          unitInvoiced: 'piece',
          pieceToKgWeightG: null,
          qtyArbitrated: null,
          unitArbitrated: null,
        }),
        makeLine({
          id: 101,
          lineNumber: 2,
          qtyArbitrated: 10,
          unitArbitrated: 'kg',
          validationStatus: 'ok',
        }),
      ])
    )

    const w = await mountDetail({ attachToBody: true })
    await flushPromises()

    // AC#6.1 — <tbody> avec data-blocking="true" sur la ligne bloquante
    const blockingTbody = w.find('#sav-line-100')
    expect(blockingTbody.element.tagName.toLowerCase()).toBe('tbody')
    expect(blockingTbody.attributes('data-blocking')).toBe('true')

    // Ligne ok = data-blocking="false"
    const okTbody = w.find('#sav-line-101')
    expect(okTbody.attributes('data-blocking')).toBe('false')

    // AC#6.1 — getElementById retourne <tbody> (ancre scroll-to-blocking preserved 3.6b)
    const el = w.element.querySelector('#sav-line-100')
    expect(el).not.toBeNull()
    expect(el!.tagName.toLowerCase()).toBe('tbody')

    el!.scrollIntoView = scrollIntoViewMock

    const jumpLink = w.find('[data-testid="sav-preview-blocking-jump"]')
    expect(jumpLink.exists()).toBe(true)
    expect(jumpLink.attributes('href')).toBe('#sav-line-100')

    await jumpLink.trigger('click')
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })

    w.unmount()
  })
})

// ---------------------------------------------------------------------------
// S-06 (NEW V1.9-B) : Motif visible (reason-pill) + fallback stub gris
// AC#3.2 — requestReason='abime' → reason-pill badge
// AC#3.3 — requestReason IS NULL → fallback stub italic
// ---------------------------------------------------------------------------

describe('V1.9-B S-06 — Motif visible: reason-pill quand requestReason set, fallback sinon', () => {
  it('requestReason="abime" → .reason-pill affiche "abime" dans Row 1 colspan=8 cell', async () => {
    mockFetch(
      makeSavWithLines([
        makeLine({
          id: 100,
          requestReason: 'abime',
          requestComment: null,
          qtyArbitrated: 10,
          unitArbitrated: 'kg',
          validationStatus: 'ok',
        }),
      ])
    )
    const w = await mountDetail()
    await flushPromises()

    const requestRow = w.find('[data-testid="sav-line-100-request-row"]')
    const contextCell = requestRow.find('td.line-request-context')
    expect(contextCell.exists()).toBe(true)

    // AC#3.2 — badge ambre visible
    const pill = contextCell.find('.reason-pill')
    expect(pill.exists()).toBe(true)
    expect(pill.text()).toBe('abime')

    // fallback stub doit être absent quand requestReason est set
    expect(contextCell.find('.line-request-context-empty').exists()).toBe(false)
  })

  it('requestReason IS NULL + requestComment IS NULL → fallback stub "Demande adhérent" affiché', async () => {
    mockFetch(
      makeSavWithLines([
        makeLine({
          id: 100,
          requestReason: null,
          requestComment: null,
          qtyArbitrated: 10,
          unitArbitrated: 'kg',
          validationStatus: 'ok',
        }),
      ])
    )
    const w = await mountDetail()
    await flushPromises()

    const requestRow = w.find('[data-testid="sav-line-100-request-row"]')
    const contextCell = requestRow.find('td.line-request-context')

    // reason-pill absent
    expect(contextCell.find('.reason-pill').exists()).toBe(false)
    // fallback stub présent
    expect(contextCell.text()).toContain('Demande adhérent')
  })

  it('requestReason="manquant" + requestComment="palette 3" → pill + comment-text tous deux visibles', async () => {
    mockFetch(
      makeSavWithLines([
        makeLine({
          id: 100,
          requestReason: 'manquant',
          requestComment: 'palette 3',
          qtyArbitrated: 10,
          unitArbitrated: 'kg',
          validationStatus: 'ok',
        }),
      ])
    )
    const w = await mountDetail()
    await flushPromises()

    const requestRow = w.find('[data-testid="sav-line-100-request-row"]')
    const contextCell = requestRow.find('td.line-request-context')

    expect(contextCell.find('.reason-pill').text()).toBe('manquant')
    expect(contextCell.find('.comment-text').text()).toBe('palette 3')
  })
})

// ---------------------------------------------------------------------------
// S-07 (NEW V1.9-B) : Édition Row 3 — inputs qtyArbitrated + unitArbitrated + save
// AC#4.3, AC#4.5, AC#5.3
// ---------------------------------------------------------------------------

describe('V1.9-B S-07 — Édition Row 3 : inputs arbitrage + save patch correct', () => {
  it('édition → input edit-qty-arbitrated-100 + edit-unit-arbitrated-100 visibles dans Row 3 ; save émet patch avec nouveaux champs', async () => {
    const saveMock = vi.fn(() =>
      Promise.resolve({
        status: 200,
        ok: true,
        json: () =>
          Promise.resolve({
            data: { validationStatus: 'ok', newVersion: 2, creditAmountCents: 1250 },
          }),
      } as unknown as Response)
    )

    // Premier fetch : chargement SAV
    let fetchCallCount = 0
    ;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCallCount++
        if (fetchCallCount === 1) {
          return Promise.resolve({
            status: 200,
            ok: true,
            json: () =>
              Promise.resolve(
                makeSavWithLines(
                  [
                    makeLine({
                      id: 100,
                      qtyInvoiced: 10,
                      unitInvoiced: 'kg',
                      qtyArbitrated: 10,
                      unitArbitrated: 'kg',
                      validationStatus: 'ok',
                    }),
                  ],
                  { status: 'in_progress' }
                )
              ),
          } as unknown as Response)
        }
        // Second fetch : PATCH save — forward args so saveMock records (url, init)
        return saveMock(input, init)
      }
    )

    const w = await mountDetail()
    await flushPromises()

    await w.find('[data-testid="edit-line-100"]').trigger('click')

    // AC#4.3 — inputs Row 3 visibles
    const arbitrationRow = w.find('[data-testid="sav-line-100-arbitration-row"]')
    const qtyInput = arbitrationRow.find('[data-testid="edit-qty-arbitrated-100"]')
    const unitInput = arbitrationRow.find('[data-testid="edit-unit-arbitrated-100"]')
    expect(qtyInput.exists()).toBe(true)
    expect(unitInput.exists()).toBe(true)

    // Modifier les valeurs
    await qtyInput.setValue('0.5')
    // unit select : trouver la valeur 'kg' si select
    if (unitInput.element.tagName.toLowerCase() === 'select') {
      await unitInput.setValue('kg')
    }

    // AC#4.5 — Enregistrer → PATCH body contient qtyArbitrated
    await arbitrationRow.find('[data-testid="save-line-100"]').trigger('click')
    await flushPromises()

    // V1.9-B.3 : 2 fetch calls — PATCH save + GET refresh post-save
    expect(saveMock).toHaveBeenCalledTimes(2)
    const patchCall = saveMock.mock.calls[0] as [string, { body?: string; method?: string }]
    const patchBody = JSON.parse(patchCall[1]?.body ?? '{}') as Record<string, unknown>
    // Le patch doit contenir qtyArbitrated (valeur convertie depuis l'input)
    expect(patchBody).toHaveProperty('qtyArbitrated')
    expect(patchBody).toHaveProperty('unitArbitrated')
  })
})

// ---------------------------------------------------------------------------
// S-08 (NEW V1.9-B) : awaiting_arbitration badge + data-blocking
// AC#3.4 — nouveau status mappé 'validation-warning' (orange)
// AC#2 (DN-1) — qtyInvoiced+PU+VAT set + qtyArbitrated IS NULL → awaiting_arbitration
// ---------------------------------------------------------------------------

describe('V1.9-B S-08 — awaiting_arbitration : badge orange + data-blocking visible', () => {
  it('qtyArbitrated IS NULL + qtyInvoiced=1 + PU+VAT set → validationStatus=awaiting_arbitration + data-blocking=true', async () => {
    mockFetch(
      makeSavWithLines([
        makeLine({
          id: 100,
          qtyInvoiced: 1,
          unitInvoiced: 'kg',
          unitPriceTtcCents: 1000,
          vatRateBpSnapshot: 550,
          qtyArbitrated: null, // ← NULL déclenche awaiting_arbitration
          unitArbitrated: null,
          validationStatus: 'awaiting_arbitration', // projeté depuis le trigger DB
          validationMessage: 'Arbitrage opérateur requis (Row 3)',
          creditAmountCents: null,
        }),
      ])
    )
    const w = await mountDetail({ attachToBody: true })
    await flushPromises()

    // AC#3.4 — badge awaiting_arbitration visible dans Row 3
    const arbitrationRow = w.find('[data-testid="sav-line-100-arbitration-row"]')
    const badge = arbitrationRow.find('.validation-badge')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('awaiting_arbitration')
    // Badge mappé 'validation-warning' (orange) — DN-1 Option A
    expect(badge.classes()).toContain('validation-warning')

    // AC#6.1 — data-blocking="true" sur <tbody> car awaiting_arbitration ≠ ok
    const tbodyGroup = w.find('#sav-line-100')
    expect(tbodyGroup.attributes('data-blocking')).toBe('true')

    // Bandeau "ligne(s) bloquante(s)" visible (preview)
    const banner = w.find('[data-testid="sav-preview-blocking-jump"]')
    expect(banner.exists()).toBe(true)

    w.unmount()
  })
})

// ---------------------------------------------------------------------------
// S-09 (NEW V1.9-B) : Pre-fill draft arbitrage = invoiced quand qtyArbitrated IS NULL
// AC#4.4 — PATTERN-V9-D
// ---------------------------------------------------------------------------

describe('V1.9-B S-09 — Pre-fill draft : qtyArbitrated IS NULL → draft préremplit avec qtyInvoiced', () => {
  it("qtyArbitrated IS NULL → à l'ouverture édition, edit-qty-arbitrated-100 pré-rempli avec qtyInvoiced", async () => {
    mockFetch(
      makeSavWithLines(
        [
          makeLine({
            id: 100,
            qtyInvoiced: 7.5,
            unitInvoiced: 'kg',
            qtyArbitrated: null, // ← NULL → pre-fill attendu avec 7.5
            unitArbitrated: null,
            validationStatus: 'awaiting_arbitration',
            creditAmountCents: null,
          }),
        ],
        { status: 'in_progress' }
      )
    )
    const w = await mountDetail()
    await flushPromises()

    await w.find('[data-testid="edit-line-100"]').trigger('click')

    // AC#4.4 — input qtyArbitrated doit être pré-rempli avec la valeur de qtyInvoiced (7.5)
    const arbitrationRow = w.find('[data-testid="sav-line-100-arbitration-row"]')
    const qtyArbitratedInput = arbitrationRow.find('[data-testid="edit-qty-arbitrated-100"]')
    expect(qtyArbitratedInput.exists()).toBe(true)

    const inputElement = qtyArbitratedInput.element as HTMLInputElement
    // La valeur pré-remplie doit correspondre à qtyInvoiced = 7.5
    expect(parseFloat(inputElement.value)).toBe(7.5)
  })

  it("qtyArbitrated=5 (set) → à l'ouverture édition, edit-qty-arbitrated-100 conserve la valeur existante", async () => {
    mockFetch(
      makeSavWithLines(
        [
          makeLine({
            id: 100,
            qtyInvoiced: 10,
            unitInvoiced: 'kg',
            qtyArbitrated: 5, // ← set → doit être conservé, pas écrasé par invoiced
            unitArbitrated: 'kg',
            validationStatus: 'ok',
            creditAmountCents: 1185,
          }),
        ],
        { status: 'in_progress' }
      )
    )
    const w = await mountDetail()
    await flushPromises()

    await w.find('[data-testid="edit-line-100"]').trigger('click')

    const arbitrationRow = w.find('[data-testid="sav-line-100-arbitration-row"]')
    const qtyArbitratedInput = arbitrationRow.find('[data-testid="edit-qty-arbitrated-100"]')
    expect(qtyArbitratedInput.exists()).toBe(true)

    const inputElement = qtyArbitratedInput.element as HTMLInputElement
    // Valeur existante (5) conservée, pas remplacée par qtyInvoiced (10)
    expect(parseFloat(inputElement.value)).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// S-10 (NEW V1.9-B) : Row 2 (invoiced) 100% read-only même en mode édition
// AC#4.2 — "100% read-only en V1.9-B" D-3 contractuel
// ---------------------------------------------------------------------------

describe('V1.9-B S-10 — Row 2 (invoiced) read-only même en mode édition actif', () => {
  it("mode édition actif → Row 2 n'a aucun input/select/textarea (qtyInvoiced/unitInvoiced read-only)", async () => {
    mockFetch(
      makeSavWithLines(
        [
          makeLine({
            id: 100,
            qtyInvoiced: 10,
            unitInvoiced: 'kg',
            qtyArbitrated: 10,
            unitArbitrated: 'kg',
            validationStatus: 'ok',
          }),
        ],
        { status: 'in_progress' }
      )
    )
    const w = await mountDetail()
    await flushPromises()

    await w.find('[data-testid="edit-line-100"]').trigger('click')

    const invoicedRow = w.find('[data-testid="sav-line-100-invoiced-row"]')
    expect(invoicedRow.exists()).toBe(true)

    // AC#4.2 — strictement 0 input/select/textarea dans Row 2
    expect(invoicedRow.findAll('input')).toHaveLength(0)
    expect(invoicedRow.findAll('select')).toHaveLength(0)
    expect(invoicedRow.findAll('textarea')).toHaveLength(0)

    // Le texte qtyInvoiced est toujours lisible (affichage texte)
    expect(invoicedRow.text()).toContain('10')
    expect(invoicedRow.text()).toContain('kg')
  })

  it('sav.status="validated" → toutes rows read-only ; Row 2 reste read-only (preserved AC#4.8)', async () => {
    mockFetch(
      makeSavWithLines(
        [
          makeLine({
            id: 100,
            qtyArbitrated: 10,
            unitArbitrated: 'kg',
            validationStatus: 'ok',
          }),
        ],
        { status: 'validated' }
      )
    )
    const w = await mountDetail()
    await flushPromises()

    // En mode "validated" le bouton Éditer est disabled ou absent
    const editBtn = w.find('[data-testid="edit-line-100"]')
    const isDisabled = !editBtn.exists() || editBtn.attributes('disabled') !== undefined
    expect(isDisabled).toBe(true)

    // Row 2 n'a toujours aucun input
    const invoicedRow = w.find('[data-testid="sav-line-100-invoiced-row"]')
    expect(invoicedRow.findAll('input')).toHaveLength(0)
  })
})
