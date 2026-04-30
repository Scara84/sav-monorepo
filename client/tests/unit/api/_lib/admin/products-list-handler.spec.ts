import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockReq, mockRes } from '../../_lib/test-helpers'
import {
  adminSession,
  savOperatorSession,
  productRow,
  type ProductRow,
} from '../../../../fixtures/admin-fixtures'

/**
 * Story 7-3b AC #1 — RED-PHASE tests pour `GET /api/admin/products`
 * (op `admin-products-list`). Handler attendu :
 *   client/api/_lib/admin/products-list-handler.ts
 *
 * Contrat (cohérent operators-list 7-3a) :
 *   200 → { items: Product[], total: number, hasMore: boolean }
 *   400 INVALID_PARAMS si limit > 100 (cap durable)
 *   403 ROLE_NOT_ALLOWED si user.role !== 'admin' (defense-in-depth)
 *   500 SERVER_ERROR si SELECT KO
 *
 * Recherche `q` :
 *   - q.length >= 3 → tsvector search via `WHERE search @@ plainto_tsquery('french', :q)`
 *     (utilise PostgREST `.textSearch('search', q, { config: 'french' })` ou
 *     filter `search=fts(french).<q>`)
 *   - q.length < 3 → fallback ILIKE OR sur (code | name_fr)
 *
 * Filtres : `supplier_code`, `default_unit`, `is_deleted` (boolean), `origin`.
 * Pagination range cap 100/page.
 */

interface State {
  selectRows: ProductRow[]
  selectError: { message: string } | null
  selectCount: number
  ilikeFilters: string[]
  textSearchCalls: Array<{ column: string; query: string; config: string | undefined }>
  eqFilters: Array<{ col: string; val: unknown }>
  isFilters: Array<{ col: string; val: unknown }>
  notFilters: Array<{ col: string; op: string; val: unknown }>
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
      textSearchCalls: [],
      eqFilters: [],
      isFilters: [],
      notFilters: [],
      limitVal: null,
      offsetVal: null,
    }) as State
)

vi.mock('../../../../../api/_lib/clients/supabase-admin', () => {
  function buildProductsQuery(): unknown {
    const out: Record<string, unknown> = {
      select: () => out,
      or: (expr: string) => {
        state.ilikeFilters.push(expr)
        return out
      },
      textSearch: (column: string, query: string, opts?: { config?: string }) => {
        state.textSearchCalls.push({ column, query, config: opts?.config })
        return out
      },
      eq: (col: string, val: unknown) => {
        state.eqFilters.push({ col, val })
        return out
      },
      is: (col: string, val: unknown) => {
        state.isFilters.push({ col, val })
        return out
      },
      not: (col: string, op: string, val: unknown) => {
        state.notFilters.push({ col, op, val })
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
        if (table === 'products') return buildProductsQuery()
        throw new Error(`Unmocked table: ${table}`)
      },
    }),
    __resetSupabaseAdminForTests: () => undefined,
  }
})

// RED — module n'existe pas encore.
import { adminProductsListHandler } from '../../../../../api/_lib/admin/products-list-handler'

beforeEach(() => {
  state.selectRows = []
  state.selectError = null
  state.selectCount = 0
  state.ilikeFilters = []
  state.textSearchCalls = []
  state.eqFilters = []
  state.isFilters = []
  state.notFilters = []
  state.limitVal = null
  state.offsetVal = null
})

describe('GET /api/admin/products (admin-products-list)', () => {
  it('200 happy path : retourne items + total + hasMore', async () => {
    state.selectRows = [
      productRow({ id: 500, code: 'TOM-RAP-1' }),
      productRow({ id: 501, code: 'POM-GAL-1', name_fr: 'Pomme Gala' }),
    ]
    state.selectCount = 2
    const req = mockReq({ method: 'GET', query: { limit: '50' } })
    req.user = adminSession()
    const res = mockRes()
    await adminProductsListHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: { items: ProductRow[]; total: number; hasMore: boolean }
    }
    expect(body.data.items).toHaveLength(2)
    expect(body.data.total).toBe(2)
    expect(body.data.hasMore).toBe(false)
  })

  it('200 + recherche tsvector si q.length >= 3 (textSearch french)', async () => {
    state.selectRows = [productRow({ code: 'TOM-RAP-1', name_fr: 'Tomate Raphael' })]
    state.selectCount = 1
    const req = mockReq({ method: 'GET', query: { q: 'tomate' } })
    req.user = adminSession()
    const res = mockRes()
    await adminProductsListHandler(req, res)
    expect(res.statusCode).toBe(200)
    expect(state.textSearchCalls.length).toBeGreaterThan(0)
    expect(state.textSearchCalls[0]?.column).toBe('search')
    expect(state.textSearchCalls[0]?.query).toContain('tomate')
    // Aucun fallback ILIKE attendu dans ce cas.
    expect(state.ilikeFilters).toHaveLength(0)
  })

  it('200 + fallback ILIKE si q.length < 3 (pas de tsvector pour q court)', async () => {
    state.selectRows = []
    state.selectCount = 0
    const req = mockReq({ method: 'GET', query: { q: 'to' } })
    req.user = adminSession()
    const res = mockRes()
    await adminProductsListHandler(req, res)
    expect(res.statusCode).toBe(200)
    // Fallback : OR(ilike code, ilike name_fr) ; pas de textSearch.
    expect(state.textSearchCalls).toHaveLength(0)
    expect(state.ilikeFilters.length).toBeGreaterThan(0)
    expect(state.ilikeFilters[0]).toMatch(/code\.ilike\.%to%|name_fr\.ilike\.%to%/i)
  })

  it("200 + filtre is_deleted=true → not('deleted_at','is',null)", async () => {
    state.selectRows = [productRow({ deleted_at: '2026-04-30T11:00:00Z' })]
    state.selectCount = 1
    const req = mockReq({ method: 'GET', query: { is_deleted: 'true' } })
    req.user = adminSession()
    const res = mockRes()
    await adminProductsListHandler(req, res)
    expect(res.statusCode).toBe(200)
    // Soit `.not('deleted_at','is',null)` soit `.is('deleted_at',null)` inversé.
    const filterRecorded =
      state.notFilters.some((f) => f.col === 'deleted_at' && f.op === 'is') ||
      state.isFilters.some((f) => f.col === 'deleted_at')
    expect(filterRecorded).toBe(true)
  })

  it('200 + pagination : range respecté (limit + offset → range from..to)', async () => {
    state.selectRows = []
    state.selectCount = 250
    const req = mockReq({ method: 'GET', query: { limit: '50', offset: '100' } })
    req.user = adminSession()
    const res = mockRes()
    await adminProductsListHandler(req, res)
    expect(res.statusCode).toBe(200)
    expect(state.offsetVal).toBe(100)
    expect(state.limitVal).toBe(50)
    const body = res.jsonBody as { data: { hasMore: boolean; total: number } }
    expect(body.data.hasMore).toBe(true)
    expect(body.data.total).toBe(250)
  })

  it('403 ROLE_NOT_ALLOWED si user role=sav-operator', async () => {
    const req = mockReq({ method: 'GET' })
    req.user = savOperatorSession()
    const res = mockRes()
    await adminProductsListHandler(req, res)
    expect(res.statusCode).toBe(403)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('ROLE_NOT_ALLOWED')
  })
})
