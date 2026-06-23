import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createWebHistory } from 'vue-router'
import SavDetailView from './SavDetailView.vue'

/**
 * spec credit-note-pdf-regenerate-feedback — feedback + bouton « Régénérer le
 * PDF » quand la génération asynchrone d'avoir échoue.
 *
 * Anti-faux-vert (feedback_test_integration_gap) : ces tests exercent les VRAIES
 * transitions d'UI. Ils ÉCHOUENT sur le code d'avant le correctif :
 *   - l'ancien « PDF en cours… » portait le testid `credit-note-pdf-link`
 *     (pas `credit-note-pdf-pending`) et l'UI ne pollait jamais ;
 *   - aucun état `failed` ni bouton `credit-note-regenerate-btn` n'existait.
 */

const POLL_INTERVAL = 3000 // PDF_POLL_INTERVAL_MS
const PDF_URL = 'https://onedrive.example/regen.pdf'

function makeRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/admin/sav', name: 'admin-sav-list', component: { template: '<div/>' } },
      { path: '/admin/sav/:id', name: 'admin-sav-detail', component: SavDetailView },
    ],
  })
}

async function mountDetail() {
  const router = makeRouter()
  await router.push('/admin/sav/1')
  await router.isReady()
  return mount(SavDetailView, { global: { plugins: [router] } })
}

function okJson(status: number, body: unknown) {
  return Promise.resolve({
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  } as unknown as Response)
}

interface CreditNoteOverride {
  pdfWebUrl: string | null
}

function creditNote(o: CreditNoteOverride) {
  return {
    id: 9,
    number: 42,
    numberFormatted: 'AV-2026-00042',
    bonType: 'AVOIR',
    totalTtcCents: 1234,
    pdfWebUrl: o.pdfWebUrl,
    issuedAt: '2026-04-01T10:00:00.000Z',
    issuedByOperatorId: 42,
  }
}

function buildDetail(state: { creditNote: ReturnType<typeof creditNote> | null }) {
  return {
    data: {
      sav: {
        id: 1,
        reference: 'SAV-2026-00001',
        status: 'validated',
        version: 1,
        groupId: null,
        invoiceRef: 'FAC-1',
        invoiceFdpCents: 0,
        totalAmountCents: 0,
        tags: [],
        assignedTo: null,
        receivedAt: '2026-03-01T00:00:00.000Z',
        takenAt: null,
        validatedAt: '2026-03-02T00:00:00.000Z',
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
        lines: [
          {
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
          },
        ],
        files: [],
      },
      comments: [],
      auditTrail: [],
      settingsSnapshot: { vat_rate_default_bp: 550, group_manager_discount_bp: 400 },
      creditNote: state.creditNote,
    },
  }
}

function emitOk() {
  return {
    status: 200,
    body: {
      data: { number_formatted: 'AV-2026-00042', pdf_web_url: null, pdf_status: 'pending' },
    },
  }
}

function regen500(failureKind: string) {
  return {
    status: 500,
    body: {
      error: {
        code: 'SERVER_ERROR',
        message: 'Régénération PDF échouée',
        requestId: 'req-test',
        details: { code: 'PDF_REGENERATE_FAILED', failure_kind: failureKind },
      },
    },
  }
}

function installFetch(opts: {
  detail: () => unknown
  onEmit?: () => { status: number; body: unknown }
  onRegenerate?: () => { status: number; body: unknown }
}) {
  const calls: { url: string; method: string }[] = []
  const fn = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ url, method })
    if (url.includes('/api/auth/me')) {
      return okJson(200, { user: { sub: 42, type: 'operator' } })
    }
    if (method === 'POST' && /\/api\/sav\/1\/credit-notes$/.test(url)) {
      const r = opts.onEmit ? opts.onEmit() : emitOk()
      return okJson(r.status, r.body)
    }
    if (method === 'POST' && /\/regenerate-pdf$/.test(url)) {
      const r = opts.onRegenerate ? opts.onRegenerate() : regen500('UNKNOWN')
      return okJson(r.status, r.body)
    }
    if (method === 'GET' && /\/api\/sav\/1$/.test(url)) {
      return okJson(200, opts.detail())
    }
    return okJson(500, { error: { message: `unexpected ${method} ${url}` } })
  })
  ;(globalThis as unknown as { fetch: unknown }).fetch = fn
  const savGets = () => calls.filter((c) => c.method === 'GET' && /\/api\/sav\/1$/.test(c.url)).length
  return { calls, fn, savGets }
}

