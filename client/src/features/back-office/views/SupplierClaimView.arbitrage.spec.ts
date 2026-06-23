/**
 * Story 8.3 — AC #11 : Tests UI grille d'arbitrage (SupplierClaimView.vue extension)
 *
 * Test type: UNIT (Vitest + Vue Test Utils + vi.fn fetch mock — no real API call)
 *
 * Decisions baked in (all DNs resolved):
 *   DN-1 = step="any" (free decimals)
 *   DN-2 = NEW composable useSupplierClaimArbitration consumed by SupplierClaimView
 *   DN-3 = Map<savLineId, {...}> client-side state
 *   DN-4 = NO draft persistence; beforeunload guard tested (not persistence)
 *   DN-5 = server-side cap DEFERRED to 8.4; client-side clamp only
 *   DN-6 = "Générer le document" button present but disabled in 8.3
 *   DN-7 = this file: views/SupplierClaimView.arbitrage.spec.ts
 *
 * AC #11 coverage (≥ 12 scenarios):
 *   ARB-UI-01 (AC #11a): transition reconciling → arbitrating (composable calls reconcile-supplier-claim, grid shown)
 *   ARB-UI-02 (AC #11b): transition reconcile-error (500 → toast + "Réessayer" button)
 *   ARB-UI-03 (AC #11c): grid render — claimLines.length===2 → 2 rows with correct columns
 *   ARB-UI-04 (AC #11d): edit qty → IMPORTE line recalculated
 *   ARB-UI-05 (AC #11e): edit qty on 2 lines → total = correct sum
 *   ARB-UI-06 (AC #11f): clamp qty > qteFact → clamped to qteFact + inline message
 *   ARB-UI-07 (AC #11g): clamp qty < 0 → clamped to 0
 *   ARB-UI-08 (AC #11h): exclusion toggle — line greyed + inputs disabled + total recalculated
 *   ARB-UI-09 (AC #11i): re-include — line re-activated + total includes it again
 *   ARB-UI-10 (AC #11j): comment input — state updated; conversionFlag≠ok → pre-filled
 *   ARB-UI-11 (AC #11k): generation gate FR21 — 1 unmatched not excluded → "Générer" disabled
 *   ARB-UI-12 (AC #11l): generation gate with blocking claimLine → "Générer" disabled
 *   ARB-UI-13 (AC #11m): unmatched/unused sections render correctly + hidden when empty
 *   ARB-UI-14 (AC #10): beforeunload listener present when state is arbitrated (no persistence)
 *   ARB-UI-15 (AC #1):  reconciling indicator shown (aria-live) during API call
 *   ARB-UI-16 (AC #8):  generate button: inline reason message when blocked
 *   ARB-UI-17 (AC #2):  blockingForGeneration=true row has data-testid="row-blocking"
 *   ARB-UI-18 (AC #11k resolved): exclude unmatched → "Générer" becomes enabled
 *
 * Mock strategy:
 *   - fetch: vi.fn stubbed globally (pattern from SupplierClaimView.spec.ts)
 *   - router: createRouter with stub route for savId param
 *   - reconcile-supplier-claim op: mocked via fetch stub
 *   - useSupplierClaimUpload: state set to 'previewing' via direct injection or by triggering
 *     the real upload flow and stubbing parse-supplier-file, then letting reconcile run
 *
 * NOTE (ATDD RED phase):
 *   SupplierClaimView.vue does not yet render the arbitrage grid.
 *   useSupplierClaimArbitration.ts does not yet exist.
 *   These tests MUST fail (component mount may pass, but arbitrage assertions fail).
 *   Green before Task 2 implementation = false-green.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createWebHistory } from 'vue-router'
import SupplierClaimView from './SupplierClaimView.vue'

// ---------------------------------------------------------------------------
// Router factory — matches story pattern from SupplierClaimView.spec.ts
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
// Fetch mock helper — same structure as SupplierClaimView.spec.ts
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string
  method: string
  body: unknown
}

interface MockResponse {
  status: number
  body: unknown
}

function makeFetchMock(responses: Map<string, MockResponse> = new Map()) {
  const calls: FetchCall[] = []

  const fn = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    let body: unknown = null
    if (init?.body && typeof init.body === 'string') {
      try { body = JSON.parse(init.body) } catch { body = init.body }
    }
    calls.push({ url, method, body })

    // Match against registered responses by url substring
    for (const [pattern, resp] of responses.entries()) {
      if (url.includes(pattern)) {
        return Promise.resolve({
          status: resp.status,
          ok: resp.status >= 200 && resp.status < 300,
          json: () => Promise.resolve(resp.body),
        } as unknown as Response)
      }
    }

    // Default: 500
    return Promise.resolve({
      status: 500,
      ok: false,
      json: () => Promise.resolve({ error: { message: 'unexpected call' } }),
    } as unknown as Response)
  })

  ;(globalThis as unknown as { fetch: unknown }).fetch = fn
  return { calls, fn }
}

// ---------------------------------------------------------------------------
// Fixture: parse-supplier-file success response (reused from 8.1 spec)
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
        {
          codeFr: '3301-1K', designationFr: 'Tomate 1kg', prixVenteClientHt: 8.75,
          unite: 'kg', qteCmd: 20, qteFact: 18, codigoEs: '3301', descripcionEs: 'Tomate',
          kilosPiezas: 'Kilos', kilosNetos: 18.0, precio: 3.2, importe: 57.6, cmd: '278',
        },
      ],
      skippedRows: 3,
      warnings: [],
    },
    bdd: {
      rows: [
        { code: '1022-5K', designationEs: 'Aguacate BIO', origen: 'Málaga' },
        { code: '3301-1K', designationEs: 'Tomate Fresco', origen: 'Almería' },
      ],
      skippedRows: 0,
      warnings: [],
    },
    fileMeta: { filename: 'data.xlsx', sizeBytes: 24819, sheetsDetected: ['MAIL', 'FACTURE_GROUPE', 'BDD'], parser: 'xlsx-cdn-0.20.3' },
  }
}

// ---------------------------------------------------------------------------
// Fixture: reconcile-supplier-claim success response (8.2 AC #7 contract)
// ---------------------------------------------------------------------------

function buildReconcileSuccessResponse(overrides: {
  claimLines?: object[]
  unmatchedSavLines?: object[]
  unusedSupplierLines?: object[]
} = {}) {
  return {
    claimLines: overrides.claimLines ?? [
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
      {
        savLineId: 'uuid-line-2',
        creditNoteLink: { savId: 1, savLineId: 'uuid-line-2' },
        codeFr: '3301-1K',
        tokenExtracted: '3301-1K',
        codigoEs: '3301',
        productoEs: 'Tomate Fresco',
        origen: 'Almería',
        unite: 'kg',
        kilosPiezas: 'Kilos',
        unidad: 'Kilos',
        conversionFlag: 'ok',
        qteFact: 18,
        qtyDefaultClient: 18,
        qty: 18,
        peso: 18,
        precio: 3.2,
        importe: 18 * 3.2,
        causaEs: 'estropeado',
        comentarios: '',
        blockingForGeneration: false,
        productNameSnapshot: 'Tomate 1kg',
      },
    ],
    unmatchedSavLines: overrides.unmatchedSavLines ?? [],
    unusedSupplierLines: overrides.unusedSupplierLines ?? [],
    totals: { importe: 7 * 4.89 + 18 * 3.2, linesMatched: 2, linesUnmatched: 0, linesBlocking: 0 },
    meta: {
      reconciliation: { savLinesTotal: 2, matched: 2, unmatched: 0, multipleMatches: 0 },
      warnings: [],
    },
  }
}

// ---------------------------------------------------------------------------
// Mount helper — triggers upload flow then lets reconcile run
// Returns wrapper after reconcile response
// ---------------------------------------------------------------------------

async function mountAndUploadAndReconcile(
  reconcileResponse: MockResponse,
  savId = 1
) {
  const { router, path } = makeRouter(savId)
  await router.push(path)
  await router.isReady()

  const responses = new Map<string, MockResponse>([
    ['op=parse-supplier-file', { status: 200, body: buildParseSuccessResponse() }],
    ['op=reconcile-supplier-claim', reconcileResponse],
  ])
  const { calls } = makeFetchMock(responses)

  const wrapper = mount(SupplierClaimView, { global: { plugins: [router] } })
  await flushPromises()

  // Trigger file upload
  const fakeXlsxContent = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])
  const fakeFile = new File([fakeXlsxContent], 'data.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const input = wrapper.find('[data-testid="file-input"]')
  const inputEl = input.element as HTMLInputElement
  Object.defineProperty(inputEl, 'files', { value: [fakeFile], writable: false, configurable: true })
  inputEl.dispatchEvent(new Event('change'))
  await wrapper.vm.$nextTick()
  await flushPromises()

  // At this point: parse returned previewing → composable triggers reconcile → response applied
  return { wrapper, calls }
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks()
})

// ===========================================================================
// ARB-UI-01 — Transition reconciling → arbitrating (AC #11a, AC #1)
// ===========================================================================

describe('ARB-UI-01: transition reconciling → arbitrating (AC #11a, AC #1)', () => {
  it('ARB-UI-01a: after successful upload + reconcile, arbitrage grid is rendered (data-testid="arbitrage-grid")', async () => {
    const { wrapper } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse(),
    })

    // Arbitrage grid must appear in the DOM (state=arbitrating)
    expect(wrapper.find('[data-testid="arbitrage-grid"]').exists()).toBe(true)
  })

  it('ARB-UI-01b: POST to op=reconcile-supplier-claim is called after upload success', async () => {
    const { calls } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse(),
    })

    const reconcileCall = calls.find(
      (c) => c.method === 'POST' && String(c.url).includes('op=reconcile-supplier-claim')
    )
    expect(reconcileCall).toBeDefined()
    expect(String(reconcileCall?.url)).toContain('id=1')
  })
})

// ===========================================================================
// ARB-UI-02 — Transition reconcile-error: toast + "Réessayer" button (AC #11b, AC #1)
// ===========================================================================

describe('ARB-UI-02: reconcile-error state — toast + retry button (AC #11b, AC #1)', () => {
  it('ARB-UI-02a: reconcile returns 500 → reconcile-error toast shown (role="alert")', async () => {
    const { wrapper } = await mountAndUploadAndReconcile({ status: 500, body: { error: { message: 'Internal error' } } })

    const toast = wrapper.find('[data-testid="reconcile-error-toast"]')
    expect(toast.exists()).toBe(true)
    expect(toast.attributes('role')).toBe('alert')
    expect(toast.text()).toMatch(/pré-remplissage impossible|réessayer|réimporter/i)
  })

  it('ARB-UI-02b: reconcile error → "Réessayer" button present', async () => {
    const { wrapper } = await mountAndUploadAndReconcile({ status: 500, body: { error: { message: 'fail' } } })

    const retryBtn = wrapper.find('[data-testid="reconcile-retry-btn"]')
    expect(retryBtn.exists()).toBe(true)
    expect(retryBtn.text()).toMatch(/réessayer/i)
  })

  it('ARB-UI-02c: reconcile error → arbitrage grid NOT shown', async () => {
    const { wrapper } = await mountAndUploadAndReconcile({ status: 500, body: { error: { message: 'fail' } } })

    expect(wrapper.find('[data-testid="arbitrage-grid"]').exists()).toBe(false)
  })
})

// ===========================================================================
// ARB-UI-03 — Grid render: 2 claimLines → 2 rows with correct columns (AC #11c, AC #2)
// ===========================================================================

describe('ARB-UI-03: arbitrage grid render — 2 claimLines → 2 rows (AC #11c, AC #2)', () => {
  it('ARB-UI-03a: 2 claimLines → 2 data-testid="arbitrage-row-<savLineId>" in DOM', async () => {
    const { wrapper } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse(),
    })

    const row1 = wrapper.find('[data-testid="arbitrage-row-uuid-line-1"]')
    const row2 = wrapper.find('[data-testid="arbitrage-row-uuid-line-2"]')
    expect(row1.exists()).toBe(true)
    expect(row2.exists()).toBe(true)
  })

  it('ARB-UI-03b: each row shows CODIGO (codigoEs) in read-only cell', async () => {
    const { wrapper } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse(),
    })

    const row1 = wrapper.find('[data-testid="arbitrage-row-uuid-line-1"]')
    expect(row1.text()).toContain('1022')
  })

  it('ARB-UI-03c: each row has qty input (data-testid="qty-input-<savLineId>") of type number', async () => {
    const { wrapper } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse(),
    })

    const qtyInput = wrapper.find('[data-testid="qty-input-uuid-line-1"]')
    expect(qtyInput.exists()).toBe(true)
    expect(qtyInput.attributes('type')).toBe('number')
    expect(qtyInput.attributes('min')).toBe('0')
    // max should equal qteFact (7 for line 1)
    expect(qtyInput.attributes('max')).toBe('7')
    // step should be "any" per DN-1
    expect(qtyInput.attributes('step')).toBe('any')
  })

  it('ARB-UI-03d: qty input initial value = qty from claimLine (7 for line 1)', async () => {
    const { wrapper } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse(),
    })

    const qtyInput = wrapper.find('[data-testid="qty-input-uuid-line-1"]')
    const inputEl = qtyInput.element as HTMLInputElement
    expect(Number(inputEl.value)).toBe(7)
  })

  it('ARB-UI-03e: IMPORTE cell rendered (data-testid="importe-uuid-line-1") with formatted value', async () => {
    const { wrapper } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse(),
    })

    const importeCell = wrapper.find('[data-testid="importe-uuid-line-1"]')
    expect(importeCell.exists()).toBe(true)
    // 7 × 4.89 = 34.23
    expect(importeCell.text()).toContain('34,23')
  })
})

// ===========================================================================
// ARB-UI-04 — Edit qty → IMPORTE line recalculated (AC #11d, AC #4)
// ===========================================================================

describe('ARB-UI-04: edit qty → IMPORTE line recalculated (AC #11d, AC #4)', () => {
  it('ARB-UI-04a: set qty=3 on line 1 → importe = 3 × 4.89 = 14.67', async () => {
    const { wrapper } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse(),
    })

    const qtyInput = wrapper.find('[data-testid="qty-input-uuid-line-1"]')
    await qtyInput.setValue('3')
    await wrapper.vm.$nextTick()

    const importeCell = wrapper.find('[data-testid="importe-uuid-line-1"]')
    // 3 × 4.89 = 14.67
    expect(importeCell.text()).toContain('14,67')
  })

  /**
   * ARB-UI-04b (HIGH-2 CR fix): type qty=9999 via @input (NO blur) on a line with qteFact=7
   * → IMPORTE cell and TOTAL must show the CLAMPED product (qteFact×precio), not 9999×precio.
   * This verifies the read-time clamp in computeTotals (not just the blur-time UX clamp).
   *
   * VTU pattern: set inputEl.value directly then dispatch native 'input' event (VTU does not
   * support setting target.value via trigger options — must mutate the element directly).
   */
  it('ARB-UI-04b: type qty=9999 via @input (no blur) on qteFact=7 line → IMPORTE = qteFact×precio (clamped at read time)', async () => {
    const { wrapper } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse(),
    })

    const qtyInput = wrapper.find('[data-testid="qty-input-uuid-line-1"]')
    const inputEl = qtyInput.element as HTMLInputElement

    // Directly set value to simulate typing 9999, then fire the input event
    // (VTU trigger does not allow target.value override — native DOM pattern required)
    inputEl.value = '9999'
    inputEl.dispatchEvent(new Event('input', { bubbles: true }))
    await wrapper.vm.$nextTick()

    // The @input handler in the Vue template calls onQtyInput which calls updateQty with parseFloat('9999')
    // computeTotals clamps at read time: effectiveQty = min(9999, 7) = 7
    const importeCell = wrapper.find('[data-testid="importe-uuid-line-1"]')
    // Clamped: effectiveQty = min(9999, 7) = 7; importe = 7 × 4.89 = 34.23
    // Must NOT show 9999 × 4.89 = 48,895.11
    expect(importeCell.text()).toContain('34,23')
    expect(importeCell.text()).not.toContain('895')

    const totalEl = wrapper.find('[data-testid="arbitrage-total"]')
    // Total line 1 clamped (34.23) + line 2 untouched (18×3.2=57.60) = 91.83
    expect(totalEl.text()).toContain('91,83')
  })
})

