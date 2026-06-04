/**
 * Story 8.1 — AC #12 : Tests UI SupplierClaimView + point d'entrée SavDetailView
 *
 * Test type: UNIT (Vue Test Utils + vi.mock fetch — no real API call)
 *
 * Decisions applied (all DNs arbitrated):
 *   DN-1 = Option A : Route dédiée /admin/sav/:id/demande-fournisseur + SupplierClaimView.vue
 *   DN-3 = sav.status === 'validated' → CTA proéminent (class cta-primary)
 *
 * AC coverage:
 *   AC #12(a) — Bouton "Demande de remboursement fournisseur" présent quel que soit sav.status (FR3)
 *               Testé pour: in_progress, validated, closed, cancelled
 *   AC #12(b) — Bouton mis en avant (class cta-primary) quand sav.status === 'validated' (FR2, DN-3)
 *   AC #12(c) — Click navigue vers /admin/sav/:id/demande-fournisseur (DN-1=A) ;
 *               Dans SupplierClaimView : upload XLSX → POST op=parse-supplier-file → preview
 *   AC #12(d) — Échec parse (mock 422) → toast d'erreur affiché, écran reste ouvert
 *
 * NOTE: Two sets of tests here:
 *   Group SC-01..03: Tests on SavDetailView.vue (existing) — will be RED until Task 3
 *                    adds the supplier-claim-btn + navigation logic.
 *   Group SC-04..05: Tests on SupplierClaimView.vue (not yet created) — isolated in a
 *                    separate describe block using a stub component until Task 3 ships.
 *                    These tests document the contract and will be wired to the real
 *                    component once it exists.
 *
 * Mock strategy:
 *   - fetch: vi.fn stubbed globally (follows SavDetailView.preview.test.ts pattern)
 *   - router: createRouter with stub child route for demande-fournisseur
 *   - SupplierClaimView: tested via a stub component that models the expected API surface
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createWebHistory } from 'vue-router'
import SavDetailView from './SavDetailView.vue'
import SupplierClaimView from './SupplierClaimView.vue'

// ---------------------------------------------------------------------------
// Router factory — DN-1=A : route SŒUR (premier niveau sous /admin)
// SavDetailView n'a PAS de <router-view> → la route demande-fournisseur doit être
// une SŒUR de admin-sav-detail (pas une enfant), montée par le RouterView parent (/admin).
//
// Fix H-1 : structure aplatie — admin-sav-demande-fournisseur est sœur, pas enfant.
// ---------------------------------------------------------------------------

const StubSupplierClaimView = defineComponent({
  name: 'StubSupplierClaimView',
  template: '<div data-testid="supplier-claim-view-stub">SupplierClaimView stub</div>',
})

// Wrapper pour le RouterView racine (monter la hiérarchie /admin/* correctement)
const RootWrapper = defineComponent({
  name: 'RootWrapper',
  template: '<div><router-view /></div>',
})

function makeRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/admin/sav', name: 'admin-sav-list', component: { template: '<div/>' } },
      {
        // Fix H-1 : route SŒUR, pas enfant — SavDetailView n'a pas de <router-view>
        path: '/admin/sav/:id',
        name: 'admin-sav-detail',
        component: SavDetailView,
      },
      {
        // Route de premier niveau — sœur de admin-sav-detail
        path: '/admin/sav/:id/demande-fournisseur',
        name: 'admin-sav-demande-fournisseur',
        component: StubSupplierClaimView,
      },
    ],
  })
}

// ---------------------------------------------------------------------------
// Fetch mock helper (mirrors SavDetailView.edit.spec.ts pattern)
// ---------------------------------------------------------------------------

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
    used: boolean
  }> = []

  const fn = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    let body: unknown = null
    if (init?.body && typeof init.body === 'string') {
      try { body = JSON.parse(init.body) } catch { body = init.body }
    }
    calls.push({ url, method, body })

    const match = responsesByPattern.find((r) => !r.used && r.match(url, method))
    if (match) {
      match.used = true
      return Promise.resolve({
        status: match.response.status,
        ok: match.response.status >= 200 && match.response.status < 300,
        json: () => Promise.resolve(match.response.body),
      } as unknown as Response)
    }
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
  return { calls, fn, onceFor(match: (url: string, method: string) => boolean, response: { status: number; body: unknown }) {
    responsesByPattern.push({ match, response, used: false })
  }}
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

const SETTINGS_SNAPSHOT = { vat_rate_default_bp: 550, group_manager_discount_bp: 400 }

function buildSavPayload(status: string) {
  return {
    data: {
      sav: {
        id: 1,
        reference: 'SAV-2026-00001',
        status,
        version: 1,
        groupId: 1,
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
        member: { id: 10, firstName: 'Jean', lastName: 'Dubois', email: 'j@d.com', isGroupManager: false, groupId: null },
        group: null,
        assignee: null,
        lines: [{
          id: 100, productId: null, lineNumber: 1, position: 1,
          productCodeSnapshot: '1022-5K', productNameSnapshot: 'Produit A',
          qtyRequested: 10, unitRequested: 'kg', qtyInvoiced: 9, unitInvoiced: 'kg',
          qtyArbitrated: 8, unitArbitrated: 'kg',
          unitPriceTtcCents: 2500, unitPriceTtcArbitratedCents: null,
          vatRateBpSnapshot: 550, creditCoefficient: 1, creditCoefficientLabel: null,
          pieceToKgWeightG: null, creditAmountCents: 20000,
          validationStatus: 'ok', validationMessage: null,
        }],
        files: [],
      },
      comments: [],
      auditTrail: [],
      settingsSnapshot: SETTINGS_SNAPSHOT,
    },
  }
}

function buildParseSuccessResponse() {
  return {
    metadata: { reference: '278_26S21_11', albaran: 3127, fechaAlbaran: '2026-05-20', warnings: [] },
    factureGroupe: {
      rows: [
        { codeFr: '1022-5K', designationFr: 'Produit A BIO 5kg', prixVenteClientHt: 19.9, unite: 'kg', qteCmd: 8, qteFact: 7, codigoEs: '1022', descripcionEs: 'Producto A BIO', kilosPiezas: 'Kilos', kilosNetos: 34.3, precio: 4.89, importe: 34.23, cmd: '278' },
        { codeFr: '3301-1K', designationFr: 'Produit C 1kg', prixVenteClientHt: 8.75, unite: 'kg', qteCmd: 20, qteFact: 18, codigoEs: '3301', descripcionEs: 'Producto C', kilosPiezas: 'Kilos', kilosNetos: 18.0, precio: 3.2, importe: 57.6, cmd: '278' },
      ],
      skippedRows: 3,
      warnings: [{ row: 6, sheet: 'FACTURE_GROUPE', fields: ['precio'] }],
    },
    bdd: {
      rows: [
        { code: '1022-5K', designationEs: 'Producto A BIO 5kg', origen: 'Málaga' },
        { code: '3301-1K', designationEs: 'Producto C 1kg', origen: 'Almería' },
      ],
      skippedRows: 1,
      warnings: [],
    },
    fileMeta: { filename: 'data.xlsx', sizeBytes: 24819, sheetsDetected: ['MAIL', 'CMD SIMPLE', 'VENTAS', 'FACTURE_GROUPE', 'BDD'], parser: 'xlsx-cdn-0.20.3' },
  }
}

// ---------------------------------------------------------------------------
// Mount helper for SavDetailView
// ---------------------------------------------------------------------------

async function mountDetailWithStatus(status: string) {
  const router = makeRouter()
  await router.push('/admin/sav/1')
  await router.isReady()
  makeFetchController(buildSavPayload(status))
  const wrapper = mount(SavDetailView, { global: { plugins: [router] } })
  await flushPromises()
  return { wrapper, router }
}

// ---------------------------------------------------------------------------
// File input helper — vue-test-utils v2 forbids setting event.target directly.
// Use Object.defineProperty to set .files on the underlying DOM element.
// ---------------------------------------------------------------------------

async function setInputFiles(
  inputEl: HTMLInputElement,
  files: File[],
  wrapper: ReturnType<typeof import('@vue/test-utils').mount>
) {
  Object.defineProperty(inputEl, 'files', {
    value: files,
    writable: false,
    configurable: true,
  })
  // Dispatch a real change event on the element
  inputEl.dispatchEvent(new Event('change'))
  await wrapper.vm.$nextTick()
  await flushPromises()
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks()
})

// ===========================================================================
// AC #12(a) — Bouton "Demande de remboursement fournisseur" présent quel que soit status (FR3)
// RED until Task 3 adds [data-testid="supplier-claim-btn"] to SavDetailView.vue
// ===========================================================================

describe('SC-01: Point d\'entrée SavDetailView — visible quel que soit sav.status (AC #12a, FR3)', () => {
  const statuses = ['in_progress', 'validated', 'closed', 'cancelled']

  for (const status of statuses) {
    it(`SC-01-${status}: bouton "Demande de remboursement fournisseur" visible quand status = ${status}`, async () => {
      const { wrapper } = await mountDetailWithStatus(status)

      // RED: data-testid="supplier-claim-btn" not yet in SavDetailView.vue header-actions-row
      // GREEN when Task 3 adds the button to SavDetailView.vue
      const btn = wrapper.find('[data-testid="supplier-claim-btn"]')
      expect(btn.exists()).toBe(true)
      expect(btn.text()).toMatch(/demande.*remboursement.*fournisseur|demande fournisseur|préparer.*demande/i)
    })
  }
})

// ===========================================================================
// AC #12(b) — CTA proéminent quand sav.status === 'validated' (FR2, DN-3)
// RED until Task 3 adds conditional class cta-primary to SavDetailView.vue
// ===========================================================================

describe('SC-02: CTA proéminent sur SAV validé (AC #12b, FR2, DN-3=A sav.status===validated)', () => {
  it('SC-02a: sav.status = "validated" → bouton a class cta-primary', async () => {
    const { wrapper } = await mountDetailWithStatus('validated')

    const btn = wrapper.find('[data-testid="supplier-claim-btn"]')
    expect(btn.exists()).toBe(true)
    expect(btn.classes()).toContain('cta-primary')
  })

  it('SC-02b: sav.status = "in_progress" → bouton N\'a PAS class cta-primary (variant neutre)', async () => {
    const { wrapper } = await mountDetailWithStatus('in_progress')

    const btn = wrapper.find('[data-testid="supplier-claim-btn"]')
    expect(btn.exists()).toBe(true)
    expect(btn.classes()).not.toContain('cta-primary')
  })

  it('SC-02c: sav.status = "closed" → bouton présent, variant neutre', async () => {
    const { wrapper } = await mountDetailWithStatus('closed')

    const btn = wrapper.find('[data-testid="supplier-claim-btn"]')
    expect(btn.exists()).toBe(true)
    expect(btn.classes()).not.toContain('cta-primary')
  })
})

// ===========================================================================
// AC #12(c) — Click navigue vers /admin/sav/:id/demande-fournisseur (DN-1=A)
// Fix H-1 : SC-03 asserts that SupplierClaimView is ACTUALLY MOUNTED in the DOM
// (not just that router.currentRoute.value.name matches).
// Uses RootWrapper + RouterView to verify the component renders.
// ===========================================================================

describe('SC-03: Navigation vers route dédiée (AC #12c, DN-1=A)', () => {
  it('SC-03a: click bouton → SupplierClaimView est RÉELLEMENT monté dans le DOM après navigation', async () => {
    // Mount via RootWrapper so RouterView renders the matched component
    const router = makeRouter()
    await router.push('/admin/sav/1')
    await router.isReady()
    makeFetchController(buildSavPayload('validated'))

    // Mount the root wrapper (has <router-view />) so navigation renders SupplierClaimView
    const rootWrapper = mount(RootWrapper, { global: { plugins: [router] } })
    await flushPromises()

    // SavDetailView should be rendered inside RootWrapper
    const btn = rootWrapper.find('[data-testid="supplier-claim-btn"]')
    expect(btn.exists()).toBe(true)

    // Click the button — triggers router.push({ name: 'admin-sav-demande-fournisseur' })
    await btn.trigger('click')
    await flushPromises()

    // Assert route change
    expect(router.currentRoute.value.name).toBe('admin-sav-demande-fournisseur')
    expect(router.currentRoute.value.path).toBe('/admin/sav/1/demande-fournisseur')

    // Assert StubSupplierClaimView is ACTUALLY IN THE DOM (H-1 fix: not just route name check)
    // This would FAIL if the route were a child without <router-view> in the parent
    const supplierView = rootWrapper.find('[data-testid="supplier-claim-view-stub"]')
    expect(supplierView.exists()).toBe(true)
  })
})

// ===========================================================================
// AC #12(c) — SupplierClaimView RÉEL : upload → preview (M-2-bis fix)
// Ces tests montent le VRAI client/src/features/back-office/views/SupplierClaimView.vue
// via le vrai router avec params id. Exercice du composable useSupplierClaimUpload réel
// (machine d'état idle→uploading→previewing|error).
// Preuve : grep "import SupplierClaimView" dans ce fichier doit matcher.
// ===========================================================================

/**
 * Factory : router avec le VRAI SupplierClaimView.vue sur la route demande-fournisseur.
 * Utilisé par SC-04 et SC-05 pour monter le vrai composant.
 */
