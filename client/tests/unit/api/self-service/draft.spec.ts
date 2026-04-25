import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

const db = vi.hoisted(() => ({
  savDrafts: new Map<number, { data: Record<string, unknown>; last_saved_at: string }>(),
  upsertError: null as null | { message: string },
  selectError: null as null | { message: string },
  // rate-limit RPC mock
  rateLimitAllowed: true,
}))

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  function selectMaybeSingle(table: string, memberId: number) {
    if (table !== 'sav_drafts') return { data: null, error: null }
    if (db.selectError) return { data: null, error: db.selectError }
    const row = db.savDrafts.get(memberId) ?? null
    return { data: row, error: null }
  }
  const client = {
    from: (table: string) => {
      if (table === 'sav_drafts') {
        return {
          select: (_cols: string) => ({
            eq: (_col: string, memberId: number) => ({
              maybeSingle: () => Promise.resolve(selectMaybeSingle(table, memberId)),
            }),
          }),
          upsert: (row: {
            member_id: number
            data: Record<string, unknown>
            last_saved_at: string
          }) => {
            if (db.upsertError) return Promise.resolve({ error: db.upsertError })
            db.savDrafts.set(row.member_id, {
              data: row.data,
              last_saved_at: row.last_saved_at,
            })
            return Promise.resolve({ error: null })
          },
        }
      }
      return {}
    },
    rpc: (fn: string) => {
      if (fn === 'increment_rate_limit') {
        return Promise.resolve({
          data: [{ allowed: db.rateLimitAllowed, retry_after: 1 }],
          error: null,
        })
      }
      return Promise.resolve({ data: null, error: null })
    },
  }
  return {
    supabaseAdmin: () => client,
    __resetSupabaseAdminForTests: () => undefined,
  }
})

// Mock le _typed-shim (utilisé par certains helpers) vers le même client.
vi.mock('../../../../api/_lib/_typed-shim', () => {
  return {
    supabaseAdmin: vi.fn(() => {
      // Ne devrait pas être appelé par draft.ts (qui utilise clients/supabase-admin).
      throw new Error('unexpected typed-shim call')
    }),
  }
})

import handler from '../../../../api/self-service/draft'

function farFuture(): number {
  return Math.floor(Date.now() / 1000) + 3600
}

function memberToken(memberId: number): string {
  const payload: SessionUser = { sub: memberId, type: 'member', exp: farFuture() }
  return signJwt(payload, SECRET)
}

