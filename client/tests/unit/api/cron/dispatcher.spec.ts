import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockReq, mockRes } from '../_lib/test-helpers'

// Mock les 3 run* avant import handler
const runs = vi.hoisted(() => ({
  cleanupRateLimits: vi.fn(async () => ({ deleted: 1 })),
  purgeTokens: vi.fn(async () => ({ deleted: 2 })),
  purgeDrafts: vi.fn(async () => ({ deleted: 3 })),
}))

vi.mock('../../../../api/_lib/cron-runners/cleanup-rate-limits', () => ({
  runCleanupRateLimits: runs.cleanupRateLimits,
}))
vi.mock('../../../../api/_lib/cron-runners/purge-tokens', () => ({
  runPurgeTokens: runs.purgeTokens,
}))
vi.mock('../../../../api/_lib/cron-runners/purge-drafts', () => ({
  runPurgeDrafts: runs.purgeDrafts,
}))

import handler from '../../../../api/cron/dispatcher'

describe('POST /api/cron/dispatcher', () => {
  beforeEach(() => {
    runs.cleanupRateLimits.mockClear().mockResolvedValue({ deleted: 1 })
    runs.purgeTokens.mockClear().mockResolvedValue({ deleted: 2 })
    runs.purgeDrafts.mockClear().mockResolvedValue({ deleted: 3 })
    process.env['CRON_SECRET'] = 'unit-test-secret-12345'
  })

  it('401 sans bearer', async () => {
    const res = mockRes()
    await handler(mockReq({ method: 'POST', headers: {} }), res)
    expect(res.statusCode).toBe(401)
    expect(runs.cleanupRateLimits).not.toHaveBeenCalled()
  })

  it('exécute les 3 jobs à chaque appel autorisé (schedule quotidien 03:00 UTC)', async () => {
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
    const body = res.jsonBody as { ok: boolean; results: Record<string, unknown> }
    expect(body.results).toMatchObject({
      cleanupRateLimits: { deleted: 1 },
      purgeTokens: { deleted: 2 },
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
})
