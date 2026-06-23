import { z } from 'zod'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { withRateLimit } from '../middleware/with-rate-limit'
import type { ApiHandler, ApiRequest } from '../types'

/**
 * Story 5.5 AC #9 — `PATCH /api/admin/settings/threshold_alert`.
 *
 * Crée une nouvelle version de la clé settings `threshold_alert`. Le
 * trigger `trg_settings_close_previous` (migration 20260504120000)
 * ferme automatiquement la version précédente lors de l'INSERT, donc
 * un seul INSERT suffit (atomique, audité par `trg_audit_settings`).
 * Le partial UNIQUE INDEX `settings_one_active_per_key` (W37) garantit
 * structurellement zéro overlap : un PATCH concurrent lève 23505 →
 * remappé en 409 CONCURRENT_PATCH (cf. patch CR A5).
 *
 * Auth : router `pilotage.ts` applique `withAuth({ types: ['operator'] })`.
 * Le handler ajoute un check manuel `role === 'admin'` (AC #9.1) — un
 * sav-operator est rejeté en 403.
 *
 * Rate-limit : 10 PATCH / 15 minutes / opérateur (CR patch A1, cohérent
 * avec autres handlers admin sensibles du repo).
 *
 * GUC `app.actor_operator_id` (CR patch D4) : posé via set_config(true)
 * dans la même transaction que l'INSERT pour que le trigger
 * `trg_audit_settings` (audit_changes) capture l'acteur dans audit_trail.
 *
 * Réponses :
 *   200 : { id, key, value, valid_from, valid_to, updated_by, notes, created_at }
 *   400 : INVALID_BODY (Zod) | NOT_OBJECT
 *   403 : ROLE_NOT_ALLOWED (sav-operator essayant de modifier)
 *   409 : CONCURRENT_PATCH (race avec autre admin, W37 unique violation)
 *   429 : RATE_LIMITED
 *   500 : PERSIST_FAILED | GUC_SET_FAILED
 */

const SETTINGS_KEY = 'threshold_alert'

const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/

const bodySchema = z
  .object({
    count: z.number().int().min(1).max(100),
    days: z.number().int().min(1).max(365),
    dedup_hours: z.number().int().min(1).max(168),
    notes: z
      .string()
      .max(500)
      .optional()
      .transform((s) => (typeof s === 'string' ? s.trim() : s))
      .refine((s) => s === undefined || s.length === 0 || !CONTROL_CHARS_RE.test(s), {
        message: 'CONTROL_CHARS',
      }),
  })
  .strict()

export interface ThresholdSettingResponse {
  id: number
  key: string
  value: { count: number; days: number; dedup_hours: number }
  valid_from: string
  valid_to: string | null
  updated_by: number | null
  notes: string | null
  created_at: string
}

const adminSettingsThresholdPatchInner: ApiHandler = async (req, res) => {
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

  const rawBody = req.body
  if (
    rawBody === undefined ||
    rawBody === null ||
    typeof rawBody !== 'object' ||
    Array.isArray(rawBody)
  ) {
    sendError(res, 'VALIDATION_FAILED', 'Body JSON requis', requestId, { code: 'INVALID_BODY' })
    return
  }

  const parsed = bodySchema.safeParse(rawBody)
  if (!parsed.success) {
    sendError(res, 'VALIDATION_FAILED', 'Body invalide', requestId, {
      code: 'INVALID_BODY',
      issues: parsed.error.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      })),
    })
    return
  }
  const body = parsed.data
  const trimmedNotes = typeof body.notes === 'string' && body.notes.length > 0 ? body.notes : null

  const value = {
    count: body.count,
    days: body.days,
    dedup_hours: body.dedup_hours,
  }

  // CR patch D3 + D4 : INSERT via RPC dédiée qui (a) pose le GUC
  // app.actor_operator_id pour le trigger audit_changes, (b) laisse
  // valid_from au DEFAULT now() de la table (atomicité trigger close-
  // previous + pas de drift d'horloge Vercel ↔ Supabase). La RPC est
  // SECURITY DEFINER + REVOKE/GRANT service_role.
  const admin = supabaseAdmin()
  const { data, error } = await admin
    .rpc('update_settings_threshold_alert', {
      p_value: value,
      p_notes: trimmedNotes ?? '',
      p_actor_operator_id: user.sub,
    })
    .single<ThresholdSettingResponse>()
  if (error) {
    // CR patch A5 : 23505 (W37 partial UNIQUE INDEX violation) → 409 explicite
    // au lieu d'un 500 générique trompeur. Race rare entre 2 PATCH admin.
    if (error.code === '23505') {
      logger.warn('admin.settings.threshold.concurrent_patch', {
        requestId,
        message: error.message,
      })
      sendError(res, 'CONFLICT', 'Une mise à jour concurrente est en cours', requestId, {
        code: 'CONCURRENT_PATCH',
      })
      return
    }
    logger.error('admin.settings.threshold.persist_failed', {
      requestId,
      code: error.code,
      message: error.message,
    })
    sendError(res, 'SERVER_ERROR', 'Persistance settings échouée', requestId, {
      code: 'PERSIST_FAILED',
    })
    return
  }
  if (!data) {
    logger.error('admin.settings.threshold.persist_empty', { requestId })
    sendError(res, 'SERVER_ERROR', 'Persistance settings échouée', requestId, {
      code: 'PERSIST_FAILED',
    })
    return
  }

  logger.info('admin.settings.threshold.updated', {
    requestId,
    actorOperatorId: user.sub,
    settingsId: data.id,
    value,
  })

  res.status(200).json({ data })
}

function rateLimitKey(req: ApiRequest): string | undefined {
  const sub = req.user?.sub
  if (typeof sub === 'number') return `op:${sub}`
  return undefined
}

export const adminSettingsThresholdPatchHandler: ApiHandler = withRateLimit({
  bucketPrefix: 'admin:settings:threshold:patch',
  keyFrom: rateLimitKey,
  max: 10,
  window: '15m',
})(adminSettingsThresholdPatchInner)

export const __testables = {
  bodySchema,
  SETTINGS_KEY,
  adminSettingsThresholdPatchInner,
  rateLimitKey,
}
