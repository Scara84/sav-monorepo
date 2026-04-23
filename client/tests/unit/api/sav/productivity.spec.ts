import { describe, it, expect, vi, beforeEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

const db = vi.hoisted(() => ({
  rpcData: null as unknown,
  rpcError: null as unknown,
  rpcArgs: null as Record<string, unknown> | null,
  insertData: null as unknown,
  insertError: null as unknown,
  rateLimitAllowed: true as boolean,
}))

vi.mock('../../../../api/_lib/clients/supabase-admin', () => ({
  supabaseAdmin: () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      if (fn === 'increment_rate_limit') {
        return Promise.resolve({
          data: [{ allowed: db.rateLimitAllowed, retry_after: 1 }],
          error: null,
        })
      }
      db.rpcArgs = args
      return Promise.resolve({ data: db.rpcData, error: db.rpcError })
    },
    from: (_table: string) => ({
      insert: (_row: unknown) => ({
        select: (_cols: string) => ({
          single: () => Promise.resolve({ data: db.insertData, error: db.insertError }),
        }),
      }),
    }),
  }),
  __resetSupabaseAdminForTests: () => undefined,
}))

import handler from '../../../../api/sav/[[...slug]]'

function opCookie(): string {
  const p: SessionUser = {
    sub: 42,
    type: 'operator',
    role: 'sav-operator',
    exp: Math.floor(Date.now() / 1000) + 3600,
  }
  return `sav_session=${signJwt(p, SECRET)}`
}
function memberCookie(): string {
  const p: SessionUser = { sub: 7, type: 'member', exp: Math.floor(Date.now() / 1000) + 3600 }
  return `sav_session=${signJwt(p, SECRET)}`
}

function req(method: string, slug: string[], body: unknown, cookie = opCookie()) {
  return mockReq({
    method,
    headers: { cookie, 'content-type': 'application/json' },
    query: { slug } as Record<string, string | string[] | undefined>,
    body: body as Record<string, unknown>,
  })
}

beforeEach(() => {
  vi.stubEnv('SESSION_COOKIE_SECRET', SECRET)
  vi.stubEnv('SUPABASE_URL', 'http://localhost')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test')
  db.rpcData = null
  db.rpcError = null
  db.rpcArgs = null
  db.insertData = null
  db.insertError = null
  db.rateLimitAllowed = true
})

