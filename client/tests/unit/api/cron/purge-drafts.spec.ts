import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockReq, mockRes } from '../_lib/test-helpers'

const db = vi.hoisted(() => ({
  lastLtCol: null as string | null,
  lastLtValue: null as string | null,
  deleteCount: 0,
  deleteError: null as null | { message: string },
}))

vi.mock('../../../../api/_lib/_typed-shim', () => {
  const client = {
    from: (_table: string) => ({
      delete: (_opts: { count: string }) => ({
        lt: (col: string, value: string) => {
          db.lastLtCol = col
          db.lastLtValue = value
          return Promise.resolve({
            count: db.deleteCount,
            error: db.deleteError,
          })
        },
      }),
    }),
  }
  return { supabaseAdmin: () => client }
})

import handler, { runPurgeDrafts } from '../../../../api/cron/purge-drafts'

describe('POST /api/cron/purge-drafts', () => {
  beforeEach(() => {
    db.lastLtCol = null
    db.lastLtValue = null
    db.deleteCount = 0
    db.deleteError = null
    process.env['CRON_SECRET'] = 'unit-test-secret-12345'
  })

  it('401 si bearer manquant', async () => {
    const res = mockRes()
    await handler(mockReq({ method: 'POST', headers: {} }), res)
    expect(res.statusCode).toBe(401)
  })

  it('401 si bearer mismatch', async () => {
    const res = mockRes()
    await handler(mockReq({ method: 'POST', headers: { authorization: 'Bearer wrong' } }), res)
    expect(res.statusCode).toBe(401)
  })

  it('200 + deleted=N avec bearer valide ; cutoff = 30 jours', async () => {
    db.deleteCount = 5
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: { authorization: 'Bearer unit-test-secret-12345' },
      }),
      res
    )
    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toEqual({ ok: true, deleted: 5 })
    expect(db.lastLtCol).toBe('created_at')
    // Cutoff doit être ~ maintenant - 30 jours
    const cutoff = new Date(db.lastLtValue!).getTime()
    const now = Date.now()
    const diffDays = (now - cutoff) / (24 * 3600 * 1000)
    expect(diffDays).toBeGreaterThan(29.9)
    expect(diffDays).toBeLessThan(30.1)
  })

  it('500 si DELETE échoue', async () => {
    db.deleteError = { message: 'db down' }
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: { authorization: 'Bearer unit-test-secret-12345' },
      }),
      res
    )
    expect(res.statusCode).toBe(500)
  })

  it('runPurgeDrafts exporté retourne { deleted }', async () => {
    db.deleteCount = 3
    const result = await runPurgeDrafts({ requestId: 'test-123' })
    expect(result).toEqual({ deleted: 3 })
  })
})