// ===========================================================================
// ARB-UI-05 — Edit qty on 2 lines → total = correct sum (AC #11e, AC #4)
// ===========================================================================

describe('ARB-UI-05: edit 2 lines → total recalculated (AC #11e, AC #4)', () => {
  it('ARB-UI-05a: set qty1=3, qty2=5 → total = 3×4.89 + 5×3.2', async () => {
    const { wrapper } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse(),
    })

    await wrapper.find('[data-testid="qty-input-uuid-line-1"]').setValue('3')
    await wrapper.find('[data-testid="qty-input-uuid-line-2"]').setValue('5')
    await wrapper.vm.$nextTick()

    const totalEl = wrapper.find('[data-testid="arbitrage-total"]')
    expect(totalEl.exists()).toBe(true)
    // 3×4.89 + 5×3.2 = 14.67 + 16.00 = 30.67
    expect(totalEl.text()).toContain('30,67')
  })
})

// ===========================================================================
// ARB-UI-06 — Clamp qty > qteFact (AC #11f, AC #3)
// ===========================================================================

describe('ARB-UI-06: clamp qty > qteFact → clamped + inline message (AC #11f, AC #3)', () => {
  it('ARB-UI-06a: enter qty=9999 on line with qteFact=7 → clamped to 7 on blur', async () => {
    const { wrapper } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse(),
    })

    const qtyInput = wrapper.find('[data-testid="qty-input-uuid-line-1"]')
    await qtyInput.setValue('9999')
    // Trigger blur to activate clamping
    await qtyInput.trigger('blur')
    await wrapper.vm.$nextTick()

    const inputEl = qtyInput.element as HTMLInputElement
    expect(Number(inputEl.value)).toBe(7)
  })

  it('ARB-UI-06b: clamp message (aria-live="polite") shown after clamping', async () => {
    const { wrapper } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse(),
    })

    const qtyInput = wrapper.find('[data-testid="qty-input-uuid-line-1"]')
    await qtyInput.setValue('9999')
    await qtyInput.trigger('blur')
    await wrapper.vm.$nextTick()

    const clampMsg = wrapper.find('[data-testid="clamp-msg-uuid-line-1"]')
    expect(clampMsg.exists()).toBe(true)
    expect(clampMsg.attributes('aria-live')).toBe('polite')
    expect(clampMsg.text()).toMatch(/plafonné|facturée|quantité/i)
  })

  it('ARB-UI-06c: no server call made during qty editing (AC #3 — client-side only, DN-5)', async () => {
    const { wrapper, calls } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse(),
    })
    const callCountBefore = calls.length

    const qtyInput = wrapper.find('[data-testid="qty-input-uuid-line-1"]')
    await qtyInput.setValue('3')
    await qtyInput.trigger('blur')
    await wrapper.vm.$nextTick()
    await flushPromises()

    // No new server calls after qty edit
    expect(calls.length).toBe(callCountBefore)
  })
})

