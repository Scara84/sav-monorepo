import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

/**
 * Story 5.5 AC #13 — tests handlers admin settings_threshold (PATCH + GET).
 *
 * Architecture après CR adversarial 2026-04-28 :
 *   - PATCH passe par la RPC `update_settings_threshold_alert` (set_config GUC
 *     atomique pour audit_changes — patch CR D4).
 *   - 23505 (W37 unique violation) → 409 CONCURRENT_PATCH (patch CR A5).
 *   - Rate-limit 10/15min/operator (patch CR A1).
 *   - Body Zod `.strict()` (patch CR S4) + notes refine control-chars (patch CR A7).
 */

interface State {
  rpcCalls: Array<Record<string, unknown>>
  rpcReturn: Record<string, unknown> | null
  rpcError: { code?: string; message: string } | null
  selectRows: Array<Record<string, unknown>>
  selectError: { message: string } | null
  operatorRows: Array<{ id: number; email: string }>
  rateLimitAllowed: boolean
  rateLimitRetryAfter: number
}

const state = vi.hoisted(
  () =>
    ({
      rpcCalls: [],
      rpcReturn: null,
      rpcError: null,
      selectRows: [],
      selectError: null,
      operatorRows: [],
      rateLimitAllowed: true,
      rateLimitRetryAfter: 0,
    }) as State
)

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  function buildSettingsHistorySelect(): unknown {
    const out = {
      select: () => out,
      eq: () => out,
      order: () => out,
      limit: () => Promise.resolve({ data: state.selectRows, error: state.selectError }),
    }
    return out
  }

  function buildOperatorsSelect(): unknown {
    const out = {
      select: () => out,
      in: () => Promise.resolve({ data: state.operatorRows, error: null }),
    }
    return out
  }

  function from(table: string): unknown {
    if (table === 'settings') return buildSettingsHistorySelect()
    if (table === 'operators') return buildOperatorsSelect()
    throw new Error(`Unmocked table: ${table}`)
  }

  function rpc(fn: string, args: Record<string, unknown>): unknown {
    if (fn === 'increment_rate_limit') {
      return Promise.resolve({
        data: [{ allowed: state.rateLimitAllowed, retry_after: state.rateLimitRetryAfter }],
        error: null,
      })
    }
    if (fn === 'update_settings_threshold_alert') {
      state.rpcCalls.push(args)
      const data = state.rpcError ? null : (state.rpcReturn ?? null)
      const built = {
        single: () => Promise.resolve({ data, error: state.rpcError }),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data, error: state.rpcError }).then(resolve),
      }
      return built
    }
    return Promise.resolve({ data: [], error: null })
  }

  return {
    supabaseAdmin: () => ({ from, rpc }),
    __resetSupabaseAdminForTests: () => undefined,
  }
})

import { adminSettingsThresholdPatchHandler } from '../../../../api/_lib/admin/settings-threshold-patch-handler'
import { adminSettingsThresholdHistoryHandler } from '../../../../api/_lib/admin/settings-threshold-history-handler'

function farFuture(): number {
  return Math.floor(Date.now() / 1000) + 3600
}

function adminReq(body: unknown): ReturnType<typeof mockReq> {
  const payload: SessionUser = { sub: 9, type: 'operator', role: 'admin', exp: farFuture() }
  const req = mockReq({ method: 'PATCH', body })
  req.user = payload
  return req
}

function operatorReq(body: unknown): ReturnType<typeof mockReq> {
  const payload: SessionUser = {
    sub: 12,
    type: 'operator',
    role: 'sav-operator',
    exp: farFuture(),
  }
  const req = mockReq({ method: 'PATCH', body })
  req.user = payload
  return req
}

function adminGetReq(query: Record<string, string> = {}): ReturnType<typeof mockReq> {
  const payload: SessionUser = { sub: 9, type: 'operator', role: 'admin', exp: farFuture() }
  const req = mockReq({ method: 'GET', query })
  req.user = payload
  return req
}

beforeEach(() => {
  state.rpcCalls = []
  state.rpcReturn = null
  state.rpcError = null
  state.selectRows = []
  state.selectError = null
  state.operatorRows = []
  state.rateLimitAllowed = true
  state.rateLimitRetryAfter = 0
})

