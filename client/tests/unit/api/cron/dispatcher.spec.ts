import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockReq, mockRes } from '../_lib/test-helpers'

// Mock les run* avant import handler
// H-02 : ajout purgeSavSubmitTokens (AC#3 — ordering D-10 : après purgeTokens, avant purgeDrafts)
const runs = vi.hoisted(() => ({
  cleanupRateLimits: vi.fn(async () => ({ deleted: 1 })),
  purgeTokens: vi.fn(async () => ({ deleted: 2 })),
  purgeSavSubmitTokens: vi.fn(async () => ({ deleted: 4 })),
  purgeDrafts: vi.fn(async () => ({ deleted: 3 })),
  thresholdAlerts: vi.fn(async () => ({
    products_over_threshold: 0,
    alerts_enqueued: 0,
    alerts_skipped_dedup: 0,
    settings_used: { count: 5, days: 7, dedup_hours: 24 },
    duration_ms: 1,
  })),
}))

vi.mock('../../../../api/_lib/cron-runners/cleanup-rate-limits', () => ({
  runCleanupRateLimits: runs.cleanupRateLimits,
}))
vi.mock('../../../../api/_lib/cron-runners/purge-tokens', () => ({
  runPurgeTokens: runs.purgeTokens,
}))
// H-02 AC#3 — mock nouveau runner purge-sav-submit-tokens
vi.mock('../../../../api/_lib/cron-runners/purge-sav-submit-tokens', () => ({
  runPurgeSavSubmitTokens: runs.purgeSavSubmitTokens,
}))
vi.mock('../../../../api/_lib/cron-runners/purge-drafts', () => ({
  runPurgeDrafts: runs.purgeDrafts,
}))
vi.mock('../../../../api/_lib/cron-runners/threshold-alerts', () => ({
  runThresholdAlerts: runs.thresholdAlerts,
}))

import handler from '../../../../api/cron/dispatcher'

