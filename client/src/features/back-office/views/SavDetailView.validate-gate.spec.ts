import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createWebHistory } from 'vue-router'
import SavDetailView from './SavDetailView.vue'

/**
 * Story V1.13 AC#8 — Gate UI « Valider le SAV ».
 *
 * Couvre :
 *   (a) creditNote.pdfWebUrl NULL → bouton sav-validate-btn disabled +
 *       title « Générez d'abord le bon SAV » (libellé PO D-5).
 *   (b) creditNote.pdfWebUrl présent + lignes OK → bouton ENABLED.
 *   (c) creditNoteDegraded === true → bouton disabled (conservateur).
 *   (d) Priorité d'affichage des messages : « Corrige les lignes en erreur »
 *       passe avant « Générez d'abord le bon SAV » si lignes en erreur ET PDF
 *       manquant simultanément.
 *   (e) 422 CREDIT_NOTE_PDF_REQUIRED (race UI obsolète) → toast «
 *       Générez d'abord le bon SAV (émettez l'avoir). ».
 *
 * Pattern : symétrique à `SavDetailView.credit-note-pdf.spec.ts`.
 *
 * Statut ATDD : RED attendu avant impl Step 6 (gate + mapping toast absents).
 */

const PDF_URL = 'https://onedrive.example/AV-V113.pdf'

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

interface BuildOpts {
  pdfWebUrl: string | null
  hasCreditNote?: boolean
  linesValidationOk?: boolean
  status?: 'in_progress' | 'validated'
}

function buildDetail(opts: BuildOpts) {
  const linesOk = opts.linesValidationOk ?? true
  const status = opts.status ?? 'in_progress'
  return {
    data: {
      sav: {
        id: 1,
        reference: 'SAV-2026-V113',
        status,
        version: 1,
        groupId: null,
        invoiceRef: 'FAC-V113',
        invoiceFdpCents: 0,
        totalAmountCents: 0,
        tags: [],
        assignedTo: null,
        receivedAt: '2026-06-01T00:00:00.000Z',
        takenAt: '2026-06-02T00:00:00.000Z',
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
            validationStatus: linesOk ? 'ok' : 'error',
            validationMessage: linesOk ? null : 'Quantité invalide',
          },
        ],
        files: [],
      },
      comments: [],
      auditTrail: [],
      settingsSnapshot: { vat_rate_default_bp: 550, group_manager_discount_bp: 400 },
      creditNote:
        opts.hasCreditNote === false
          ? null
          : {
              id: 9,
              number: 42,
              numberFormatted: 'AV-2026-V113',
              bonType: 'AVOIR',
              totalTtcCents: 1234,
              pdfWebUrl: opts.pdfWebUrl,
              issuedAt: '2026-06-02T10:00:00.000Z',
              issuedByOperatorId: 42,
            },
    },
  }
}

function installFetch(opts: {
  detail: () => unknown
  onValidate?: () => { status: number; body: unknown }
}) {
  const calls: { url: string; method: string }[] = []
  const fn = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ url, method })
    if (url.includes('/api/auth/me')) {
      return okJson(200, { user: { sub: 42, type: 'operator' } })
    }
    if (method === 'PATCH' && /\/api\/sav\/1\/status$/.test(url)) {
      const r = opts.onValidate ?? (() => ({ status: 200, body: { data: {} } }))
      const resp = r()
      return okJson(resp.status, resp.body)
    }
    if (method === 'GET' && /\/api\/sav\/1$/.test(url)) {
      return okJson(200, opts.detail())
    }
    return okJson(500, { error: { message: `unexpected ${method} ${url}` } })
  })
  ;(globalThis as unknown as { fetch: unknown }).fetch = fn
  return { calls, fn }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('SavDetailView — V1.13 AC#8 gate Valider', () => {
  it("AC#8 (a) creditNote.pdfWebUrl NULL → bouton disabled + title « Générez d'abord le bon SAV »", async () => {
    installFetch({
      detail: () =>
        buildDetail({ pdfWebUrl: null, hasCreditNote: true, status: 'in_progress' }),
    })

    const w = await mountDetail()
    await flushPromises()

    const btn = w.find('[data-testid="sav-validate-btn"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.attributes('title')).toContain("Générez d'abord le bon SAV")
  })

  it("AC#8 (a-bis) creditNote absent (jamais émis) → bouton disabled + title « Générez d'abord le bon SAV »", async () => {
    installFetch({
      detail: () =>
        buildDetail({ pdfWebUrl: null, hasCreditNote: false, status: 'in_progress' }),
    })

    const w = await mountDetail()
    await flushPromises()

    const btn = w.find('[data-testid="sav-validate-btn"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.attributes('title')).toContain("Générez d'abord le bon SAV")
  })

  it('AC#8 (b) creditNote.pdfWebUrl présent + lignes OK → bouton ENABLED + title « Valider le SAV »', async () => {
    installFetch({
      detail: () =>
        buildDetail({ pdfWebUrl: PDF_URL, hasCreditNote: true, status: 'in_progress' }),
    })

    const w = await mountDetail()
    await flushPromises()

    const btn = w.find('[data-testid="sav-validate-btn"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('disabled')).toBeUndefined()
    expect(btn.attributes('title')).toBe('Valider le SAV')
  })

  it("AC#8 (d) priorité : lignes en erreur ET pdfWebUrl manquant → message « Corrige les lignes en erreur » l'emporte", async () => {
    installFetch({
      detail: () =>
        buildDetail({
          pdfWebUrl: null,
          hasCreditNote: true,
          linesValidationOk: false,
          status: 'in_progress',
        }),
    })

    const w = await mountDetail()
    await flushPromises()

    const btn = w.find('[data-testid="sav-validate-btn"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.attributes('title')).toContain('Corrige les lignes en erreur')
  })

  it('AC#8 (e) 422 CREDIT_NOTE_PDF_REQUIRED (race UI obsolète) → toast spécifique', async () => {
    installFetch({
      // Détail montre pdfWebUrl OK → bouton actif → l'opérateur peut cliquer.
      detail: () =>
        buildDetail({ pdfWebUrl: PDF_URL, hasCreditNote: true, status: 'in_progress' }),
      onValidate: () => ({
        status: 422,
        body: {
          error: {
            code: 'BUSINESS_RULE',
            message: 'CREDIT_NOTE_PDF_REQUIRED',
            requestId: 'req-test',
            details: { code: 'CREDIT_NOTE_PDF_REQUIRED' },
          },
        },
      }),
    })

    const w = await mountDetail()
    await flushPromises()

    await w.find('[data-testid="sav-validate-btn"]').trigger('click')
    await flushPromises()

    const toast = w.find('[data-testid="sav-toast"]')
    expect(toast.exists()).toBe(true)
    // Libellé PO D-5 : « Générez d'abord le bon SAV ».
    expect(toast.text()).toContain('Générez')
  })
})