function makeRouterWithRealSupplierClaim() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/admin/sav', name: 'admin-sav-list', component: { template: '<div/>' } },
      {
        path: '/admin/sav/:id',
        name: 'admin-sav-detail',
        component: SavDetailView,
      },
      {
        // VRAI SupplierClaimView.vue — pas un stub
        path: '/admin/sav/:id/demande-fournisseur',
        name: 'admin-sav-demande-fournisseur',
        component: SupplierClaimView,
      },
    ],
  })
}

/**
 * Monte le VRAI SupplierClaimView.vue via RootWrapper + router navigué sur
 * /admin/sav/:savId/demande-fournisseur.
 */
async function mountRealSupplierClaimView(savId: number) {
  const router = makeRouterWithRealSupplierClaim()
  await router.push(`/admin/sav/${savId}/demande-fournisseur`)
  await router.isReady()
  const rootWrapper = mount(RootWrapper, { global: { plugins: [router] } })
  await flushPromises()
  return { rootWrapper, router }
}

describe('SC-04: SupplierClaimView RÉEL — upload XLSX + preview (AC #12c, M-2-bis fix)', () => {
  it('SC-04a: input[type="file"] présent dans le VRAI SupplierClaimView (data-testid="file-input")', async () => {
    // Aucun mock fetch nécessaire pour ce test — juste monter le composant
    makeFetchController(buildSavPayload('validated'))
    const { rootWrapper } = await mountRealSupplierClaimView(1)

    // Le vrai composant doit exposer data-testid="file-input"
    const input = rootWrapper.find('[data-testid="file-input"]')
    expect(input.exists()).toBe(true)
    expect(input.attributes('type')).toBe('file')

    // Sanity : le VRAI composant est monté (pas un stub)
    expect(rootWrapper.find('[data-testid="supplier-claim-view"]').exists()).toBe(true)
    // Pas le stub SC-03
    expect(rootWrapper.find('[data-testid="supplier-claim-view-stub"]').exists()).toBe(false)
  })

  it('SC-04b: upload XLSX réussi → POST op=parse-supplier-file appelé + preview affiche metadata + compteurs (VRAI composant + composable useSupplierClaimUpload)', async () => {
    // Mock fetch : POST → 200 avec buildParseSuccessResponse()
    const ctrl = makeFetchController(buildSavPayload('validated'))
    ctrl.onceFor(
      (url, method) => method === 'POST' && url.includes('op=parse-supplier-file'),
      { status: 200, body: buildParseSuccessResponse() }
    )

    const { rootWrapper } = await mountRealSupplierClaimView(1)

    // Sanity : confirmer que le VRAI SupplierClaimView est monté
    expect(rootWrapper.find('[data-testid="supplier-claim-view"]').exists()).toBe(true)

    // Déclencher l'upload via le vrai input
    const fakeXlsxContent = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])
    const fakeFile = new File([fakeXlsxContent], 'data.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const input = rootWrapper.find('[data-testid="file-input"]')
    await setInputFiles(input.element as HTMLInputElement, [fakeFile], rootWrapper)

    // POST vers parse-supplier-file doit avoir été émis par useSupplierClaimUpload
    const parseCall = ctrl.calls.find(
      (c) => c.method === 'POST' && String(c.url).includes('op=parse-supplier-file')
    )
    expect(parseCall).toBeDefined()
    // Le savId = 1 (extrait de route.params.id par le composable)
    expect(String(parseCall?.url)).toContain('id=1')

    // Preview affiche les données (état 'previewing' atteint)
    expect(rootWrapper.find('[data-testid="preview-panel"]').exists()).toBe(true)
    expect(rootWrapper.find('[data-testid="preview-reference"]').text()).toContain('278_26S21_11')
    expect(rootWrapper.find('[data-testid="preview-albaran"]').text()).toContain('3127')
    expect(rootWrapper.find('[data-testid="preview-fecha-albaran"]').text()).toContain('2026-05-20')
    expect(rootWrapper.find('[data-testid="preview-facture-groupe-count"]').text()).toBe('2')
    expect(rootWrapper.find('[data-testid="preview-bdd-count"]').text()).toBe('2')
  })
})