// ===========================================================================
// ARB-UI-07 — Clamp qty < 0 → clamped to 0 (AC #11g, AC #3)
// ===========================================================================

describe('ARB-UI-07: clamp qty < 0 → clamped to 0 (AC #11g, AC #3)', () => {
  it('ARB-UI-07a: enter qty=-5 on blur → clamped to 0', async () => {
    const { wrapper } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse(),
    })

    const qtyInput = wrapper.find('[data-testid="qty-input-uuid-line-1"]')
    await qtyInput.setValue('-5')
    await qtyInput.trigger('blur')
    await wrapper.vm.$nextTick()

    const inputEl = qtyInput.element as HTMLInputElement
    expect(Number(inputEl.value)).toBe(0)
  })
})

// ===========================================================================
// ARB-UI-08 — Exclusion toggle: line greyed + inputs disabled + total recalc (AC #11h, AC #7)
// ===========================================================================

describe('ARB-UI-08: exclusion toggle (AC #11h, AC #7)', () => {
  it('ARB-UI-08a: click "Exclure" on line 1 → row gets aria-disabled or visual marker, qty input disabled', async () => {
    const { wrapper } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse(),
    })

    const excludeBtn = wrapper.find('[data-testid="exclude-btn-uuid-line-1"]')
    expect(excludeBtn.exists()).toBe(true)
    await excludeBtn.trigger('click')
    await wrapper.vm.$nextTick()

    const qtyInput = wrapper.find('[data-testid="qty-input-uuid-line-1"]')
    expect((qtyInput.element as HTMLInputElement).disabled).toBe(true)
  })

  it('ARB-UI-08b: after excluding line 1, total excludes its importe', async () => {
    const { wrapper } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse(),
    })

    // Initial total: 7×4.89 + 18×3.2 = 34.23 + 57.6 = 91.83
    const excludeBtn = wrapper.find('[data-testid="exclude-btn-uuid-line-1"]')
    await excludeBtn.trigger('click')
    await wrapper.vm.$nextTick()

    const totalEl = wrapper.find('[data-testid="arbitrage-total"]')
    // After excluding line 1: only line 2 = 18×3.2 = 57.60
    expect(totalEl.text()).toContain('57,60')
  })

  it('ARB-UI-08c: after excluding, button text changes to "Réinclure"', async () => {
    const { wrapper } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse(),
    })

    const excludeBtn = wrapper.find('[data-testid="exclude-btn-uuid-line-1"]')
    await excludeBtn.trigger('click')
    await wrapper.vm.$nextTick()

    // The same button should now say "Réinclure"
    expect(excludeBtn.text()).toMatch(/réinclure/i)
  })
})

