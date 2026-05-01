import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { recordAudit } from '../audit/record'
import { parseTargetId } from './parse-target-id'
import { isErpQueueTableProvisioned } from './erp-queue-list-handler'
import type { ApiHandler } from '../types'

/**
 * Story 7-5 AC #5 D-8 + D-9 — `POST /api/admin/erp-queue/:id/retry`
 * (op `admin-erp-push-retry`).
 *
 * Décisions :
 *   D-8 — UPDATE atomique conditionnel `WHERE id=$1 AND status='failed'`
 *         RETURNING. Reset 4 colonnes opérationnelles (attempts=0,
 *         status='pending', next_retry_at=NULL, last_error=NULL). 0 row
 *         affecté → 422 RETRY_NOT_APPLICABLE avec hint current_status
 *         (SELECT post-fail). Iso-fact preservation : payload, signature,
 *         idempotency_key, created_at NON mutés.
 *   D-9 — recordAudit(entity_type='erp_push', action='retry_manual') best-
 *         effort try/catch (cohérent 7-3a/b/c/4 D-7).
 *   D-10 — feature-flag : si table erp_push_queue absente → 503.
 *
 * Réponses :
 *   200 → { data: { id, status:'pending', attempts:0, retried_at, retried_by } }
 *   403 ROLE_NOT_ALLOWED
 *   422 INVALID_TARGET_ID | RETRY_NOT_APPLICABLE
 *   503 ERP_QUEUE_NOT_PROVISIONED
 *   500 INTERNAL_ERROR
 */

interface UpdateReturnRow {
  id: number
  status: string
  attempts: number
}

export const adminErpPushRetryHandler: ApiHandler = async (req, res) => {
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

  const pushId = parseTargetId(req)
  if (pushId === null) {
    sendError(res, 'BUSINESS_RULE', 'ID push invalide', requestId, {
      code: 'INVALID_TARGET_ID',
    })
    return
  }

  // D-10 feature-flag.
  const provisioned = await isErpQueueTableProvisioned()
  if (!provisioned) {
    sendError(
      res,
      'DEPENDENCY_DOWN',
      "La file ERP n'est pas encore provisionnée — Story 7-1 en attente du contrat ERP Fruitstock",
      requestId,
      { code: 'ERP_QUEUE_NOT_PROVISIONED' }
    )
    return
  }

  const admin = supabaseAdmin()
  const nowIso = new Date().toISOString()

  // D-9 hardening (CR-7-5 SHOULD-FIX F-4) — pré-lecture best-effort de
  // `attempts` AVANT l'UPDATE atomique, pour enrichir le diff audit
  // `before.attempts: N`. La race « attempts incrémenté par cron entre
  // pré-lecture et UPDATE » est tolérée : la valeur reste indicative
  // (l'audit est une trace métier non comptable). Si la lecture échoue
  // ou la ligne n'existe pas, on tombe sur `null` (omis du diff).
  let beforeAttempts: number | null = null
  try {
    const { data: pre } = (await admin
      .from('erp_push_queue')
      .select('attempts')
      .eq('id', pushId)
      .maybeSingle()) as unknown as {
      data: { attempts: number } | null
    }
    if (pre !== null && typeof pre.attempts === 'number') {
      beforeAttempts = pre.attempts
    }
  } catch (e) {
    logger.warn('admin.erp_push.retry.pre_read_attempts_failed', {
      requestId,
      pushId,
      message: e instanceof Error ? e.message : String(e),
    })
  }

  // D-8 — UPDATE atomique conditionnel.
  const { data, error } = (await (
    admin.from('erp_push_queue').update({
      attempts: 0,
      status: 'pending',
      next_retry_at: null,
      last_error: null,
      updated_at: nowIso,
    }) as unknown as {
      eq: (
        c: string,
        v: unknown
      ) => {
        eq: (
          c: string,
          v: unknown
        ) => {
          select: (cols?: string) => {
            maybeSingle: () => Promise<{
              data: UpdateReturnRow | null
              error: { code?: string; message: string } | null
            }>
          }
        }
      }
    }
  )
    .eq('id', pushId)
    .eq('status', 'failed')
    .select('id, status, attempts')
    .maybeSingle()) as {
    data: UpdateReturnRow | null
    error: { code?: string; message: string } | null
  }

  if (error) {
    logger.error('admin.erp_push.retry.update_failed', {
      requestId,
      pushId,
      message: error.message,
    })
    sendError(res, 'SERVER_ERROR', 'Retry échoué', requestId, {
      code: 'INTERNAL_ERROR',
    })
    return
  }

  if (!data) {
    // 0 row affecté → soit n'existe pas, soit status ≠ 'failed'.
    // SELECT post-fail pour hint current_status.
    let currentStatus: string = 'not_found'
    try {
      const { data: existing } = (await admin
        .from('erp_push_queue')
        .select('status')
        .eq('id', pushId)
        .maybeSingle()) as unknown as {
        data: { status: string } | null
      }
      if (existing !== null && typeof existing.status === 'string') {
        currentStatus = existing.status
      }
    } catch (e) {
      logger.warn('admin.erp_push.retry.post_fail_select_threw', {
        requestId,
        pushId,
        message: e instanceof Error ? e.message : String(e),
      })
    }

    sendError(res, 'BUSINESS_RULE', 'Retry non applicable', requestId, {
      code: 'RETRY_NOT_APPLICABLE',
      current_status: currentStatus,
    })
    return
  }

  // D-9 — recordAudit best-effort try/catch.
  try {
    await recordAudit({
      entityType: 'erp_push',
      entityId: pushId,
      action: 'retry_manual',
      actorOperatorId: user.sub,
      diff: {
        before:
          beforeAttempts !== null
            ? { status: 'failed', attempts: beforeAttempts }
            : { status: 'failed' },
        after: { status: 'pending', attempts: 0 },
      },
      notes: 'Retry manuel admin via /admin/erp-queue',
    })
  } catch (e) {
    logger.warn('admin.erp_push.retry.audit_failed', {
      requestId,
      pushId,
      message: e instanceof Error ? e.message : String(e),
    })
  }

  logger.info('admin.erp_push.retry.success', {
    requestId,
    actorOperatorId: user.sub,
    pushId,
  })

  res.status(200).json({
    data: {
      id: data.id,
      status: data.status,
      attempts: data.attempts,
      retried_at: nowIso,
      retried_by: user.sub,
    },
  })
}
