import { z } from 'zod'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import type { ApiHandler } from '../types'

/**
 * Story 5.5 AC #10 — `GET /api/admin/settings/threshold_alert/history`.
 *
 * Liste les N dernières versions de la clé `threshold_alert` (DESC sur
 * valid_from) avec un email opérateur PII-limité (préfixe avant `@`).
 *
 * Query params :
 *   - limit : 1..50 (défaut 10)
 *
 * Réponse 200 :
 *   { items: [{ id, value, valid_from, valid_to, notes, created_at,
 *               updated_by: { id, email_display_short } | null }] }
 */

const SETTINGS_KEY = 'threshold_alert'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional().default(10),
})

interface SettingsRow {
  id: number
  value: unknown
  valid_from: string
  valid_to: string | null
  updated_by: number | null
  notes: string | null
  created_at: string
}

export interface ThresholdHistoryItem {
  id: number
  value: unknown
  valid_from: string
  valid_to: string | null
  notes: string | null
  created_at: string
  updated_by: { id: number; email_display_short: string | null } | null
}

function shortEmail(email: string | null): string | null {
  if (email === null || email.length === 0) return null
  const at = email.indexOf('@')
  if (at <= 0) return null
  return email.slice(0, at)
}

export const adminSettingsThresholdHistoryHandler: ApiHandler = async (req, res) => {
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

  const parsed = querySchema.safeParse(req.query ?? {})
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
  const { limit } = parsed.data

  const admin = supabaseAdmin()
  const { data: rows, error } = await admin
    .from('settings')
    .select('id, value, valid_from, valid_to, updated_by, notes, created_at')
    .eq('key', SETTINGS_KEY)
    .order('valid_from', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit)
  if (error) {
    logger.error('admin.settings.threshold.history_query_failed', {
      requestId,
      message: error.message,
    })
    sendError(res, 'SERVER_ERROR', 'Lecture historique échouée', requestId, {
      code: 'QUERY_FAILED',
    })
    return
  }

  const settingsRows = (rows ?? []) as SettingsRow[]
  const operatorIds = Array.from(
    new Set(settingsRows.map((r) => r.updated_by).filter((v): v is number => typeof v === 'number'))
  )

  const operatorsMap = new Map<number, string>()
  if (operatorIds.length > 0) {
    const { data: opRows, error: opErr } = await admin
      .from('operators')
      .select('id, email')
      .in('id', operatorIds)
    if (opErr) {
      logger.warn('admin.settings.threshold.operators_query_failed', {
        requestId,
        message: opErr.message,
      })
    } else {
      for (const r of (opRows ?? []) as Array<{ id: number; email: string }>) {
        operatorsMap.set(r.id, r.email)
      }
    }
  }

  const items: ThresholdHistoryItem[] = settingsRows.map((r) => ({
    id: r.id,
    value: r.value,
    valid_from: r.valid_from,
    valid_to: r.valid_to,
    notes: r.notes,
    created_at: r.created_at,
    updated_by:
      r.updated_by !== null
        ? {
            id: r.updated_by,
            email_display_short: shortEmail(operatorsMap.get(r.updated_by) ?? null),
          }
        : null,
  }))

  res.status(200).json({ data: { items } })
}

export const __testables = { shortEmail, querySchema, SETTINGS_KEY }
