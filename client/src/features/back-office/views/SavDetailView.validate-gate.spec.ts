import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createWebHistory } from 'vue-router'
import SavDetailView from './SavDetailView.vue'
import { invalidateCurrentUser } from '../../../shared/composables/useCurrentUser'

/**
 * Story V1.13 AC#8 — Gate UI « Valider le SAV ».
 *
 * Couvre :
 *   (a) creditNote.pdfWebUrl NULL → bouton sav-validate-btn disabled +
 *       title « Le PDF du bon SAV doit être disponible avant la validation ».
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

async function mountDetail(attached = false) {
  const router = makeRouter()
  await router.push('/admin/sav/1')
  await router.isReady()
  return mount(SavDetailView, { ...(attached ? { attachTo: document.body } : {}), global: { plugins: [router] } })
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
  detail: (id: number) => unknown
  identityStatus?: () => number
  conflictOnEmit?: boolean
  userType?: string
  onEmit?: () => void
  onRegenerate?: () => void
  onValidate?: () => { status: number; body: unknown }
}) {
  const calls: { url: string; method: string }[] = []
  const fn = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ url, method })
    if (url.includes('/api/auth/me')) {
      return okJson(opts.identityStatus?.() ?? 200, { user: { sub: 42, type: opts.userType ?? 'operator' } })
    }
    if (method === 'POST' && url.endsWith('/credit-notes') && opts.onEmit) {
      opts.onEmit()
      if (opts.conflictOnEmit) return okJson(409, { error: { details: { code: 'CREDIT_NOTE_ALREADY_ISSUED' } } })
      return okJson(201, { data: {} })
    }
    if (method === 'POST' && url.endsWith('/regenerate-pdf') && opts.onRegenerate) {
      opts.onRegenerate()
      return okJson(200, { data: {} })
    }
    if (method === 'PATCH' && /\/api\/sav\/1\/status$/.test(url)) {
      const r = opts.onValidate ?? (() => ({ status: 200, body: { data: {} } }))
      const resp = r()
      return okJson(resp.status, resp.body)
    }
    const detailMatch = /^\/api\/sav\/(\d+)$/.exec(url)
    if (method === 'GET' && detailMatch) {
      return okJson(200, opts.detail(Number(detailMatch[1])))
    }
    return okJson(500, { error: { message: `unexpected ${method} ${url}` } })
  })
  ;(globalThis as unknown as { fetch: unknown }).fetch = fn
  return { calls, fn }
}

afterEach(() => {
  invalidateCurrentUser()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('SavDetailView — V1.13 AC#8 gate Valider', () => {
  it("AC#8 (a) creditNote.pdfWebUrl NULL → bouton disabled avec motif du PDF indisponible", async () => {
    installFetch({
      detail: () =>
        buildDetail({ pdfWebUrl: null, hasCreditNote: true, status: 'in_progress' }),
    })

    const w = await mountDetail()
    await flushPromises()

    const btn = w.find('[data-testid="sav-validate-btn"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.attributes('title')).toBe('Le PDF du bon SAV doit être disponible avant la validation')
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

describe('Suite comptable du dossier', () => {
  it('contient le focus, annule sans émission, puis guide la reprise du même avoir', async () => {
    vi.useFakeTimers()
    let issued = false
    let pdfWebUrl: string | null = null
    const { calls } = installFetch({
      detail: () => buildDetail({ hasCreditNote: issued, pdfWebUrl }),
      onEmit: () => { issued = true },
      onRegenerate: () => { pdfWebUrl = PDF_URL },
    })
    const w = await mountDetail(true)
    try {
      await flushPromises()
      const trigger = w.get('[data-testid="sav-emit-credit-btn"]')
      await trigger.trigger('click')
      const dialog = w.get('[role="dialog"]')
      const first = dialog.get('input:checked')
      const confirm = dialog.get('[data-testid="sav-emit-confirm"]')
      expect(document.activeElement).toBe(first.element)
      await first.trigger('keydown.tab', { shiftKey: true })
      expect(document.activeElement).toBe(confirm.element)
      await confirm.trigger('keydown.tab')
      expect(document.activeElement).toBe(first.element)
      await first.trigger('keydown.esc')
      expect(document.activeElement).toBe(trigger.element)
      expect(issued).toBe(false)

      await trigger.trigger('click')
      const submit = w.get('[data-testid="sav-emit-confirm"]')
      await Promise.all([submit.trigger('click'), submit.trigger('click')])
      await flushPromises()
      expect(calls.filter(c => c.method === 'POST' && c.url.endsWith('/credit-notes'))).toHaveLength(1)
      expect(document.activeElement).toBe(w.get('.action-title').element)
      expect(w.get('#validation-help').text()).toContain('AV-2026-V113 émis')
      expect(w.get('[data-testid="sav-validate-btn"]').attributes('disabled')).toBeDefined()
      await vi.advanceTimersByTimeAsync(15000)
      await flushPromises()
      expect(w.get('#validation-help').text()).toContain('Relancez')
      await w.get('[data-testid="credit-note-regenerate-btn"]').trigger('click')
      await flushPromises()
      expect(w.get('#validation-help').text()).toContain('valider le SAV')
      expect(w.get('[data-testid="sav-validate-btn"]').attributes('disabled')).toBeUndefined()
    } finally {
      w.unmount()
    }
  })

  it('ferme la confirmation lors du passage à un autre dossier', async () => {
    const { calls } = installFetch({ detail: id => {
      const detail = buildDetail({ hasCreditNote: false, pdfWebUrl: null })
      detail.data.sav.id = id
      return detail
    } })
    const w = await mountDetail()
    await flushPromises()
    await w.get('[data-testid="sav-emit-credit-btn"]').trigger('click')
    const oldConfirm = w.get('[data-testid="sav-emit-confirm"]')
    await w.vm.$router.push('/admin/sav/2')
    await flushPromises()
    expect(w.find('[data-testid="sav-emit-dialog"]').exists()).toBe(false)
    await oldConfirm.trigger('click')
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(0)
    w.unmount()
  })

  it('propose de réessayer après un échec temporaire de lecture des droits', async () => {
    let identityStatus = 503
    installFetch({ identityStatus: () => identityStatus, detail: () => buildDetail({ hasCreditNote: false, pdfWebUrl: null }) })
    const w = await mountDetail()
    await flushPromises()
    expect(w.find('[data-testid="sav-emit-credit-btn"]').exists()).toBe(false)
    identityStatus = 200
    await w.get('[data-testid="retry-identity"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="sav-emit-credit-btn"]').exists()).toBe(true)
    w.unmount()
  })

  it('suit le PDF après la découverte d’un avoir déjà émis', async () => {
    vi.useFakeTimers()
    let issued = false
    let pdfWebUrl: string | null = null
    installFetch({ conflictOnEmit: true, onEmit: () => { issued = true }, detail: () => buildDetail({ hasCreditNote: issued, pdfWebUrl }) })
    const w = await mountDetail()
    await flushPromises()
    await w.get('[data-testid="sav-emit-credit-btn"]').trigger('click')
    await w.get('[data-testid="sav-emit-confirm"]').trigger('click')
    await flushPromises()
    expect(w.get('#validation-help').text()).toContain('en préparation')
    pdfWebUrl = PDF_URL
    await vi.advanceTimersByTimeAsync(3000)
    await flushPromises()
    expect(w.get('[data-testid="sav-validate-btn"]').attributes('disabled')).toBeUndefined()
    w.unmount()
  })

  it.each(['empty', 'error', 'degraded'])('présente le prérequis %s et empêche l’émission', async mode => {
    let degraded = mode === 'degraded'
    installFetch({ detail: () => {
      const detail = buildDetail({ hasCreditNote: false, pdfWebUrl: null, linesValidationOk: mode !== 'error' })
      if (mode === 'empty') detail.data.sav.lines = []
      return { ...detail, meta: { creditNoteDegraded: degraded } }
    } })
    const w = await mountDetail()
    await flushPromises()
    if (degraded) {
      expect(w.get('#validation-help').text()).toContain('Rechargez')
      expect(w.find('[data-testid="sav-emit-credit-btn"]').exists()).toBe(false)
      degraded = false
      await w.get('[data-testid="accounting-reload"]').trigger('click')
      await flushPromises()
      expect(w.get('[data-testid="sav-emit-credit-btn"]').attributes('disabled')).toBeUndefined()
    } else {
      expect(w.get('#validation-help').text()).toContain(mode === 'empty' ? 'Ajoutez' : 'Corrigez')
      expect(w.get('[data-testid="sav-emit-credit-btn"]').attributes('disabled')).toBeDefined()
    }
    w.unmount()
  })

  it.each([false, true])('masque les commandes comptables au membre, avoir présent %s', async issued => {
    installFetch({ userType: 'member', detail: () => buildDetail({ pdfWebUrl: PDF_URL, hasCreditNote: issued }) })
    const w = await mountDetail()
    await flushPromises()
    for (const id of ['sav-validate-btn', 'sav-emit-credit-btn', 'credit-note-force-regenerate-btn']) {
      expect(w.find(`[data-testid="${id}"]`).exists()).toBe(false)
    }
    w.unmount()
  })
})
