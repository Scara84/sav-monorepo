import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockReq, mockRes } from '../../_lib/test-helpers'
import {
  adminSession,
  savOperatorSession,
  operatorRow,
  type OperatorRow,
} from '../../../../fixtures/admin-fixtures'

/**
 * Story 7-3a AC #1 — RED-PHASE tests pour `GET /api/admin/operators`
 * (op `admin-operators-list`). Handler attendu :
 *   client/api/_lib/admin/operators-list-handler.ts
 *
 * Contrat (cohérent /api/sav Story 3.2) :
 *   200 → { items: Operator[], total: number, hasMore: boolean }
 *   400 si limit > 50 ou role filter invalide
 *   403 si user.role !== 'admin' (defense-in-depth)
 *   500 si SELECT KO
 *
 * Pagination cap 50 ; recherche `q` ILIKE substring sur email|display_name ;
 * filtre `role` ∈ {admin, sav-operator, all}.
 */

interface State {
  selectRows: OperatorRow[]
  selectError: { message: string } | null
  selectCount: number
  ilikeFilters: string[]
  eqFilters: Array<{ col: string; val: unknown }>
  limitVal: number | null
  offsetVal: number | null
}

const state = vi.hoisted(
  () =>
    ({
      selectRows: [],
      selectError: null,
      selectCount: 0,
      ilikeFilters: [],
      eqFilters: [],
      limitVal: null,
      offsetVal: null,
    }) as State
)

vi.mock('../../../../../api/_lib/clients/supabase-admin', () => {
  function buildOperatorsQuery(): unknown {
    const out = {
      select: () => out,
      or: (expr: string) => {
        state.ilikeFilters.push(expr)
        return out
      },
      eq: (col: string, val: unknown) => {
        state.eqFilters.push({ col, val })
        return out
      },
      order: () => out,
      range: (from: number, to: number) => {
        state.offsetVal = from
        state.limitVal = to - from + 1
        return Promise.resolve({
          data: state.selectRows,
          error: state.selectError,
          count: state.selectCount,
        })
      },
      limit: () => out,
    }
    return out
  }
  return {
    supabaseAdmin: () => ({
      from: (table: string) => {
        if (table === 'operators') return buildOperatorsQuery()
        throw new Error(`Unmocked table: ${table}`)
      },
    }),
    __resetSupabaseAdminForTests: () => undefined,
  }
})

// RED — module n'existe pas encore. L'import doit ÉCHOUER en Step 3 GREEN-phase.
import { adminOperatorsListHandler } from '../../../../../api/_lib/admin/operators-list-handler'

beforeEach(() => {
  state.selectRows = []
  state.selectError = null
  state.selectCount = 0
  state.ilikeFilters = []
  state.eqFilters = []
  state.limitVal = null
  state.offsetVal = null
})

