import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockReq, mockRes } from '../../_lib/test-helpers'
import {
  adminSession,
  savOperatorSession,
  productRow,
  productCreateBody,
  type ProductRow,
} from '../../../../fixtures/admin-fixtures'

/**
 * Story 7-3b AC #2 — RED-PHASE tests pour `POST /api/admin/products`
 * (op `admin-product-create`). Handler attendu :
 *   client/api/_lib/admin/product-create-handler.ts
 *
 * Validation Zod (D-2 + D-5) :
 *   - code : non vide, max 64, regex `^[A-Z0-9_-]+$`
 *   - name_fr : non vide max 200
 *   - name_en, name_es : optionnels max 200 (nullable)
 *   - vat_rate_bp : int 0..10000 (default 550)
 *   - default_unit : enum 'kg' | 'piece' | 'liter'
 *   - piece_weight_grams : int > 0 ou null ; requis si default_unit='piece' (D-2 conditionnel)
 *   - tier_prices : array [{tier int>=1, price_ht_cents int>=0}], min 1, max 10, strict croissant tier (D-2)
 *   - supplier_code : optionnel max 32
 *   - origin : optionnel ISO 3166-1 alpha-2 — regex /^[A-Z]{2}$/ (D-5)
 *
 * Réponses :
 *   201 → { product: Product }
 *   400 INVALID_BODY (Zod errors)
 *   403 ROLE_NOT_ALLOWED
 *   409 CODE_ALREADY_EXISTS si 23505 sur products_code_key
 *   500 PERSIST_FAILED
 *
 * D-4 : recordAudit() avec entity='product', action='created',
 *   actor_operator_id=req.user.sub, diff={after}.
 */

interface State {
  insertRows: ProductRow[]
  insertError: { code?: string; message: string; constraint?: string } | null
  recordAuditCalls: Array<Record<string, unknown>>
}

const state = vi.hoisted(
  () =>
    ({
      insertRows: [],
      insertError: null,
      recordAuditCalls: [],
    }) as State
)

vi.mock('../../../../../api/_lib/clients/supabase-admin', () => {
  function buildProductsBuilder(): unknown {
    const out = {
      insert: (_payload: unknown) => ({
        select: () => ({
          single: () =>
            Promise.resolve({
              data: state.insertError ? null : (state.insertRows[0] ?? null),
              error: state.insertError,
            }),
        }),
      }),
    }
    return out
  }
  return {
    supabaseAdmin: () => ({
      from: (table: string) => {
        if (table === 'products') return buildProductsBuilder()
        throw new Error(`Unmocked table: ${table}`)
      },
    }),
    __resetSupabaseAdminForTests: () => undefined,
  }
})

vi.mock('../../../../../api/_lib/audit/record', () => ({
  recordAudit: (input: Record<string, unknown>) => {
    state.recordAuditCalls.push(input)
    return Promise.resolve()
  },
}))

// RED — module n'existe pas encore.
import { adminProductCreateHandler } from '../../../../../api/_lib/admin/product-create-handler'

beforeEach(() => {
  state.insertRows = []
  state.insertError = null
  state.recordAuditCalls = []
})