// ===========================================================================
// ARB-UI-09 — Re-include: line re-activated + total includes it (AC #11i, AC #7)
// ===========================================================================

describe('ARB-UI-09: re-include toggle (AC #11i, AC #7)', () => {
  it('ARB-UI-09a: exclude then re-include line 1 → qty input enabled again + total restored', async () => {
    const { wrapper } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse(),
    })

    const excludeBtn = wrapper.find('[data-testid="exclude-btn-uuid-line-1"]')
    // Exclude
    await excludeBtn.trigger('click')
    await wrapper.vm.$nextTick()

    // Re-include
    await excludeBtn.trigger('click')
    await wrapper.vm.$nextTick()

    const qtyInput = wrapper.find('[data-testid="qty-input-uuid-line-1"]')
    expect((qtyInput.element as HTMLInputElement).disabled).toBe(false)

    // Total restored: 7×4.89 + 18×3.2 = 91.83
    const totalEl = wrapper.find('[data-testid="arbitrage-total"]')
    expect(totalEl.text()).toContain('91,83')
  })
})

// ===========================================================================
// ARB-UI-10 — Comment input: state updated; conversionFlag≠ok → pre-filled (AC #11j, AC #5)
// ===========================================================================

describe('ARB-UI-10: comment input state + conversionFlag pre-fill (AC #11j, AC #5)', () => {
  it('ARB-UI-10a: typing in comentarios textarea updates state (no server call)', async () => {
    const { wrapper, calls } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse(),
    })
    const callsBefore = calls.length

    const commentInput = wrapper.find('[data-testid="comment-input-uuid-line-1"]')
    expect(commentInput.exists()).toBe(true)
    await commentInput.setValue('Test comment')
    await wrapper.vm.$nextTick()
    await flushPromises()

    // No new server call
    expect(calls.length).toBe(callsBefore)
  })

  it('ARB-UI-10b: line with conversionFlag="ATTENTION A CONVERTIR" → comment pre-filled with flag text', async () => {
    const lineWithFlag = {
      savLineId: 'uuid-line-conv',
      creditNoteLink: { savId: 1, savLineId: 'uuid-line-conv' },
      codeFr: '5555-1K',
      tokenExtracted: '5555-1K',
      codigoEs: '5555',
      productoEs: 'Producto X',
      origen: null,
      unite: 'piece',
      kilosPiezas: 'Kilos',
      unidad: 'Kilos',
      conversionFlag: 'ATTENTION A CONVERTIR',
      qteFact: 5,
      qtyDefaultClient: 5,
      qty: 5,
      peso: 5,
      precio: 2.5,
      importe: 12.5,
      causaEs: 'estropeado',
      comentarios: '',
      blockingForGeneration: false,
      productNameSnapshot: 'Produit X',
    }

    const { wrapper } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse({ claimLines: [lineWithFlag] }),
    })

    const commentInput = wrapper.find('[data-testid="comment-input-uuid-line-conv"]')
    expect(commentInput.exists()).toBe(true)
    const inputEl = commentInput.element as HTMLInputElement | HTMLTextAreaElement
    // AC #5: conversionFlag pre-filled in comment (legacy VBA pattern)
    expect(inputEl.value).toContain('ATTENTION A CONVERTIR')
  })
})

