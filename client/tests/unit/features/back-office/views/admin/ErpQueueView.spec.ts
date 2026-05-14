/**
 * H-10 AC #3 — OQ-2 — ATDD RED PHASE
 *
 * W117 — ErpQueueView passe removeFromList: filters.status === 'failed' à retryPush.
 *
 * AC testés :
 *   AC #3.3 — ErpQueueView.vue:43 appelle erp.retryPush(push.id, { removeFromList: filters.status === 'failed' })
 *   AC #3.6 — filters.status === 'all' → removeFromList: false
 *
 * Tests :
 *   T1 — filters.status='failed' + click "Retenter" → retryPush appelé avec { removeFromList: true }
 *   T2 — filters.status='all' + click "Retenter" → retryPush appelé avec { removeFromList: false }
 *
 * Mock strategy :
 *   - vi.mock useAdminErpQueue → spy sur retryPush.
 *   - vi.hoisted utilisé UNIQUEMENT pour les vi.fn() (pas de ref Vue, pas de TDZ).
 *   - pushes ref créé DANS le factory de vi.mock (après import Vue résolu).
 *   - featureAvailable = true (mode actif, pas le placeholder banner)
 *   - pushes pré-remplis avec 1 push status='failed' pour avoir le bouton "Retenter"
 *   - filters.status modifié via le <select> dans le SFC
 *
 * RED attendu :
 *   T1 : RED — onRetry appelle actuellement erp.retryPush(push.id) sans opts
 *   T2 : RED — même raison
 *
 * Note directory : ErpQueueView.vue est dans views/admin/ → spec dans views/admin/
 * (convention vérifiée : CatalogAdminView.spec.ts, ValidationListsAdminView.spec.ts)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'

// ---------------------------------------------------------------------------
// vi.hoisted : UNIQUEMENT pour les fonctions spy (pas de ref Vue ici).
// Les ref Vue doivent être créés DANS le factory de vi.mock.
// ---------------------------------------------------------------------------
const mockFns = vi.hoisted(() => ({
  retryPush: vi.fn(),
  fetchPushes: vi.fn(),
}))

vi.mock('../../../../../../src/features/back-office/composables/useAdminErpQueue', () => {
  // Vue est disponible ici (factory exécutée au moment de l'import, après résolution des deps)
  const { ref } = require('vue')

  const pushes = ref([
    {
      id: 42,
      sav_id: 142,
      sav_reference: 'SAV-2026-00042',
      status: 'failed',
      attempts: 3,
      last_error: 'connection refused',
      last_attempt_at: '2026-05-14T10:00:00Z',
      next_retry_at: null,
      scheduled_at: null,
      created_at: '2026-05-14T09:00:00Z',
      updated_at: '2026-05-14T10:00:00Z',
    },
  ])

  return {
    useAdminErpQueue: () => ({
      pushes,
      nextCursor: ref(null),
      featureAvailable: ref(true),
      loading: ref(false),
      error: ref(null),
      fetchPushes: mockFns.fetchPushes,
      retryPush: mockFns.retryPush,
    }),
  }
})

import ErpQueueView from '../../../../../../src/features/back-office/views/admin/ErpQueueView.vue'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function mountView() {
  return mount(ErpQueueView, {
    global: {
      stubs: {
        transition: true,
      },
    },
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('ErpQueueView — H-10 OQ-2 W117: retryPush reçoit removeFromList selon filters.status (AC #3.3)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // retryPush résout (succès) pour que le toast success soit affiché
    mockFns.retryPush.mockResolvedValue(undefined)
    mockFns.fetchPushes.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('T1 — filters.status="failed" + click Retenter → retryPush(42, { removeFromList: true }) (AC #3.3)', async () => {
    /**
     * RED : onRetry appelle erp.retryPush(push.id) sans 2e argument.
     * Après fix : erp.retryPush(push.id, { removeFromList: filters.status === 'failed' })
     * → { removeFromList: true } car filters.status = 'failed' (défaut ErpQueueView).
     */
    const w = await mountView()
    await flushPromises()

    // Le filtre par défaut est 'failed' (ErpQueueView.vue:18-21)
    // Le bouton "Retenter" est visible car push.status === 'failed'
    const retryBtn = w.find('[data-retry-push="42"]')
    expect(retryBtn.exists()).toBe(true)

    await retryBtn.trigger('click')
    await flushPromises()

    // Vérifier que retryPush a été appelé avec les bons arguments
    expect(mockFns.retryPush).toHaveBeenCalledOnce()
    expect(mockFns.retryPush).toHaveBeenCalledWith(42, { removeFromList: true })
  })

  it('T2 — filters.status="all" + click Retenter → retryPush(42, { removeFromList: false }) (AC #3.3 / #3.6)', async () => {
    /**
     * RED : même raison que T1 — opts non passé.
     * Après fix : filters.status = 'all' → removeFromList = false.
     */
    const w = await mountView()
    await flushPromises()

    // Changer le filtre vers 'all' via le <select>
    const filterSelect = w.find('#filter-status')
    expect(filterSelect.exists()).toBe(true)
    await filterSelect.setValue('all')
    await w.vm.$nextTick()

    // Cliquer Retenter
    const retryBtn = w.find('[data-retry-push="42"]')
    expect(retryBtn.exists()).toBe(true)

    await retryBtn.trigger('click')
    await flushPromises()

    // Vérifier que retryPush a été appelé avec removeFromList: false
    expect(mockFns.retryPush).toHaveBeenCalledOnce()
    expect(mockFns.retryPush).toHaveBeenCalledWith(42, { removeFromList: false })
  })
})