async function emit(w: Awaited<ReturnType<typeof mountDetail>>) {
  await w.find('[data-testid="sav-emit-credit-btn"]').trigger('click')
  await w.find('[data-testid="sav-emit-confirm"]').trigger('click')
  await flushPromises()
}

// CN-PDF-D1 : depuis le mount, un avoir avec pdfWebUrl null arme le poll borné
// (phase « pending »). Pour exercer la régénération il faut donc d'abord laisser
// le poll expirer (5 × 3 s) pour atteindre la phase « failed » (bouton visible).
// Prérequis : la fetch mock doit déjà être installée par l'appelant.
async function mountAtFailed() {
  vi.useFakeTimers()
  const w = await mountDetail()
  await flushPromises()
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL)
    await flushPromises()
  }
  return w
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('SavDetailView — feedback génération PDF avoir (poll + régénération)', () => {
  it('poll : pdfWebUrl arrive avant le timeout → lien affiché, polling stoppé', async () => {
    vi.useFakeTimers()
    let emitted = false
    let pdfReady = false
    const { savGets } = installFetch({
      detail: () =>
        buildDetail({
          creditNote: emitted ? creditNote({ pdfWebUrl: pdfReady ? PDF_URL : null }) : null,
        }),
      onEmit: () => {
        emitted = true
        return emitOk()
      },
    })

    const w = await mountDetail()
    await flushPromises()
    await emit(w)

    // Émission faite, PDF pas encore prêt → phase « pending », pas de lien.
    expect(w.find('[data-testid="credit-note-pdf-pending"]').exists()).toBe(true)
    expect(w.find('[data-testid="credit-note-pdf-link"]').exists()).toBe(false)

    // Poll #1 (3 s) → toujours null.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL)
    await flushPromises()
    expect(w.find('[data-testid="credit-note-pdf-pending"]').exists()).toBe(true)

    // Le PDF devient prêt ; le poll #2 le récupère.
    pdfReady = true
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL)
    await flushPromises()

    const link = w.find('[data-testid="credit-note-pdf-link"]')
    expect(link.exists()).toBe(true)
    expect(link.attributes('href')).toBe('/api/credit-notes/AV-2026-00042/pdf')
    expect(w.find('[data-testid="credit-note-pdf-pending"]').exists()).toBe(false)

    // Polling stoppé : plus aucun GET /api/sav/1 sur les intervalles suivants.
    const after = savGets()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL * 3)
    await flushPromises()
    expect(savGets()).toBe(after)
  })

  it('poll : 5 tentatives sans pdfWebUrl → état failed + bouton « Régénérer »', async () => {
    vi.useFakeTimers()
    let emitted = false
    installFetch({
      detail: () => buildDetail({ creditNote: emitted ? creditNote({ pdfWebUrl: null }) : null }),
      onEmit: () => {
        emitted = true
        return emitOk()
      },
    })

    const w = await mountDetail()
    await flushPromises()
    await emit(w)

    expect(w.find('[data-testid="credit-note-pdf-pending"]').exists()).toBe(true)

    // 5 polls × 3 s, pdfWebUrl reste null.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL)
      await flushPromises()
    }

    expect(w.find('[data-testid="credit-note-pdf-pending"]').exists()).toBe(false)
    expect(w.find('[data-testid="credit-note-pdf-failed"]').exists()).toBe(true)
    expect(w.find('[data-testid="credit-note-regenerate-btn"]').exists()).toBe(true)
    expect(w.find('[data-testid="credit-note-pdf-link"]').exists()).toBe(false)
  })

  it('CN-PDF-D1 : reload avoir pdf null → poll armé au mount (pending), failed après timeout', async () => {
    vi.useFakeTimers()
    installFetch({
      detail: () => buildDetail({ creditNote: creditNote({ pdfWebUrl: null }) }),
    })

    const w = await mountDetail()
    await flushPromises()

    // Poll armé dès le chargement → « en cours… », PAS « failed »/bouton d'emblée.
    expect(w.find('[data-testid="credit-note-pdf-pending"]').exists()).toBe(true)
    expect(w.find('[data-testid="credit-note-regenerate-btn"]').exists()).toBe(false)

    // Après expiration du poll borné → bascule failed + bouton.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL)
      await flushPromises()
    }
    expect(w.find('[data-testid="credit-note-pdf-pending"]').exists()).toBe(false)
    expect(w.find('[data-testid="credit-note-regenerate-btn"]').exists()).toBe(true)
  })

  it('régénérer : clic → 200 → lien affiché, bouton disparaît', async () => {
    let pdfReady = false
    installFetch({
      detail: () => buildDetail({ creditNote: creditNote({ pdfWebUrl: pdfReady ? PDF_URL : null }) }),
      onRegenerate: () => {
        pdfReady = true
        return {
          status: 200,
          body: { data: { pdf_web_url: PDF_URL, credit_note_number_formatted: 'AV-2026-00042' } },
        }
      },
    })

    const w = await mountAtFailed()
    expect(w.find('[data-testid="credit-note-regenerate-btn"]').exists()).toBe(true)

    await w.find('[data-testid="credit-note-regenerate-btn"]').trigger('click')
    await flushPromises()

    const link = w.find('[data-testid="credit-note-pdf-link"]')
    expect(link.exists()).toBe(true)
    expect(link.attributes('href')).toBe('/api/credit-notes/AV-2026-00042/pdf')
    expect(w.find('[data-testid="credit-note-regenerate-btn"]').exists()).toBe(false)
  })

  it('régénérer : 500 PDF_GENERATION_FAILED → message « paramètres société », bouton reste', async () => {
    installFetch({
      detail: () => buildDetail({ creditNote: creditNote({ pdfWebUrl: null }) }),
      onRegenerate: () => regen500('PDF_GENERATION_FAILED'),
    })

    const w = await mountAtFailed()

    await w.find('[data-testid="credit-note-regenerate-btn"]').trigger('click')
    await flushPromises()

    const msg = w.find('[data-testid="credit-note-pdf-failed-msg"]')
    expect(msg.exists()).toBe(true)
    expect(msg.text()).toContain('paramètres société')
    // Échec → reste en phase failed, bouton re-cliquable, pas de lien.
    expect(w.find('[data-testid="credit-note-regenerate-btn"]').exists()).toBe(true)
    expect(w.find('[data-testid="credit-note-pdf-link"]').exists()).toBe(false)
  })

  it('régénérer : 500 PDF_UPLOAD_FAILED → message OneDrive (mapping distinct)', async () => {
    installFetch({
      detail: () => buildDetail({ creditNote: creditNote({ pdfWebUrl: null }) }),
      onRegenerate: () => regen500('PDF_UPLOAD_FAILED'),
    })

    const w = await mountAtFailed()

    await w.find('[data-testid="credit-note-regenerate-btn"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="credit-note-pdf-failed-msg"]').text()).toContain('OneDrive')
  })

  it('régénérer : 500 PDF_RENDER_FAILED → message « rendu du document »', async () => {
    installFetch({
      detail: () => buildDetail({ creditNote: creditNote({ pdfWebUrl: null }) }),
      onRegenerate: () => regen500('PDF_RENDER_FAILED'),
    })

    const w = await mountAtFailed()

    await w.find('[data-testid="credit-note-regenerate-btn"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="credit-note-pdf-failed-msg"]').text()).toContain(
      'rendu du document'
    )
    expect(w.find('[data-testid="credit-note-regenerate-btn"]').exists()).toBe(true)
  })

  it('régénérer : 429 rate-limited → message « patientez »', async () => {
    installFetch({
      detail: () => buildDetail({ creditNote: creditNote({ pdfWebUrl: null }) }),
      onRegenerate: () => ({
        status: 429,
        body: {
          error: {
            code: 'RATE_LIMITED',
            message: 'Trop de requêtes',
            requestId: 'req-test',
          },
        },
      }),
    })

    const w = await mountAtFailed()

    await w.find('[data-testid="credit-note-regenerate-btn"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="credit-note-pdf-failed-msg"]').text()).toContain('Patientez')
    expect(w.find('[data-testid="credit-note-pdf-link"]').exists()).toBe(false)
  })

  it('régénérer : erreur réseau (fetch rejette) → message générique, bouton reste', async () => {
    const fn = vi.fn((url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.includes('/api/auth/me')) {
        return okJson(200, { user: { sub: 42, type: 'operator' } })
      }
      if (method === 'POST' && /\/regenerate-pdf$/.test(url)) {
        return Promise.reject(new TypeError('Failed to fetch'))
      }
      if (method === 'GET' && /\/api\/sav\/1$/.test(url)) {
        return okJson(200, buildDetail({ creditNote: creditNote({ pdfWebUrl: null }) }))
      }
      return okJson(500, { error: { message: 'unexpected' } })
    })
    ;(globalThis as unknown as { fetch: unknown }).fetch = fn

    const w = await mountAtFailed()

    await w.find('[data-testid="credit-note-regenerate-btn"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="credit-note-pdf-failed-msg"]').text()).toContain(
      'Échec de la régénération du PDF'
    )
    expect(w.find('[data-testid="credit-note-regenerate-btn"]').exists()).toBe(true)
  })

  it('régénérer : 500 PDF_UPDATE_FAILED → message générique (fallback)', async () => {
    installFetch({
      detail: () => buildDetail({ creditNote: creditNote({ pdfWebUrl: null }) }),
      onRegenerate: () => regen500('PDF_UPDATE_FAILED'),
    })

    const w = await mountAtFailed()

    await w.find('[data-testid="credit-note-regenerate-btn"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="credit-note-pdf-failed-msg"]').text()).toContain(
      'Échec de la régénération du PDF'
    )
  })

  it('régénérer : 409 PDF_ALREADY_GENERATED → refresh → lien (course bénigne)', async () => {
    let pdfReady = false
    installFetch({
      detail: () => buildDetail({ creditNote: creditNote({ pdfWebUrl: pdfReady ? PDF_URL : null }) }),
      onRegenerate: () => {
        pdfReady = true
        return {
          status: 409,
          body: {
            error: {
              code: 'CONFLICT',
              message: 'PDF déjà généré pour ce credit_note.',
              requestId: 'req-test',
              details: {
                code: 'PDF_ALREADY_GENERATED',
                pdf_web_url: PDF_URL,
                credit_note_number_formatted: 'AV-2026-00042',
              },
            },
          },
        }
      },
    })

    const w = await mountAtFailed()

    await w.find('[data-testid="credit-note-regenerate-btn"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="credit-note-pdf-link"]').exists()).toBe(true)
    // Course bénigne : aucun message d'erreur ne doit subsister.
    expect(w.find('[data-testid="credit-note-pdf-failed"]').exists()).toBe(false)
    expect(w.find('[data-testid="credit-note-pdf-failed-msg"]').exists()).toBe(false)
  })
})