describe('POST /api/cron/dispatcher', () => {
  beforeEach(() => {
    runs.cleanupRateLimits.mockClear().mockResolvedValue({ deleted: 1 })
    runs.purgeTokens.mockClear().mockResolvedValue({ deleted: 2 })
    runs.purgeSavSubmitTokens.mockClear().mockResolvedValue({ deleted: 4 })
    runs.purgeDrafts.mockClear().mockResolvedValue({ deleted: 3 })
    runs.thresholdAlerts.mockClear().mockResolvedValue({
      products_over_threshold: 0,
      alerts_enqueued: 0,
      alerts_skipped_dedup: 0,
      settings_used: { count: 5, days: 7, dedup_hours: 24 },
      duration_ms: 1,
    })
    process.env['CRON_SECRET'] = 'unit-test-secret-12345'
  })

  it('401 sans bearer', async () => {
    const res = mockRes()
    await handler(mockReq({ method: 'POST', headers: {} }), res)
    expect(res.statusCode).toBe(401)
    expect(runs.cleanupRateLimits).not.toHaveBeenCalled()
  })

  it('exécute les 7 jobs à chaque appel autorisé (schedule quotidien 03:00 UTC)', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: { authorization: 'Bearer unit-test-secret-12345' },
      }),
      res
    )
    expect(res.statusCode).toBe(200)
    expect(runs.cleanupRateLimits).toHaveBeenCalledOnce()
    expect(runs.purgeTokens).toHaveBeenCalledOnce()
    expect(runs.purgeDrafts).toHaveBeenCalledOnce()
    expect(runs.thresholdAlerts).toHaveBeenCalledOnce()
    const body = res.jsonBody as { ok: boolean; results: Record<string, unknown> }
    expect(body.results).toMatchObject({
      cleanupRateLimits: { deleted: 1 },
      purgeTokens: { deleted: 2 },
      purgeDrafts: { deleted: 3 },
      thresholdAlerts: { products_over_threshold: 0, alerts_enqueued: 0 },
    })
  })

  // H-02 AC#3 + AC#5(c) — câblage du 7e runner purgeSavSubmitTokens
  it('H-02 AC#3 — exécute purgeSavSubmitTokens (7e job, entre purgeTokens et purgeDrafts)', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: { authorization: 'Bearer unit-test-secret-12345' },
      }),
      res
    )
    expect(res.statusCode).toBe(200)
    // Le nouveau job doit être appelé
    expect(runs.purgeSavSubmitTokens).toHaveBeenCalledOnce()
    // Les jobs existants ne sont pas impactés
    expect(runs.purgeTokens).toHaveBeenCalledOnce()
    expect(runs.purgeDrafts).toHaveBeenCalledOnce()
    const body = res.jsonBody as { ok: boolean; results: Record<string, unknown> }
    // Le résultat du nouveau job apparaît dans le payload dispatcher
    expect(body.results).toMatchObject({
      purgeSavSubmitTokens: { deleted: 4 },
    })
  })

  it('H-02 AC#3 — payload results contient purgeSavSubmitTokens distinct de purgeTokens', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: { authorization: 'Bearer unit-test-secret-12345' },
      }),
      res
    )
    const body = res.jsonBody as { ok: boolean; results: Record<string, unknown> }
    // Métriques séparées (D-6 : 2 runners séparés pour 2 logs distincts)
    expect(body.results).toMatchObject({
      purgeTokens: { deleted: 2 },
      purgeSavSubmitTokens: { deleted: 4 },
    })
    // Les clés sont distinctes
    expect(body.results).toHaveProperty('purgeTokens')
    expect(body.results).toHaveProperty('purgeSavSubmitTokens')
  })

  it('H-02 AC#5(c) — purgeSavSubmitTokens qui throw ne bloque pas purgeDrafts (résilience safeRun)', async () => {
    runs.purgeSavSubmitTokens.mockRejectedValueOnce(new Error('sav-submit kaboom'))
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: { authorization: 'Bearer unit-test-secret-12345' },
      }),
      res
    )
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { results: Record<string, unknown> }
    // purgeSavSubmitTokens en erreur → { error: '...' } dans results
    expect(body.results).toMatchObject({
      purgeSavSubmitTokens: { error: 'sav-submit kaboom' },
    })
    // purgeDrafts a bien été exécuté malgré l'erreur du job précédent
    expect(runs.purgeDrafts).toHaveBeenCalledOnce()
    expect(body.results).toMatchObject({
      purgeDrafts: { deleted: 3 },
    })
  })

  it('un job qui throw ne bloque pas les autres', async () => {
    runs.purgeTokens.mockRejectedValueOnce(new Error('kaboom'))
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: { authorization: 'Bearer unit-test-secret-12345' },
      }),
      res
    )
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { results: Record<string, unknown> }
    expect(body.results).toMatchObject({
      cleanupRateLimits: { deleted: 1 },
      purgeTokens: { error: 'kaboom' },
      purgeDrafts: { deleted: 3 },
    })
    // Même avec un throw sur purgeTokens, purgeDrafts a bien été appelé
    expect(runs.purgeDrafts).toHaveBeenCalledOnce()
  })

  it('CR T2 — thresholdAlerts qui throw ne bloque pas les jobs précédents', async () => {
    runs.thresholdAlerts.mockRejectedValueOnce(new Error('threshold boom'))
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: { authorization: 'Bearer unit-test-secret-12345' },
      }),
      res
    )
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { ok: boolean; results: Record<string, unknown> }
    expect(body.ok).toBe(true)
    expect(body.results).toMatchObject({
      cleanupRateLimits: { deleted: 1 },
      purgeTokens: { deleted: 2 },
      purgeDrafts: { deleted: 3 },
      thresholdAlerts: { error: 'threshold boom' },
    })
    // Tous les jobs ont été tentés (résilience confirmée pour le nouveau job).
    expect(runs.cleanupRateLimits).toHaveBeenCalledOnce()
    expect(runs.purgeTokens).toHaveBeenCalledOnce()
    expect(runs.purgeDrafts).toHaveBeenCalledOnce()
    expect(runs.thresholdAlerts).toHaveBeenCalledOnce()
  })
})
