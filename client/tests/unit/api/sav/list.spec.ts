import { describe, it, expect, vi, beforeEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

// ---- Supabase mock ---------------------------------------------------------
const db = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  error: null as null | { message: string },
  searchResponses: [] as Array<{
    data: Array<Record<string, unknown>> | null
    error: null | { message: string }
  }>,
  rateLimitAllowed: true as boolean,
  rpcCalls: [] as Array<[string, Record<string, unknown> | undefined]>,
}))

function resetDb(): void {
  db.rows = []
  db.error = null
  db.searchResponses = []
  db.rateLimitAllowed = true
  db.rpcCalls = []
}

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  const client = {
    rpc: (fn: string, args?: Record<string, unknown>) => {
      db.rpcCalls.push([fn, args])
      if (fn === 'increment_rate_limit') {
        return Promise.resolve({
          data: [{ allowed: db.rateLimitAllowed, retry_after: 1 }],
          error: null,
        })
      }
      if (fn === 'search_sav_list') {
        const queued = db.searchResponses.shift()
        if (queued) return Promise.resolve(queued)
        return Promise.resolve({ data: db.error ? null : db.rows, error: db.error })
      }
      return Promise.resolve({ data: null, error: null })
    },
  }
  return {
    supabaseAdmin: () => client,
    __resetSupabaseAdminForTests: () => undefined,
  }
})

import handler from '../../../../api/sav'
import { __testables } from '../../../../api/_lib/sav/list-handler'

function operatorToken(): string {
  const payload: SessionUser = {
    sub: 42,
    type: 'operator',
    role: 'sav-operator',
    exp: Math.floor(Date.now() / 1000) + 3600,
  }
  return signJwt(payload, SECRET)
}

function memberToken(): string {
  const payload: SessionUser = {
    sub: 7,
    type: 'member',
    exp: Math.floor(Date.now() / 1000) + 3600,
  }
  return signJwt(payload, SECRET)
}

function listReq(query: Record<string, unknown> = {}, cookie = `sav_session=${operatorToken()}`) {
  // Vercel rewrite /api/sav → /api/sav/list, le router catch-all reçoit slug=['list'].
  return mockReq({
    method: 'GET',
    headers: { cookie },
    query: { ...query, op: 'list' } as Record<string, string | string[] | undefined>,
  })
}

function searchRpcArgs(): Record<string, unknown> {
  const call = db.rpcCalls.find(([fn]) => fn === 'search_sav_list')
  expect(call).toBeDefined()
  return call?.[1] ?? {}
}

beforeEach(() => {
  vi.stubEnv('SESSION_COOKIE_SECRET', SECRET)
  vi.stubEnv('SUPABASE_URL', 'http://localhost')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test')
  resetDb()
})

