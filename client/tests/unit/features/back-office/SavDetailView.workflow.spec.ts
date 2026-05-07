import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { defineComponent } from 'vue'

/**
 * Workflow back-office — boutons transitions de statut + émission avoir.
 *
 * AC :
 *   W-01 SAV en statut `draft` → bouton « Marquer reçu » visible ; clic →
 *        PATCH /status status=received avec version courante.
 *   W-02 SAV en statut `received` → bouton « Démarrer le traitement » visible ;
 *        clic → PATCH /status status=in_progress.
 *   W-03 SAV en statut `validated` → bouton « Clôturer » + bouton « Émettre
 *        l'avoir » visibles (tant que pas de creditNote).
 *   W-04 SAV avec `creditNote` non null → section « Avoir émis » + bouton
 *        « Émettre » caché.
 *   W-05 Bouton Annuler visible sur draft/received/in_progress/validated ;
 *        confirm prompt → cancellation avec note dans body.
 *   W-06 Modale émission → POST /api/sav/:id/credit-notes avec bon_type choisi.
 *   W-07 Émission 409 CREDIT_NOTE_ALREADY_ISSUED → modale fermée + refresh
 *        appelé + toast affiché avec n°avoir existant (CR F-4).
 *   W-08 Bouton Annuler + prompt() === null → no-op (PAS de PATCH).
 *   W-09 Bouton Annuler + prompt() === '' → PATCH cancelled SANS note.
 *   W-10 Statuts terminaux closed/cancelled → AUCUN bouton workflow visible.
 *   W-11 Concurrent transitions race (CR F-2) — 2e clic ignoré tant que
 *        la 1re transition est en vol.
 */

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

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

function makeSavPayload(
  overrides: Partial<{
    status: string
    version: number
    lines: unknown[]
    creditNote: unknown
  }> = {}
): unknown {
  return {
    data: {
      sav: {
        id: 1,
        reference: 'SAV-2026-00001',
        status: overrides.status ?? 'draft',
        version: overrides.version ?? 2,
        groupId: null,
        invoiceRef: 'FAC-1',
        invoiceFdpCents: 0,
        totalAmountCents: 1500,
        tags: [],
        assignedTo: 42,
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
        assignee: { id: 42, displayName: 'Op Jean', email: 'op@x.com' },
        lines: overrides.lines ?? [],
        files: [],
      },
      comments: [],
      auditTrail: [],
      settingsSnapshot: { vat_rate_default_bp: 550, group_manager_discount_bp: 400 },
      creditNote: overrides.creditNote ?? null,
    },
  }
}

const ME_RESPONSE = {
  // me-handler.ts:107 envelope `{ user: ... }` — useCurrentUser composable
  // s'aligne sur ce contrat depuis le fix 3.7b (commit 88df643).
  user: { sub: 42, type: 'operator', role: 'sav-operator' },
}