// ===========================================================================
// ARB-UI-11 — Generation gate FR21: 1 unmatched not excluded → disabled (AC #11k, AC #8)
// ===========================================================================

describe('ARB-UI-11: generation gate FR21 — unmatched line blocks generate (AC #11k, AC #8)', () => {
  it('ARB-UI-11a: 1 unmatched SAV line (not excluded) → "Générer" button disabled + aria-disabled="true"', async () => {
    const { wrapper } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse({
        unmatchedSavLines: [
          { savLineId: 'uuid-u1', productCodeSnapshot: '9999-INCONNU', tokenExtracted: null, productNameSnapshot: 'Mystère' },
        ],
      }),
    })

    const generateBtn = wrapper.find('[data-testid="generate-btn"]')
    expect(generateBtn.exists()).toBe(true)
    expect((generateBtn.element as HTMLButtonElement).disabled).toBe(true)
    expect(generateBtn.attributes('aria-disabled')).toBe('true')
  })

  it('ARB-UI-11b: 1 unmatched → inline blocking reason visible (role="status")', async () => {
    const { wrapper } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse({
        unmatchedSavLines: [
          { savLineId: 'uuid-u1', productCodeSnapshot: '9999-INCONNU', tokenExtracted: null, productNameSnapshot: 'Mystère' },
        ],
      }),
    })

    const blockingMsg = wrapper.find('[data-testid="generation-blocked-msg"]')
    expect(blockingMsg.exists()).toBe(true)
    expect(blockingMsg.attributes('role')).toBe('status')
    expect(blockingMsg.text()).toMatch(/bloqué|non appariée|traiter/i)
  })
})

// ===========================================================================
// ARB-UI-12 — Generation gate with blocking claimLine (AC #11l, AC #8)
// ===========================================================================

describe('ARB-UI-12: generation gate — blocking claimLine (AC #11l, AC #8)', () => {
  it('ARB-UI-12a: claimLine with blockingForGeneration=true (not excluded) → "Générer" disabled', async () => {
    const blockingLine = {
      savLineId: 'uuid-blocking',
      creditNoteLink: { savId: 1, savLineId: 'uuid-blocking' },
      codeFr: '7777-X',
      tokenExtracted: '7777-X',
      codigoEs: '7777',
      productoEs: 'Blocking Product',
      origen: null,
      unite: 'kg',
      kilosPiezas: 'Kilos',
      unidad: 'Kilos',
      conversionFlag: 'ok',
      qteFact: null,
      qtyDefaultClient: 0,
      qty: 0,
      peso: 0,
      precio: null,
      importe: null,
      causaEs: null,
      comentarios: '',
      blockingForGeneration: true,
      productNameSnapshot: 'Blocking snapshot',
    }

    const normalLine = {
      savLineId: 'uuid-normal',
      creditNoteLink: { savId: 1, savLineId: 'uuid-normal' },
      codeFr: '1022-5K',
      tokenExtracted: '1022-5K',
      codigoEs: '1022',
      productoEs: 'Aguacate',
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
      productNameSnapshot: 'Avocat',
    }

    const { wrapper } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse({ claimLines: [normalLine, blockingLine] }),
    })

    const generateBtn = wrapper.find('[data-testid="generate-btn"]')
    expect(generateBtn.exists()).toBe(true)
    expect((generateBtn.element as HTMLButtonElement).disabled).toBe(true)
  })

  it('ARB-UI-12b: blockingForGeneration=true row has data-testid="row-blocking" marker (AC #2)', async () => {
    const blockingLine = {
      savLineId: 'uuid-blocking',
      creditNoteLink: { savId: 1, savLineId: 'uuid-blocking' },
      codeFr: '7777-X', tokenExtracted: '7777-X', codigoEs: '7777',
      productoEs: 'BP', origen: null, unite: 'kg', kilosPiezas: 'Kilos',
      unidad: 'Kilos', conversionFlag: 'ok', qteFact: null, qtyDefaultClient: 0,
      qty: 0, peso: 0, precio: null, importe: null, causaEs: null, comentarios: '',
      blockingForGeneration: true, productNameSnapshot: 'Blocking',
    }

    const { wrapper } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse({ claimLines: [blockingLine] }),
    })

    const blockingRow = wrapper.find('[data-testid="row-blocking"]')
    expect(blockingRow.exists()).toBe(true)
  })
})

