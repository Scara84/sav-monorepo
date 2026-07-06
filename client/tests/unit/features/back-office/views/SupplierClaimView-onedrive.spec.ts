import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createWebHistory } from 'vue-router'
import { computed, ref } from 'vue'

const mockState = vi.hoisted(() => ({
  generateResult: null as {
    filename?: string
    lineCount?: number
    onedriveStatus?: 'success' | 'skipped' | 'failed'
    onedriveWebUrl?: string
    onedriveMessage?: string
  } | null,
}))

vi.mock('../../../../../src/features/back-office/composables/useSupplierClaimUpload', () => ({
  useSupplierClaimUpload: () => ({
    state: ref('idle'),
    parseResult: ref(null),
    errorMessage: ref(null),
    handleFileChange: vi.fn(),
    reset: vi.fn(),
  }),
}))

vi.mock('../../../../../src/features/back-office/composables/useSupplierClaimArbitration', () => ({
  useSupplierClaimArbitration: () => ({
    reconcileState: ref(null),
    reconcileError: ref(null),
    claimLines: ref([]),
    unmatchedSavLines: ref([]),
    unusedSupplierLines: ref([]),
    clientDemandLines: ref([]),
    edits: ref(new Map()),
    exclusions: ref(new Map()),
    comments: ref(new Map()),
    clampMessages: ref(new Map()),
    totalImporte: computed(() => 0),
    lineImportes: computed(() => new Map()),
    canGenerateComputed: computed(() => true),
    blockingReasons: computed(() => []),
    runReconcile: vi.fn(),
    handleQtyBlur: vi.fn(),
    updateComment: vi.fn(),
    toggleLineExclusion: vi.fn(),
    generateState: ref('generated'),
    generateError: ref(null),
    generateResult: ref(mockState.generateResult),
    generate: vi.fn(),
    retryGenerate: vi.fn(),
    resetToArbitrating: vi.fn(),
  }),
  formatImporte: (value: number) => String(value),
}))

import SupplierClaimView from '../../../../../src/features/back-office/views/SupplierClaimView.vue'

function makeRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/admin/sav', name: 'admin-sav-list', component: { template: '<div/>' } },
      { path: '/admin/sav/:id', name: 'admin-sav-detail', component: { template: '<div/>' } },
      {
        path: '/admin/sav/:id/demande-fournisseur',
        name: 'admin-sav-supplier-claim',
        component: SupplierClaimView,
      },
    ],
  })
}

function setupHistoryFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            savId: 16,
            claims: [
              {
                id: 42,
                generatedAt: '2026-07-06T10:00:00Z',
                generatedByOperator: { id: 1, fullName: 'Opérateur SAV' },
                totalImporteCents: 58,
                lineCount: 1,
                filename: 'RECLAMACION.xlsx',
                version: 1,
                regenerationOf: null,
                isLatest: true,
                hasDocument: true,
              },
            ],
          }),
      } as unknown as Response)
    )
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  setupHistoryFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  mockState.generateResult = null
})

describe('SupplierClaimView — statut remplissage OneDrive', () => {
  it('affiche un avertissement quand le remplissage OneDrive échoue', async () => {
    mockState.generateResult = {
      filename: 'RECLAMACION.xlsx',
      lineCount: 1,
      onedriveStatus: 'failed',
      onedriveMessage: 'Graph 403',
    }
    const router = makeRouter()
    await router.push('/admin/sav/16/demande-fournisseur')
    await router.isReady()

    const wrapper = mount(SupplierClaimView, {
      global: { plugins: [router] },
      attachTo: document.body,
    })

    await flushPromises()

    const status = wrapper.get('[data-testid="onedrive-fill-status"]')
    expect(status.text()).toContain('Graph 403')
    expect(status.classes()).toContain('onedrive-status--warning')

    wrapper.unmount()
  })

  it('affiche le statut désactivé quand la configuration OneDrive est absente', async () => {
    mockState.generateResult = {
      filename: 'RECLAMACION.xlsx',
      lineCount: 1,
      onedriveStatus: 'skipped',
      onedriveMessage: 'Configuration OneDrive fournisseur absente.',
    }
    const router = makeRouter()
    await router.push('/admin/sav/16/demande-fournisseur')
    await router.isReady()

    const wrapper = mount(SupplierClaimView, {
      global: { plugins: [router] },
      attachTo: document.body,
    })

    await flushPromises()

    const status = wrapper.get('[data-testid="onedrive-fill-status"]')
    expect(status.text()).toContain('Configuration OneDrive fournisseur absente.')
    expect(status.classes()).toContain('onedrive-status--muted')

    wrapper.unmount()
  })
})
