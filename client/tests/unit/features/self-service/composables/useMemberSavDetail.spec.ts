/**
 * H-11 — ATDD RED PHASE
 *
 * W103 — Auto-refresh PDF pending : polling 30s tant que creditNote.hasPdf === false.
 *
 * ACs testés :
 *   AC #1 — Polling démarre/arrête selon creditNote.hasPdf
 *   AC #2 — Cleanup déterministe (reset(), switch SAV, cap 20 attempts)
 *   AC #3 — Polling silencieux : loading/error refs inchangés pendant un tick
 *   AC #4 — Tests Vitest fake-timer (ce fichier)
 *
 * Tests porteurs :
 *   W-103-T1 — Polling démarre après load() quand creditNote && !hasPdf
 *   W-103-T2 — Polling s'arrête dès que hasPdf: true revient du tick
 *   W-103-T3 — Pas de polling si creditNote === null ou hasPdf: true au load initial
 *   W-103-T4 — reset() arrête le polling ; cap 20 attempts respecté
 *
 * Conventions :
 *   - globalThis.fetch mocké inline par test (vi.fn().mockResolvedValueOnce séquentiel)
 *   - vi.useFakeTimers() / vi.useRealTimers() en beforeEach/afterEach
 *   - vi.advanceTimersByTimeAsync(N) pour flusher microtasks après chaque tick
 *   - Helper jsonResponse() cohérent avec MemberSavDetailView-6-4.spec.ts:39
 *   - Composable importé directement (pas de mount Vue SFC) — isolation pure TS
 *
 * RED attendu avant implémentation H-11 :
 *   W-103-T1 : RED — startPollingIfNeeded() absente → setInterval jamais armé
 *   W-103-T2 : RED — stopPolling() absente → le polling ne s'arrête pas sur hasPdf:true
 *   W-103-T3 : GREEN probable — pas de polling si creditNote=null (aucune logique à planter)
 *   W-103-T4 : RED — reset() non exposé / cap 20 absent
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import {
  POLL_INTERVAL_MS,
  POLL_MAX_ATTEMPTS,
} from '@features/self-service/composables/useMemberSavDetail'

// ---------------------------------------------------------------------------
// Helper : construit une Response JSON minimale (pattern MemberSavDetailView-6-4.spec.ts:39)
// ---------------------------------------------------------------------------
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    headers: new Headers(),
  } as unknown as Response
}

// ---------------------------------------------------------------------------
// Fixture : detail SAV de base (sans avoir)
// ---------------------------------------------------------------------------
const BASE_DETAIL = {
  id: 123,
  reference: 'SAV-2026-00123',
  status: 'closed',
  version: 3,
  receivedAt: '2026-04-25T10:00:00Z',
  takenAt: '2026-04-25T11:00:00Z',
  validatedAt: '2026-04-26T10:00:00Z',
  closedAt: '2026-04-27T10:00:00Z',
  cancelledAt: null,
  totalAmountCents: 12500,
  lines: [],
  files: [],
  comments: [],
  creditNote: null as null | {
    number: string
    issuedAt: string
    totalTtcCents: number
    hasPdf: boolean
  },
}

// Credit note avec PDF pending
const CREDIT_NOTE_PENDING = {
  number: 'AV-2026-00042',
  issuedAt: '2026-04-26T15:00:00Z',
  totalTtcCents: 9900,
  hasPdf: false,
}

// Credit note avec PDF disponible
const CREDIT_NOTE_READY = {
  ...CREDIT_NOTE_PENDING,
  hasPdf: true,
}

// ---------------------------------------------------------------------------
// Restore globaux après chaque test
// ---------------------------------------------------------------------------
const originalFetch = globalThis.fetch

// ---------------------------------------------------------------------------
// Suite de tests
// ---------------------------------------------------------------------------
describe('useMemberSavDetail — H-11 polling auto-refresh PDF pending (AC #1 / #2 / #3)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    globalThis.fetch = originalFetch
  })

  // -------------------------------------------------------------------------
  // W-103-T1 — Polling démarre après load() quand creditNote && !hasPdf
  // AC #1 (c)(f) — startPollingIfNeeded() invoquée après load() succès
  // -------------------------------------------------------------------------
  it('W-103-T1 — Polling démarre 30s après load() avec creditNote.hasPdf=false', async () => {
    const detailPending = { ...BASE_DETAIL, creditNote: CREDIT_NOTE_PENDING }
    const detailPendingStill = { ...BASE_DETAIL, creditNote: CREDIT_NOTE_PENDING }

    // fetch #1 : load initial → pending
    // fetch #2 : tick polling 30s → pending encore (PDF pas encore là)
    let callCount = 0
    globalThis.fetch = vi.fn(() => {
      callCount++
      if (callCount === 1) return Promise.resolve(jsonResponse(200, { data: detailPending }))
      return Promise.resolve(jsonResponse(200, { data: detailPendingStill }))
    }) as unknown as typeof globalThis.fetch

    // Import dynamique pour contourner l'isolation de module entre tests
    const { useMemberSavDetail } = await import(
      '@features/self-service/composables/useMemberSavDetail'
    )
    const composable = useMemberSavDetail()

    // Déclenche load(123) — doit armer le polling car hasPdf=false
    await composable.load(123)
    await flushPromises()

    // À t=0 : 1 seul fetch (load initial)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    expect(composable.data.value?.creditNote?.hasPdf).toBe(false)

    // Avance 30s — le setInterval doit déclencher pollOnce()
    await vi.advanceTimersByTimeAsync(30_000)

    // À t=30s : 2 fetches (load initial + 1 tick polling)
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)

    // Vérifie que la 2e URL est bien /api/self-service/sav/123
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
    expect(String(calls[1]![0])).toBe('/api/self-service/sav/123')
  })

  // -------------------------------------------------------------------------
  // W-103-T2 — Polling s'arrête dès que hasPdf: true revient du tick
  // AC #1 (e) — pollOnce() appelle stopPolling() quand hasPdf=true
  // AC #2 (e) — pas de double-tick après arrêt
  // -------------------------------------------------------------------------
  it("W-103-T2 — Polling s'arrête dès que hasPdf:true revient du tick", async () => {
    const detailPending = { ...BASE_DETAIL, creditNote: CREDIT_NOTE_PENDING }
    const detailReady = { ...BASE_DETAIL, creditNote: CREDIT_NOTE_READY }

    // fetch #1 : load initial → pending
    // fetch #2 : 1er tick polling → PDF prêt !
    // fetch #3 ne doit PAS se produire (polling stoppé)
    let callCount = 0
    globalThis.fetch = vi.fn(() => {
      callCount++
      if (callCount === 1) return Promise.resolve(jsonResponse(200, { data: detailPending }))
      if (callCount === 2) return Promise.resolve(jsonResponse(200, { data: detailReady }))
      // Ce 3e appel ne devrait pas se produire
      return Promise.resolve(jsonResponse(200, { data: detailReady }))
    }) as unknown as typeof globalThis.fetch

    const { useMemberSavDetail } = await import(
      '@features/self-service/composables/useMemberSavDetail'
    )
    const composable = useMemberSavDetail()

    await composable.load(123)
    await flushPromises()

    // 1er tick : hasPdf passe à true → polling doit s'arrêter
    await vi.advanceTimersByTimeAsync(30_000)
    // hasPdf: true → data mis à jour
    expect(composable.data.value?.creditNote?.hasPdf).toBe(true)

    // 2e tick : ne doit PAS déclencher un fetch (polling arrêté)
    await vi.advanceTimersByTimeAsync(30_000)

    // Total : 2 fetches (load initial + 1 tick) — pas de 3e
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })

  // -------------------------------------------------------------------------
  // W-103-T3 (a) — Pas de polling si creditNote === null (aucun avoir)
  // AC #1 (i) — startPollingIfNeeded() retourne early si !cn
  // -------------------------------------------------------------------------
  it('W-103-T3 (a) — Pas de polling si creditNote=null après load()', async () => {
    const detailNoCreditNote = { ...BASE_DETAIL, creditNote: null }

    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { data: detailNoCreditNote }))
    ) as unknown as typeof globalThis.fetch

    const { useMemberSavDetail } = await import(
      '@features/self-service/composables/useMemberSavDetail'
    )
    const composable = useMemberSavDetail()

    await composable.load(123)
    await flushPromises()

    // Avance 60s — aucun tick polling ne doit partir
    await vi.advanceTimersByTimeAsync(60_000)

    // 1 seul fetch (load initial uniquement)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  // -------------------------------------------------------------------------
  // W-103-T3 (b) — Pas de polling si hasPdf: true au load initial
  // AC #1 (j) — startPollingIfNeeded() retourne early si cn.hasPdf === true
  // -------------------------------------------------------------------------
  it('W-103-T3 (b) — Pas de polling si creditNote.hasPdf=true au load initial', async () => {
    const detailReady = { ...BASE_DETAIL, creditNote: CREDIT_NOTE_READY }

    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { data: detailReady }))
    ) as unknown as typeof globalThis.fetch

    const { useMemberSavDetail } = await import(
      '@features/self-service/composables/useMemberSavDetail'
    )
    const composable = useMemberSavDetail()

    await composable.load(123)
    await flushPromises()

    // Avance 60s — aucun tick polling ne doit partir (PDF déjà dispo)
    await vi.advanceTimersByTimeAsync(60_000)

    // 1 seul fetch (load initial uniquement)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    expect(composable.data.value?.creditNote?.hasPdf).toBe(true)
  })

  // -------------------------------------------------------------------------
  // W-103-T4 (i) — reset() arrête le polling immédiatement
  // AC #2 (a) — reset() exposé publiquement + clearInterval
  // -------------------------------------------------------------------------
  it('W-103-T4 (i) — reset() arrête le polling, aucun tick post-reset', async () => {
    const detailPending = { ...BASE_DETAIL, creditNote: CREDIT_NOTE_PENDING }

    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { data: detailPending }))
    ) as unknown as typeof globalThis.fetch

    const { useMemberSavDetail } = await import(
      '@features/self-service/composables/useMemberSavDetail'
    )
    const composable = useMemberSavDetail()

    await composable.load(123)
    await flushPromises()

    // polling armé à ce stade (hasPdf=false)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)

    // reset() doit couper le polling
    composable.reset()

    // Avance 60s — aucun tick ne doit partir
    await vi.advanceTimersByTimeAsync(60_000)

    // Toujours 1 seul fetch (load initial — pas de tick post-reset)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)

    // reset() vide aussi data / error / loading
    expect(composable.data.value).toBeNull()
    expect(composable.error.value).toBeNull()
    expect(composable.loading.value).toBe(false)
  })

  // -------------------------------------------------------------------------
  // W-103-T4 (ii) — Cap 20 tentatives : le polling s'arrête après 20 ticks
  // AC #2 (c) — pollAttempts > 20 déclenche stopPolling()
  // -------------------------------------------------------------------------
  it('W-103-T4 (ii) — Cap 20 tentatives : fetch totalise 21 (1 load + 20 ticks), pas 22', async () => {
    const detailPending = { ...BASE_DETAIL, creditNote: CREDIT_NOTE_PENDING }

    // Tous les fetches retournent hasPdf: false (PDF jamais prêt)
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { data: detailPending }))
    ) as unknown as typeof globalThis.fetch

    const { useMemberSavDetail } = await import(
      '@features/self-service/composables/useMemberSavDetail'
    )
    const composable = useMemberSavDetail()

    await composable.load(123)
    await flushPromises()

    // Avance 21 × 30s = 630s — déclenche 21 ticks
    // Le 21e tick (pollAttempts=21 > 20) doit arrêter le polling AVANT de fetcher
    // Donc : 20 ticks actifs seulement → 21 total (1 load + 20 ticks)
    await vi.advanceTimersByTimeAsync(21 * 30_000)

    // Compte des appels : 1 (load) + 20 (ticks 1..20) = 21 — pas 22
    expect(globalThis.fetch).toHaveBeenCalledTimes(21)

    // Un 22e tick ne doit pas partir non plus
    await vi.advanceTimersByTimeAsync(30_000)
    expect(globalThis.fetch).toHaveBeenCalledTimes(21)
  })

  // -------------------------------------------------------------------------
  // W-103-T5 (bonus AC #3) — pollOnce() ne touche pas loading ni error
  // AC #3 (a)(b) — loading reste false, error reste null pendant les ticks
  // -------------------------------------------------------------------------
  it('W-103-T5 — pollOnce() ne modifie pas loading ni error (polling silencieux)', async () => {
    const detailPending = { ...BASE_DETAIL, creditNote: CREDIT_NOTE_PENDING }

    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { data: detailPending }))
    ) as unknown as typeof globalThis.fetch

    const { useMemberSavDetail } = await import(
      '@features/self-service/composables/useMemberSavDetail'
    )
    const composable = useMemberSavDetail()

    await composable.load(123)
    await flushPromises()

    // Après load() : loading=false, error=null
    expect(composable.loading.value).toBe(false)
    expect(composable.error.value).toBeNull()

    // Avance 30s → tick polling
    await vi.advanceTimersByTimeAsync(30_000)

    // Pendant et après le tick : loading toujours false, error toujours null
    expect(composable.loading.value).toBe(false)
    expect(composable.error.value).toBeNull()
    // 2 fetches confirmés (load + 1 tick)
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })

  // -------------------------------------------------------------------------
  // W-103-T6 (AC #2 (f)) — Switch SAV : stopPolling() avant nouveau load()
  // Quand load(newSavId) est appelé, l'ancien polling est tué
  // -------------------------------------------------------------------------
  it("W-103-T6 — Switch SAV : le polling de l'ancien SAV est stoppé par load(newId)", async () => {
    const detailSav123Pending = { ...BASE_DETAIL, id: 123, creditNote: CREDIT_NOTE_PENDING }
    const detailSav456NoCreditNote = {
      ...BASE_DETAIL,
      id: 456,
      reference: 'SAV-2026-00456',
      creditNote: null,
    }

    let callCount = 0
    globalThis.fetch = vi.fn((url: string | URL | Request) => {
      callCount++
      const urlStr = String(url)
      if (urlStr.includes('/sav/123')) {
        return Promise.resolve(jsonResponse(200, { data: detailSav123Pending }))
      }
      // SAV 456 — pas d'avoir → pas de polling
      return Promise.resolve(jsonResponse(200, { data: detailSav456NoCreditNote }))
    }) as unknown as typeof globalThis.fetch

    const { useMemberSavDetail } = await import(
      '@features/self-service/composables/useMemberSavDetail'
    )
    const composable = useMemberSavDetail()

    // Charge SAV 123 → polling armé (hasPdf=false)
    await composable.load(123)
    await flushPromises()
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)

    // Switch vers SAV 456 → doit stopper le polling de SAV 123
    await composable.load(456)
    await flushPromises()
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)

    // Avance 60s — aucun tick pour SAV 123 ni SAV 456 (456 n'a pas d'avoir)
    await vi.advanceTimersByTimeAsync(60_000)

    // Toujours 2 fetches (load 123 + load 456)
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
    expect(composable.data.value?.id).toBe(456)
  })

  // -------------------------------------------------------------------------
  // W-103-T7 (AC #2 (e)) — Pas de double-tick : garde if (pollTimer !== null)
  // Appeler startPollingIfNeeded() deux fois n'empile pas 2 setInterval
  // -------------------------------------------------------------------------
  it('W-103-T7 — Pas de double-tick : reload() ne double pas le polling', async () => {
    const detailPending = { ...BASE_DETAIL, creditNote: CREDIT_NOTE_PENDING }

    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { data: detailPending }))
    ) as unknown as typeof globalThis.fetch

    const { useMemberSavDetail } = await import(
      '@features/self-service/composables/useMemberSavDetail'
    )
    const composable = useMemberSavDetail()

    // load() initial → polling armé
    await composable.load(123)
    await flushPromises()
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)

    // reload() → stoppe puis redémarre le polling (load() est appelé)
    // Mais si l'implémentation est correcte, un seul setInterval actif
    await composable.reload()
    await flushPromises()
    // reload() a re-fetché → 2 appels
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)

    // 1 seul tick 30s plus tard (pas 2 ticks en parallèle)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(globalThis.fetch).toHaveBeenCalledTimes(3)

    // Un autre tick : toujours +1 (pas +2)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(globalThis.fetch).toHaveBeenCalledTimes(4)
  })

  // -------------------------------------------------------------------------
  // CR-NEW-1 — pollOnce() fetch error branch : reject → silent fail
  // AC #3 (b) — error.value inchangé, data.value inchangé, loading inchangé
  // -------------------------------------------------------------------------
  it('CR-NEW-1 — pollOnce() fetch error: loading=false, error=null, data unchanged (silent fail)', async () => {
    const detailPending = { ...BASE_DETAIL, creditNote: CREDIT_NOTE_PENDING }

    let callCount = 0
    globalThis.fetch = vi.fn(() => {
      callCount++
      if (callCount === 1) return Promise.resolve(jsonResponse(200, { data: detailPending }))
      // 2nd fetch (polling tick) rejects with a network error
      return Promise.reject(new Error('network error'))
    }) as unknown as typeof globalThis.fetch

    const { useMemberSavDetail } = await import(
      '@features/self-service/composables/useMemberSavDetail'
    )
    const composable = useMemberSavDetail()

    await composable.load(123)
    await flushPromises()

    // Baseline after load
    expect(composable.loading.value).toBe(false)
    expect(composable.error.value).toBeNull()
    const dataBefore = composable.data.value

    // Advance 30s — triggers pollOnce() which rejects
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)

    // Silent fail: loading stays false, error stays null, data unchanged
    expect(composable.loading.value).toBe(false)
    expect(composable.error.value).toBeNull()
    expect(composable.data.value).toBe(dataBefore)
    // fetch was called twice (1 load + 1 failing tick)
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })

  // -------------------------------------------------------------------------
  // CR-NEW-2 — Cap reached + recovery via reload()
  // AC #2 (d) — après cap, reload() remet pollAttempts à 0 et redémarre polling
  // -------------------------------------------------------------------------
  it('CR-NEW-2 — Cap atteint puis reload() repart avec un nouveau cycle de polling', async () => {
    const detailPending = { ...BASE_DETAIL, creditNote: CREDIT_NOTE_PENDING }

    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { data: detailPending }))
    ) as unknown as typeof globalThis.fetch

    const { useMemberSavDetail } = await import(
      '@features/self-service/composables/useMemberSavDetail'
    )
    const composable = useMemberSavDetail()

    await composable.load(123)
    await flushPromises()

    // Advance past cap: (POLL_MAX_ATTEMPTS + 1) ticks to exhaust the cap
    await vi.advanceTimersByTimeAsync((POLL_MAX_ATTEMPTS + 1) * POLL_INTERVAL_MS)
    const fetchCountAfterCap = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length
    // Should be 1 (load) + POLL_MAX_ATTEMPTS (ticks) = 21
    expect(fetchCountAfterCap).toBe(1 + POLL_MAX_ATTEMPTS)

    // Confirm polling is stopped: advance another interval → no new fetch
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(globalThis.fetch).toHaveBeenCalledTimes(fetchCountAfterCap)

    // Recovery: reload() should reset pollAttempts and restart polling
    await composable.reload()
    await flushPromises()
    const fetchCountAfterReload = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length
    // reload() triggers one more fetch
    expect(fetchCountAfterReload).toBe(fetchCountAfterCap + 1)

    // After reload, polling should be active again — advance 30s → one more tick
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(globalThis.fetch).toHaveBeenCalledTimes(fetchCountAfterReload + 1)
  })

  // -------------------------------------------------------------------------
  // CR-NEW-3 — Two instances do NOT share polling state (HIGH-1 fix proof)
  // Proves pollTimer/pollAttempts are per-instance (function-scoped)
  // -------------------------------------------------------------------------
  it('CR-NEW-3 — Deux instances composable ont un polling indépendant (pas de module state partagé)', async () => {
    const detail123Pending = { ...BASE_DETAIL, id: 123, creditNote: CREDIT_NOTE_PENDING }
    const detail456Pending = {
      ...BASE_DETAIL,
      id: 456,
      reference: 'SAV-2026-00456',
      creditNote: CREDIT_NOTE_PENDING,
    }

    // Route calls to correct response based on URL
    globalThis.fetch = vi.fn((url: string | URL | Request) => {
      const urlStr = String(url)
      if (urlStr.includes('/sav/123')) {
        return Promise.resolve(jsonResponse(200, { data: detail123Pending }))
      }
      return Promise.resolve(jsonResponse(200, { data: detail456Pending }))
    }) as unknown as typeof globalThis.fetch

    const { useMemberSavDetail } = await import(
      '@features/self-service/composables/useMemberSavDetail'
    )

    // Create two independent composable instances
    const composable1 = useMemberSavDetail()
    const composable2 = useMemberSavDetail()

    // Load different SAVs in parallel
    await Promise.all([composable1.load(123), composable2.load(456)])
    await flushPromises()

    // Both loads happened: 2 fetches
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
    expect(composable1.data.value?.id).toBe(123)
    expect(composable2.data.value?.id).toBe(456)

    // Advance 30s — BOTH instances should poll independently
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)

    // 2 (loads) + 2 (one tick per instance) = 4
    expect(globalThis.fetch).toHaveBeenCalledTimes(4)

    // Advance another 30s — both instances tick again
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(globalThis.fetch).toHaveBeenCalledTimes(6)

    // Cleanup both instances
    composable1.reset()
    composable2.reset()
  })
})
