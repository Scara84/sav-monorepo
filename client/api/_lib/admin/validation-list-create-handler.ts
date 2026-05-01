import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { recordAudit } from '../audit/record'
import {
  validationListCreateSchema,
  normalizeValueEs,
  type ValidationListEntryRow,
} from './validation-lists-schema'
import type { ApiHandler } from '../types'

/**
 * Story 7-3c AC #2 — `POST /api/admin/validation-lists` (op
 * `admin-validation-list-create`).
 *
 * Validation Zod (D-7) :
 *   - list_code : enum strict V1 = ['sav_cause', 'bon_type', 'unit']
 *   - value (FR) : trim non vide ≤ 100
 *   - value_es : optionnel ≤ 100 (nullable) — pas de value_en (D-6 retirée)
 *   - sort_order : int ≥ 0, défaut 100
 *   - is_active : boolean, défaut true
 *
 * Audit best-effort : si recordAudit() throw, l'INSERT a déjà réussi → on
 * log warn et on retourne 201 quand même (cohérent G-2 Story 7-3a/7-3b). Le
 * trigger PG `trg_audit_validation_lists` (migration ligne 269) écrit aussi
 * automatiquement sans actor_operator_id (D-4 double-écriture acceptée V1).
 *
 * Réponses :
 *   201 → { data: { entry: ValidationListEntryRow } }
 *   400 INVALID_BODY
 *   403 ROLE_NOT_ALLOWED
 *   409 VALUE_ALREADY_EXISTS
 *   500 PERSIST_FAILED
 */

export const adminValidationListCreateHandler: ApiHandler = async (req, res) => {
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
    sendError(res, 'VALIDATION_FAILED', 'Body JSON requis', requestId, {
      code: 'INVALID_BODY',
    })
    return
  }

  const parsed = validationListCreateSchema.safeParse(rawBody)
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

  const insertPayload: Record<string, unknown> = {
    list_code: body.list_code,
    value: body.value,
    sort_order: body.sort_order,
    is_active: body.is_active,
  }
  // value_es : ne setter que si présent dans le body (handler distingue
  // `null` explicite de `undefined`). Le test « pas de value_en (D-6
  // retirée) » assert que `value_en` n'apparaît jamais dans le payload.
  // Hardening W-7-3c-4 : normalise `""` (whitespace-only post-trim) → null
  // pour éviter casse fallback FR côté exports Rufino.
  const normalizedValueEs = normalizeValueEs(body.value_es)
  if (normalizedValueEs !== undefined) insertPayload['value_es'] = normalizedValueEs

  const admin = supabaseAdmin()
  const { data, error } = await admin
    .from('validation_lists')
    .insert(insertPayload)
    .select('id, list_code, value, value_es, sort_order, is_active')
    .single<ValidationListEntryRow>()

  if (error) {
    if (error.code === '23505') {
      logger.warn('admin.validation_lists.create.unique_violation', {
        requestId,
        constraint: (error as { constraint?: string }).constraint ?? null,
      })
      sendError(res, 'CONFLICT', 'Valeur déjà présente dans la liste', requestId, {
        code: 'VALUE_ALREADY_EXISTS',
      })
      return
    }
    logger.error('admin.validation_lists.create.persist_failed', {
      requestId,
      code: error.code,
      message: error.message,
    })
    sendError(res, 'SERVER_ERROR', 'Persistance échouée', requestId, {
      code: 'PERSIST_FAILED',
    })
    return
  }
  if (!data) {
    logger.error('admin.validation_lists.create.persist_empty', { requestId })
    sendError(res, 'SERVER_ERROR', 'Persistance échouée', requestId, {
      code: 'PERSIST_FAILED',
    })
    return
  }

  // D-4 : audit explicite avec actor_operator_id. Best-effort : l'INSERT a
  // réussi, on ne fail pas la requête si l'audit échoue (le trigger PG
  // `trg_audit_validation_lists` aura écrit sans actor — backup).
  try {
    await recordAudit({
      entityType: 'validation_list',
      entityId: data.id,
      action: 'created',
      actorOperatorId: user.sub,
      diff: {
        after: {
          list_code: data.list_code,
          value: data.value,
          value_es: data.value_es,
          sort_order: data.sort_order,
          is_active: data.is_active,
        },
      },
    })
  } catch (e) {
    logger.warn('admin.validation_lists.create.audit_failed', {
      requestId,
      entryId: data.id,
      message: e instanceof Error ? e.message : String(e),
    })
  }

  logger.info('admin.validation_lists.create.success', {
    requestId,
    actorOperatorId: user.sub,
    entryId: data.id,
    listCode: data.list_code,
    value: data.value,
  })

  res.status(201).json({ data: { entry: data } })
}
