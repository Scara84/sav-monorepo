import { z } from 'zod'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import type { ApiHandler } from '../types'

/**
 * Story 5.3 AC #4 — `GET /api/reports/top-reasons-suppliers`.
 *
 * Top motifs (extrait depuis sav_lines.validation_messages jsonb,
 * kind=cause) + top fournisseurs (products.supplier_code) sur fenêtre
 * p_days. Deux RPC en Promise.all (parallèle DB-side, 1 seul round-trip
 * réseau côté client si Supabase batch — sinon 2 round-trips JS-await).
 *
 * Query params :
 *   - days  : 1..365 (défaut 90)
 *   - limit : 1..50  (défaut 10)
 *
 * Robustesse : si une des 2 RPC échoue, l'autre payload est quand même
 * livré avec une error envelope dédiée. V1 : on échoue 500 si UNE des deux
 * échoue (cohérent UX dashboard global), simplification — Epic 6 raffinera
 * en partial-success si besoin.
 */

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional().default(90),
  limit: z.coerce.number().int().min(1).max(50).optional().default(10),
})

interface ReasonRpcRow {
  motif: string
  n: number | string
  total_cents: number | string
}
interface SupplierRpcRow {
  supplier_code: string
  sav_count: number | string
  total_cents: number | string
}

export interface ReasonItem {
  motif: string
  count: number
  total_cents: number
}
export interface SupplierItem {
  supplier_code: string
  sav_count: number
  total_cents: number
}

export interface TopReasonsSuppliersResponse {
  window_days: number
  reasons: ReasonItem[]
  suppliers: SupplierItem[]
}

function num(v: number | string): number {
  return typeof v === 'number' ? v : Number(v)
}

export const topReasonsSuppliersHandler: ApiHandler = async (req, res) => {
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
    const [reasonsRes, suppliersRes] = await Promise.all([
      admin.rpc('report_top_reasons', { p_days: q.days, p_limit: q.limit }),
      admin.rpc('report_top_suppliers', { p_days: q.days, p_limit: q.limit }),
    ])

    if (reasonsRes.error) {
      logger.error('report.top_reasons.failed', {
        requestId,
        message: reasonsRes.error.message,
        params: q,
        durationMs: Date.now() - startedAt,
      })
      sendError(res, 'SERVER_ERROR', 'Lecture top-motifs échouée', requestId, {
        code: 'QUERY_FAILED',
      })
      return
    }
    if (suppliersRes.error) {
      logger.error('report.top_suppliers.failed', {
        requestId,
        message: suppliersRes.error.message,
        params: q,
        durationMs: Date.now() - startedAt,
      })
      sendError(res, 'SERVER_ERROR', 'Lecture top-fournisseurs échouée', requestId, {
        code: 'QUERY_FAILED',
      })
      return
    }

    const reasonsRows = (reasonsRes.data ?? []) as ReasonRpcRow[]
    const suppliersRows = (suppliersRes.data ?? []) as SupplierRpcRow[]

    const reasons: ReasonItem[] = reasonsRows.map((r) => ({
      motif: r.motif,
      count: num(r.n),
      total_cents: num(r.total_cents),
    }))
    const suppliers: SupplierItem[] = suppliersRows.map((r) => ({
      supplier_code: r.supplier_code,
      sav_count: num(r.sav_count),
      total_cents: num(r.total_cents),
    }))

    const durationMs = Date.now() - startedAt
    logger.info('report.top_reasons_suppliers.success', {
      requestId,
      params: q,
      durationMs,
      n_reasons: reasons.length,
      n_suppliers: suppliers.length,
    })

    const payload: TopReasonsSuppliersResponse = {
      window_days: q.days,
      reasons,
      suppliers,
    }
    res.status(200).json({ data: payload })
  } catch (err) {
    logger.error('report.top_reasons_suppliers.exception', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    })
    sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId, { code: 'QUERY_FAILED' })
  }
}

export const __testables = { num }
