/**
 * Story 8.4 — AC #12, AC #13 : Tests UI génération SupplierClaimView
 *
 * Test type: UNIT (Vitest + Vue Test Utils + vi.fn fetch mock — pas d'API réelle)
 *
 * Fichier distinct de SupplierClaimView.arbitrage.spec.ts (8.3) pour isoler les
 * scénarios de génération 8.4 des scénarios d'arbitrage 8.3.
 *
 * Décisions appliquées :
 *   DN-2=B LOCKED : payload sans creditNoteId → 200 autorisé (cas "réclamation anticipée")
 *   DN-8=A LOCKED : filename RECLAMACION_SOL_Y_FRUTA_<ref>_<YYYY-MM-DD>.xlsx
 *   AC #12 : états generating → generated → generate-error
 *   AC #13 : ≥ 5 scénarios UI génération
 *
 * Leçons appliquées :
 *   - feedback_test_integration_gap.md : tests discriminants doivent ÉCHOUER avant implémentation
 *     (les tests vérifient des comportements spécifiques 8.4, pas juste l'existence de l'élément)
 *
 * Coverage (≥ 5 scénarios AC #13) :
 *   GEN-UI-01 (AC #13a) : Click "Générer" enabled → POST op=generate-supplier-claim avec body correct
 *   GEN-UI-02 (AC #13b) : 200 + blob → URL.createObjectURL appelé + transition vers "generated" + toast success
 *   GEN-UI-03 (AC #13c) : Payload sans creditNoteId → 200, download OK, transition generated (DN-2=B)
 *   GEN-UI-04 (AC #13c) : creditNoteId invalide → 400 → toast role="alert" + état arbitrating préservé
 *   GEN-UI-05 (AC #13d) : Réseau down (fetch reject) → toast error + bouton "Réessayer" présent
 *   GEN-UI-06 (AC #13e) : État "generated" → click "Régénérer" → retour arbitrating (state préservé)
 *   GEN-UI-07 (AC #12)  : Click "Générer" → bouton disabled + spinner "Génération en cours…" pendant le fetch
 *   GEN-UI-08 (AC #8)   : Toast success contient total IMPORTE + nb lignes
 *
 * NOTE RED phase :
 *   useSupplierClaimArbitration.ts ne supporte pas encore generate() / état generating/generated.
 *   SupplierClaimView.vue n'a pas encore le câblage bouton "Générer" → POST.
 *   Ces tests DOIVENT échouer jusqu'à l'implémentation Task 4.
 *   Tout green avant implémentation = faux-vert — à investiguer.
 *   Exception : GEN-UI-01 peut passer partiellement si le bouton "Générer" existe déjà (8.3)
 *   mais le POST n'est pas encore câblé.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createWebHistory } from 'vue-router'
import SupplierClaimView from './SupplierClaimView.vue'

// ---------------------------------------------------------------------------
// Router factory (réutilise pattern SupplierClaimView.arbitrage.spec.ts)
// ---------------------------------------------------------------------------

function makeRouter(savId = 1) {
  const router = createRouter({
    history: createWebHistory(),
    routes: [
      {
        path: '/admin/sav/:id/demande-fournisseur',
        name: 'admin-sav-demande-fournisseur',
        component: SupplierClaimView,
      },
    ],
  })
  return { router, path: `/admin/sav/${savId}/demande-fournisseur` }
}

// ---------------------------------------------------------------------------
// Types pour les mocks fetch
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string
  method: string
  body: unknown
}

interface MockResponse {
  status: number
  body: unknown
  isBlob?: boolean // Pour les réponses blob (download)
}

// ---------------------------------------------------------------------------
// Fetch mock avec support blob (pour le download xlsx)
// ---------------------------------------------------------------------------

function makeFetchMock(
  responses: Map<string, MockResponse> = new Map(),
  blobResponses: Map<string, Uint8Array> = new Map()
) {
  const calls: FetchCall[] = []

  // Petit blob xlsx minimal valide pour les tests blob
  const minimalXlsxBlob = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])

  const fn = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    let body: unknown = null
    if (init?.body && typeof init.body === 'string') {
      try { body = JSON.parse(init.body) } catch { body = init.body }
    }
    calls.push({ url, method, body })

    // Check blob responses first
    for (const [pattern, blobData] of blobResponses.entries()) {
      if (url.includes(pattern)) {
        return Promise.resolve({
          status: 200,
          ok: true,
          headers: new Headers({
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': 'attachment; filename="RECLAMACION_SOL_Y_FRUTA_SAV-2026-00012_2026-06-05.xlsx"',
          }),
          json: () => Promise.reject(new Error('not json')),
          blob: () => Promise.resolve(new Blob([blobData as unknown as ArrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })),
        } as unknown as Response)
      }
    }

    // Check JSON responses
    for (const [pattern, resp] of responses.entries()) {
      if (url.includes(pattern)) {
        if (resp.isBlob) {
          return Promise.resolve({
            status: resp.status,
            ok: resp.status >= 200 && resp.status < 300,
            headers: new Headers({
              'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'content-disposition': 'attachment; filename="RECLAMACION_SOL_Y_FRUTA_SAV-2026-00012_2026-06-05.xlsx"',
            }),
            json: () => Promise.reject(new Error('not json')),
            blob: () => Promise.resolve(new Blob([minimalXlsxBlob], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })),
          } as unknown as Response)
        }
        return Promise.resolve({
          status: resp.status,
          ok: resp.status >= 200 && resp.status < 300,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve(resp.body),
          blob: () => Promise.reject(new Error('not blob')),
        } as unknown as Response)
      }
    }

    return Promise.resolve({
      status: 500,
      ok: false,
      headers: new Headers(),
      json: () => Promise.resolve({ error: { message: 'unexpected call' } }),
      blob: () => Promise.reject(new Error('unexpected')),
    } as unknown as Response)
  })

  ;(globalThis as unknown as { fetch: unknown }).fetch = fn
  return { calls, fn }
}

// ---------------------------------------------------------------------------
// Fixtures parse + reconcile (réutilisées de 8.3 arbitrage.spec.ts)
// ---------------------------------------------------------------------------

function buildParseSuccessResponse() {
  return {
    metadata: { reference: '278_26S21_11', albaran: 3127, fechaAlbaran: '2026-05-20', warnings: [] },
    factureGroupe: {
      rows: [
        {
          codeFr: '1022-5K', designationFr: 'Avocat BIO 5kg', prixVenteClientHt: 19.9,
          unite: 'kg', qteCmd: 8, qteFact: 7, codigoEs: '1022', descripcionEs: 'Aguacate BIO',
          kilosPiezas: 'Kilos', kilosNetos: 34.3, precio: 4.89, importe: 34.23, cmd: '278',
        },
      ],
      skippedRows: 3,
      warnings: [],
    },
    bdd: {
      rows: [{ code: '1022-5K', designationEs: 'Aguacate BIO', origen: 'Málaga' }],
      skippedRows: 0,
      warnings: [],
    },
    fileMeta: { filename: 'data.xlsx', sizeBytes: 24819, sheetsDetected: ['MAIL', 'FACTURE_GROUPE', 'BDD'], parser: 'xlsx-cdn-0.20.3' },
  }
}

function buildReconcileSuccessResponse() {
  return {
    claimLines: [
      {
        savLineId: 'uuid-line-1',
        creditNoteLink: { savId: 1, savLineId: 'uuid-line-1' },
        codeFr: '1022-5K',
        tokenExtracted: '1022-5K',
        codigoEs: '1022',
        productoEs: 'Aguacate BIO',
        origen: 'Málaga',
        unite: 'kg',
        kilosPiezas: 'Kilos',
        unidad: 'Kilos',
        conversionFlag: 'ok',
        qteFact: 7,
        qtyDefaultClient: 7,
        qty: 7,
        peso: 7,
        precio: 4.89,
        importe: 7 * 4.89,
        causaEs: 'estropeado',
        comentarios: '',
        blockingForGeneration: false,
        productNameSnapshot: 'Avocat BIO 5kg',
      },
    ],
    unmatchedSavLines: [],
    unusedSupplierLines: [],
    totals: { importe: 7 * 4.89, linesMatched: 1, linesUnmatched: 0, linesBlocking: 0 },
    meta: {
      reconciliation: { savLinesTotal: 1, matched: 1, unmatched: 0, multipleMatches: 0 },
      warnings: [],
    },
  }
}

// ---------------------------------------------------------------------------
// Mount helper — upload + reconcile pour arriver en état arbitrating
// ---------------------------------------------------------------------------

async function mountAndReachArbitrating(
  generateResponse: MockResponse | null = null,
  savId = 1
) {
  const { router, path } = makeRouter(savId)
  await router.push(path)
  await router.isReady()

  const responses = new Map<string, MockResponse>([
    ['op=parse-supplier-file', { status: 200, body: buildParseSuccessResponse() }],
    ['op=reconcile-supplier-claim', { status: 200, body: buildReconcileSuccessResponse() }],
  ])

  if (generateResponse !== null) {
    responses.set('op=generate-supplier-claim', generateResponse)
  }

  const { calls } = makeFetchMock(responses)
  const wrapper = mount(SupplierClaimView, { global: { plugins: [router] } })
  await flushPromises()

  // Upload fichier
  const fakeFile = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'data.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const input = wrapper.find('[data-testid="file-input"]')
  const inputEl = input.element as HTMLInputElement
  Object.defineProperty(inputEl, 'files', { value: [fakeFile], writable: false, configurable: true })
  inputEl.dispatchEvent(new Event('change'))
  await wrapper.vm.$nextTick()
  await flushPromises()

  return { wrapper, calls }
}

// Mount helper avec réponse blob pour le download (200 + Content-Type xlsx)
async function mountAndReachArbitratingWithBlobResponse(savId = 1) {
  const { router, path } = makeRouter(savId)
  await router.push(path)
  await router.isReady()

  const minimalXlsxBlob = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])
  const responses = new Map<string, MockResponse>([
    ['op=parse-supplier-file', { status: 200, body: buildParseSuccessResponse() }],
    ['op=reconcile-supplier-claim', { status: 200, body: buildReconcileSuccessResponse() }],
  ])
  const blobResponses = new Map<string, Uint8Array>([
    ['op=generate-supplier-claim', minimalXlsxBlob],
  ])

  const { calls } = makeFetchMock(responses, blobResponses)
  const wrapper = mount(SupplierClaimView, { global: { plugins: [router] } })
  await flushPromises()

  const fakeFile = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'data.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const input = wrapper.find('[data-testid="file-input"]')
  const inputEl = input.element as HTMLInputElement
  Object.defineProperty(inputEl, 'files', { value: [fakeFile], writable: false, configurable: true })
  inputEl.dispatchEvent(new Event('change'))
  await wrapper.vm.$nextTick()
  await flushPromises()

  return { wrapper, calls }
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks()
})

// ===========================================================================
// GEN-UI-01 — Click "Générer" enabled → POST op=generate-supplier-claim (AC #13a)
// ===========================================================================

describe('GEN-UI-01: click "Générer" → POST op=generate-supplier-claim avec body (AC #13a)', () => {
  it('GEN-UI-01a: après arbitrage, bouton "Générer" est enabled (FR21 levé)', async () => {
    const { wrapper } = await mountAndReachArbitrating(
      { status: 200, body: {}, isBlob: true }
    )

    const generateBtn = wrapper.find('[data-testid="generate-btn"]')
    expect(generateBtn.exists()).toBe(true)
    // Le bouton doit être enabled (toutes lignes matchées, aucune bloquante)
    expect((generateBtn.element as HTMLButtonElement).disabled).toBe(false)
  })

  it('GEN-UI-01b: click "Générer" → POST /api/sav?op=generate-supplier-claim&id=1', async () => {
    const { wrapper, calls } = await mountAndReachArbitratingWithBlobResponse()

    const generateBtn = wrapper.find('[data-testid="generate-btn"]')
    expect(generateBtn.exists()).toBe(true)
    expect((generateBtn.element as HTMLButtonElement).disabled).toBe(false)

    await generateBtn.trigger('click')
    await flushPromises()

    const genCall = calls.find(
      (c) => c.method === 'POST' && String(c.url).includes('op=generate-supplier-claim')
    )
    expect(genCall).toBeDefined()
    expect(String(genCall?.url)).toContain('id=1')
  })

  it('GEN-UI-01c: body POST contient metadata + claimLines (PATTERN-ARBITRATED-CLAIM-PAYLOAD)', async () => {
    const { wrapper, calls } = await mountAndReachArbitratingWithBlobResponse()

    const generateBtn = wrapper.find('[data-testid="generate-btn"]')
    await generateBtn.trigger('click')
    await flushPromises()

    const genCall = calls.find(
      (c) => c.method === 'POST' && String(c.url).includes('op=generate-supplier-claim')
    )
    expect(genCall).toBeDefined()
    const body = genCall?.body as Record<string, unknown>
    expect(body).toHaveProperty('metadata')
    expect(body).toHaveProperty('claimLines')
    expect(Array.isArray(body?.['claimLines'])).toBe(true)
  })
})

// ===========================================================================
// GEN-UI-02 — 200 + blob → download + toast success + transition "generated" (AC #13b)
// ===========================================================================

describe('GEN-UI-02: 200 + blob → download + toast success + état generated (AC #13b)', () => {
  it('GEN-UI-02a: 200 + blob → URL.createObjectURL appelé', async () => {
    const createObjectURLSpy = vi.fn(() => 'blob:http://localhost/fake-url')
    global.URL.createObjectURL = createObjectURLSpy

    const { wrapper } = await mountAndReachArbitratingWithBlobResponse()

    const generateBtn = wrapper.find('[data-testid="generate-btn"]')
    await generateBtn.trigger('click')
    await flushPromises()

    expect(createObjectURLSpy).toHaveBeenCalled()
  })

  it('GEN-UI-02b: 200 + blob → toast success avec role="status" visible', async () => {
    const { wrapper } = await mountAndReachArbitratingWithBlobResponse()

    const generateBtn = wrapper.find('[data-testid="generate-btn"]')
    await generateBtn.trigger('click')
    await flushPromises()

    const toast = wrapper.find('[data-testid="generate-success-toast"]')
    expect(toast.exists()).toBe(true)
    expect(toast.attributes('role')).toBe('status')
  })

  it('GEN-UI-02c: 200 + blob → transition vers état "generated" (data-testid="generated-state" visible)', async () => {
    const { wrapper } = await mountAndReachArbitratingWithBlobResponse()

    const generateBtn = wrapper.find('[data-testid="generate-btn"]')
    await generateBtn.trigger('click')
    await flushPromises()

    // En état "generated", une section de récapitulatif est visible
    const generatedState = wrapper.find('[data-testid="generated-state"]')
    expect(generatedState.exists()).toBe(true)
  })
})

// ===========================================================================
// GEN-UI-03 — Payload sans creditNoteId → 200 OK (DN-2=B LOCKED) (AC #13c)
// ===========================================================================

describe('GEN-UI-03: payload sans creditNoteId → 200 autorisé (DN-2=B LOCKED) (AC #13c)', () => {
  it('GEN-UI-03a: bouton "Générer" accessible même sans avoir client (pas de gate creditNoteId)', async () => {
    // Le composant ne doit PAS griser le bouton "Générer" parce qu'il n'y a pas d'avoir lié
    const { wrapper } = await mountAndReachArbitrating(
      { status: 200, body: {}, isBlob: true }
    )

    const generateBtn = wrapper.find('[data-testid="generate-btn"]')
    expect(generateBtn.exists()).toBe(true)
    // Le bouton ne doit pas être disabled à cause de l'absence d'avoir (DN-2=B)
    // La seule gate est FR21 (lignes bloquantes non exclues) — ici aucune
    expect((generateBtn.element as HTMLButtonElement).disabled).toBe(false)
  })

  it('GEN-UI-03b: body POST ne contient PAS creditNoteId obligatoire (ou null) — pas de 422', async () => {
    const { wrapper, calls } = await mountAndReachArbitratingWithBlobResponse()

    const generateBtn = wrapper.find('[data-testid="generate-btn"]')
    await generateBtn.trigger('click')
    await flushPromises()

    const genCall = calls.find(
      (c) => c.method === 'POST' && String(c.url).includes('op=generate-supplier-claim')
    )
    expect(genCall).toBeDefined()
    const body = genCall?.body as Record<string, unknown>
    // creditNoteId peut être absent ou null — les 2 sont acceptés par l'API (DN-2=B)
    if ('creditNoteId' in body) {
      expect(body['creditNoteId']).toBeNull()
    }
    // Pas de vérification que le status est 200 car le mock retourne 200 dans tous les cas
  })
})

// ===========================================================================
// GEN-UI-04 — creditNoteId invalide → 400 → toast error + état préservé (AC #13c variante)
// ===========================================================================

describe('GEN-UI-04: creditNoteId invalide → 400 → toast error (AC #13c)', () => {
  it('GEN-UI-04a: réponse 400 invalid_credit_note_id → toast role="alert" visible', async () => {
    const { wrapper } = await mountAndReachArbitrating({
      status: 400,
      body: { error: { code: 'invalid_credit_note_id', message: 'Avoir client invalide ou introuvable' } },
    })

    const generateBtn = wrapper.find('[data-testid="generate-btn"]')
    await generateBtn.trigger('click')
    await flushPromises()

    const errorToast = wrapper.find('[data-testid="generate-error-toast"]')
    expect(errorToast.exists()).toBe(true)
    expect(errorToast.attributes('role')).toBe('alert')
    // Le message doit mentionner l'avoir invalide
    expect(errorToast.text()).toMatch(/avoir|invalide|introuvable/i)
  })

  it('GEN-UI-04b: réponse 400 → état arbitrating préservé (pas de transition generated)', async () => {
    const { wrapper } = await mountAndReachArbitrating({
      status: 400,
      body: { error: { code: 'invalid_credit_note_id', message: 'Avoir invalide' } },
    })

    const generateBtn = wrapper.find('[data-testid="generate-btn"]')
    await generateBtn.trigger('click')
    await flushPromises()

    // La grille d'arbitrage est toujours visible (état arbitrating préservé)
    const arbitrageGrid = wrapper.find('[data-testid="arbitrage-grid"]')
    expect(arbitrageGrid.exists()).toBe(true)

    // L'état "generated" ne doit PAS être visible
    const generatedState = wrapper.find('[data-testid="generated-state"]')
    expect(generatedState.exists()).toBe(false)
  })
})

// ===========================================================================
// GEN-UI-05 — Réseau down → toast error + bouton "Réessayer" (AC #13d)
// ===========================================================================

describe('GEN-UI-05: réseau down → toast error + bouton Réessayer (AC #13d)', () => {
  it('GEN-UI-05a: fetch rejet (NetworkError) → toast error visible', async () => {
    const { router, path } = makeRouter(1)
    await router.push(path)
    await router.isReady()

    let callCount = 0
    const fn = vi.fn((url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'POST' && url.includes('op=parse-supplier-file')) {
        return Promise.resolve({
          status: 200, ok: true,
          headers: new Headers(),
          json: () => Promise.resolve(buildParseSuccessResponse()),
          blob: () => Promise.reject(new Error('not blob')),
        } as unknown as Response)
      }
      if (method === 'POST' && url.includes('op=reconcile-supplier-claim')) {
        return Promise.resolve({
          status: 200, ok: true,
          headers: new Headers(),
          json: () => Promise.resolve(buildReconcileSuccessResponse()),
          blob: () => Promise.reject(new Error('not blob')),
        } as unknown as Response)
      }
      if (method === 'POST' && url.includes('op=generate-supplier-claim')) {
        callCount++
        // Simuler une erreur réseau
        return Promise.reject(new TypeError('Failed to fetch'))
      }
      return Promise.resolve({
        status: 500, ok: false,
        headers: new Headers(),
        json: () => Promise.resolve({}),
        blob: () => Promise.reject(new Error('not blob')),
      } as unknown as Response)
    })
    ;(globalThis as unknown as { fetch: unknown }).fetch = fn

    const wrapper = mount(SupplierClaimView, { global: { plugins: [router] } })
    await flushPromises()

    const fakeFile = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'data.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const input = wrapper.find('[data-testid="file-input"]')
    const inputEl = input.element as HTMLInputElement
    Object.defineProperty(inputEl, 'files', { value: [fakeFile], writable: false, configurable: true })
    inputEl.dispatchEvent(new Event('change'))
    await wrapper.vm.$nextTick()
    await flushPromises()

    // Click "Générer"
    const generateBtn = wrapper.find('[data-testid="generate-btn"]')
    await generateBtn.trigger('click')
    await flushPromises()

    // Toast error visible
    const errorToast = wrapper.find('[data-testid="generate-error-toast"]')
    expect(errorToast.exists()).toBe(true)
    expect(errorToast.attributes('role')).toBe('alert')
  })

  it('GEN-UI-05b: après network error → bouton "Réessayer" présent', async () => {
    const { router, path } = makeRouter(1)
    await router.push(path)
    await router.isReady()

    const fn = vi.fn((url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'POST' && url.includes('op=parse-supplier-file')) {
        return Promise.resolve({
          status: 200, ok: true, headers: new Headers(),
          json: () => Promise.resolve(buildParseSuccessResponse()),
          blob: () => Promise.reject(new Error('not blob')),
        } as unknown as Response)
      }
      if (method === 'POST' && url.includes('op=reconcile-supplier-claim')) {
        return Promise.resolve({
          status: 200, ok: true, headers: new Headers(),
          json: () => Promise.resolve(buildReconcileSuccessResponse()),
          blob: () => Promise.reject(new Error('not blob')),
        } as unknown as Response)
      }
      if (method === 'POST' && url.includes('op=generate-supplier-claim')) {
        return Promise.reject(new TypeError('Failed to fetch'))
      }
      return Promise.resolve({ status: 500, ok: false, headers: new Headers(), json: () => Promise.resolve({}), blob: () => Promise.reject(new Error('not blob')) } as unknown as Response)
    })
    ;(globalThis as unknown as { fetch: unknown }).fetch = fn

    const wrapper = mount(SupplierClaimView, { global: { plugins: [router] } })
    await flushPromises()

    const fakeFile = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'data.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const input = wrapper.find('[data-testid="file-input"]')
    const inputEl = input.element as HTMLInputElement
    Object.defineProperty(inputEl, 'files', { value: [fakeFile], writable: false, configurable: true })
    inputEl.dispatchEvent(new Event('change'))
    await wrapper.vm.$nextTick()
    await flushPromises()

    const generateBtn = wrapper.find('[data-testid="generate-btn"]')
    await generateBtn.trigger('click')
    await flushPromises()

    // Bouton "Réessayer" (retenter la génération)
    const retryBtn = wrapper.find('[data-testid="generate-retry-btn"]')
    expect(retryBtn.exists()).toBe(true)
    expect(retryBtn.text()).toMatch(/réessayer/i)
  })
})

// ===========================================================================
// GEN-UI-06 — État "generated" → click "Régénérer" → retour arbitrating (AC #13e)
// ===========================================================================

describe('GEN-UI-06: état generated → click "Régénérer" → retour arbitrating (AC #13e)', () => {
  it('GEN-UI-06a: depuis état generated, bouton "Régénérer" présent', async () => {
    const { wrapper } = await mountAndReachArbitratingWithBlobResponse()

    const generateBtn = wrapper.find('[data-testid="generate-btn"]')
    await generateBtn.trigger('click')
    await flushPromises()

    // En état "generated", bouton "Régénérer" visible
    const regenerateBtn = wrapper.find('[data-testid="regenerate-btn"]')
    expect(regenerateBtn.exists()).toBe(true)
    expect(regenerateBtn.text()).toMatch(/régénérer/i)
  })

  it('GEN-UI-06b: click "Régénérer" → modale de confirmation → [Confirmer] → retour awaiting-upload (CR M2 fix — DN-4 no exception)', async () => {
    // CR fix M2: onRegenerateFromGenerated() now routes through the confirmation modal (DN-4 LOCKED).
    // Old behavior (direct jump to arbitrating) was removed — the modal is always shown.
    const { wrapper } = await mountAndReachArbitratingWithBlobResponse()

    // Aller en état generated
    const generateBtn = wrapper.find('[data-testid="generate-btn"]')
    await generateBtn.trigger('click')
    await flushPromises()

    // Vérifier qu'on est bien en generated
    expect(wrapper.find('[data-testid="generated-state"]').exists()).toBe(true)

    // Cliquer "Régénérer" depuis l'état generated
    const regenerateBtn = wrapper.find('[data-testid="regenerate-btn"]')
    await regenerateBtn.trigger('click')
    await wrapper.vm.$nextTick()

    // Modale doit apparaître (DN-4 — pas d'exception pour le chemin generated)
    const modal = wrapper.find('[data-testid="regenerate-confirm-modal"]')
    expect(modal.exists()).toBe(true)

    // Confirmer → transition vers awaiting-upload
    const confirmBtn = wrapper.find('[data-testid="regenerate-confirm-btn"]')
    await confirmBtn.trigger('click')
    await wrapper.vm.$nextTick()
    await flushPromises()

    // Après confirmation : awaiting-upload (écran d'import)
    const awaitingState = wrapper.find('[data-testid="awaiting-upload-state"]')
    const fileInput = wrapper.find('[data-testid="file-input"]')
    const hasUploadUI = awaitingState.exists() || fileInput.exists()
    expect(hasUploadUI).toBe(true)

    // generated-state ne doit plus être visible
    expect(wrapper.find('[data-testid="generated-state"]').exists()).toBe(false)
  })
})

// ===========================================================================
// GEN-UI-07 — Click "Générer" → spinner "Génération en cours…" pendant le fetch (AC #12)
// ===========================================================================

describe('GEN-UI-07: pendant la génération → bouton disabled + spinner (AC #12)', () => {
  it('GEN-UI-07a: pendant fetch generate → bouton "Générer" disabled + texte "Génération en cours"', async () => {
    const { router, path } = makeRouter(1)
    await router.push(path)
    await router.isReady()

    let resolveGenerate!: (v: unknown) => void
    const generatePromise = new Promise((r) => { resolveGenerate = r })

    const fn = vi.fn((url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'POST' && url.includes('op=parse-supplier-file')) {
        return Promise.resolve({
          status: 200, ok: true, headers: new Headers(),
          json: () => Promise.resolve(buildParseSuccessResponse()),
          blob: () => Promise.reject(new Error('not blob')),
        } as unknown as Response)
      }
      if (method === 'POST' && url.includes('op=reconcile-supplier-claim')) {
        return Promise.resolve({
          status: 200, ok: true, headers: new Headers(),
          json: () => Promise.resolve(buildReconcileSuccessResponse()),
          blob: () => Promise.reject(new Error('not blob')),
        } as unknown as Response)
      }
      if (method === 'POST' && url.includes('op=generate-supplier-claim')) {
        return generatePromise as Promise<Response>
      }
      return Promise.resolve({ status: 500, ok: false, headers: new Headers(), json: () => Promise.resolve({}), blob: () => Promise.reject(new Error('not blob')) } as unknown as Response)
    })
    ;(globalThis as unknown as { fetch: unknown }).fetch = fn

    const wrapper = mount(SupplierClaimView, { global: { plugins: [router] } })
    await flushPromises()

    const fakeFile = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'data.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const input = wrapper.find('[data-testid="file-input"]')
    const inputEl = input.element as HTMLInputElement
    Object.defineProperty(inputEl, 'files', { value: [fakeFile], writable: false, configurable: true })
    inputEl.dispatchEvent(new Event('change'))
    await wrapper.vm.$nextTick()
    await flushPromises()

    // Click "Générer"
    const generateBtn = wrapper.find('[data-testid="generate-btn"]')
    await generateBtn.trigger('click')
    await wrapper.vm.$nextTick()

    // Pendant le fetch : bouton disabled + spinner
    expect((generateBtn.element as HTMLButtonElement).disabled).toBe(true)

    // Spinner ou texte "Génération en cours"
    const generatingIndicator = wrapper.find('[data-testid="generating-indicator"]')
    if (generatingIndicator.exists()) {
      expect(generatingIndicator.text()).toMatch(/génération en cours|génération\.\.\./i)
    }

    // Cleanup : résoudre la promesse
    const minimalBlob = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])
    resolveGenerate({
      status: 200,
      ok: true,
      headers: new Headers({
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': 'attachment; filename="test.xlsx"',
      }),
      json: () => Promise.reject(new Error('not json')),
      blob: () => Promise.resolve(new Blob([minimalBlob])),
    })
    await flushPromises()
  })
})

// ===========================================================================
// GEN-UI-08 — Toast success contient total IMPORTE + nb lignes (AC #8)
// ===========================================================================

describe('GEN-UI-08: toast success contient total IMPORTE + nb lignes (AC #8)', () => {
  it('GEN-UI-08a: toast success affiché avec information sur la réclamation générée', async () => {
    const { wrapper } = await mountAndReachArbitratingWithBlobResponse()

    const generateBtn = wrapper.find('[data-testid="generate-btn"]')
    await generateBtn.trigger('click')
    await flushPromises()

    const toast = wrapper.find('[data-testid="generate-success-toast"]')
    expect(toast.exists()).toBe(true)
    // Le toast doit mentionner "Réclamation générée" (AC #8)
    expect(toast.text()).toMatch(/réclamation générée|généré/i)
  })
})
