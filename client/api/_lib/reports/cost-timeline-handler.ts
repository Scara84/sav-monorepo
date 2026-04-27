import { z } from 'zod'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import type { ApiHandler } from '../types'

/**
 * Story 5.3 AC #1 — `GET /api/reports/cost-timeline`.
 *
 * Coût SAV agrégé mensuel + comparatif N-1 (FR52). Utilise la RPC
 * `report_cost_timeline` (migration 20260505120000) qui fait le gap-fill
 * via generate_series + LEFT JOIN current/previous CTE — 1 round-trip.
 *
 * Query params :
 *   - granularity : 'month' (V1, seul supporté). Validé côté Zod enum
 *     → switch côté handler pour éviter toute interpolation SQL
 *     (cf. Dev Notes §sécurité Story 5.3).
 *   - from / to : YYYY-MM (mois inclus inclusivement). Garde-fou 36 mois
 *     max (mémoire générée par cost-timeline + N-1 = 72 mois total).
 *
 * Réponse :
 *   { granularity, periods: [ { period, total_cents, n1_total_cents } ] }
 *
 * Erreurs :
 *   - 400 INVALID_PARAMS (Zod) | PERIOD_INVALID (from > to) | PERIOD_TOO_LARGE (>36m)
 *   - 500 QUERY_FAILED
 */

const YYYY_MM_RE = /^\d{4}-\d{2}$/
const MAX_RANGE_MONTHS = 36

// P9 : V1 ne livre que 'month'. On accepte uniquement 'month' au niveau
// Zod (un client qui passe 'year' reçoit INVALID_PARAMS, cohérent avec
// les autres valeurs invalides). Le 400 GRANULARITY_NOT_SUPPORTED a été
// retiré : la `z.enum(['month'])` est la seule source de vérité.
const querySchema = z.object({
  granularity: z.enum(['month']).optional().default('month'),
  from: z.string().regex(YYYY_MM_RE, 'from doit être au format YYYY-MM'),
  to: z.string().regex(YYYY_MM_RE, 'to doit être au format YYYY-MM'),
})

type Query = z.infer<typeof querySchema>

interface RpcRow {
  period: string
  total_cents: number | string
  n1_total_cents: number | string
}

export interface CostTimelinePeriod {
  period: string
  total_cents: number
  n1_total_cents: number
}

export interface CostTimelineResponse {
  granularity: 'month'
  periods: CostTimelinePeriod[]
}

/** Convertit "YYYY-MM" en date YYYY-MM-01 (UTC). */
function periodToDate(p: string): string {
  return `${p}-01`
}

/**
 * Compte le nombre de mois entre deux périodes "YYYY-MM" inclusivement.
 * Ex : "2026-01" → "2026-12" = 12 mois.
 */
function monthsDiff(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number) as [number, number]
  const [ty, tm] = to.split('-').map(Number) as [number, number]
  return (ty - fy) * 12 + (tm - fm) + 1
}

function toBigintNumber(v: number | string): number {
  // Supabase RPC peut renvoyer bigint en string si > Number.MAX_SAFE_INTEGER.
  // Sur des montants TTC en cents, on reste largement sous 2^53 (estimation
  // 10^15 cents = 10 milliards d'euros) — coercion safe en V1.
  return typeof v === 'number' ? v : Number(v)
}

export const costTimelineHandler: ApiHandler = async (req, res) => {
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
  const q: Query = parse.data

  // P9 : `granularity='year'` est désormais rejeté par Zod (enum=['month']
  // unique). Code dédié `GRANULARITY_NOT_SUPPORTED` retiré — un client qui
  // passe 'year' reçoit INVALID_PARAMS comme toute valeur invalide. Si on
  // livre la granularité 'year' plus tard, on la remettra dans l'enum.

  if (q.from > q.to) {
    sendError(res, 'VALIDATION_FAILED', 'from doit être <= to', requestId, {
      code: 'PERIOD_INVALID',
    })
    return
  }

  const months = monthsDiff(q.from, q.to)
  if (months > MAX_RANGE_MONTHS) {
    sendError(res, 'VALIDATION_FAILED', `Période > ${MAX_RANGE_MONTHS} mois`, requestId, {
      code: 'PERIOD_TOO_LARGE',
      max_months: MAX_RANGE_MONTHS,
    })
    return
  }

  const fromDate = periodToDate(q.from)
  const toDate = periodToDate(q.to)

  try {
    const admin = supabaseAdmin()
    const { data, error } = await admin.rpc('report_cost_timeline', {
      p_from: fromDate,
      p_to: toDate,
    })
    if (error) {
      logger.error('report.cost_timeline.failed', {
        requestId,
        message: error.message,
        params: { from: q.from, to: q.to },
        durationMs: Date.now() - startedAt,
      })
      sendError(res, 'SERVER_ERROR', 'Lecture timeline coût échouée', requestId, {
        code: 'QUERY_FAILED',
      })
      return
    }

    const rows = (data ?? []) as RpcRow[]
    const periods: CostTimelinePeriod[] = rows.map((r) => ({
      period: r.period,
      total_cents: toBigintNumber(r.total_cents),
      n1_total_cents: toBigintNumber(r.n1_total_cents),
    }))

    const payload: CostTimelineResponse = {
      granularity: 'month',
      periods,
    }

    const durationMs = Date.now() - startedAt
    logger.info('report.cost_timeline.success', {
      requestId,
      params: { from: q.from, to: q.to, months },
      durationMs,
      n_periods: periods.length,
    })

    res.status(200).json({ data: payload })
  } catch (err) {
    logger.error('report.cost_timeline.exception', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    })
    sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId, { code: 'QUERY_FAILED' })
  }
}

export const __testables = {
  monthsDiff,
  periodToDate,
  toBigintNumber,
}