describe('GET /api/sav (Story 3.2 — list SAV)', () => {
  it('TS-01: 401 sans cookie', async () => {
    const res = mockRes()
    const req = mockReq({ method: 'GET', headers: {}, query: { op: 'list' } })
    await handler(req, res)
    expect(res.statusCode).toBe(401)
  })

  it('TS-02: 403 si session member (type non-autorisé)', async () => {
    const res = mockRes()
    const req = listReq({}, `sav_session=${memberToken()}`)
    await handler(req, res)
    expect(res.statusCode).toBe(403)
  })

  it('mappe tous les filtres validés vers la RPC search_sav_list', async () => {
    const from = '2026-01-01T00:00:00.000Z'
    const to = '2026-04-01T00:00:00.000Z'
    const res = mockRes()
    await handler(
      listReq({
        status: 'received,in_progress',
        from,
        to,
        invoiceRef: 'FAC_100%',
        memberId: '12',
        groupId: '7',
        assignedTo: '42',
        tag: 'à rappeler',
        q: '479_26S41_64_2',
        limit: '25',
      }),
      res
    )
    expect(res.statusCode).toBe(200)
    expect(searchRpcArgs()).toEqual({
      p_status: ['received', 'in_progress'],
      p_from: from,
      p_to: to,
      p_invoice_ref: 'FAC_100%',
      p_member_id: 12,
      p_group_id: 7,
      p_assigned_to: 42,
      p_unassigned: false,
      p_tag: 'à rappeler',
      p_q: '479_26S41_64_2',
      p_cursor_received_at: null,
      p_cursor_id: null,
      p_limit: 25,
    })
  })

  it('mappe assignedTo=unassigned sans identifiant opérateur', async () => {
    const res = mockRes()
    await handler(listReq({ assignedTo: 'unassigned' }), res)
    expect(res.statusCode).toBe(200)
    expect(searchRpcArgs()).toMatchObject({ p_assigned_to: null, p_unassigned: true })
  })

  it('normalise un statut scalaire en tableau pour la RPC', async () => {
    const res = mockRes()
    await handler(listReq({ status: 'received' }), res)
    expect(res.statusCode).toBe(200)
    expect(searchRpcArgs()).toMatchObject({ p_status: ['received'] })
  })

  it('retourne une liste vide et count=0 sans exposer de résultat partiel', async () => {
    const res = mockRes()
    await handler(listReq({ q: 'Nathan' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toEqual({ data: [], meta: { cursor: null, count: 0, limit: 50 } })
  })

  it('récupère exact_count sans cursor si une page cursored est vide', async () => {
    db.searchResponses = [
      { data: [], error: null },
      { data: [{ exact_count: 7 }], error: null },
    ]
    const cursor = Buffer.from(
      JSON.stringify({ rec: '2026-03-01T12:00:00.000Z', id: 123 })
    ).toString('base64url')
    const res = mockRes()
    await handler(listReq({ cursor, limit: '25' }), res)

    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toEqual({ data: [], meta: { cursor: null, count: 7, limit: 25 } })
    const searchCalls = db.rpcCalls.filter(([fn]) => fn === 'search_sav_list')
    expect(searchCalls).toHaveLength(2)
    expect(searchCalls[1]?.[1]).toMatchObject({
      p_cursor_received_at: null,
      p_cursor_id: null,
      p_limit: 1,
    })
  })

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    'retourne 500 si exact_count est invalide (%s)',
    async (exactCount) => {
      db.rows = [{ exact_count: exactCount }]
      const res = mockRes()
      await handler(listReq(), res)
      expect(res.statusCode).toBe(500)
      expect(res.jsonBody).toMatchObject({ error: { code: 'SERVER_ERROR' } })
    }
  )

  it("TS-11: 400 si from n'est pas un datetime ISO", async () => {
    const res = mockRes()
    await handler(listReq({ from: 'not-a-date' }), res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_FAILED')
  })

  it('TS-12: 400 si limit=200 (Zod max=100)', async () => {
    const res = mockRes()
    await handler(listReq({ limit: '200' }), res)
    expect(res.statusCode).toBe(400)
  })

  it('TS-13: 200 avec 51 rows + limit=50 → meta.cursor non-null, data.length=50', async () => {
    db.rows = Array.from({ length: 51 }, (_, i) => ({
      id: i + 1,
      reference: `SAV-2026-${String(i + 1).padStart(5, '0')}`,
      status: 'received',
      member_id: 1,
      group_id: null,
      invoice_ref: '',
      total_amount_cents: 0,
      tags: [],
      assigned_to: null,
      received_at: new Date(Date.now() - i * 1000).toISOString(),
      taken_at: null,
      validated_at: null,
      closed_at: null,
      cancelled_at: null,
      version: 0,
      invoice_special_mention: null,
      member_first_name: null,
      member_last_name: 'Test',
      member_email: 't@example.com',
      group_name: null,
      assignee_display_name: null,
      exact_count: 51,
    }))
    const res = mockRes()
    await handler(listReq({ limit: '50' }), res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: unknown[]
      meta: { cursor: string | null; count: number }
    }
    expect(body.data).toHaveLength(50)
    expect(body.meta.cursor).not.toBeNull()
    expect(body.meta.count).toBe(51)
  })

  it('TS-14: 200 avec cursor valide → paramètres cursor transmis à la RPC', async () => {
    const cursor = Buffer.from(
      JSON.stringify({ rec: '2026-03-01T12:00:00.000Z', id: 123 })
    ).toString('base64url')
    const res = mockRes()
    await handler(listReq({ cursor }), res)
    expect(res.statusCode).toBe(200)
    expect(searchRpcArgs()).toMatchObject({
      p_cursor_received_at: '2026-03-01T12:00:00.000Z',
      p_cursor_id: 123,
    })
  })

  it('TS-15: 429 si rate-limit épuisé', async () => {
    db.rateLimitAllowed = false
    const res = mockRes()
    await handler(listReq(), res)
    expect(res.statusCode).toBe(429)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('RATE_LIMITED')
  })

  it('accepte le curseur exact signalé en production sans perdre les microsecondes', async () => {
    const cursor = 'eyJyZWMiOiIyMDI2LTA4LTMwVDE3OjU4OjI3LjEzMzExNyswMDowMCIsImlkIjo3MH0'
    const res = mockRes()
    await handler(listReq({ cursor }), res)
    expect(res.statusCode).toBe(200)
    expect(searchRpcArgs()).toMatchObject({
      p_cursor_received_at: '2026-08-30T17:58:27.133117Z',
      p_cursor_id: 70,
    })
  })

  it('réutilise le curseur Supabase émis pour la page suivante et termine sans curseur', async () => {
    const rec = '2026-08-30T17:58:27.133117+00:00'
    const row = {
      id: 70,
      reference: 'SAV-2026-00070',
      status: 'received',
      received_at: rec,
      invoice_ref: '',
      total_amount_cents: 0,
      tags: [],
      taken_at: null,
      validated_at: null,
      closed_at: null,
      cancelled_at: null,
      version: 0,
      invoice_special_mention: null,
      member_id: 1,
      group_id: 5,
      assigned_to: 2,
      member_first_name: null,
      member_last_name: 'Test',
      member_email: 'test@example.com',
      group_name: 'Groupe Test',
      assignee_display_name: 'Op Test',
      exact_count: 2,
    }
    db.rows = [row, { ...row, id: 69 }]
    const first = mockRes()
    await handler(listReq({ limit: '1' }), first)
    expect(first.statusCode).toBe(200)
    const body = first.jsonBody as { data: { id: number }[]; meta: { cursor: string } }
    expect(body.data.map((item) => item.id)).toEqual([70])
    expect(JSON.parse(Buffer.from(body.meta.cursor, 'base64url').toString('utf8'))).toEqual({
      rec,
      id: 70,
    })

    resetDb()
    db.rows = [{ ...row, id: 69 }]
    const second = mockRes()
    await handler(listReq({ limit: '1', cursor: body.meta.cursor }), second)
    expect(second.statusCode).toBe(200)
    expect(searchRpcArgs()).toMatchObject({
      p_cursor_received_at: '2026-08-30T17:58:27.133117Z',
      p_cursor_id: 70,
    })
    expect(second.jsonBody).toMatchObject({
      data: [{ id: 69 }],
      meta: { cursor: null, count: 2, limit: 1 },
    })
  })

  it.each([
    null,
    [],
    'cursor',
    42,
    {},
    { id: 1 },
    { rec: null, id: 1 },
    { rec: 42, id: 1 },
    { rec: [], id: 1 },
    ...[0, -1, 1.5, '70'].map((id) => ({ rec: '2026-08-30T17:58:27+00:00', id })),
    ...[
      '2026-02-30T17:58:27+00:00',
      '2026-08-30T25:58:27+00:00',
      '2026-08-30T17:58:27',
      '2026-08-30T17:58:27+01:00',
      '2026-08-30T17:58:27.1331179+00:00',
      '2026-08-30T17:58:27+00:00suffix',
      '2026-08-30T17:58:27Z),id.gt.0+00:00',
    ].map((rec) => ({ rec, id: 70 })),
  ])('rejette le curseur invalide %j avant la pagination', async (payload) => {
    const cursor = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const res = mockRes()
    await handler(listReq({ cursor }), res)
    expect(res.statusCode).toBe(400)
    expect(res.jsonBody).toMatchObject({ error: { code: 'VALIDATION_FAILED' } })
    expect(db.rpcCalls.some(([fn]) => fn === 'search_sav_list')).toBe(false)
  })

  it("TS-16: q='; DROP TABLE sav; --' reste un paramètre RPC littéral", async () => {
    const res = mockRes()
    const payload = "'; DROP TABLE sav; --"
    await handler(listReq({ q: payload }), res)
    expect(res.statusCode).toBe(200)
    expect(searchRpcArgs()['p_q']).toBe(payload)
  })

  it('retourne 500 sans résultat partiel si la RPC échoue', async () => {
    db.error = { message: 'rpc unavailable' }
    const res = mockRes()
    await handler(listReq({ q: 'Nathan' }), res)
    expect(res.statusCode).toBe(500)
    expect(res.jsonBody).toMatchObject({ error: { code: 'SERVER_ERROR' } })
  })

  it('400 si q est whitespace-only (Zod .trim().min(1))', async () => {
    const res = mockRes()
    await handler(listReq({ q: '   ' }), res)
    expect(res.statusCode).toBe(400)
  })

  it('400 si cursor corrompu', async () => {
    const res = mockRes()
    await handler(listReq({ cursor: 'not-valid-base64url-json' }), res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_FAILED')
  })
})

describe('Helpers list-handler', () => {
  it.each(['', '.1', '.12', '.133', '.1331', '.13311', '.133117'])(
    'préserve la précision %s avec les deux représentations UTC',
    (fraction) => {
      const rec = `2026-08-30T17:58:27${fraction}Z`
      for (const suffix of ['Z', '+00:00']) {
        const cursor = __testables.encodeCursor({
          received_at: `2026-08-30T17:58:27${fraction}${suffix}`,
          id: 70,
        })
        expect(__testables.decodeCursor(cursor)).toEqual({ rec, id: 70 })
      }
    }
  )
  it('encodeCursor / decodeCursor round-trip', () => {
    const row = { received_at: '2026-03-01T12:34:56.000Z', id: 42 }
    const c = __testables.encodeCursor(row)
    const back = __testables.decodeCursor(c)
    expect(back).toEqual({ rec: row.received_at, id: row.id })
  })

  it('decodeCursor returns null on garbage', () => {
    expect(__testables.decodeCursor('not-a-cursor')).toBeNull()
  })

  it('decodeCursor rejette un cursor dont le shape ne valide pas (injection)', () => {
    const malicious = Buffer.from(
      JSON.stringify({ rec: 'NOT AN ISO; DROP TABLE sav;--', id: 1 })
    ).toString('base64url')
    expect(__testables.decodeCursor(malicious)).toBeNull()
  })

  it('projectSavRow mappe snake_case → camelCase et aplatit les relations', () => {
    const raw = {
      id: 1,
      reference: 'SAV-2026-00001',
      status: 'received',
      member_id: 10,
      group_id: 5,
      invoice_ref: 'FAC-1',
      total_amount_cents: 1500,
      tags: ['urgent'],
      assigned_to: 2,
      received_at: '2026-03-01T00:00:00.000Z',
      taken_at: null,
      validated_at: null,
      closed_at: null,
      cancelled_at: null,
      version: 1,
      invoice_special_mention: '479_26S41_64_2',
      member_first_name: 'Jean',
      member_last_name: 'Dubois',
      member_email: 'j@d.com',
      group_name: 'Groupe Test',
      assignee_display_name: 'Op Test',
      exact_count: 1,
    }
    const projected = __testables.projectSavRow(raw as never)
    expect(projected).toMatchObject({
      id: 1,
      reference: 'SAV-2026-00001',
      receivedAt: '2026-03-01T00:00:00.000Z',
      totalAmountCents: 1500,
      invoiceSpecialMention: '479_26S41_64_2',
      tags: ['urgent'],
      member: { firstName: 'Jean', lastName: 'Dubois' },
      group: { id: 5, name: 'Groupe Test' },
      assignee: { id: 2, displayName: 'Op Test' },
    })
    expect(projected).not.toHaveProperty('metadata')
  })

  it('projectSavRow conserve les relations groupe/assigné nulles', () => {
    const projected = __testables.projectSavRow({
      id: 1,
      reference: 'SAV-2026-00001',
      status: 'received',
      member_id: 10,
      group_id: null,
      invoice_ref: 'FAC-1',
      total_amount_cents: 0,
      tags: [],
      assigned_to: null,
      received_at: '2026-03-01T00:00:00.000Z',
      taken_at: null,
      validated_at: null,
      closed_at: null,
      cancelled_at: null,
      version: 1,
      invoice_special_mention: null,
      member_first_name: null,
      member_last_name: 'Dubois',
      member_email: 'j@d.com',
      group_name: null,
      assignee_display_name: null,
      exact_count: 1,
    })
    expect(projected.group).toBeNull()
    expect(projected.assignee).toBeNull()
  })
})
