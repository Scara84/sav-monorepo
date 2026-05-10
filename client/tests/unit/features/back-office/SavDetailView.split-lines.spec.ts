import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createWebHistory } from 'vue-router'
import SavDetailView from '../../../../src/features/back-office/views/SavDetailView.vue'

/**
 * Story V1.9-A — Split UX tableau lignes SAV : 2 rows par ligne.
 *
 * AC couverts :
 *   S-01 : AC#1 — Layout 2 <tbody class="sav-line-group"> avec 2 <tr> chacun.
 *   S-02 : AC#1 + AC#3 — Row 1 contient qtyRequested/unitRequested + colspan stub ;
 *          Row 2 contient badge validation + boutons Actions.
 *   S-03 : AC#2 + AC#3 — Mode édition in_progress : inputs qtyRequested dans Row 1,
 *          input qtyInvoiced dans Row 2 ; sélecteurs data-testid V1.x-B preservés.
 *   S-04 : AC#2 — validationStatus=to_calculate + édition → edit-extra-row dans même <tbody>.
 *   S-05 : AC#1 + AC#4 — validationStatus!='ok' → data-blocking="true" sur <tbody> ;
 *          getElementById('sav-line-{id}') retourne le <tbody> (contrat scroll-to-blocking 3.6b).
 *
 * RED-phase : ces tests échoueront tant que la refacto template SavDetailView.vue
 * (Task 1 Step 3) n'est pas appliquée. Les tests régression (locks GREEN) sont
 * dupliqués dans la même suite pour vérifier que le contrat V1.x-B est preservé.
 *
 * DN-6 confirmed : requestComment absent de la projection detail-handler.ts
 * (SAV_SELECT ne contient pas ce champ, projectLine ne le mappe pas).
 * -> colspan=8 Row 1 = stub italic gris "Demande adhérent" (Option A).
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
 * Helper to produce a full line object matching the edit.spec.ts fixture pattern.
 * Mirrors `line()` helper from SavDetailView.edit.spec.ts for consistency.
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
 * Helper to build a full payload for SavDetailView mount, similar to buildPayload
 * in SavDetailView.edit.spec.ts.
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
// S-01 : AC#1.2 — Layout <tbody class="sav-line-group"> par ligne SAV (DN-1)
// ---------------------------------------------------------------------------

describe('V1.9-A S-01 — Layout split: 2 <tbody class="sav-line-group"> pour 2 lignes', () => {
  it('SAV avec 2 lignes → 2 <tbody class="sav-line-group"> rendus, chacun avec 2 <tr>', async () => {
    mockFetch(
      makeSavWithLines([
        makeLine({ id: 100 }),
        makeLine({
          id: 101,
          lineNumber: 2,
          productCodeSnapshot: 'BAN-02',
          productNameSnapshot: 'Bananes',
        }),
      ])
    )
    const w = await mountDetail()
    await flushPromises()

    // AC#1.2 — chaque ligne SAV dans un <tbody class="sav-line-group">
    const groups = w.findAll('tbody.sav-line-group')
    expect(groups).toHaveLength(2)

    // Chaque groupe contient exactement 2 <tr> (request + validation)
    // (edit-extra-row absent car pas en mode édition + validationStatus=ok)
    expect(groups[0]!.findAll('tr')).toHaveLength(2)
    expect(groups[1]!.findAll('tr')).toHaveLength(2)

    // AC#1.2 — id="sav-line-{id}" migré du <tr> au <tbody>
    expect(w.find('#sav-line-100').element.tagName.toLowerCase()).toBe('tbody')
    expect(w.find('#sav-line-101').element.tagName.toLowerCase()).toBe('tbody')

    // AC#3.2 — testids scoped par row (PATTERN-V9-B)
    expect(w.find('[data-testid="sav-line-100-request-row"]').exists()).toBe(true)
    expect(w.find('[data-testid="sav-line-100-validation-row"]').exists()).toBe(true)
    expect(w.find('[data-testid="sav-line-101-request-row"]').exists()).toBe(true)
    expect(w.find('[data-testid="sav-line-101-validation-row"]').exists()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// S-02 : AC#1.3 + AC#1.4 — Contenu Row 1 (demande) vs Row 2 (validation)
// ---------------------------------------------------------------------------

describe('V1.9-A S-02 — Contenu Row 1 (request) et Row 2 (validation)', () => {
  it('Row 1 contient qtyRequested+unitRequested et colspan stub "Demande adhérent" ; Row 2 contient badge validationStatus et boutons Actions', async () => {
    mockFetch(
      makeSavWithLines([
        makeLine({ id: 100, qtyRequested: 10, unitRequested: 'kg', validationStatus: 'ok' }),
      ])
    )
    const w = await mountDetail()
    await flushPromises()

    const requestRow = w.find('[data-testid="sav-line-100-request-row"]')
    const validationRow = w.find('[data-testid="sav-line-100-validation-row"]')

    // AC#1.3 — Row 1 : qtyRequested + unitRequested présents
    expect(requestRow.text()).toContain('10')
    expect(requestRow.text()).toContain('kg')

    // AC#1.3 — Row 1 : colspan=8 stub "Demande adhérent" (DN-6 Option A — requestComment absent)
    const contextCell = requestRow.find('td.line-request-context')
    expect(contextCell.exists()).toBe(true)
    expect(contextCell.attributes('colspan')).toBe('8')
    expect(contextCell.text()).toContain('Demande adhérent')

    // AC#1.3 — Row 1 : classe sav-line-request sur le <tr>
    expect(requestRow.classes()).toContain('sav-line-request')

    // AC#1.4 — Row 2 : classe sav-line-validation sur le <tr>
    expect(validationRow.classes()).toContain('sav-line-validation')

    // AC#1.4 — Row 2 : badge validation présent
    const badge = validationRow.find('.validation-badge')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('ok')

    // AC#2.5 — Row 2 : boutons Éditer + Supprimer dans cellule Actions (pas Row 1)
    expect(validationRow.find('[data-testid="edit-line-100"]').exists()).toBe(true)
    expect(validationRow.find('[data-testid="delete-line-100"]').exists()).toBe(true)
    // Confirmation négative : les boutons ne sont PAS dans Row 1
    expect(requestRow.find('[data-testid="edit-line-100"]').exists()).toBe(false)
    expect(requestRow.find('[data-testid="delete-line-100"]').exists()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// S-03 : AC#2 — Édition inline in_progress : inputs sur les bonnes rows
//        + Lock-in V1.x-B : unitRequested éditable en in_progress
// ---------------------------------------------------------------------------

describe('V1.9-A S-03 — Mode édition in_progress : inputs placés sur Row 1 et Row 2', () => {
  it('clic edit-line-{id} → edit-qty-requested dans Row 1, input qtyInvoiced dans Row 2 ; sélecteurs V1.x-B preservés', async () => {
    mockFetch(makeSavWithLines([makeLine({ id: 100 })], { status: 'in_progress' }))
    const w = await mountDetail()
    await flushPromises()

    // Déclenche l'édition via le testid preservé AC#3.1
    expect(w.find('[data-testid="edit-line-100"]').exists()).toBe(true)
    await w.find('[data-testid="edit-line-100"]').trigger('click')

    const requestRow = w.find('[data-testid="sav-line-100-request-row"]')
    const validationRow = w.find('[data-testid="sav-line-100-validation-row"]')

    // AC#2.1 — input qtyRequested apparaît dans Row 1 (V1.x-B regression lock)
    expect(requestRow.find('[data-testid="edit-qty-requested-100"]').exists()).toBe(true)

    // V1.x-B lock : unitRequested éditable en in_progress (D-3 preserved)
    expect(requestRow.find('[data-testid="edit-unit-requested-100"]').exists()).toBe(true)

    // AC#2.2 — input qtyInvoiced apparaît dans Row 2
    const qtyInvoicedInput = validationRow.find('input[aria-label*="Quantité facturée"]')
    expect(qtyInvoicedInput.exists()).toBe(true)

    // AC#2.3 — boutons Enregistrer/Annuler dans Row 2
    expect(validationRow.find('[data-testid="save-line-100"]').exists()).toBe(true)

    // Confirmation négative : boutons Éditer/Supprimer absents (remplacés par Enregistrer/Annuler)
    expect(w.find('[data-testid="edit-line-100"]').exists()).toBe(false)
    expect(w.find('[data-testid="delete-line-100"]').exists()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// S-04 : AC#2.4 — validationStatus=to_calculate + édition → edit-extra-row dans même <tbody>
// ---------------------------------------------------------------------------

describe('V1.9-A S-04 — edit-extra-row dans même <tbody> quand to_calculate', () => {
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
          }),
        ],
        { status: 'in_progress' }
      )
    )
    const w = await mountDetail()
    await flushPromises()

    await w.find('[data-testid="edit-line-100"]').trigger('click')

    // AC#2.4 — edit-extra-row visible avec input edit-piece-to-kg-weight-g
    const extraRow = w.find('tr.edit-extra-row')
    expect(extraRow.exists()).toBe(true)
    expect(extraRow.find('[data-testid="edit-piece-to-kg-weight-g"]').exists()).toBe(true)

    // AC#1.5 — edit-extra-row est dans le même <tbody class="sav-line-group">
    // Vérification : le parent du <tr.edit-extra-row> est un <tbody class="sav-line-group">
    const tbodyGroup = w.find('tbody.sav-line-group')
    expect(tbodyGroup.find('tr.edit-extra-row').exists()).toBe(true)

    // Colspan = 12 preserved
    const td = extraRow.find('td')
    expect(td.attributes('colspan')).toBe('12')
  })
})

// ---------------------------------------------------------------------------
// S-05 : AC#1.2 + AC#4.1 — data-blocking sur <tbody> + contrat scroll-to-blocking 3.6b
// ---------------------------------------------------------------------------

describe('V1.9-A S-05 — data-blocking sur <tbody> + scrollIntoView cible le <tbody>', () => {
  it('validationStatus!=ok → <tbody class="sav-line-group"> a data-blocking="true" ; getElementById retourne le <tbody>', async () => {
    // Mock scrollIntoView pour pouvoir vérifier l'appel (jsdom ne l'implémente pas)
    const scrollIntoViewMock = vi.fn()

    // Pour que preview.anyLineBlocking=true (nécessaire pour afficher le lien de jump),
    // la ligne 100 doit avoir des unités réellement incompatibles selon le moteur de calcul
    // (unit_requested='kg', unit_invoiced='piece', pieceToKgWeightG=null → unit_mismatch dans engine).
    // La ligne 101 est ok (unités identiques).
    mockFetch(
      makeSavWithLines([
        makeLine({
          id: 100,
          validationStatus: 'unit_mismatch',
          validationMessage: 'Unité incohérente',
          unitRequested: 'kg',
          unitInvoiced: 'piece',
          pieceToKgWeightG: null,
        }),
        makeLine({ id: 101, lineNumber: 2 }),
      ])
    )
    // attachTo=body requis pour que document.getElementById() fonctionne dans scrollToFirstBlocking
    const w = await mountDetail({ attachToBody: true })
    await flushPromises()

    // AC#1.2 — <tbody class="sav-line-group"> avec data-blocking="true" sur la ligne bloquante
    const blockingTbody = w.find('#sav-line-100')
    expect(blockingTbody.element.tagName.toLowerCase()).toBe('tbody')
    expect(blockingTbody.attributes('data-blocking')).toBe('true')

    // Ligne ok = data-blocking="false"
    const okTbody = w.find('#sav-line-101')
    expect(okTbody.attributes('data-blocking')).toBe('false')

    // AC#4.1 — contrat scroll-to-blocking 3.6b :
    // getElementById('sav-line-100') retourne le <tbody> (pas un <tr>)
    // On vérifie via le DOM attaché au wrapper
    const el = w.element.querySelector('#sav-line-100')
    expect(el).not.toBeNull()
    expect(el!.tagName.toLowerCase()).toBe('tbody')

    // Mock scrollIntoView sur l'élément
    el!.scrollIntoView = scrollIntoViewMock

    // Déclenche scrollToFirstBlocking via le lien de jump de la preview blocking
    // (le lien data-testid="sav-preview-blocking-jump" a href="#sav-line-100")
    const jumpLink = w.find('[data-testid="sav-preview-blocking-jump"]')
    expect(jumpLink.exists()).toBe(true)
    expect(jumpLink.attributes('href')).toBe('#sav-line-100')

    // Déclenche scrollToFirstBlocking (bound via @click.prevent sur le lien)
    await jumpLink.trigger('click')

    // scrollIntoView appelé sur l'élément <tbody> avec { behavior: 'smooth', block: 'center' }
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })

    // Cleanup : démonter pour libérer le body (attachTo requis dans ce test)
    w.unmount()
  })
})