// ===========================================================================
// ARB-UI-13 — Unmatched/unused sections (AC #11m, AC #6)
// ===========================================================================

describe('ARB-UI-13: unmatched/unused sections (AC #11m, AC #6)', () => {
  it('ARB-UI-13a: with unmatchedSavLines → section A visible (data-testid="unmatched-sav-lines")', async () => {
    const { wrapper } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse({
        unmatchedSavLines: [
          { savLineId: 'uuid-u1', productCodeSnapshot: '9999-A', tokenExtracted: null, productNameSnapshot: 'Mystère A' },
        ],
      }),
    })

    const section = wrapper.find('[data-testid="unmatched-sav-lines"]')
    expect(section.exists()).toBe(true)
    // Counter should show (1)
    expect(section.text()).toContain('1')
  })

  it('ARB-UI-13b: with unusedSupplierLines → section B visible (data-testid="unused-supplier-lines")', async () => {
    const { wrapper } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse({
        unusedSupplierLines: [
          { codeFr: '8888-Z', codigoEs: '8888', descripcionEs: 'Unused product' },
        ],
      }),
    })

    const section = wrapper.find('[data-testid="unused-supplier-lines"]')
    expect(section.exists()).toBe(true)
  })

  it('ARB-UI-13c: empty unmatchedSavLines → section A hidden', async () => {
    const { wrapper } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse({ unmatchedSavLines: [] }),
    })

    expect(wrapper.find('[data-testid="unmatched-sav-lines"]').exists()).toBe(false)
  })

  it('ARB-UI-13d: empty unusedSupplierLines → section B hidden', async () => {
    const { wrapper } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse({ unusedSupplierLines: [] }),
    })

    expect(wrapper.find('[data-testid="unused-supplier-lines"]').exists()).toBe(false)
  })
})

// ===========================================================================
// ARB-UI-14 — beforeunload listener present (AC #10, DN-4)
// ===========================================================================

describe('ARB-UI-14: beforeunload guard — no persistence, UX safety net (AC #10, DN-4)', () => {
  /**
   * HIGH-1 (CR fix): Hardened test — captures ACTUAL handler references from ALL
   * 'beforeunload' addEventListener calls, then invokes each to find the one that
   * actually calls preventDefault() AND sets returnValue === warning text.
   *
   * Strategy: the environment (happy-dom/VTU/vue-router) may register its own
   * 'beforeunload' listeners before ours. We capture ALL registrations after mount
   * and probe each handler to find OUR handler (the one that sets returnValue).
   * This CANNOT pass unless our real handler exists and is correctly implemented.
   */
  it('ARB-UI-14a: handler invocation — calls preventDefault() and sets returnValue to warning text', async () => {
    // Spy BEFORE mount so we capture every call including env setup calls
    const addEventSpy = vi.spyOn(window, 'addEventListener')

    await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse(),
    })

    // Collect ALL 'beforeunload' handler registrations
    const beforeunloadCalls = addEventSpy.mock.calls.filter(([event]) => event === 'beforeunload')
    expect(beforeunloadCalls.length).toBeGreaterThan(0)

    // Find OUR handler — the one that actually calls preventDefault and sets returnValue
    // (other env handlers may be no-ops or behave differently)
    let ourHandlerFound = false
    for (const call of beforeunloadCalls) {
      const handler = call[1] as ((event: Event) => void) | undefined
      if (typeof handler !== 'function') continue

      const fakeEvent = { preventDefault: vi.fn(), returnValue: '' } as unknown as BeforeUnloadEvent
      handler(fakeEvent)

      if (
        (fakeEvent as unknown as Record<string, unknown>)['returnValue'] === 'Vos modifications ne sont pas sauvegardées'
      ) {
        ourHandlerFound = true
        // Also assert preventDefault was called
        expect((fakeEvent as unknown as { preventDefault: ReturnType<typeof vi.fn> }).preventDefault).toHaveBeenCalled()
        break
      }
    }

    // This assertion fails if NO handler set the warning text — meaning our handler is absent/broken
    expect(ourHandlerFound).toBe(true)
  })

  /**
   * ARB-UI-14b: after wrapper.unmount(), removeEventListener('beforeunload', sameRef) must be called
   * with the SAME reference as the one registered by our composable (not just any function).
   * Ensures no stale guard / memory leak after component teardown.
   *
   * Strategy: identify OUR handler (the one that sets returnValue) from addEventSpy,
   * then verify it appears in removeEventSpy after unmount.
   */
  it('ARB-UI-14b: removeEventListener called with same handler reference on unmount (no memory leak)', async () => {
    const addEventSpy = vi.spyOn(window, 'addEventListener')
    const removeEventSpy = vi.spyOn(window, 'removeEventListener')

    const { wrapper } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse(),
    })

    // Find OUR handler from addEventListener calls — the one that sets returnValue
    const beforeunloadCalls = addEventSpy.mock.calls.filter(([event]) => event === 'beforeunload')
    let ourRegisteredHandler: ((event: Event) => void) | null = null
    for (const call of beforeunloadCalls) {
      const handler = call[1] as ((event: Event) => void) | undefined
      if (typeof handler !== 'function') continue
      const fakeEvent = { preventDefault: vi.fn(), returnValue: '' } as unknown as BeforeUnloadEvent
      handler(fakeEvent)
      if ((fakeEvent as unknown as Record<string, unknown>)['returnValue'] === 'Vos modifications ne sont pas sauvegardées') {
        ourRegisteredHandler = handler
        break
      }
    }
    expect(ourRegisteredHandler).not.toBeNull()

    // Unmount the component — onUnmounted should fire removeEventListener
    await wrapper.unmount()

    // Find removeEventListener calls for 'beforeunload'
    const removeCalls = removeEventSpy.mock.calls.filter(([event]) => event === 'beforeunload')
    expect(removeCalls.length).toBeGreaterThan(0)

    // OUR handler reference must appear in the remove calls
    const ourHandlerWasRemoved = removeCalls.some(([, handler]) => handler === ourRegisteredHandler)
    expect(ourHandlerWasRemoved).toBe(true)
  })
})