describe('PATCH /api/admin/settings/threshold_alert', () => {
  it('200 happy path : RPC update_settings_threshold_alert appelée', async () => {
    state.rpcReturn = {
      id: 99,
      key: 'threshold_alert',
      value: { count: 7, days: 14, dedup_hours: 48 },
      valid_from: '2026-04-28T10:00:00Z',
      valid_to: null,
      updated_by: 9,
      notes: 'Tightening threshold',
      created_at: '2026-04-28T10:00:00Z',
    }
    const res = mockRes()
    await adminSettingsThresholdPatchHandler(
      adminReq({ count: 7, days: 14, dedup_hours: 48, notes: 'Tightening threshold' }),
      res
    )
    expect(res.statusCode).toBe(200)
    expect(state.rpcCalls).toHaveLength(1)
    expect(state.rpcCalls[0]).toMatchObject({
      p_value: { count: 7, days: 14, dedup_hours: 48 },
      p_notes: 'Tightening threshold',
      p_actor_operator_id: 9,
    })
    const body = res.jsonBody as { data: { id: number; value: unknown } }
    expect(body.data.id).toBe(99)
    expect(body.data.value).toEqual({ count: 7, days: 14, dedup_hours: 48 })
  })

  it('400 INVALID_BODY si Zod invalide (count=0)', async () => {
    const res = mockRes()
    await adminSettingsThresholdPatchHandler(adminReq({ count: 0, days: 7, dedup_hours: 24 }), res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('INVALID_BODY')
  })

  it('400 INVALID_BODY si days > 365', async () => {
    const res = mockRes()
    await adminSettingsThresholdPatchHandler(
      adminReq({ count: 5, days: 400, dedup_hours: 24 }),
      res
    )
    expect(res.statusCode).toBe(400)
  })

  it('400 INVALID_BODY si body est un array', async () => {
    const res = mockRes()
    await adminSettingsThresholdPatchHandler(adminReq([1, 2, 3]), res)
    expect(res.statusCode).toBe(400)
  })

  it('CR S4 — 400 INVALID_BODY si body contient une clé inconnue (Zod .strict)', async () => {
    const res = mockRes()
    await adminSettingsThresholdPatchHandler(
      adminReq({ count: 5, days: 7, dedup_hours: 24, secretKey: 'pwn' }),
      res
    )
    expect(res.statusCode).toBe(400)
    expect(state.rpcCalls).toHaveLength(0)
  })

  it('CR A7 — 400 INVALID_BODY si notes contient des chars de contrôle', async () => {
    const res = mockRes()
    await adminSettingsThresholdPatchHandler(
      adminReq({
        count: 5,
        days: 7,
        dedup_hours: 24,
        notes: `ok${String.fromCharCode(0x00)}bad`,
      }),
      res
    )
    expect(res.statusCode).toBe(400)
  })

  it('403 ROLE_NOT_ALLOWED si role=sav-operator', async () => {
    const res = mockRes()
    await adminSettingsThresholdPatchHandler(
      operatorReq({ count: 5, days: 7, dedup_hours: 24 }),
      res
    )
    expect(res.statusCode).toBe(403)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('ROLE_NOT_ALLOWED')
    expect(state.rpcCalls).toHaveLength(0)
  })

  it('CR A5 — 409 CONCURRENT_PATCH si la RPC retourne 23505 (W37 unique violation)', async () => {
    state.rpcError = { code: '23505', message: 'duplicate key on settings_one_active_per_key' }
    const res = mockRes()
    await adminSettingsThresholdPatchHandler(adminReq({ count: 5, days: 7, dedup_hours: 24 }), res)
    expect(res.statusCode).toBe(409)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('CONCURRENT_PATCH')
  })

  it('500 PERSIST_FAILED si la RPC échoue avec autre code', async () => {
    state.rpcError = { code: '40001', message: 'serialization failure' }
    const res = mockRes()
    await adminSettingsThresholdPatchHandler(adminReq({ count: 5, days: 7, dedup_hours: 24 }), res)
    expect(res.statusCode).toBe(500)
  })

  it('CR A1 — 429 RATE_LIMITED si bucket dépassé', async () => {
    state.rateLimitAllowed = false
    state.rateLimitRetryAfter = 60
    const res = mockRes()
    await adminSettingsThresholdPatchHandler(adminReq({ count: 5, days: 7, dedup_hours: 24 }), res)
    expect(res.statusCode).toBe(429)
    expect(state.rpcCalls).toHaveLength(0)
  })
})

describe('GET /api/admin/settings/threshold_alert/history', () => {
  it('200 retourne items DESC valid_from avec operator email_short', async () => {
    state.selectRows = [
      {
        id: 3,
        value: { count: 7, days: 14, dedup_hours: 48 },
        valid_from: '2026-04-28T10:00:00Z',
        valid_to: null,
        updated_by: 9,
        notes: 'New tighter threshold',
        created_at: '2026-04-28T10:00:00Z',
      },
      {
        id: 2,
        value: { count: 5, days: 7, dedup_hours: 24 },
        valid_from: '2026-04-20T10:00:00Z',
        valid_to: '2026-04-28T10:00:00Z',
        updated_by: 9,
        notes: null,
        created_at: '2026-04-20T10:00:00Z',
      },
    ]
    state.operatorRows = [{ id: 9, email: 'admin@fruitstock.fr' }]
    const res = mockRes()
    await adminSettingsThresholdHistoryHandler(adminGetReq({ limit: '5' }), res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: {
        items: Array<{
          id: number
          value: { count: number }
          valid_to: string | null
          updated_by: { email_display_short: string | null } | null
        }>
      }
    }
    expect(body.data.items).toHaveLength(2)
    expect(body.data.items[0]!.id).toBe(3)
    expect(body.data.items[0]!.valid_to).toBeNull()
    expect(body.data.items[0]!.updated_by?.email_display_short).toBe('admin')
  })

  it('200 limit par défaut 10 si query vide', async () => {
    state.selectRows = []
    const res = mockRes()
    await adminSettingsThresholdHistoryHandler(adminGetReq(), res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: { items: unknown[] } }
    expect(body.data.items).toEqual([])
  })

  it('400 INVALID_PARAMS si limit > 50', async () => {
    const res = mockRes()
    await adminSettingsThresholdHistoryHandler(adminGetReq({ limit: '999' }), res)
    expect(res.statusCode).toBe(400)
  })

  it('403 ROLE_NOT_ALLOWED si role=sav-operator', async () => {
    const operatorPayload: SessionUser = {
      sub: 12,
      type: 'operator',
      role: 'sav-operator',
      exp: farFuture(),
    }
    const req = mockReq({ method: 'GET' })
    req.user = operatorPayload
    const res = mockRes()
    await adminSettingsThresholdHistoryHandler(req, res)
    expect(res.statusCode).toBe(403)
  })

  it('500 QUERY_FAILED si SELECT KO', async () => {
    state.selectError = { message: 'db down' }
    const res = mockRes()
    await adminSettingsThresholdHistoryHandler(adminGetReq(), res)
    expect(res.statusCode).toBe(500)
  })
})
