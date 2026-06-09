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

    const w = await mountDetail()
    await flushPromises()

    // Avoir existant avec pdfWebUrl null, pas de poll en cours → phase failed.
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

    const w = await mountDetail()
    await flushPromises()

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

    const w = await mountDetail()
    await flushPromises()

    await w.find('[data-testid="credit-note-regenerate-btn"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="credit-note-pdf-failed-msg"]').text()).toContain('OneDrive')
  })

  it('régénérer : 500 PDF_RENDER_FAILED → message « rendu du document »', async () => {
    installFetch({
      detail: () => buildDetail({ creditNote: creditNote({ pdfWebUrl: null }) }),
      onRegenerate: () => regen500('PDF_RENDER_FAILED'),
    })

    const w = await mountDetail()
    await flushPromises()

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

    const w = await mountDetail()
    await flushPromises()

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

    const w = await mountDetail()
    await flushPromises()

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

    const w = await mountDetail()
    await flushPromises()

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

    const w = await mountDetail()
    await flushPromises()

    await w.find('[data-testid="credit-note-regenerate-btn"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="credit-note-pdf-link"]').exists()).toBe(true)
    // Course bénigne : aucun message d'erreur ne doit subsister.
    expect(w.find('[data-testid="credit-note-pdf-failed"]').exists()).toBe(false)
    expect(w.find('[data-testid="credit-note-pdf-failed-msg"]').exists()).toBe(false)
  })
})