describe('GET/PUT /api/self-service/draft', () => {
  beforeEach(() => {
    db.savDrafts.clear()
    db.upsertError = null
    db.selectError = null
    db.rateLimitAllowed = true
    process.env['SESSION_COOKIE_SECRET'] = SECRET
  })

  afterEach(() => {
    delete process.env['SESSION_COOKIE_SECRET']
  })

  it('GET retourne { data: null } si aucun brouillon', async () => {
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
    })
    const res = mockRes()
    await handler(req, res)
    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toEqual({ data: null })
  })

  it('GET retourne data + lastSavedAt si brouillon existant', async () => {
    db.savDrafts.set(42, {
      data: { items: [{ code: 'A1', qty: 2 }] },
      last_saved_at: '2026-04-21T10:00:00.000Z',
    })
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
    })
    const res = mockRes()
    await handler(req, res)
    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toEqual({
      data: {
        data: { items: [{ code: 'A1', qty: 2 }] },
        lastSavedAt: '2026-04-21T10:00:00.000Z',
      },
    })
  })

  it('PUT crée puis PUT met à jour sans doublonner (UPSERT)', async () => {
    const req1 = mockReq({
      method: 'PUT',
      cookies: { sav_session: memberToken(42) },
      body: { data: { step: 1 } },
    })
    await handler(req1, mockRes())

    const req2 = mockReq({
      method: 'PUT',
      cookies: { sav_session: memberToken(42) },
      body: { data: { step: 2 } },
    })
    const res2 = mockRes()
    await handler(req2, res2)
    expect(res2.statusCode).toBe(200)
    expect((res2.jsonBody as { data: { lastSavedAt: string } }).data.lastSavedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T/
    )
    expect(db.savDrafts.size).toBe(1)
    expect(db.savDrafts.get(42)?.data).toEqual({ step: 2 })
  })

  it('PUT isolation par member : M2 ne touche pas le draft de M1', async () => {
    await handler(
      mockReq({
        method: 'PUT',
        cookies: { sav_session: memberToken(1) },
        body: { data: { owner: 'M1' } },
      }),
      mockRes()
    )
    await handler(
      mockReq({
        method: 'PUT',
        cookies: { sav_session: memberToken(2) },
        body: { data: { owner: 'M2' } },
      }),
      mockRes()
    )
    expect(db.savDrafts.get(1)?.data).toEqual({ owner: 'M1' })
    expect(db.savDrafts.get(2)?.data).toEqual({ owner: 'M2' })

    // GET M1 ne voit que son draft
    const resM1 = mockRes()
    await handler(mockReq({ method: 'GET', cookies: { sav_session: memberToken(1) } }), resM1)
    expect((resM1.jsonBody as { data: { data: { owner: string } } }).data.data.owner).toBe('M1')
  })

  it('PUT retourne 400 VALIDATION_FAILED si payload > 256 KiB', async () => {
    // Construit un objet JSON > 256 KiB (champ "blob" = 300 KiB).
    const big = 'x'.repeat(300 * 1024)
    const req = mockReq({
      method: 'PUT',
      cookies: { sav_session: memberToken(42) },
      body: { data: { blob: big } },
    })
    const res = mockRes()
    await handler(req, res)
    expect(res.statusCode).toBe(400)
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED')
    expect(db.savDrafts.size).toBe(0)
  })

  it('PUT sans auth → 401', async () => {
    const req = mockReq({ method: 'PUT', body: { data: { step: 1 } } })
    const res = mockRes()
    await handler(req, res)
    expect(res.statusCode).toBe(401)
    expect(db.savDrafts.size).toBe(0)
  })

  it('GET sans auth → 401', async () => {
    const req = mockReq({ method: 'GET' })
    const res = mockRes()
    await handler(req, res)
    expect(res.statusCode).toBe(401)
  })

  it('PUT avec body invalide (data absent) → 400', async () => {
    const req = mockReq({
      method: 'PUT',
      cookies: { sav_session: memberToken(42) },
      body: { foo: 'bar' },
    })
    const res = mockRes()
    await handler(req, res)
    expect(res.statusCode).toBe(400)
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED')
  })

  // --- Patch F4 review adversarial ---
  it('PUT rejette les clés prototype-pollution (__proto__, constructor)', async () => {
    for (const badKey of ['__proto__', 'constructor', 'prototype', '__secret', '$malicious']) {
      const res = mockRes()
      await handler(
        mockReq({
          method: 'PUT',
          cookies: { sav_session: memberToken(42) },
          body: { data: { nested: { [badKey]: 'evil' } } },
        }),
        res
      )
      expect(res.statusCode, `key=${badKey}`).toBe(400)
      expect(
        (res.jsonBody as { error: { details: Array<{ message: string }> } }).error.details[0]
          ?.message
      ).toMatch(/forbidden key/)
    }
    expect(db.savDrafts.size).toBe(0)
  })

  it('PUT rejette si profondeur > 8', async () => {
    let deep: Record<string, unknown> = { leaf: true }
    for (let i = 0; i < 10; i++) deep = { n: deep }
    const res = mockRes()
    await handler(
      mockReq({
        method: 'PUT',
        cookies: { sav_session: memberToken(42) },
        body: { data: deep },
      }),
      res
    )
    expect(res.statusCode).toBe(400)
  })

  // W40 (CR Story 5.2) — defense-in-depth router-level auth.
  it('W40 op=invalid sans auth → 401 (auth bloque avant le 404 router)', async () => {
    const res = mockRes()
    await handler(mockReq({ method: 'GET', query: { op: 'garbage' } }), res)
    expect(res.statusCode).toBe(401)
  })

  // W52 (CR Story 5.2) — méthode non supportée → 405 METHOD_NOT_ALLOWED.
  it('W52 DELETE /draft → 405 METHOD_NOT_ALLOWED', async () => {
    const res = mockRes()
    await handler(mockReq({ method: 'DELETE', cookies: { sav_session: memberToken(42) } }), res)
    expect(res.statusCode).toBe(405)
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('METHOD_NOT_ALLOWED')
  })

  it('W52 GET /upload-session → 405 METHOD_NOT_ALLOWED (POST attendu)', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'GET',
        cookies: { sav_session: memberToken(42) },
        query: { op: 'upload-session' },
      }),
      res
    )
    expect(res.statusCode).toBe(405)
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('METHOD_NOT_ALLOWED')
  })
})