describe('PATCH /api/sav/:id/tags (Story 3.7)', () => {
  it('TT-01: 401 sans auth', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'PATCH',
        headers: {},
        query: { slug: ['1', 'tags'] },
        body: { add: ['foo'], version: 0 },
      }),
      res
    )
    expect(res.statusCode).toBe(401)
  })

  it('TT-02: 200 add 2 tags', async () => {
    db.rpcData = [{ sav_id: 1, new_tags: ['a', 'b'], new_version: 1 }]
    const res = mockRes()
    await handler(req('PATCH', ['1', 'tags'], { add: ['a', 'b'], version: 0 }), res)
    expect(res.statusCode).toBe(200)
    expect(db.rpcArgs).toMatchObject({ p_sav_id: 1, p_add: ['a', 'b'], p_remove: [] })
  })

  it('TT-03: 200 remove 1 tag', async () => {
    db.rpcData = [{ sav_id: 1, new_tags: ['b'], new_version: 2 }]
    const res = mockRes()
    await handler(req('PATCH', ['1', 'tags'], { remove: ['a'], version: 1 }), res)
    expect(res.statusCode).toBe(200)
  })

  it('TT-05: 409 VERSION_CONFLICT', async () => {
    db.rpcError = { code: 'P0001', message: 'VERSION_CONFLICT|current=5' }
    const res = mockRes()
    await handler(req('PATCH', ['1', 'tags'], { add: ['x'], version: 1 }), res)
    expect(res.statusCode).toBe(409)
  })

  it('TT-06: 400 regex tag invalide (contient <)', async () => {
    const res = mockRes()
    await handler(req('PATCH', ['1', 'tags'], { add: ['evil<script>'], version: 0 }), res)
    expect(res.statusCode).toBe(400)
  })

  it('TT-07: 422 TAGS_LIMIT', async () => {
    db.rpcError = { code: 'P0001', message: 'TAGS_LIMIT|count=31' }
    const res = mockRes()
    await handler(req('PATCH', ['1', 'tags'], { add: ['x'], version: 0 }), res)
    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as { error: { details: { code: string; count: number } } }
    expect(body.error.details.code).toBe('TAGS_LIMIT')
    expect(body.error.details.count).toBe(31)
  })

  it('TT-08: 400 add + remove tous deux vides', async () => {
    const res = mockRes()
    await handler(req('PATCH', ['1', 'tags'], { version: 0 }), res)
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /api/sav/:id/comments (Story 3.7)', () => {
  it('TC-01: 401 sans auth', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: {},
        query: { slug: ['1', 'comments'] },
        body: { body: 'hi', visibility: 'all' },
      }),
      res
    )
    expect(res.statusCode).toBe(401)
  })

  it('TC-02: 403 session member', async () => {
    const res = mockRes()
    await handler(
      req('POST', ['1', 'comments'], { body: 'hi', visibility: 'all' }, memberCookie()),
      res
    )
    expect(res.statusCode).toBe(403)
  })

  it('TC-03: 201 visibility=all OK', async () => {
    db.insertData = { id: 99, created_at: '2026-03-01T00:00:00Z', visibility: 'all', body: 'hi' }
    const res = mockRes()
    await handler(req('POST', ['1', 'comments'], { body: 'hi', visibility: 'all' }), res)
    expect(res.statusCode).toBe(201)
    const body = res.jsonBody as { data: { commentId: number } }
    expect(body.data.commentId).toBe(99)
  })

  it('TC-04: 201 visibility=internal OK', async () => {
    db.insertData = {
      id: 100,
      created_at: '2026-03-01T00:00:00Z',
      visibility: 'internal',
      body: 'note',
    }
    const res = mockRes()
    await handler(req('POST', ['1', 'comments'], { body: 'note', visibility: 'internal' }), res)
    expect(res.statusCode).toBe(201)
  })

  it('TC-05: 400 body vide', async () => {
    const res = mockRes()
    await handler(req('POST', ['1', 'comments'], { body: '', visibility: 'all' }), res)
    expect(res.statusCode).toBe(400)
  })

  it('TC-06: 400 body > 5000 chars', async () => {
    const res = mockRes()
    const huge = 'a'.repeat(5001)
    await handler(req('POST', ['1', 'comments'], { body: huge, visibility: 'all' }), res)
    expect(res.statusCode).toBe(400)
  })

  it('404 si SAV inexistant (FK violation)', async () => {
    db.insertError = { code: '23503', message: 'foreign key violation' }
    const res = mockRes()
    await handler(req('POST', ['99999', 'comments'], { body: 'hi', visibility: 'all' }), res)
    expect(res.statusCode).toBe(404)
  })
})

describe('POST /api/sav/:id/duplicate (Story 3.7)', () => {
  it('TD-01: 401 sans auth', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: {},
        query: { slug: ['1', 'duplicate'] },
      }),
      res
    )
    expect(res.statusCode).toBe(401)
  })

  it('TD-02: 404 SAV source inexistant', async () => {
    db.rpcError = { code: 'P0001', message: 'NOT_FOUND' }
    const res = mockRes()
    await handler(req('POST', ['99', 'duplicate'], {}), res)
    expect(res.statusCode).toBe(404)
  })

  it('TD-03: 201 OK + newSavId + newReference', async () => {
    db.rpcData = [{ new_sav_id: 500, new_reference: 'SAV-2026-00100' }]
    const res = mockRes()
    await handler(req('POST', ['1', 'duplicate'], {}), res)
    expect(res.statusCode).toBe(201)
    const body = res.jsonBody as { data: { newSavId: number; newReference: string } }
    expect(body.data.newSavId).toBe(500)
    expect(body.data.newReference).toBe('SAV-2026-00100')
    expect(db.rpcArgs).toMatchObject({ p_source_sav_id: 1, p_actor_operator_id: 42 })
  })
})