// ===========================================================================
// ARB-UI-15 — Reconciling indicator (aria-live) during API call (AC #1)
// ===========================================================================

describe('ARB-UI-15: reconciling indicator shown during API call (AC #1)', () => {
  it('ARB-UI-15a: while reconcile is pending, aria-live="polite" indicator shown', async () => {
    const { router, path } = makeRouter(1)
    await router.push(path)
    await router.isReady()

    // Slow reconcile: parse resolves immediately, reconcile never resolves
    let resolveReconcile!: (v: unknown) => void
    const reconcilePromise = new Promise((r) => { resolveReconcile = r })

    const fn = vi.fn((url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'POST' && url.includes('op=parse-supplier-file')) {
        return Promise.resolve({
          status: 200, ok: true,
          json: () => Promise.resolve(buildParseSuccessResponse()),
        } as unknown as Response)
      }
      if (method === 'POST' && url.includes('op=reconcile-supplier-claim')) {
        return reconcilePromise as Promise<Response>
      }
      return Promise.resolve({ status: 500, ok: false, json: () => Promise.resolve({}) } as unknown as Response)
    })
    ;(globalThis as unknown as { fetch: unknown }).fetch = fn

    const wrapper = mount(SupplierClaimView, { global: { plugins: [router] } })
    await flushPromises()

    // Trigger upload
    const fakeFile = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'data.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const input = wrapper.find('[data-testid="file-input"]')
    const inputEl = input.element as HTMLInputElement
    Object.defineProperty(inputEl, 'files', { value: [fakeFile], writable: false, configurable: true })
    inputEl.dispatchEvent(new Event('change'))
    await wrapper.vm.$nextTick()
    // Parse resolves
    await flushPromises()

    // At this point: reconcile is pending → should show reconciling indicator
    const reconciliingIndicator = wrapper.find('[data-testid="reconciling-indicator"]')
    expect(reconciliingIndicator.exists()).toBe(true)
    expect(reconciliingIndicator.attributes('aria-live')).toBe('polite')
    expect(reconciliingIndicator.text()).toMatch(/pré-remplissage|réclamation|patientez/i)

    // Resolve to clean up
    resolveReconcile({
      status: 200, ok: true,
      json: () => Promise.resolve(buildReconcileSuccessResponse()),
    })
    await flushPromises()
  })
})

// ===========================================================================
// ARB-UI-16 — Generate button: inline reason message when blocked (AC #8)
// ===========================================================================

describe('ARB-UI-16: generate button inline reason (AC #8)', () => {
  it('ARB-UI-16a: generation-blocked-msg enumerates blocking conditions count', async () => {
    const blockingLine = {
      savLineId: 'uuid-b', creditNoteLink: { savId: 1, savLineId: 'uuid-b' },
      codeFr: 'X', tokenExtracted: 'X', codigoEs: 'X', productoEs: 'X', origen: null,
      unite: 'kg', kilosPiezas: 'Kilos', unidad: 'Kilos', conversionFlag: 'ok' as const,
      qteFact: null, qtyDefaultClient: 0, qty: 0, peso: 0, precio: null, importe: null,
      causaEs: null, comentarios: '', blockingForGeneration: true as const, productNameSnapshot: 'X',
    }

    const { wrapper } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse({
        claimLines: [blockingLine],
        unmatchedSavLines: [
          { savLineId: 'uuid-u1', productCodeSnapshot: '9999', tokenExtracted: null, productNameSnapshot: 'U1' },
          { savLineId: 'uuid-u2', productCodeSnapshot: '8888', tokenExtracted: null, productNameSnapshot: 'U2' },
        ],
      }),
    })

    const blockingMsg = wrapper.find('[data-testid="generation-blocked-msg"]')
    expect(blockingMsg.exists()).toBe(true)
    // Should mention both unmatched lines count and blocking lines
    const text = blockingMsg.text()
    expect(text).toMatch(/2|deux|non appariée/i)
  })
})

// ===========================================================================
// ARB-UI-17 — blockingForGeneration=true row: data-testid="row-blocking" (AC #2)
// (covered in ARB-UI-12b but isolated here for clarity)
// ===========================================================================

describe('ARB-UI-17: row-blocking marker (AC #2)', () => {
  it('ARB-UI-17a: non-blocking row does NOT have data-testid="row-blocking"', async () => {
    const { wrapper } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse(), // all lines non-blocking
    })

    // Both rows exist but neither should have row-blocking
    expect(wrapper.find('[data-testid="arbitrage-row-uuid-line-1"][data-testid="row-blocking"]').exists()).toBe(false)
    // Alternatively: no row-blocking elements at all
    expect(wrapper.findAll('[data-testid="row-blocking"]')).toHaveLength(0)
  })
})