describe('POST /api/admin/products (admin-product-create)', () => {
  it('201 happy path : INSERT products + recordAudit appelé', async () => {
    state.insertRows = [productRow({ id: 600, code: 'TOM-RAP-1' })]
    const req = mockReq({ method: 'POST', body: productCreateBody() })
    req.user = adminSession()
    const res = mockRes()
    await adminProductCreateHandler(req, res)
    expect(res.statusCode).toBe(201)
    const body = res.jsonBody as { data: { product: ProductRow } }
    expect(body.data.product.code).toBe('TOM-RAP-1')
    expect(body.data.product.origin).toBe('ES')
    expect(state.recordAuditCalls).toHaveLength(1)
    expect(state.recordAuditCalls[0]).toMatchObject({
      entityType: 'product',
      action: 'created',
      actorOperatorId: 9,
    })
  })

  it('400 INVALID_BODY si code ne respecte pas regex ^[A-Z0-9_-]+$', async () => {
    const req = mockReq({
      method: 'POST',
      body: productCreateBody({ code: 'lower-case' }),
    })
    req.user = adminSession()
    const res = mockRes()
    await adminProductCreateHandler(req, res)
    expect(res.statusCode).toBe(400)
    expect(state.recordAuditCalls).toHaveLength(0)
  })

  it('400 INVALID_BODY si name_fr vide', async () => {
    const req = mockReq({
      method: 'POST',
      body: productCreateBody({ name_fr: '' }),
    })
    req.user = adminSession()
    const res = mockRes()
    await adminProductCreateHandler(req, res)
    expect(res.statusCode).toBe(400)
  })

  it('400 INVALID_BODY si vat_rate_bp hors range (>10000)', async () => {
    const req = mockReq({
      method: 'POST',
      body: productCreateBody({ vat_rate_bp: 12000 }),
    })
    req.user = adminSession()
    const res = mockRes()
    await adminProductCreateHandler(req, res)
    expect(res.statusCode).toBe(400)
  })

  it('400 INVALID_BODY si default_unit hors enum', async () => {
    const req = mockReq({
      method: 'POST',
      body: productCreateBody({
        default_unit: 'box' as unknown as 'kg' | 'piece' | 'liter',
      }),
    })
    req.user = adminSession()
    const res = mockRes()
    await adminProductCreateHandler(req, res)
    expect(res.statusCode).toBe(400)
  })

  it('D-2 : 400 INVALID_BODY si tier_prices vide []', async () => {
    const req = mockReq({
      method: 'POST',
      body: productCreateBody({ tier_prices: [] }),
    })
    req.user = adminSession()
    const res = mockRes()
    await adminProductCreateHandler(req, res)
    expect(res.statusCode).toBe(400)
  })

  it('D-2 : 400 INVALID_BODY si tier_prices ordre non strict croissant', async () => {
    const req = mockReq({
      method: 'POST',
      body: productCreateBody({
        tier_prices: [
          { tier: 2, price_ht_cents: 200 },
          { tier: 1, price_ht_cents: 250 }, // tier 1 après tier 2 — invalide
        ],
      }),
    })
    req.user = adminSession()
    const res = mockRes()
    await adminProductCreateHandler(req, res)
    expect(res.statusCode).toBe(400)
  })

  it('D-2 conditionnel : 400 INVALID_BODY si default_unit=piece et piece_weight_grams null', async () => {
    const req = mockReq({
      method: 'POST',
      body: productCreateBody({
        default_unit: 'piece',
        piece_weight_grams: null,
      }),
    })
    req.user = adminSession()
    const res = mockRes()
    await adminProductCreateHandler(req, res)
    expect(res.statusCode).toBe(400)
  })

  it('D-5 : 201 OK avec origin valide ISO alpha-2 (FR)', async () => {
    state.insertRows = [productRow({ id: 601, code: 'POM-GAL-1', origin: 'FR' })]
    const req = mockReq({
      method: 'POST',
      body: productCreateBody({ code: 'POM-GAL-1', origin: 'FR' }),
    })
    req.user = adminSession()
    const res = mockRes()
    await adminProductCreateHandler(req, res)
    expect(res.statusCode).toBe(201)
    const body = res.jsonBody as { data: { product: ProductRow } }
    expect(body.data.product.origin).toBe('FR')
  })

  it('D-5 : 400 INVALID_BODY si origin invalide (lowercase ou 3 chars)', async () => {
    const req1 = mockReq({
      method: 'POST',
      body: productCreateBody({ origin: 'esp' }),
    })
    req1.user = adminSession()
    const res1 = mockRes()
    await adminProductCreateHandler(req1, res1)
    expect(res1.statusCode).toBe(400)

    const req2 = mockReq({
      method: 'POST',
      body: productCreateBody({ origin: '12' }),
    })
    req2.user = adminSession()
    const res2 = mockRes()
    await adminProductCreateHandler(req2, res2)
    expect(res2.statusCode).toBe(400)
  })

  // ===== Hardening Round 1 régression =====

  it('W-7-3b-5 : 201 OK avec vat_rate_bp=0 (TVA 0% — exonération)', async () => {
    // TVA 0% existe en France pour certains produits export (frais Espagne).
    // Zod `.min(0)` accepte 0, mais sans test explicite un consumer JS
    // pourrait masquer le bug avec `if (vat_rate_bp)` (falsy).
    state.insertRows = [productRow({ id: 602, code: 'EXPORT-1', vat_rate_bp: 0 })]
    const req = mockReq({
      method: 'POST',
      body: productCreateBody({ code: 'EXPORT-1', vat_rate_bp: 0 }),
    })
    req.user = adminSession()
    const res = mockRes()
    await adminProductCreateHandler(req, res)
    expect(res.statusCode).toBe(201)
    const body = res.jsonBody as { data: { product: ProductRow } }
    expect(body.data.product.vat_rate_bp).toBe(0)
  })

  it('W-7-3b-5 : 400 INVALID_BODY si tier_prices.price_ht_cents > cap (sanity max 100k€)', async () => {
    const req = mockReq({
      method: 'POST',
      body: productCreateBody({
        tier_prices: [{ tier: 1, price_ht_cents: 999_999_999_999 }],
      }),
    })
    req.user = adminSession()
    const res = mockRes()
    await adminProductCreateHandler(req, res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('INVALID_BODY')
  })

  it('403 ROLE_NOT_ALLOWED si role=sav-operator', async () => {
    const req = mockReq({ method: 'POST', body: productCreateBody() })
    req.user = savOperatorSession()
    const res = mockRes()
    await adminProductCreateHandler(req, res)
    expect(res.statusCode).toBe(403)
    expect(state.recordAuditCalls).toHaveLength(0)
  })
})
