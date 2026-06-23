import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import {
  SETTING_KEYS_WHITELIST,
  shortEmail,
  type SettingActiveSummary,
  type SettingKey,
} from './settings-schema'
import type { ApiHandler } from '../types'

/**
 * Story 7-4 AC #1 — `GET /api/admin/settings` (op `admin-settings-list`).
 *
 * Liste les versions actives (valid_to IS NULL) des 8 clés whitelist D-1
 * avec :
 *   - operator updated_by (PII-limited shortEmail)
 *   - versions_count (count par-clé sur historique full)
 *   - filtre handler-side strict whitelist : les clés orphelines (seed
 *     manuel, migration future) ne fuient pas vers le client.
 *
 * Auth : router pilotage applique withAuth + check admin via ADMIN_ONLY_OPS Set.
 * Le handler ré-applique role==='admin' (defense-in-depth, pattern 7-3a).
 *
 * Réponses :
 *   200 → { data: { items: SettingActiveSummary[] } }
 *   403 ROLE_NOT_ALLOWED
 *   500 QUERY_FAILED
 */

interface SettingsActiveRow {
  id: number
  key: string
  value: unknown
  valid_from: string
  valid_to: string | null
  updated_by: number | null
  notes: string | null
  created_at: string
}

const WHITELIST_SET: ReadonlySet<string> = new Set(SETTING_KEYS_WHITELIST)

export const adminSettingsListHandler: ApiHandler = async (req, res) => {
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

  const admin = supabaseAdmin()

  // 1) SELECT versions actives (valid_to IS NULL).
  const activeQuery = admin
    .from('settings')
    .select('id, key, value, valid_from, valid_to, updated_by, notes, created_at')
    .is('valid_to', null)
    .order('key', { ascending: true })

  const { data: activeRowsRaw, error: activeErr } = (await activeQuery) as unknown as {
    data: SettingsActiveRow[] | null
    error: { code?: string; message: string } | null
  }
  if (activeErr) {
    logger.error('admin.settings.list.active_query_failed', {
      requestId,
      message: activeErr.message,
    })
    sendError(res, 'SERVER_ERROR', 'Lecture impossible', requestId, { code: 'QUERY_FAILED' })
    return
  }
  // Filtre handler-side strict whitelist (D-1 — orphan keys ne fuient pas) +
  // tri ASC déterministe (le `.order('key')` côté DB est best-effort, on
  // ré-applique handler-side pour garantir l'ordre côté client).
  const activeRows = (activeRowsRaw ?? [])
    .filter((r) => WHITELIST_SET.has(r.key))
    .sort((a, b) => a.key.localeCompare(b.key))

  // 2) SELECT keys whitelisted (full history) pour comptage versions par clé.
  // Hardening W-7-4-5 : filtre `.in(SETTING_KEYS_WHITELIST)` côté DB pour
  // éliminer les orphan keys (seed manuel, migrations futures hors V1) et
  // réduire le payload réseau.
  const { data: countRowsRaw, error: countErr } = (await admin
    .from('settings')
    .select('key')
    .in('key', SETTING_KEYS_WHITELIST as unknown as string[])) as unknown as {
    data: Array<{ key: string }> | null
    error: { code?: string; message: string } | null
  }
  if (countErr) {
    logger.warn('admin.settings.list.count_query_failed', {
      requestId,
      message: countErr.message,
    })
  }
  const countByKey = new Map<string, number>()
  for (const r of countRowsRaw ?? []) {
    countByKey.set(r.key, (countByKey.get(r.key) ?? 0) + 1)
  }

  // 3) LEFT JOIN operators (PII-limited).
  const operatorIds = Array.from(
    new Set(activeRows.map((r) => r.updated_by).filter((v): v is number => typeof v === 'number'))
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
      logger.warn('admin.settings.list.operators_query_failed', {
        requestId,
        message: opErr.message,
      })
    } else {
      for (const r of opRows ?? []) {
        operatorsMap.set(r.id, r.email)
      }
    }
  }

  const items: SettingActiveSummary[] = activeRows.map((r) => ({
    id: r.id,
    key: r.key as SettingKey,
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
    versions_count: countByKey.get(r.key) ?? 0,
  }))

  res.status(200).json({ data: { items } })
}