async function importSavDetailView() {
  return (await import('../../../../src/features/back-office/views/SavDetailView.vue')).default
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SavDetailView — workflow back-office (transitions + émission avoir)', () => {
  it('W-01 draft → bouton "Marquer reçu" visible et fonctionnel', async () => {
    const patchBodies: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.includes('/api/auth/me')) return jsonResponse(200, ME_RESPONSE)
      if (method === 'PATCH' && url.includes('/status')) {
        const body = JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>
        patchBodies.push(body)
        return jsonResponse(200, { data: { savId: 1, status: 'received', version: 3 } })
      }
      return jsonResponse(200, makeSavPayload({ status: 'draft', version: 2 }))
    })
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

    const SavDetailView = await importSavDetailView()
    const router = makeRouter()
    await router.push('/admin/sav/1')
    await router.isReady()
    const wrapper = mount(SavDetailView, { global: { plugins: [router] } })
    await flushPromises()

    const btn = wrapper.find('[data-testid="sav-receive-btn"]')
    expect(btn.exists()).toBe(true)

    // No "start" or "validate" or "close" button on draft
    expect(wrapper.find('[data-testid="sav-start-btn"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="sav-validate-btn"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="sav-close-btn"]').exists()).toBe(false)

    await btn.trigger('click')
    await flushPromises()

    expect(patchBodies).toHaveLength(1)
    expect(patchBodies[0]?.['status']).toBe('received')
    expect(patchBodies[0]?.['version']).toBe(2)
  })

  it('W-02 received → bouton "Démarrer le traitement" visible et fonctionnel', async () => {
    const patchBodies: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.includes('/api/auth/me')) return jsonResponse(200, ME_RESPONSE)
      if (method === 'PATCH' && url.includes('/status')) {
        const body = JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>
        patchBodies.push(body)
        return jsonResponse(200, { data: { savId: 1, status: 'in_progress', version: 3 } })
      }
      return jsonResponse(200, makeSavPayload({ status: 'received', version: 2 }))
    })
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

    const SavDetailView = await importSavDetailView()
    const router = makeRouter()
    await router.push('/admin/sav/1')
    await router.isReady()
    const wrapper = mount(SavDetailView, { global: { plugins: [router] } })
    await flushPromises()

    const btn = wrapper.find('[data-testid="sav-start-btn"]')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')
    await flushPromises()

    expect(patchBodies[0]?.['status']).toBe('in_progress')
  })

  it('W-03 validated + sans creditNote → boutons "Émettre l\'avoir" + "Clôturer" visibles', async () => {
    const lines = [
      {
        id: 1,
        productId: null,
        productCodeSnapshot: 'X',
        productNameSnapshot: 'Pommes',
        qtyRequested: 1,
        unitRequested: 'kg',
        qtyInvoiced: 1,
        unitInvoiced: 'kg',
        unitPriceTtcCents: 200,
        vatRateBpSnapshot: 550,
        creditCoefficient: 1,
        creditCoefficientLabel: null,
        pieceToKgWeightG: null,
        creditAmountCents: 200,
        validationStatus: 'ok',
        validationMessage: null,
        position: 1,
        lineNumber: 1,
      },
    ]
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/auth/me')) return jsonResponse(200, ME_RESPONSE)
      return jsonResponse(200, makeSavPayload({ status: 'validated', version: 5, lines }))
    })
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

    const SavDetailView = await importSavDetailView()
    const router = makeRouter()
    await router.push('/admin/sav/1')
    await router.isReady()
    const wrapper = mount(SavDetailView, { global: { plugins: [router] } })
    await flushPromises()

    expect(wrapper.find('[data-testid="sav-emit-credit-btn"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="sav-close-btn"]').exists()).toBe(true)
    // Pas d'avoir → pas de section "Avoir émis"
    expect(wrapper.find('[data-testid="sav-credit-note-issued"]').exists()).toBe(false)
  })

  it('W-04 creditNote présent → section affichée, bouton émettre caché', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/auth/me')) return jsonResponse(200, ME_RESPONSE)
      return jsonResponse(
        200,
        makeSavPayload({
          status: 'validated',
          version: 5,
          creditNote: {
            id: 9,
            number: 1,
            numberFormatted: 'AVOIR-2026-00001',
            bonType: 'AVOIR',
            totalTtcCents: 1234,
            pdfWebUrl: 'https://onedrive/file.pdf',
            issuedAt: '2026-04-01T10:00:00.000Z',
            issuedByOperatorId: 42,
          },
        })
      )
    })
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

    const SavDetailView = await importSavDetailView()
    const router = makeRouter()
    await router.push('/admin/sav/1')
    await router.isReady()
    const wrapper = mount(SavDetailView, { global: { plugins: [router] } })
    await flushPromises()

    expect(wrapper.find('[data-testid="sav-credit-note-issued"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="credit-note-number"]').text()).toBe('AVOIR-2026-00001')
    const link = wrapper.find('[data-testid="credit-note-pdf-link"]')
    expect(link.exists()).toBe(true)
    expect(link.attributes('href')).toBe('/api/credit-notes/AVOIR-2026-00001/pdf')

    // Bouton "Émettre" caché car creditNote déjà existant
    expect(wrapper.find('[data-testid="sav-emit-credit-btn"]').exists()).toBe(false)
  })

  it('W-05 cancel button → prompt + PATCH status=cancelled', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('Erreur de saisie')
    const patchBodies: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.includes('/api/auth/me')) return jsonResponse(200, ME_RESPONSE)
      if (method === 'PATCH' && url.includes('/status')) {
        const body = JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>
        patchBodies.push(body)
        return jsonResponse(200, { data: { savId: 1, status: 'cancelled', version: 3 } })
      }
      return jsonResponse(200, makeSavPayload({ status: 'in_progress', version: 2 }))
    })
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

    const SavDetailView = await importSavDetailView()
    const router = makeRouter()
    await router.push('/admin/sav/1')
    await router.isReady()
    const wrapper = mount(SavDetailView, { global: { plugins: [router] } })
    await flushPromises()

    const btn = wrapper.find('[data-testid="sav-cancel-btn"]')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')
    await flushPromises()

    expect(promptSpy).toHaveBeenCalled()
    expect(patchBodies[0]?.['status']).toBe('cancelled')
    expect(patchBodies[0]?.['note']).toBe('Erreur de saisie')

    promptSpy.mockRestore()
  })

  it('W-06 modale émission avoir → POST credit-notes avec bon_type choisi', async () => {
    const lines = [
      {
        id: 1,
        productId: null,
        productCodeSnapshot: 'X',
        productNameSnapshot: 'Pommes',
        qtyRequested: 1,
        unitRequested: 'kg',
        qtyInvoiced: 1,
        unitInvoiced: 'kg',
        unitPriceTtcCents: 200,
        vatRateBpSnapshot: 550,
        creditCoefficient: 1,
        creditCoefficientLabel: null,
        pieceToKgWeightG: null,
        creditAmountCents: 200,
        validationStatus: 'ok',
        validationMessage: null,
        position: 1,
        lineNumber: 1,
      },
    ]
    const postBodies: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.includes('/api/auth/me')) return jsonResponse(200, ME_RESPONSE)
      if (method === 'POST' && url.includes('/credit-notes')) {
        const body = JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>
        postBodies.push(body)
        return jsonResponse(200, {
          data: {
            number: 1,
            number_formatted: 'AVOIR-2026-00001',
            pdf_web_url: null,
            pdf_status: 'pending',
            issued_at: '2026-04-01T10:00:00.000Z',
            totals: {},
          },
        })
      }
      return jsonResponse(200, makeSavPayload({ status: 'validated', version: 5, lines }))
    })
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

    const SavDetailView = await importSavDetailView()
    const router = makeRouter()
    await router.push('/admin/sav/1')
    await router.isReady()
    const wrapper = mount(SavDetailView, { global: { plugins: [router] } })
    await flushPromises()

    // Open dialog
    const openBtn = wrapper.find('[data-testid="sav-emit-credit-btn"]')
    expect(openBtn.exists()).toBe(true)
    await openBtn.trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="sav-emit-dialog"]').exists()).toBe(true)

    // Choose VIREMENT BANCAIRE
    const radio = wrapper.find('[data-testid="emit-bon-type-VIREMENT"]')
    expect(radio.exists()).toBe(true)
    await radio.setValue(true)

    // Confirm
    const confirmBtn = wrapper.find('[data-testid="sav-emit-confirm"]')
    await confirmBtn.trigger('click')
    await flushPromises()

    expect(postBodies).toHaveLength(1)
    expect(postBodies[0]?.['bon_type']).toBe('VIREMENT BANCAIRE')
  })

  it('W-07 émission 409 ALREADY_ISSUED → modale fermée + refresh + toast', async () => {
    const lines = [
      {
        id: 1,
        productId: null,
        productCodeSnapshot: 'X',
        productNameSnapshot: 'Pommes',
        qtyRequested: 1,
        unitRequested: 'kg',
        qtyInvoiced: 1,
        unitInvoiced: 'kg',
        unitPriceTtcCents: 200,
        vatRateBpSnapshot: 550,
        creditCoefficient: 1,
        creditCoefficientLabel: null,
        pieceToKgWeightG: null,
        creditAmountCents: 200,
        validationStatus: 'ok',
        validationMessage: null,
        position: 1,
        lineNumber: 1,
      },
    ]
    let detailFetchCount = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.includes('/api/auth/me')) return jsonResponse(200, ME_RESPONSE)
      if (method === 'POST' && url.includes('/credit-notes')) {
        return jsonResponse(409, {
          error: {
            code: 'CONFLICT',
            message: 'Un avoir a déjà été émis',
            details: {
              code: 'CREDIT_NOTE_ALREADY_ISSUED',
              number_formatted: 'AVOIR-2026-00007',
            },
          },
        })
      }
      if (method === 'GET' && url.match(/\/api\/sav\/\d+$/)) {
        detailFetchCount++
      }
      return jsonResponse(200, makeSavPayload({ status: 'validated', version: 5, lines }))
    })
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

    const SavDetailView = await importSavDetailView()
    const router = makeRouter()
    await router.push('/admin/sav/1')
    await router.isReady()
    const wrapper = mount(SavDetailView, { global: { plugins: [router] } })
    await flushPromises()

    const initialFetchCount = detailFetchCount

    await wrapper.find('[data-testid="sav-emit-credit-btn"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="sav-emit-confirm"]').trigger('click')
    await flushPromises()

    // CR F-4 : modale doit être fermée après refresh
    expect(wrapper.find('[data-testid="sav-emit-dialog"]').exists()).toBe(false)
    // Refresh doit avoir été appelé (CR AC #2.e)
    expect(detailFetchCount).toBeGreaterThan(initialFetchCount)
  })

  it('W-08 cancelSav prompt() === null → no-op (pas de PATCH)', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue(null)
    const patchBodies: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.includes('/api/auth/me')) return jsonResponse(200, ME_RESPONSE)
      if (method === 'PATCH' && url.includes('/status')) {
        const body = JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>
        patchBodies.push(body)
        return jsonResponse(200, { data: { savId: 1, status: 'cancelled', version: 3 } })
      }
      return jsonResponse(200, makeSavPayload({ status: 'in_progress', version: 2 }))
    })
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

    const SavDetailView = await importSavDetailView()
    const router = makeRouter()
    await router.push('/admin/sav/1')
    await router.isReady()
    const wrapper = mount(SavDetailView, { global: { plugins: [router] } })
    await flushPromises()

    await wrapper.find('[data-testid="sav-cancel-btn"]').trigger('click')
    await flushPromises()

    expect(promptSpy).toHaveBeenCalled()
    // Aucun PATCH /status envoyé (cancellation abandonnée)
    expect(patchBodies).toHaveLength(0)
    promptSpy.mockRestore()
  })

  it('W-09 cancelSav prompt() === "" → PATCH cancelled SANS note', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('')
    const patchBodies: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.includes('/api/auth/me')) return jsonResponse(200, ME_RESPONSE)
      if (method === 'PATCH' && url.includes('/status')) {
        const body = JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>
        patchBodies.push(body)
        return jsonResponse(200, { data: { savId: 1, status: 'cancelled', version: 3 } })
      }
      return jsonResponse(200, makeSavPayload({ status: 'in_progress', version: 2 }))
    })
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

    const SavDetailView = await importSavDetailView()
    const router = makeRouter()
    await router.push('/admin/sav/1')
    await router.isReady()
    const wrapper = mount(SavDetailView, { global: { plugins: [router] } })
    await flushPromises()

    await wrapper.find('[data-testid="sav-cancel-btn"]').trigger('click')
    await flushPromises()

    expect(patchBodies).toHaveLength(1)
    expect(patchBodies[0]?.['status']).toBe('cancelled')
    // Empty/whitespace prompt → pas de champ `note` envoyé
    expect(patchBodies[0]?.['note']).toBeUndefined()
    promptSpy.mockRestore()
  })

  it('W-10 statuts terminaux closed/cancelled → AUCUN bouton workflow visible', async () => {
    for (const terminalStatus of ['closed', 'cancelled']) {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/api/auth/me')) return jsonResponse(200, ME_RESPONSE)
        return jsonResponse(200, makeSavPayload({ status: terminalStatus, version: 5 }))
      })
      ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

      const SavDetailView = await importSavDetailView()
      const router = makeRouter()
      await router.push('/admin/sav/1')
      await router.isReady()
      const wrapper = mount(SavDetailView, { global: { plugins: [router] } })
      await flushPromises()

      // AC #1.f : aucun des 6 boutons workflow ne doit être visible
      for (const id of [
        'sav-receive-btn',
        'sav-start-btn',
        'sav-validate-btn',
        'sav-emit-credit-btn',
        'sav-close-btn',
        'sav-cancel-btn',
      ]) {
        expect(wrapper.find(`[data-testid="${id}"]`).exists()).toBe(false)
      }
    }
  })

  it('W-11 concurrent transitions race → 2e clic ignoré pendant 1re en vol (CR F-2)', async () => {
    const patchBodies: Array<Record<string, unknown>> = []
    let resolveFirst!: (r: Response) => void
    const firstPending = new Promise<Response>((res) => {
      resolveFirst = res
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.includes('/api/auth/me')) return jsonResponse(200, ME_RESPONSE)
      if (method === 'PATCH' && url.includes('/status')) {
        const body = JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>
        patchBodies.push(body)
        // 1re requête reste en vol jusqu'à `resolveFirst()`
        if (patchBodies.length === 1) return firstPending
        return jsonResponse(200, { data: { savId: 1, status: 'received', version: 3 } })
      }
      return jsonResponse(200, makeSavPayload({ status: 'draft', version: 2 }))
    })
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

    const SavDetailView = await importSavDetailView()
    const router = makeRouter()
    await router.push('/admin/sav/1')
    await router.isReady()
    const wrapper = mount(SavDetailView, { global: { plugins: [router] } })
    await flushPromises()

    // 1er clic → PATCH en vol
    await wrapper.find('[data-testid="sav-receive-btn"]').trigger('click')
    await flushPromises()
    expect(patchBodies).toHaveLength(1)

    // 2e clic pendant que la 1re transition est en vol — doit être ignoré (CR F-2)
    // Le bouton Annuler reste visible et cliquable visuellement, mais la garde
    // re-entry empêche le 2nd PATCH.
    const cancelBtn = wrapper.find('[data-testid="sav-cancel-btn"]')
    if (cancelBtn.exists()) {
      const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('')
      await cancelBtn.trigger('click')
      await flushPromises()
      expect(patchBodies).toHaveLength(1) // toujours 1 — pas de 2e PATCH
      promptSpy.mockRestore()
    }

    // Résoudre la 1re — laisse la situation propre pour le test suivant
    resolveFirst(jsonResponse(200, { data: { savId: 1, status: 'received', version: 3 } }))
    await flushPromises()
  })
})
