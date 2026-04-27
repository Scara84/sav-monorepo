import { z } from 'zod'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import type { ApiHandler } from '../types'

/**
 * Story 5.3 AC #3 — `GET /api/reports/delay-distribution`.
 *
 * Distribution délais traitement SAV (heures) entre received_at et
 * closed_at sur la fenêtre [from, to]. RPC `report_delay_distribution`
 * (percentile_cont 0.5 / 0.9, AVG, MIN, MAX, COUNT).
 *
 * Query params :
 *   - from / to : YYYY-MM-DD ISO (UTC). Range max 2 ans.
 *   - basis (P11) : 'received' (défaut, V1) — SAV reçus dans la fenêtre
 *                   (cohort, comportement historique)
 *                 | 'closed' — SAV clos dans la fenêtre (activité période,
 *                   plus stable car élimine la censure de fin de fenêtre).
 *                   Le selector est exposé côté UI sur la card.
 *
 * Réponse :
 *   - n_samples = 0 → p50/p90 = null + warning='NO_DATA'
 *   - 1 <= n_samples < 5 → warning='LOW_SAMPLE_SIZE' (percentiles non fiables)
 *   - n_samples >= 5 → pas de warning
 *   - basis : echo de la valeur retenue (default 'received')
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_RANGE_DAYS = 2 * 365 + 1 // 2 ans + 1 jour bissextile tolérance

const querySchema = z.object({
  from: z.string().regex(ISO_DATE_RE, 'from doit être au format YYYY-MM-DD'),
  to: z.string().regex(ISO_DATE_RE, 'to doit être au format YYYY-MM-DD'),
  // P11 : selector cohort 'received' (défaut V1) vs activité 'closed'.
  basis: z.enum(['received', 'closed']).optional().default('received'),
})

interface RpcRow {
  p50_hours: number | string | null
  p90_hours: number | string | null
  avg_hours: number | string | null
  min_hours: number | string | null
  max_hours: number | string | null
  n_samples: number | string
}

export interface DelayDistributionResponse {
  from: string
  to: string
  /** P11 : echo de la base utilisée (received | closed). */
  basis: 'received' | 'closed'
  p50_hours: number | null
  p90_hours: number | null
  avg_hours: number | null
  min_hours: number | null
  max_hours: number | null
  n_samples: number
  warning?: 'LOW_SAMPLE_SIZE' | 'NO_DATA'
}

function nullableNum(v: number | string | null): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function num(v: number | string): number {
  return typeof v === 'number' ? v : Number(v)
}

function daysDiffInclusive(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00.000Z`)
  const toMs = Date.parse(`${to}T00:00:00.000Z`)
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return Number.POSITIVE_INFINITY
  return Math.floor((toMs - fromMs) / (24 * 3600 * 1000)) + 1
}

export const delayDistributionHandler: ApiHandler = async (req, res) => {
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

  if (q.from > q.to) {
    sendError(res, 'VALIDATION_FAILED', 'from doit être <= to', requestId, {
      code: 'PERIOD_INVALID',
    })
    return
  }

  const days = daysDiffInclusive(q.from, q.to)
  if (days > MAX_RANGE_DAYS) {
    sendError(res, 'VALIDATION_FAILED', 'Période > 2 ans', requestId, {
      code: 'PERIOD_TOO_LARGE',
      max_days: MAX_RANGE_DAYS,
    })
    return
  }

  // p_to exclusif côté SQL : on passe `to + 1 jour` (00:00 du jour suivant).
  const fromTs = `${q.from}T00:00:00.000Z`
  const toExclusiveMs = Date.parse(`${q.to}T00:00:00.000Z`) + 24 * 3600 * 1000
  const toExclusive = new Date(toExclusiveMs).toISOString()

  try {
    const admin = supabaseAdmin()
    const { data, error } = await admin.rpc('report_delay_distribution', {
      p_from: fromTs,
      p_to: toExclusive,
      p_basis: q.basis,
    })
    if (error) {
      logger.error('report.delay_distribution.failed', {
        requestId,
        message: error.message,
        params: q,
        durationMs: Date.now() - startedAt,
      })
      sendError(res, 'SERVER_ERROR', 'Lecture délais échouée', requestId, {
        code: 'QUERY_FAILED',
      })
      return
    }

    const rows = (data ?? []) as RpcRow[]
    // RPC retourne toujours 1 row (agrégat sans GROUP BY) — défensif si vide.
    const row: RpcRow = rows[0] ?? {
      p50_hours: null,
      p90_hours: null,
      avg_hours: null,
      min_hours: null,
      max_hours: null,
      n_samples: 0,
    }

    const nSamples = num(row.n_samples)
    const payload: DelayDistributionResponse = {
      from: q.from,
      to: q.to,
      basis: q.basis,
      p50_hours: nullableNum(row.p50_hours),
      p90_hours: nullableNum(row.p90_hours),
      avg_hours: nullableNum(row.avg_hours),
      min_hours: nullableNum(row.min_hours),
      max_hours: nullableNum(row.max_hours),
      n_samples: nSamples,
    }
    if (nSamples === 0) {
      payload.p50_hours = null
      payload.p90_hours = null
      payload.warning = 'NO_DATA'
    } else if (nSamples < 5) {
      payload.warning = 'LOW_SAMPLE_SIZE'
    }

    const durationMs = Date.now() - startedAt
    logger.info('report.delay_distribution.success', {
      requestId,
      params: q,
      durationMs,
      n_samples: nSamples,
    })

    res.status(200).json({ data: payload })
  } catch (err) {
    logger.error('report.delay_distribution.exception', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    })
    sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId, { code: 'QUERY_FAILED' })
  }
}

export const __testables = { daysDiffInclusive, nullableNum, num }
