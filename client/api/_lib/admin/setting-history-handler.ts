import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import {
  settingKeySchema,
  settingHistoryQuerySchema,
  shortEmail,
  type SettingHistoryItem,
} from './settings-schema'
import type { ApiHandler } from '../types'

/**
 * Story 7-4 AC #4 — `GET /api/admin/settings/:key/history?limit=10`
 * (op `admin-setting-history`).
 *
 * D-1 : `key` validée Zod enum whitelist 8 keys → 422 KEY_NOT_WHITELISTED.
 * D-6 : `limit` Zod `z.coerce.number().int().min(1).max(50).default(10)`,
 *       cohérent Story 5.5 threshold-history-handler.
 * PII-mask : `shortEmail()` (préfixe avant @) cohérent Story 5.5.
 * Ordering : `valid_from DESC, id DESC` (tiebreak déterministe).
 *
 * Réponses :
 *   200 → { data: { items: SettingHistoryItem[] } }
 *   400 INVALID_PARAMS (limit hors bornes)
 *   403 ROLE_NOT_ALLOWED
 *   422 KEY_NOT_WHITELISTED
 *   500 QUERY_FAILED
 */

interface SettingsRow {
  id: number
  value: unknown
  valid_from: string
  valid_to: string | null
  updated_by: number | null
  notes: string | null
  created_at: string
}

export const adminSettingHistoryHandler: ApiHandler = async (req, res) => {
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

  const queryRaw = (req.query as Record<string, unknown> | undefined) ?? {}
  const rawKey = typeof queryRaw['key'] === 'string' ? (queryRaw['key'] as string) : null

  // D-1 strict — validate `key` enum AVANT lecture DB.
  const keyParsed = settingKeySchema.safeParse(rawKey)
  if (!keyParsed.success) {
    sendError(res, 'BUSINESS_RULE', 'Clé settings non whitelistée', requestId, {
      code: 'KEY_NOT_WHITELISTED',
    })
    return
  }
  const key = keyParsed.data

  const limitParsed = settingHistoryQuerySchema.safeParse({ limit: queryRaw['limit'] })
  if (!limitParsed.success) {
    sendError(res, 'VALIDATION_FAILED', 'Paramètres invalides', requestId, {
      code: 'INVALID_PARAMS',
      issues: limitParsed.error.issues.map((i) => ({
        // Hardening W-7-4-4 — G-7 cohérence : Zod 3.x `path: PropertyKey[]`
        // peut contenir `symbol`, `.join('.')` direct fail TS strict.
        field: i.path.map((p) => String(p)).join('.'),
        message: i.message,
      })),
    })
    return
  }
  const { limit } = limitParsed.data

  const admin = supabaseAdmin()
  const { data: rows, error } = (await admin
    .from('settings')
    .select('id, value, valid_from, valid_to, updated_by, notes, created_at')
    .eq('key', key)
    .order('valid_from', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit)) as unknown as {
    data: SettingsRow[] | null
    error: { code?: string; message: string } | null
  }

  if (error) {
    logger.error('admin.setting.history.query_failed', {
      requestId,
      key,
      message: error.message,
    })
    sendError(res, 'SERVER_ERROR', 'Lecture historique échouée', requestId, {
      code: 'QUERY_FAILED',
    })
    return
  }

  const settingsRows = rows ?? []
  const operatorIds = Array.from(
    new Set(settingsRows.map((r) => r.updated_by).filter((v): v is number => typeof v === 'number'))
  )
  const operatorsMap = new Map<number, string>()
  if (operatorIds.length > 0) {
    const { data: opRows, error: opErr } = (await admin
      .from('operators')
      .select('id, email')
      .in('id', operatorIds)) as unknown as {
      data: Array<{ id: number; email: string }> | null
      error: { code?: string; message: string } | null
    }
    if (opErr) {
      logger.warn('admin.setting.history.operators_query_failed', {
        requestId,
        message: opErr.message,
      })
    } else {
      for (const r of opRows ?? []) {
        operatorsMap.set(r.id, r.email)
      }
    }
  }

  const items: SettingHistoryItem[] = settingsRows.map((r) => ({
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
