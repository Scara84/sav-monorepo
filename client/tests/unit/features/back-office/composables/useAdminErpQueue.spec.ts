/**
 * H-10 AC #3 — ATDD RED PHASE
 *
 * W117 — ERP retry : ligne disparaît du tableau filtré "failed".
 *
 * AC testés :
 *   AC #3.1 — Signature étendue : retryPush(id, opts?: { removeFromList?: boolean })
 *   AC #3.2 — Bifurcation post-POST :
 *             opts.removeFromList=true  → push retiré de pushes.value (filter)
 *             opts.removeFromList=false (ou absent) → push muté en status='pending' (rétrocompat)
 *   AC #3.4 — Pas de changement du toast (hors scope composable — géré par ErpQueueView)
 *   AC #3.5 — Pas de fetch backend supplémentaire déclenché par retryPush
 *   AC #3.6 — Si opts.removeFromList absent → comportement actuel (mute status='pending')
 *
 * Tests :
 *   T1 — retryPush(42) sans opts → push id=42 a status='pending' dans pushes.value (rétrocompat)
 *   T2 — retryPush(42, { removeFromList: true }) → push id=42 absent de pushes.value
 *   T3 — retryPush(42, { removeFromList: false }) → push id=42 reste avec status='pending' (rétrocompat)
 *   T4 — POST retry successful → 1 seul fetch POST (pas de re-fetch GET) (AC #3.5)
 *   T5 — retryPush erreur API → error.value posé + push non modifié dans pushes.value
 *
 * Mock strategy :
 *   - globalThis.fetch stubé inline (pas de module mock nécessaire — composable pur TS)
 *   - Pas de setup Vue SFC — composable instancié directement
 *   - pushes pré-remplis manuellement via fetchPushes mocké
 *
 * RED attendu :
 *   T1 : GREEN probable (comportement actuel — rétrocompat)
 *   T2 : RED — opts.removeFromList n'est pas encore dans la signature
 *   T3 : GREEN probable (opts absent → branche par défaut)
 *   T4 : GREEN probable (un seul fetch POST déjà)
 *   T5 : GREEN probable (gestion d'erreur déjà en place)
 *
 * Note DN-5 re-confirmée : grep retryPush → 1 seul caller (ErpQueueView.vue:43).
 * Extension rétrocompat opts? sans impact caller existant.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'

// ---------------------------------------------------------------------------
// Setup fetch mock helpers
// ---------------------------------------------------------------------------

type FetchMockOptions = {
  retryStatus?: number
  retryBody?: unknown
}

function setupFetch(opts: FetchMockOptions = {}) {
  const { retryStatus = 200, retryBody = { data: { push: {} } } } = opts

  const fetchCalls: string[] = []
  const fn = vi.fn(async (url: string, options?: RequestInit) => {
    const method = options?.method?.toUpperCase() ?? 'GET'
    fetchCalls.push(`${method} ${url}`)

    if (url.includes('/retry')) {
      return {
        ok: retryStatus >= 200 && retryStatus < 300,
        status: retryStatus,
        json: () => Promise.resolve(retryBody),
      } as unknown as Response
    }

    // GET /api/admin/erp-queue (fetchPushes)
    return {
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          data: { items: [], nextCursor: null },
        }),
    } as unknown as Response
  })
  ;(globalThis as unknown as { fetch: typeof fn }).fetch = fn
  return { fn, fetchCalls }
}

// ---------------------------------------------------------------------------
// Helper : crée un ErpPushItem de test
// ---------------------------------------------------------------------------
function makePush(id: number, status: 'failed' | 'pending' | 'success' = 'failed') {
  return {
    id,
    sav_id: 100 + id,
    sav_reference: `SAV-2026-0000${id}`,
    status,
    attempts: 3,
    last_error: 'connection refused',
    last_attempt_at: '2026-05-14T10:00:00Z',
    next_retry_at: null,
    scheduled_at: null,
    created_at: '2026-05-14T09:00:00Z',
    updated_at: '2026-05-14T10:00:00Z',
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('useAdminErpQueue — H-10 W117 retryPush opts.removeFromList (AC #3)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('T1 — retryPush(42) sans opts → push id=42 muté en status=pending (rétrocompat) (AC #3.2 / #3.6)', async () => {
    // GREEN probable : comportement actuel
    setupFetch()
    const { useAdminErpQueue } = await import(
      '../../../../../src/features/back-office/composables/useAdminErpQueue'
    )
    const erp = useAdminErpQueue()

    // Pré-remplir pushes via assignation directe (le ref est exposé)
    erp.pushes.value = [makePush(42, 'failed'), makePush(43, 'failed')]

    await erp.retryPush(42)
    await flushPromises()

    // La ligne doit encore exister mais avec status='pending'
    const push42 = erp.pushes.value.find((p) => p.id === 42)
    expect(push42).toBeDefined()
    expect(push42!.status).toBe('pending')
    // La ligne 43 ne doit pas être affectée
    const push43 = erp.pushes.value.find((p) => p.id === 43)
    expect(push43).toBeDefined()
    expect(push43!.status).toBe('failed')
    expect(erp.pushes.value).toHaveLength(2)
  })

  it('T2 — retryPush(42, { removeFromList: true }) → push id=42 absent de pushes (AC #3.1 / #3.2)', async () => {
    // RED : opts.removeFromList n'existe pas encore dans la signature
    setupFetch()
    const { useAdminErpQueue } = await import(
      '../../../../../src/features/back-office/composables/useAdminErpQueue'
    )
    const erp = useAdminErpQueue()

    erp.pushes.value = [makePush(42, 'failed'), makePush(43, 'failed')]

    // Appel avec opts selon AC #3.1
    await erp.retryPush(42, { removeFromList: true })
    await flushPromises()

    // La ligne id=42 doit avoir disparu
    expect(erp.pushes.value.find((p) => p.id === 42)).toBeUndefined()
    // La ligne id=43 doit être préservée
    expect(erp.pushes.value).toHaveLength(1)
    expect(erp.pushes.value[0]!.id).toBe(43)
  })

  it('T3 — retryPush(42, { removeFromList: false }) → push id=42 reste avec status=pending (AC #3.6)', async () => {
    // GREEN probable : opts.removeFromList=false → branche par défaut
    setupFetch()
    const { useAdminErpQueue } = await import(
      '../../../../../src/features/back-office/composables/useAdminErpQueue'
    )
    const erp = useAdminErpQueue()

    erp.pushes.value = [makePush(42, 'failed')]

    await erp.retryPush(42, { removeFromList: false })
    await flushPromises()

    const push42 = erp.pushes.value.find((p) => p.id === 42)
    expect(push42).toBeDefined()
    expect(push42!.status).toBe('pending')
    expect(erp.pushes.value).toHaveLength(1)
  })

  it('T4 — retryPush POST réussi → 1 seul fetch (pas de re-fetch GET) (AC #3.5)', async () => {
    const { fn } = setupFetch()
    const { useAdminErpQueue } = await import(
      '../../../../../src/features/back-office/composables/useAdminErpQueue'
    )
    const erp = useAdminErpQueue()
    erp.pushes.value = [makePush(42, 'failed')]

    await erp.retryPush(42)
    await flushPromises()

    // 1 seul appel fetch (le POST retry) — aucun GET supplémentaire
    const retryFetches = fn.mock.calls.filter((c) => String(c[0]).includes('/retry'))
    const getFetches = fn.mock.calls.filter(
      (c) => String(c[0]).includes('/erp-queue') && !String(c[0]).includes('/retry')
    )
    expect(retryFetches).toHaveLength(1)
    expect(getFetches).toHaveLength(0)
  })

  it('T5 — retryPush erreur API 500 → error.value posé + liste inchangée', async () => {
    // GREEN probable : gestion d'erreur déjà en place
    setupFetch({
      retryStatus: 500,
      retryBody: { error: { code: 'SERVER_ERROR', message: 'Internal error' } },
    })
    const { useAdminErpQueue } = await import(
      '../../../../../src/features/back-office/composables/useAdminErpQueue'
    )
    const erp = useAdminErpQueue()
    erp.pushes.value = [makePush(42, 'failed')]

    await expect(erp.retryPush(42)).rejects.toThrow()
    await flushPromises()

    // error.value doit être posé
    expect(erp.error.value).toBeTruthy()
    // La liste ne doit pas avoir changé (push reste failed)
    expect(erp.pushes.value[0]!.status).toBe('failed')
  })
})
