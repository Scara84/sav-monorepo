import { z } from 'zod'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import type { ApiHandler } from '../types'

/**
 * Story 5.3 AC #2 — `GET /api/reports/top-products`.
 *
 * Top N produits problématiques sur fenêtre p_days. Utilise la RPC
 * `report_top_products` (ORDER BY déterministe sav_count DESC, total_cents
 * DESC, p.id DESC).
 *
 * Query params :
 *   - days  : 1..365 (défaut 90)
 *   - limit : 1..50  (défaut 10)
 *
 * Réponse :
 *   { window_days, items: [ { product_id, product_code, name_fr,
 *                             sav_count, total_cents } ] }
 */

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional().default(90),
  limit: z.coerce.number().int().min(1).max(50).optional().default(10),
})

interface RpcRow {
  product_id: number | string
  product_code: string
  name_fr: string
  sav_count: number | string
  total_cents: number | string
}

export interface TopProductItem {
  product_id: number
  product_code: string
  name_fr: string
  sav_count: number
  total_cents: number
}

export interface TopProductsResponse {
  window_days: number
  items: TopProductItem[]
}

function num(v: number | string): number {
  return typeof v === 'number' ? v : Number(v)
}

export const topProductsHandler: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  const startedAt = Date.now()
  const user = req.user

  if (!user || user.type !== 'operator') {
    sendError(res, 'FORBIDDEN', 'Session opérateur requise', requestId)
    return
  }

  const parse = querySchema.safeParse(req.query ?? {})
  if (!parse.success) {
    sendError(res, 'VALIDATION_FAILED', 'Paramètres invalides', requestId, {
      code: 'INVALID_PARAMS',
      issues: parse.error.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      })),
    })
    return
  }
  const q = parse.data

  try {
    const admin = supabaseAdmin()
    const { data, error } = await admin.rpc('report_top_products', {
      p_days: q.days,
      p_limit: q.limit,
    })
    if (error) {
      logger.error('report.top_products.failed', {
        requestId,
        message: error.message,
        params: q,
        durationMs: Date.now() - startedAt,
      })
      sendError(res, 'SERVER_ERROR', 'Lecture top-products échouée', requestId, {
        code: 'QUERY_FAILED',
      })
      return
    }

    const rows = (data ?? []) as RpcRow[]
    const items: TopProductItem[] = rows.map((r) => ({
      product_id: num(r.product_id),
      product_code: r.product_code,
      name_fr: r.name_fr,
      sav_count: num(r.sav_count),
      total_cents: num(r.total_cents),
    }))

    const durationMs = Date.now() - startedAt
    logger.info('report.top_products.success', {
      requestId,
      params: q,
      durationMs,
      n_items: items.length,
    })

    res.status(200).json({ data: { window_days: q.days, items } })
  } catch (err) {
    logger.error('report.top_products.exception', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    })
    sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId, { code: 'QUERY_FAILED' })
  }
}

export const __testables = { num }