// ============================================================================
// spec credit-note-force-regenerate-pdf — bouton « Régénérer le PDF » en phase
// `ready` (force=true).
// Style identique : fetch recorder + `vi.stubGlobal('confirm', …)`.
// ============================================================================

// Helper : monter directement en phase `ready` (pdfWebUrl déjà servi).
async function mountAtReady(installArgs: {
  onRegenerate?: () => { status: number; body: unknown }
  onRegenerateReject?: () => Promise<never>
}): Promise<{
  w: Awaited<ReturnType<typeof mountDetail>>
  calls: { url: string; method: string; body: string | null }[]
}> {
  const calls: { url: string; method: string; body: string | null }[] = []
  const fn = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? (init.body as string) : null
    calls.push({ url, method, body })
    if (url.includes('/api/auth/me')) {
      return okJson(200, { user: { sub: 42, type: 'operator' } })
    }
    if (method === 'POST' && /\/regenerate-pdf$/.test(url)) {
      if (installArgs.onRegenerateReject) {
        return installArgs.onRegenerateReject()
      }
      const r = installArgs.onRegenerate
        ? installArgs.onRegenerate()
        : { status: 200, body: { data: { pdf_web_url: PDF_URL, credit_note_number_formatted: 'AV-2026-00042' } } }
      return okJson(r.status, r.body)
    }
    if (method === 'GET' && /\/api\/sav\/1$/.test(url)) {
      return okJson(200, buildDetail({ creditNote: creditNote({ pdfWebUrl: PDF_URL }) }))
    }
    return okJson(500, { error: { message: `unexpected ${method} ${url}` } })
  })
  ;(globalThis as unknown as { fetch: unknown }).fetch = fn
  const w = await mountDetail()
  await flushPromises()
  return { w, calls }
}