// ===========================================================================
// ARB-UI-18 — Exclude unmatched → generate becomes enabled (AC #11k resolved)
// ===========================================================================

describe('ARB-UI-18: exclude unmatched SAV line → gate resolved → generate enabled (AC #11k)', () => {
  it('ARB-UI-18a: 1 unmatched → disabled; exclude it via "Exclure" → button enabled', async () => {
    const { wrapper } = await mountAndUploadAndReconcile({
      status: 200,
      body: buildReconcileSuccessResponse({
        unmatchedSavLines: [
          { savLineId: 'uuid-u1', productCodeSnapshot: '9999-A', tokenExtracted: null, productNameSnapshot: 'Mystère' },
        ],
      }),
    })

    // Initially disabled
    const generateBtn = wrapper.find('[data-testid="generate-btn"]')
    expect((generateBtn.element as HTMLButtonElement).disabled).toBe(true)

    // Exclude the unmatched line
    const excludeUnmatchedBtn = wrapper.find('[data-testid="exclude-unmatched-btn-uuid-u1"]')
    expect(excludeUnmatchedBtn.exists()).toBe(true)
    await excludeUnmatchedBtn.trigger('click')
    await wrapper.vm.$nextTick()

    // Gate resolved → button enabled
    expect((generateBtn.element as HTMLButtonElement).disabled).toBe(false)
    expect(generateBtn.attributes('aria-disabled')).toBe('false')

    // Blocking message should disappear
    expect(wrapper.find('[data-testid="generation-blocked-msg"]').exists()).toBe(false)
  })
})

// ===========================================================================
// ARB-UI-19 — MEDIUM-2 (CR fix): re-upload triggers fresh reconcile + state reset
// ===========================================================================

describe('ARB-UI-19: re-upload file B after file A → reconcile re-fires and arbitrage state resets (MEDIUM-2)', () => {
  /**
   * Regression for the watcher guard `reconcileState.value === null` that blocked a
   * second reconcile after the first succeeded (state was already 'arbitrating').
   * After fix: guard is `reconcileState.value !== 'reconciling'`, so any new parseResult
   * triggers a fresh reconcile and resets stale edits/exclusions/comments/clampMessages.
   */
  it('ARB-UI-19a: upload file A → arbitrate → upload file B → reconcile is called again with file B lines', async () => {
    const { router, path } = makeRouter(1)
    await router.push(path)
    await router.isReady()

    // File A reconcile response: 1 line (uuid-line-1)
    const fileAResponse = buildReconcileSuccessResponse()
    // File B reconcile response: different line (uuid-line-b)
    const fileBResponse = buildReconcileSuccessResponse({
      claimLines: [
        {
          savLineId: 'uuid-line-b',
          creditNoteLink: { savId: 1, savLineId: 'uuid-line-b' },
          codeFr: '9000-1K',
          tokenExtracted: '9000-1K',
          codigoEs: '9000',
          productoEs: 'Producto B',
          origen: 'Valencia',
          unite: 'kg',
          kilosPiezas: 'Kilos',
          unidad: 'Kilos',
          conversionFlag: 'ok',
          qteFact: 5,
          qtyDefaultClient: 5,
          qty: 5,
          peso: 5,
          precio: 2.0,
          importe: 10.0,
          causaEs: 'estropeado',
          comentarios: '',
          blockingForGeneration: false,
          productNameSnapshot: 'Produit B',
        },
      ],
    })

    let reconcileCallCount = 0
    const fn = vi.fn((url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'POST' && url.includes('op=parse-supplier-file')) {
        return Promise.resolve({
          status: 200, ok: true,
          json: () => Promise.resolve(buildParseSuccessResponse()),
        } as unknown as Response)
      }
      if (method === 'POST' && url.includes('op=reconcile-supplier-claim')) {
        reconcileCallCount++
        const body = reconcileCallCount === 1 ? fileAResponse : fileBResponse
        return Promise.resolve({
          status: 200, ok: true,
          json: () => Promise.resolve(body),
        } as unknown as Response)
      }
      return Promise.resolve({ status: 500, ok: false, json: () => Promise.resolve({}) } as unknown as Response)
    })
    ;(globalThis as unknown as { fetch: unknown }).fetch = fn

    const wrapper = mount(SupplierClaimView, { global: { plugins: [router] } })
    await flushPromises()

    // Upload file A
    const uploadFile = async () => {
      const fakeFile = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'data.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const input = wrapper.find('[data-testid="file-input"]')
      const inputEl = input.element as HTMLInputElement
      Object.defineProperty(inputEl, 'files', { value: [fakeFile], writable: false, configurable: true })
      inputEl.dispatchEvent(new Event('change'))
      await wrapper.vm.$nextTick()
      await flushPromises()
    }

    // First upload (file A) → should reconcile and show uuid-line-1
    await uploadFile()
    expect(reconcileCallCount).toBe(1)
    expect(wrapper.find('[data-testid="arbitrage-row-uuid-line-1"]').exists()).toBe(true)

    // Second upload (file B) → should re-trigger reconcile
    await uploadFile()
    await flushPromises()

    // reconcile must have been called a second time
    expect(reconcileCallCount).toBe(2)

    // Arbitrage grid should now show file B's line (uuid-line-b), NOT file A's (uuid-line-1)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="arbitrage-row-uuid-line-b"]').exists()).toBe(true)
    // File A's line should no longer be in the grid (stale key cleaned up)
    expect(wrapper.find('[data-testid="arbitrage-row-uuid-line-1"]').exists()).toBe(false)
  })
})
