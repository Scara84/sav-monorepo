import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { recordAudit } from '../audit/record'
import {
  validationListUpdateSchema,
  normalizeValueEs,
  type ValidationListEntryRow,
} from './validation-lists-schema'
import { parseTargetId } from './parse-target-id'
import type { ApiHandler } from '../types'

/**
 * Story 7-3c AC #3 — `PATCH /api/admin/validation-lists/:id` (op
 * `admin-validation-list-update`).
 *
 * Garde-fous (D-8) :
 *   - 422 VALUE_IMMUTABLE si body inclut `value` (immutable — `value` est
 *     un text non-FK référencé text-based dans `sav.metadata.cause`,
 *     exports etc. ; muter `value` casserait l'historique).
 *   - 422 LIST_CODE_IMMUTABLE si body inclut `list_code` (idem).
 *   - On check AVANT le Zod parse (cohérent product-update CODE_IMMUTABLE) :
 *     les tests vérifient qu'aucune validation Zod ne masque le 422.
 *   - Zod partial : value_es, sort_order, is_active autorisés. `.strict()`
 *     rejette tout autre champ inconnu.
 *
 * Soft-delete (D-8) : pas de DELETE physique exposé. La désactivation
 * passe par PATCH `{ is_active: false }`. Pas de route DELETE → le router
 * pilotage.ts ne dispatche pas DELETE pour validation-lists (cohérent
 * `ADMIN_ONLY_OPS` Set qui n'a pas d'op `admin-validation-list-delete`).
 *
 * Audit : `action='updated'` cohérent product-update (ATDD Decision #4 :
 * D-8 traite `is_active` comme un champ standard, pas une action séparée
 * `deactivated`/`reactivated` comme operators).
 *
 * Réponses :
 *   200 → { data: { entry: ValidationListEntryRow } }
 *   400 INVALID_BODY | INVALID_PARAMS
 *   403 ROLE_NOT_ALLOWED
 *   404 NOT_FOUND
 *   422 VALUE_IMMUTABLE | LIST_CODE_IMMUTABLE
 *   500 PERSIST_FAILED
 */

interface SupabaseAdminLike {
  from: (table: string) => unknown
}

async function fetchEntry(
  admin: SupabaseAdminLike,
  id: number
): Promise<{ row: ValidationListEntryRow | null }> {
  const builder = admin.from('validation_lists') as {
    select: (cols: string) => {
      eq: (
        col: string,
        val: unknown
      ) => {
        single: () => Promise<{
          data: ValidationListEntryRow | null
          error: unknown
        }>
      }
    }
  }
  const { data } = await builder
    .select('id, list_code, value, value_es, sort_order, is_active')
    .eq('id', id)
    .single()
  return { row: data }
}

export const adminValidationListUpdateHandler: ApiHandler = async (req, res) => {
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

  const targetId = parseTargetId(req)
  if (targetId === null) {
    sendError(res, 'VALIDATION_FAILED', 'ID entrée manquant', requestId, {
      code: 'INVALID_PARAMS',
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

  // D-8 garde-fous immutables — check explicite AVANT Zod parse (les tests
  // exigent un 422 dédié et qu'aucun UPDATE ne soit envoyé à Supabase).
  const bodyAsRecord = rawBody as Record<string, unknown>
  if ('value' in bodyAsRecord) {
    sendError(res, 'BUSINESS_RULE', "Le champ 'value' est immutable", requestId, {
      code: 'VALUE_IMMUTABLE',
    })
    return
  }
  if ('list_code' in bodyAsRecord) {
    sendError(res, 'BUSINESS_RULE', "Le champ 'list_code' est immutable", requestId, {
      code: 'LIST_CODE_IMMUTABLE',
    })
    return
  }

  const parsed = validationListUpdateSchema.safeParse(rawBody)
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
  const patch = parsed.data

  const admin = supabaseAdmin() as SupabaseAdminLike

  const { row: before } = await fetchEntry(admin, targetId)
  if (!before) {
    sendError(res, 'NOT_FOUND', 'Entrée introuvable', requestId, {
      code: 'ENTRY_NOT_FOUND',
    })
    return
  }

  const updatePayload: Record<string, unknown> = {}
  // Hardening W-7-3c-4 : normalise `value_es=""` → null avant UPDATE.
  if (patch.value_es !== undefined) {
    const normalized = normalizeValueEs(patch.value_es)
    updatePayload['value_es'] = normalized === undefined ? null : normalized
  }
  if (patch.sort_order !== undefined) updatePayload['sort_order'] = patch.sort_order
  if (patch.is_active !== undefined) updatePayload['is_active'] = patch.is_active

  // Hardening W-7-3c-3 : court-circuit no-op. Si tous les champs du payload
  // sont déjà égaux à `before`, on ne fait pas d'UPDATE et pas d'audit row
  // (évite pollution audit_trail sur double-clic ou retry idempotent).
  const beforeRecord = before as unknown as Record<string, unknown>
  const isNoOp =
    Object.keys(updatePayload).length > 0 &&
    Object.entries(updatePayload).every(([k, v]) => beforeRecord[k] === v)
  if (isNoOp) {
    logger.info('admin.validation_lists.update.noop', {
      requestId,
      entryId: targetId,
    })
    res.status(200).json({ data: { entry: before } })
    return
  }

  const updateBuilder = admin.from('validation_lists') as {
    update: (payload: unknown) => {
      eq: (
        col: string,
        val: unknown
      ) => {
        select: (cols: string) => {
          single: () => Promise<{
            data: ValidationListEntryRow | null
            error: { code?: string; message: string } | null
          }>
        }
      }
    }
  }
  const { data: after, error: updateError } = await updateBuilder
    .update(updatePayload)
    .eq('id', targetId)
    .select('id, list_code, value, value_es, sort_order, is_active')
    .single()

  if (updateError) {
    logger.error('admin.validation_lists.update.persist_failed', {
      requestId,
      code: updateError.code,
      message: updateError.message,
    })
    sendError(res, 'SERVER_ERROR', 'Mise à jour impossible', requestId, {
      code: 'PERSIST_FAILED',
    })
    return
  }
  if (!after) {
    logger.error('admin.validation_lists.update.persist_empty', { requestId })
    sendError(res, 'SERVER_ERROR', 'Mise à jour impossible', requestId, {
      code: 'PERSIST_FAILED',
    })
    return
  }

  // Diff filtré aux champs réellement présents dans le patch — cohérent
  // product-update-handler. `value` et `list_code` sont déjà rejetés en
  // amont (D-8) donc absents du patch.
  const diffBefore: Record<string, unknown> = {}
  const diffAfter: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    diffBefore[k] = (before as unknown as Record<string, unknown>)[k]
    diffAfter[k] = v
  }

  // ATDD Decision #4 : action='updated' cohérent product-update — D-8 traite
  // is_active comme un champ standard, pas une action séparée
  // `deactivated`/`reactivated` (cf. operators).
  try {
    await recordAudit({
      entityType: 'validation_list',
      entityId: after.id,
      action: 'updated',
      actorOperatorId: user.sub,
      diff: { before: diffBefore, after: diffAfter },
    })
  } catch (e) {
    logger.warn('admin.validation_lists.update.audit_failed', {
      requestId,
      entryId: after.id,
      message: e instanceof Error ? e.message : String(e),
    })
  }

  logger.info('admin.validation_lists.update.success', {
    requestId,
    actorOperatorId: user.sub,
    entryId: after.id,
  })

  res.status(200).json({ data: { entry: after } })
}
