import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockReq, mockRes } from '../../_lib/test-helpers'
import { adminSession, savOperatorSession, ADMIN_ID } from '../../../../fixtures/admin-fixtures'

/**
 * Story 7-4 AC #4 + AC #5 — RED-PHASE tests pour
 * `GET /api/admin/settings/:key/history?limit=10` (op `admin-setting-history`).
 *
 * Handler attendu :
 *   client/api/_lib/admin/setting-history-handler.ts
 *
 * Décisions :
 *   D-1 : `key` validée par Zod enum whitelist 8 keys. Hors whitelist →
 *         422 KEY_NOT_WHITELISTED **avant** lecture DB.
 *   D-6 : `limit` Zod `z.coerce.number().int().min(1).max(50).default(10)`,
 *         cohérent Story 5.5 threshold-history-handler.
 *   PII-mask : `shortEmail()` (préfixe avant @) cohérent Story 5.5.
 *   Ordering : `valid_from DESC, id DESC` (tiebreak déterministe).
 *
 * Réponses :
 *   200 → { data: { items: SettingHistoryItem[] } }
 *   400 INVALID_PARAMS (limit hors bornes)
 *   403 ROLE_NOT_ALLOWED
 *   422 KEY_NOT_WHITELISTED
 *   500 QUERY_FAILED
 */

interface State {
  selectRows: Array<{
    id: number
    value: unknown
    valid_from: string
    valid_to: string | null
    updated_by: number | null
    notes: string | null
    created_at: string
  }>
  selectError: { message: string } | null
  operatorRows: Array<{ id: number; email: string }>
  eqFilters: Array<{ col: string; val: unknown }>
  orderCalls: Array<{ col: string; opts: { ascending: boolean } }>
  limitVal: number | null
}

const state = vi.hoisted(
  () =>
    ({
      selectRows: [],
      selectError: null,
      operatorRows: [],
      eqFilters: [],
      orderCalls: [],
      limitVal: null,
    }) as State
)

vi.mock('../../../../../api/_lib/clients/supabase-admin', () => {
  function buildSettingsBuilder(): unknown {
    const out: Record<string, unknown> = {
      select: () => out,
      eq: (col: string, val: unknown) => {
        state.eqFilters.push({ col, val })
        return out
      },
      order: (col: string, opts: { ascending: boolean }) => {
        state.orderCalls.push({ col, opts })
        return out
      },
      limit: (n: number) => {
        state.limitVal = n
        return Promise.resolve({
          data: state.selectError ? null : state.selectRows,
          error: state.selectError,
        })
      },
    }
    return out
  }
  function buildOperatorsBuilder(): unknown {
    const out: Record<string, unknown> = {
      select: () => out,
      in: () => Promise.resolve({ data: state.operatorRows, error: null }),
    }
    return out
  }
  return {
    supabaseAdmin: () => ({
      from: (table: string) => {
        if (table === 'settings') return buildSettingsBuilder()
        if (table === 'operators') return buildOperatorsBuilder()
        throw new Error(`Unmocked table: ${table}`)
      },
    }),
    __resetSupabaseAdminForTests: () => undefined,
  }
})

// RED — module n'existe pas encore.
import { adminSettingHistoryHandler } from '../../../../../api/_lib/admin/setting-history-handler'

beforeEach(() => {
  state.selectRows = []
  state.selectError = null
  state.operatorRows = []
  state.eqFilters = []
  state.orderCalls = []
  state.limitVal = null
})

describe('GET /api/admin/settings/:key/history (admin-setting-history)', () => {
  it('200 happy path : retourne items DESC valid_from + shortEmail PII-mask', async () => {
    state.selectRows = [
      {
        id: 102,
        value: { bp: 600 },
        valid_from: '2026-07-01T00:00:00Z',
        valid_to: null,
        updated_by: ADMIN_ID,
        notes: 'Hausse TVA décret 2026',
        created_at: '2026-05-01T10:00:00Z',
      },
      {
        id: 101,
        value: { bp: 550 },
        valid_from: '2020-01-01T00:00:00Z',
        valid_to: '2026-07-01T00:00:00Z',
        updated_by: ADMIN_ID,
        notes: null,
        created_at: '2020-01-01T00:00:00Z',
      },
    ]
    state.operatorRows = [{ id: ADMIN_ID, email: 'admin@fruitstock.fr' }]
    const req = mockReq({
      method: 'GET',
      query: { key: 'vat_rate_default', limit: '10' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminSettingHistoryHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: {
        items: Array<{
          id: number
          value: unknown
          valid_to: string | null
          updated_by: { id: number; email_display_short: string | null } | null
        }>
      }
    }
    expect(body.data.items).toHaveLength(2)
    // PII-mask : 'admin@fruitstock.fr' → 'admin'.
    expect(body.data.items[0]?.updated_by?.email_display_short).toBe('admin')
    // Active row en première position (valid_to=null, valid_from le plus récent).
    expect(body.data.items[0]?.valid_to).toBeNull()
    // Tri DB demandé DESC sur valid_from puis id.
    const cols = state.orderCalls.map((c) => c.col)
    expect(cols).toContain('valid_from')
    // Filtre key.
    expect(state.eqFilters).toContainEqual({ col: 'key', val: 'vat_rate_default' })
  })

  it('200 + limit défaut 10 si query.limit absent (D-6 default)', async () => {
    state.selectRows = []
    const req = mockReq({
      method: 'GET',
      query: { key: 'vat_rate_default' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminSettingHistoryHandler(req, res)
    expect(res.statusCode).toBe(200)
    expect(state.limitVal).toBe(10)
  })

  it('400 INVALID_PARAMS si limit > 50 (D-6 cap)', async () => {
    const req = mockReq({
      method: 'GET',
      query: { key: 'vat_rate_default', limit: '999' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminSettingHistoryHandler(req, res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('INVALID_PARAMS')
  })

  it('422 KEY_NOT_WHITELISTED si key="evil_key" (D-1 strict)', async () => {
    const req = mockReq({
      method: 'GET',
      query: { key: 'evil_key', limit: '10' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminSettingHistoryHandler(req, res)
    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('KEY_NOT_WHITELISTED')
  })

  it('403 ROLE_NOT_ALLOWED si role=sav-operator (defense-in-depth)', async () => {
    const req = mockReq({
      method: 'GET',
      query: { key: 'vat_rate_default' },
    })
    req.user = savOperatorSession()
    const res = mockRes()
    await adminSettingHistoryHandler(req, res)
    expect(res.statusCode).toBe(403)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('ROLE_NOT_ALLOWED')
  })
})
