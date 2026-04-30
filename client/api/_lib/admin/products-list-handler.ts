import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { productListQuerySchema, type ProductRow } from './products-schema'
import type { ApiHandler } from '../types'

/**
 * Story 7-3b AC #1 — `GET /api/admin/products` (op `admin-products-list`).
 *
 * Pagination range offset/limit (cap 100/page), recherche `q` :
 *   - q.length >= 3 → tsvector via `.textSearch('search', q, { config:'french' })`
 *     (la colonne `products.search` est `GENERATED ALWAYS AS` dans la
 *     migration `20260421140000_schema_sav_capture.sql:121-123`).
 *   - q.length < 3 → fallback ILIKE OR sur `code|name_fr` (le tsvector
 *     n'aide pas pour les substrings de 1-2 char).
 *
 * Filtres : `supplier_code`, `default_unit`, `is_deleted` (true/false),
 * `origin` (ISO alpha-2). Si `is_deleted` absent → masque les soft-deleted
 * (`.is('deleted_at', null)`). Si `is_deleted=true` → seulement les
 * soft-deleted (`.not('deleted_at','is',null)`). Si `is_deleted=false` →
 * `.is('deleted_at', null)`.
 *
 * Auth : router `pilotage.ts` applique `withAuth({ types:['operator'] })`
 * + check role admin via Set `ADMIN_ONLY_OPS` + helper `requireAdminRole`.
 * Le handler ré-applique le check (defense-in-depth — pattern Story 7-3a).
 *
 * Réponse 200 : { data: { items: ProductRow[], total: number, hasMore: boolean } }
 * Erreurs : 400 INVALID_PARAMS | 403 ROLE_NOT_ALLOWED | 500 QUERY_FAILED
 */

export const adminProductsListHandler: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  const user = req.user
  if (!user || user.type !== 'operator') {
    sendError(res, 'FORBIDDEN', 'Session opérateur requise', requestId)
    return
  }
  if (user.role !== 'admin') {
    sendError(res, 'FORBIDDEN', 'Rôle admin requis', requestId, {
      code: 'ROLE_NOT_ALLOWED',
    })
    return
  }

  const parsed = productListQuerySchema.safeParse(req.query ?? {})
  if (!parsed.success) {
    sendError(res, 'VALIDATION_FAILED', 'Paramètres invalides', requestId, {
      code: 'INVALID_PARAMS',
      issues: parsed.error.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      })),
    })
    return
  }
  const { q, supplier_code, default_unit, origin, is_deleted, limit, offset } = parsed.data

  const admin = supabaseAdmin()
  let query = admin
    .from('products')
    .select(
      'id, code, name_fr, name_en, name_es, vat_rate_bp, default_unit, ' +
        'piece_weight_grams, tier_prices, supplier_code, origin, ' +
        'created_at, updated_at, deleted_at',
      { count: 'exact' }
    )
    .order('id', { ascending: false })

  // Recherche : tsvector pour q.length >= 3, fallback ILIKE sinon.
  if (typeof q === 'string' && q.length > 0) {
    if (q.length >= 3) {
      // Pattern PostgREST `.textSearch(column, query, opts)` — utilise la
      // colonne `search` (GENERATED ALWAYS AS) en french config.
      const builderWithFts = query as unknown as {
        textSearch: (col: string, q: string, opts: { config: string }) => typeof query
      }
      query = builderWithFts.textSearch('search', q, { config: 'french' })
    } else {
      // Fallback ILIKE substring sur code|name_fr. Neutraliser les
      // caractères structurels PostgREST `.or()` (`,`, `(`, `)`) et les
      // wildcards SQL ILIKE (`%`, `_`) pour cohérence pattern Story 7-3a
      // (W-7-3a-1 hardening).
      const safe = q.replace(/[(),%_]/g, '_')
      query = query.or(`code.ilike.%${safe}%,name_fr.ilike.%${safe}%`)
    }
  }

  if (typeof supplier_code === 'string' && supplier_code.length > 0) {
    query = query.eq('supplier_code', supplier_code)
  }
  if (default_unit !== undefined) {
    query = query.eq('default_unit', default_unit)
  }
  if (typeof origin === 'string' && origin.length > 0) {
    query = query.eq('origin', origin)
  }

  // is_deleted : default = false (masque soft-deleted).
  if (is_deleted === 'true') {
    const builder = query as unknown as {
      not: (col: string, op: string, val: unknown) => typeof query
    }
    query = builder.not('deleted_at', 'is', null)
  } else {
    query = query.is('deleted_at', null)
  }

  const from = offset
  const to = offset + limit - 1
  const { data, error, count } = await query.range(from, to)

  if (error) {
    logger.error('admin.products.list.query_failed', {
      requestId,
      code: error.code,
      message: error.message,
    })
    sendError(res, 'SERVER_ERROR', 'Lecture impossible', requestId, {
      code: 'QUERY_FAILED',
    })
    return
  }

  const items = (data ?? []) as unknown as ProductRow[]
  const total = typeof count === 'number' ? count : items.length
  const hasMore = offset + items.length < total

  res.status(200).json({ data: { items, total, hasMore } })
}