describe('SavDetailView — bouton force-regenerate (phase ready)', () => {
  it('F1 — bouton `credit-note-force-regenerate-btn` visible en phase ready', async () => {
    const { w } = await mountAtReady({})
    // Lien PDF + bouton force tous deux présents en phase ready.
    expect(w.find('[data-testid="credit-note-pdf-link"]').exists()).toBe(true)
    expect(w.find('[data-testid="credit-note-force-regenerate-btn"]').exists()).toBe(true)
  })

  it('F2 — confirm annulée → AUCUN POST regenerate-pdf', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false))
    const { w, calls } = await mountAtReady({})

    await w.find('[data-testid="credit-note-force-regenerate-btn"]').trigger('click')
    await flushPromises()

    const postCount = calls.filter(
      (c) => c.method === 'POST' && /\/regenerate-pdf$/.test(c.url)
    ).length
    expect(postCount).toBe(0)
  })

  it('F3 — confirm OK → POST body exact `{"force":true}` + content-type application/json + refresh après 200', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    const { w, calls } = await mountAtReady({
      onRegenerate: () => ({
        status: 200,
        body: {
          data: {
            pdf_web_url: PDF_URL,
            credit_note_number_formatted: 'AV-2026-00042',
            totals: {
              total_ht_cents: 1000,
              discount_cents: 0,
              vat_cents: 55,
              total_ttc_cents: 1055,
            },
          },
        },
      }),
    })

    const savGetsBefore = calls.filter(
      (c) => c.method === 'GET' && /\/api\/sav\/1$/.test(c.url)
    ).length

    await w.find('[data-testid="credit-note-force-regenerate-btn"]').trigger('click')
    await flushPromises()

    const postCalls = calls.filter(
      (c) => c.method === 'POST' && /\/regenerate-pdf$/.test(c.url)
    )
    expect(postCalls.length).toBe(1)
    expect(postCalls[0]!.body).toBe(JSON.stringify({ force: true }))
    // Refresh post-200 : nouveau GET /api/sav/1.
    const savGetsAfter = calls.filter(
      (c) => c.method === 'GET' && /\/api\/sav\/1$/.test(c.url)
    ).length
    expect(savGetsAfter).toBeGreaterThan(savGetsBefore)
  })

  it('F3b — content-type application/json vérifié dans les headers du POST force', async () => {
    // Headers ne sont pas capturés par le recorder existant. On reconstruit
    // un fetch dédié qui capture init pour vérifier le header.
    vi.stubGlobal('confirm', vi.fn(() => true))
    const captured: Array<{ url: string; init: RequestInit | undefined }> = []
    const fn = vi.fn((url: string, init?: RequestInit) => {
      captured.push({ url, init })
      if (url.includes('/api/auth/me')) {
        return okJson(200, { user: { sub: 42, type: 'operator' } })
      }
      if (
        init?.method === 'POST' &&
        /\/regenerate-pdf$/.test(url)
      ) {
        return okJson(200, { data: { pdf_web_url: PDF_URL, credit_note_number_formatted: 'AV-2026-00042' } })
      }
      if ((init?.method ?? 'GET') === 'GET' && /\/api\/sav\/1$/.test(url)) {
        return okJson(200, buildDetail({ creditNote: creditNote({ pdfWebUrl: PDF_URL }) }))
      }
      return okJson(500, { error: { message: 'unexpected' } })
    })
    ;(globalThis as unknown as { fetch: unknown }).fetch = fn

    const w = await mountDetail()
    await flushPromises()

    await w.find('[data-testid="credit-note-force-regenerate-btn"]').trigger('click')
    await flushPromises()

    const postCall = captured.find(
      (c) => c.init?.method === 'POST' && /\/regenerate-pdf$/.test(c.url)
    )
    expect(postCall).toBeDefined()
    const headers = postCall!.init!.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/json')
  })

  it('F4 — 422 → message serveur affiché, PAS de refresh', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    const { w, calls } = await mountAtReady({
      onRegenerate: () => ({
        status: 422,
        body: {
          error: {
            code: 'BUSINESS_RULE',
            message: "Pour modifier l'avoir, repassez le SAV en cours.",
            requestId: 'req-test',
            details: { code: 'SAV_STATUS_FROZEN' },
          },
        },
      }),
    })

    const savGetsBefore = calls.filter(
      (c) => c.method === 'GET' && /\/api\/sav\/1$/.test(c.url)
    ).length

    await w.find('[data-testid="credit-note-force-regenerate-btn"]').trigger('click')
    await flushPromises()

    // Message serveur visible : phase reste `ready` (pdfWebUrl pas touché).
    const errEl = w.find('[data-testid="credit-note-force-regenerate-error"]')
    expect(errEl.exists()).toBe(true)
    expect(errEl.text()).toContain('repassez le SAV en cours')

    // PAS de refresh (422 = vue stable).
    const savGetsAfter = calls.filter(
      (c) => c.method === 'GET' && /\/api\/sav\/1$/.test(c.url)
    ).length
    expect(savGetsAfter).toBe(savGetsBefore)
  })

  it('F5 — 409 CREDIT_NOTE_STATE_CHANGED → message « lignes ont changé » + refresh', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    const { w, calls } = await mountAtReady({
      onRegenerate: () => ({
        status: 409,
        body: {
          error: {
            code: 'CONFLICT',
            message: 'Les lignes ont changé.',
            requestId: 'req-test',
            details: { code: 'CREDIT_NOTE_STATE_CHANGED' },
          },
        },
      }),
    })

    const savGetsBefore = calls.filter(
      (c) => c.method === 'GET' && /\/api\/sav\/1$/.test(c.url)
    ).length

    await w.find('[data-testid="credit-note-force-regenerate-btn"]').trigger('click')
    await flushPromises()

    // Le refresh récupère le détail (pdfWebUrl toujours présent dans le mock)
    // → on reste en phase `ready` et le message d'erreur force s'affiche.
    const errEl = w.find('[data-testid="credit-note-force-regenerate-error"]')
    expect(errEl.exists()).toBe(true)
    expect(errEl.text()).toContain('lignes ont changé')

    // Refresh appelé post-409.
    const savGetsAfter = calls.filter(
      (c) => c.method === 'GET' && /\/api\/sav\/1$/.test(c.url)
    ).length
    expect(savGetsAfter).toBeGreaterThan(savGetsBefore)
  })

  it('F6 — 500 → refresh appelé + état final sans lien mort + message visible', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    // Après le 500, le détail rafraîchi rend pdfWebUrl=null (l'état réel
    // post-RPC : totaux mutés, PDF effacé). L'UI doit basculer en phase
    // `failed` SANS lien mort et garder le message d'erreur affiché.
    let regenerated = false
    const calls: { url: string; method: string; body: string | null }[] = []
    const fn = vi.fn((url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = typeof init?.body === 'string' ? (init.body as string) : null
      calls.push({ url, method, body })
      if (url.includes('/api/auth/me')) {
        return okJson(200, { user: { sub: 42, type: 'operator' } })
      }
      if (method === 'POST' && /\/regenerate-pdf$/.test(url)) {
        regenerated = true
        return okJson(500, {
          error: {
            code: 'SERVER_ERROR',
            message: 'Régénération PDF échouée',
            requestId: 'req-test',
            details: { code: 'PDF_REGENERATE_FAILED', failure_kind: 'PDF_UPLOAD_FAILED' },
          },
        })
      }
      if (method === 'GET' && /\/api\/sav\/1$/.test(url)) {
        // Avant force : pdfWebUrl set. Après force (500) : pdfWebUrl null
        // (RPC déjà commitée, PDF nullifié).
        return okJson(
          200,
          buildDetail({ creditNote: creditNote({ pdfWebUrl: regenerated ? null : PDF_URL }) })
        )
      }
      return okJson(500, { error: { message: 'unexpected' } })
    })
    ;(globalThis as unknown as { fetch: unknown }).fetch = fn

    const w = await mountDetail()
    await flushPromises()

    const savGetsBefore = calls.filter(
      (c) => c.method === 'GET' && /\/api\/sav\/1$/.test(c.url)
    ).length

    await w.find('[data-testid="credit-note-force-regenerate-btn"]').trigger('click')
    await flushPromises()

    // Refresh appelé.
    const savGetsAfter = calls.filter(
      (c) => c.method === 'GET' && /\/api\/sav\/1$/.test(c.url)
    ).length
    expect(savGetsAfter).toBeGreaterThan(savGetsBefore)

    // Pas de lien mort : le pdfWebUrl est désormais null côté détail → l'UI
    // bascule en phase `failed`, le lien disparaît.
    expect(w.find('[data-testid="credit-note-pdf-link"]').exists()).toBe(false)
    expect(w.find('[data-testid="credit-note-pdf-failed"]').exists()).toBe(true)

    // Message visible (cf. P4b) : la zone failed-msg affiche le contenu de
    // `regenerateError` (fallback PDF_FAILED_DEFAULT_MSG si null). Ici
    // regenerateError vaut le mapping OneDrive.
    const msg = w.find('[data-testid="credit-note-pdf-failed-msg"]')
    expect(msg.exists()).toBe(true)
    expect(msg.text()).toContain('OneDrive')
  })
})