describe('GET /api/admin/operators (admin-operators-list)', () => {
  it('200 happy path : retourne items + total + hasMore', async () => {
    state.selectRows = [
      operatorRow({ id: 9, email: 'admin@fruitstock.fr', role: 'admin' }),
      operatorRow({ id: 12, email: 'sav@fruitstock.fr', role: 'sav-operator' }),
    ]
    state.selectCount = 2
    const req = mockReq({ method: 'GET', query: { limit: '50' } })
    req.user = adminSession()
    const res = mockRes()
    await adminOperatorsListHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: { items: OperatorRow[]; total: number; hasMore: boolean }
    }
    expect(body.data.items).toHaveLength(2)
    expect(body.data.total).toBe(2)
    expect(body.data.hasMore).toBe(false)
  })

  it('200 + recherche q ILIKE sur email|display_name (substring)', async () => {
    state.selectRows = [operatorRow({ email: 'jane.doe@fruitstock.fr', display_name: 'Jane Doe' })]
    state.selectCount = 1
    const req = mockReq({ method: 'GET', query: { q: 'jane' } })
    req.user = adminSession()
    const res = mockRes()
    await adminOperatorsListHandler(req, res)
    expect(res.statusCode).toBe(200)
    expect(state.ilikeFilters.length).toBeGreaterThan(0)
    // OR expr doit cibler email ET display_name avec %jane%
    expect(state.ilikeFilters[0]).toMatch(/email\.ilike\.%jane%|display_name\.ilike\.%jane%/i)
  })

  it("200 + filtre role=admin → eq('role','admin')", async () => {
    state.selectRows = [operatorRow({ role: 'admin' })]
    state.selectCount = 1
    const req = mockReq({ method: 'GET', query: { role: 'admin' } })
    req.user = adminSession()
    const res = mockRes()
    await adminOperatorsListHandler(req, res)
    expect(res.statusCode).toBe(200)
    expect(state.eqFilters).toContainEqual({ col: 'role', val: 'admin' })
  })

  it('403 ROLE_NOT_ALLOWED si role=sav-operator (defense-in-depth)', async () => {
    const req = mockReq({ method: 'GET' })
    req.user = savOperatorSession()
    const res = mockRes()
    await adminOperatorsListHandler(req, res)
    expect(res.statusCode).toBe(403)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('ROLE_NOT_ALLOWED')
  })

  it('400 INVALID_PARAMS si limit > 50', async () => {
    const req = mockReq({ method: 'GET', query: { limit: '999' } })
    req.user = adminSession()
    const res = mockRes()
    await adminOperatorsListHandler(req, res)
    expect(res.statusCode).toBe(400)
  })

  // Hardening W-7-3a-1 — neutralisation des wildcards SQL ILIKE `%` `_`
  // dans `q` (CR E1 + G-6 challenge). Les caractères passent à `_` (le
  // `_` substitué reste neutre fonctionnellement vs littéral). Important :
  // `q="%"` ne doit PAS apparaître littéralement dans l'expression
  // PostgREST .or() — sinon match de tous les operators.
  it('W-7-3a-1 : q="%admin%" est neutralisé (pas de wildcard SQL libre)', async () => {
    state.selectRows = []
    state.selectCount = 0
    const req = mockReq({ method: 'GET', query: { q: '%admin%' } })
    req.user = adminSession()
    const res = mockRes()
    await adminOperatorsListHandler(req, res)
    expect(res.statusCode).toBe(200)
    expect(state.ilikeFilters.length).toBeGreaterThan(0)
    const expr = state.ilikeFilters[0] as string
    // Les `%` injectés par l'utilisateur doivent avoir été neutralisés
    // (remplacés par `_`). Seuls les `%` structurels du pattern
    // `email.ilike.%xxx%` doivent rester (2 `%` au début, 2 `%` à la fin —
    // soit 4 `%` au total, jamais 6).
    const percentCount = (expr.match(/%/g) ?? []).length
    expect(percentCount).toBe(4)
    // Le contenu user-input neutralisé doit apparaître comme `_admin_`.
    expect(expr).toContain('email.ilike.%_admin_%')
  })

  it('W-7-3a-1 : q="_______" (underscores) → pas de wildcard ILIKE arbitraire', async () => {
    state.selectRows = []
    state.selectCount = 0
    const req = mockReq({ method: 'GET', query: { q: '_______' } })
    req.user = adminSession()
    const res = mockRes()
    await adminOperatorsListHandler(req, res)
    expect(res.statusCode).toBe(200)
    const expr = state.ilikeFilters[0] as string
    // Tous les `_` originaux ont été remplacés par `_` (idempotent — comportement
    // déterministe documenté). Le pattern ne doit pas avoir muté en `%` libre.
    expect(expr).not.toContain('%%')
    // L'expression doit contenir le placeholder `_` substitué exactement 7 fois
    // (les 7 `_` originaux). On compte les `_` après `email.ilike.%` jusqu'au `%,`.
    const emailPattern = expr.match(/email\.ilike\.%([^%]*)%/)
    expect(emailPattern).not.toBeNull()
    expect(emailPattern?.[1]).toBe('_______')
  })

  // Hardening W-7-3a-2 — borne supérieure dure `limit ≤ 50`. CR cas explicite.
  it('W-7-3a-2 : 400 INVALID_PARAMS si limit=51 (cap dur 50)', async () => {
    const req = mockReq({ method: 'GET', query: { limit: '51' } })
    req.user = adminSession()
    const res = mockRes()
    await adminOperatorsListHandler(req, res)
    expect(res.statusCode).toBe(400)
  })

  it('W-7-3a-2 : 400 INVALID_PARAMS si offset > 10000 (cap dur)', async () => {
    const req = mockReq({ method: 'GET', query: { offset: '10001' } })
    req.user = adminSession()
    const res = mockRes()
    await adminOperatorsListHandler(req, res)
    expect(res.statusCode).toBe(400)
  })
})