// ===========================================================================
// AC #12(d) — Échec parse (422/415) → toast d'erreur, écran reste ouvert (VRAI composant)
// M-2-bis fix : exercice du composable useSupplierClaimUpload réel, état 'error'
// ===========================================================================

describe('SC-05: Gestion d\'erreur parse (AC #12d, M-2-bis fix — VRAI SupplierClaimView)', () => {
  it('SC-05a: parse retourne 422 → toast erreur affiché sur le VRAI composant, vue reste ouverte, aucune persistance', async () => {
    const ctrl = makeFetchController(buildSavPayload('validated'))
    ctrl.onceFor(
      (url, method) => method === 'POST' && url.includes('op=parse-supplier-file'),
      {
        status: 422,
        body: { error: { code: 'UNPROCESSABLE_ENTITY', message: 'Fichier non lisible — fournir un .xlsx valide' } },
      }
    )

    const { rootWrapper } = await mountRealSupplierClaimView(1)

    // Sanity : VRAI composant monté
    expect(rootWrapper.find('[data-testid="supplier-claim-view"]').exists()).toBe(true)
    // Pas encore en état erreur
    expect(rootWrapper.find('[data-testid="parse-error-toast"]').exists()).toBe(false)

    // Déclencher l'upload avec un fichier "corrompu"
    const fakeFile = new File([new Uint8Array([0x50, 0x4b])], 'corrupted.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const input = rootWrapper.find('[data-testid="file-input"]')
    await setInputFiles(input.element as HTMLInputElement, [fakeFile], rootWrapper)
    await flushPromises()

    // Toast d'erreur visible (état 'error' du composable useSupplierClaimUpload)
    const errorToast = rootWrapper.find('[data-testid="parse-error-toast"]')
    expect(errorToast.exists()).toBe(true)
    expect(errorToast.text()).toMatch(/fichier|lisible|erreur|xlsx/i)

    // Vue reste montée (non-unmounted — AC #12d)
    expect(rootWrapper.find('[data-testid="supplier-claim-view"]').exists()).toBe(true)
    // Aucune preview affichée (état error, pas previewing)
    expect(rootWrapper.find('[data-testid="preview-panel"]').exists()).toBe(false)

    // Aucune autre requête POST envoyée (pas de persistance — 0 side-effect serveur)
    const otherPosts = ctrl.calls.filter(
      (c) => c.method === 'POST' && !String(c.url).includes('op=parse-supplier-file')
    )
    expect(otherPosts).toHaveLength(0)
  })

  it('SC-05b: parse retourne 415 (mauvais type) → toast d\'erreur sur le VRAI composant, vue reste ouverte', async () => {
    const ctrl = makeFetchController(buildSavPayload('validated'))
    ctrl.onceFor(
      (url, method) => method === 'POST' && url.includes('op=parse-supplier-file'),
      { status: 415, body: { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Type de fichier non supporté.' } } }
    )

    const { rootWrapper } = await mountRealSupplierClaimView(1)

    const fakePdf = new File([Buffer.from('%PDF-1.4')], 'document.pdf', { type: 'application/pdf' })
    const input = rootWrapper.find('[data-testid="file-input"]')
    await setInputFiles(input.element as HTMLInputElement, [fakePdf], rootWrapper)
    await flushPromises()

    // Toast d'erreur visible (composable useSupplierClaimUpload en état 'error')
    expect(rootWrapper.find('[data-testid="parse-error-toast"]').exists()).toBe(true)
    // Vue reste ouverte (AC #12d)
    expect(rootWrapper.find('[data-testid="supplier-claim-view"]').exists()).toBe(true)
    // Aucune persistance
    const otherPosts = ctrl.calls.filter(
      (c) => c.method === 'POST' && !String(c.url).includes('op=parse-supplier-file')
    )
    expect(otherPosts).toHaveLength(0)
  })
})
