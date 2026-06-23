import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockReq, mockRes } from '../_lib/test-helpers'

/**
 * Story 6.6 AC #8 — runner retry-emails branché dans le dispatcher cron
 * quotidien existant (`api/cron/dispatcher.ts` 03:00 UTC), AUCUN nouveau
 * slot Vercel Hobby.
 */

const calls: string[] = []
const runs = vi.hoisted(() => ({
  cleanupRateLimits: vi.fn(),
  purgeTokens: vi.fn(),
  purgeDrafts: vi.fn(),
  thresholdAlerts: vi.fn(),
  retryEmails: vi.fn(),
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
vi.mock('../../../../api/_lib/cron-runners/threshold-alerts', () => ({
  runThresholdAlerts: runs.thresholdAlerts,
}))
vi.mock('../../../../api/_lib/cron-runners/retry-emails', () => ({
  runRetryEmails: runs.retryEmails,
}))

import handler from '../../../../api/cron/dispatcher'

describe('cron dispatcher — Story 6.6 retry-emails integration', () => {
  beforeEach(() => {
    calls.length = 0
    runs.cleanupRateLimits.mockReset().mockImplementation(async () => {
      calls.push('cleanupRateLimits')
      return { deleted: 1 }
    })
    runs.purgeTokens.mockReset().mockImplementation(async () => {
      calls.push('purgeTokens')
      return { deleted: 2 }
    })
    runs.purgeDrafts.mockReset().mockImplementation(async () => {
      calls.push('purgeDrafts')
      return { deleted: 3 }
    })
    runs.thresholdAlerts.mockReset().mockImplementation(async () => {
      calls.push('thresholdAlerts')
      return { products_over_threshold: 0, alerts_enqueued: 0, duration_ms: 1 }
    })
    runs.retryEmails.mockReset().mockImplementation(async () => {
      calls.push('retryEmails')
      return { scanned: 0, sent: 0, failed: 0, skipped_optout: 0, durationMs: 1 }
    })
    process.env['CRON_SECRET'] = 'unit-test-secret-12345'
  })

  it('AC#8 dispatcher invoque runRetryEmails APRÈS runThresholdAlerts (ordre)', async () => {
    const res = mockRes()
    await handler(
      mockReq({ method: 'POST', headers: { authorization: 'Bearer unit-test-secret-12345' } }),
      res
    )
    expect(res.statusCode).toBe(200)
    const tIdx = calls.indexOf('thresholdAlerts')
    const rIdx = calls.indexOf('retryEmails')
    expect(tIdx).toBeGreaterThanOrEqual(0)
    expect(rIdx).toBeGreaterThan(tIdx)
  })

  it('AC#8 retryEmails throw → dispatcher renvoie 200 avec results.retryEmails.error', async () => {
    runs.retryEmails.mockRejectedValueOnce(new Error('boom'))
    const res = mockRes()
    await handler(
      mockReq({ method: 'POST', headers: { authorization: 'Bearer unit-test-secret-12345' } }),
      res
    )
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { results: Record<string, unknown> }
    expect(body.results['retryEmails']).toMatchObject({ error: 'boom' })
  })

  it('AC#8 results.retryEmails contient { scanned, sent, failed, skipped_optout, durationMs }', async () => {
    const res = mockRes()
    await handler(
      mockReq({ method: 'POST', headers: { authorization: 'Bearer unit-test-secret-12345' } }),
      res
    )
    const body = res.jsonBody as { results: { retryEmails: Record<string, unknown> } }
    expect(body.results.retryEmails).toHaveProperty('scanned')
    expect(body.results.retryEmails).toHaveProperty('sent')
    expect(body.results.retryEmails).toHaveProperty('failed')
    expect(body.results.retryEmails).toHaveProperty('skipped_optout')
    expect(body.results.retryEmails).toHaveProperty('durationMs')
  })

  it('AC#8 aucun nouveau cron Vercel — `api/cron/retry-emails.ts` ne doit PAS exister', async () => {
    const fs = await import('node:fs/promises')
    const url = new URL('../../../../api/cron/retry-emails.ts', import.meta.url)
    await expect(fs.access(url.pathname)).rejects.toThrow()
  })
})
