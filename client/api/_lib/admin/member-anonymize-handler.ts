import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { recordAudit } from '../audit/record'
import { parseTargetId } from './parse-target-id'
import type { ApiHandler } from '../types'

/**
 * Story 7-6 AC #3 + AC #4 — `POST /api/admin/members/:id/anonymize`
 * (op `admin-member-anonymize`).
 *
 * Décisions appliquées :
 *   D-3 : idempotence — RPC raises ALREADY_ANONYMIZED → 422.
 *   D-6 : member inexistant — RPC raises MEMBER_NOT_FOUND → 404.
 *   D-7 : recordAudit handler-side `entity_type='member'` (singulier),
 *         `action='anonymized'` ; best-effort try/catch ; jamais sur fail.
 *   D-8 : RBAC defense-in-depth — sav-operator → 403.
 *   D-9 : RPC PG `admin_anonymize_member(p_member_id, p_actor_operator_id)`
 *         atomique (UPDATE conditionnel + purges cross-tables D-11 +
 *         purge_audit_pii_for_member dans la même TX MVCC).
 *   D-11 : retour RPC inclut `tokens_deleted`, `drafts_deleted`,
 *          `email_pending_deleted`, `email_sent_anonymized` (purges
 *          magic_link_tokens / sav_drafts / email_outbox).
 *
 * Réponses :
 *   200 → { member_id, anonymized_at, hash8, audit_purge_count,
 *           tokens_deleted, drafts_deleted, email_pending_deleted,
 *           email_sent_anonymized }
 *   403 ROLE_NOT_ALLOWED
 *   404 MEMBER_NOT_FOUND
 *   422 ALREADY_ANONYMIZED { anonymized_at }
 *   500 RGPD_SALT_NOT_CONFIGURED | ANONYMIZE_FAILED
 */

interface AnonymizeRpcRow {
  member_id: number
  anonymized_at: string
  hash8: string
  audit_purge_count: number
  tokens_deleted: number
  drafts_deleted: number
  email_pending_deleted: number
  email_sent_anonymized: number
}

function parseAlreadyAnonymizedAt(message: string): string | null {
  // HARDEN-1 (F-1) — RPC raises 'ALREADY_ANONYMIZED <ts>' où <ts> est formaté
  // par la migration en ISO 8601 UTC (`YYYY-MM-DDTHH:MI:SSZ`) via to_char().
  // Greedy `(.+)$` capture full timestamp même si format change futur.
  // .trim() défensif pour les retours qui contiennent des trailing whitespaces.
  const m = /^ALREADY_ANONYMIZED\s+(.+)$/.exec(message.trim())
  return m?.[1]?.trim() ?? null
}

export const adminMemberAnonymizeHandler: ApiHandler = async (req, res) => {
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

  const memberId = parseTargetId(req)
  if (memberId === null) {
    sendError(res, 'VALIDATION_FAILED', 'Member ID invalide', requestId, {
      code: 'INVALID_MEMBER_ID',
    })
    return
  }

  const admin = supabaseAdmin()

  const { data, error } = (await admin.rpc('admin_anonymize_member', {
    p_member_id: memberId,
    p_actor_operator_id: user.sub,
  })) as unknown as {
    data: AnonymizeRpcRow[] | AnonymizeRpcRow | null
    error: { code?: string; message: string } | null
  }

  if (error) {
    const msg = error.message || ''
    const code = error.code || ''
    // HARDEN-3 (F-3) — env fault prioritaire (ops actionable).
    if (msg.includes('RGPD_SALT_NOT_CONFIGURED')) {
      logger.error('admin.anonymize.salt_not_configured', { requestId, memberId })
      sendError(res, 'SERVER_ERROR', 'RGPD salt non configuré', requestId, {
        code: 'RGPD_SALT_NOT_CONFIGURED',
      })
      return
    }
    // HARDEN-3 (F-3) — strict ^anchor pour les exceptions custom P0001.
    if (/^MEMBER_NOT_FOUND\b/.test(msg)) {
      sendError(res, 'NOT_FOUND', 'Member introuvable', requestId, {
        code: 'MEMBER_NOT_FOUND',
      })
      return
    }
    if (/^ALREADY_ANONYMIZED\b/.test(msg)) {
      const anonymizedAt = parseAlreadyAnonymizedAt(msg)
      const details: Record<string, unknown> = { code: 'ALREADY_ANONYMIZED' }
      if (anonymizedAt !== null) details['anonymized_at'] = anonymizedAt
      sendError(res, 'BUSINESS_RULE', 'Membre déjà anonymisé', requestId, details)
      return
    }
    // HARDEN-6 (F-6) — collision hash8 ('23505' unique_violation sur
    // members.email anon+<hash8>@fruitstock.invalid). V1 hash8 = 32 bits
    // (~50% birthday @ 77k members ; <0.001% à V1 <1k). Mapping explicite
    // pour ops UX. Cohérent D-10 doc « V2 hash16 ».
    if (code === '23505') {
      logger.error('admin.anonymize.hash8_collision', {
        requestId,
        memberId,
        message: msg,
      })
      sendError(res, 'SERVER_ERROR', 'Collision hash8 (rotate salt)', requestId, {
        code: 'HASH8_COLLISION',
        hint: 'rotate RGPD_ANONYMIZE_SALT or upgrade to hash16',
      })
      return
    }
    logger.error('admin.anonymize.rpc_failed', {
      requestId,
      memberId,
      code,
      message: msg,
    })
    sendError(res, 'SERVER_ERROR', 'Anonymisation échouée', requestId, {
      code: 'ANONYMIZE_FAILED',
    })
    return
  }

  // PostgREST `rpc` peut retourner soit une row directe (RETURNS jsonb /
  // composite scalar) soit un array (RETURNS TABLE / SETOF). On normalise.
  const row = Array.isArray(data) ? data[0] : data
  if (!row || typeof row !== 'object') {
    logger.error('admin.anonymize.rpc_empty', { requestId, memberId })
    sendError(res, 'SERVER_ERROR', 'Anonymisation échouée', requestId, {
      code: 'ANONYMIZE_FAILED',
    })
    return
  }

  // D-7 — recordAudit handler-side best-effort (entity_type='member' singulier,
  // action='anonymized'). Le trigger PG `trg_audit_members` produit en
  // parallèle une row `entity_type='members'` pluriel via l'UPDATE de la RPC.
  try {
    await recordAudit({
      entityType: 'member',
      entityId: memberId,
      action: 'anonymized',
      actorOperatorId: user.sub,
      diff: {
        before: { anonymized_at: null },
        after: {
          anonymized_at: row.anonymized_at,
          hash8: row.hash8,
          audit_purge_count: row.audit_purge_count,
          tokens_deleted: row.tokens_deleted,
          drafts_deleted: row.drafts_deleted,
          email_pending_deleted: row.email_pending_deleted,
          email_sent_anonymized: row.email_sent_anonymized,
        },
      },
      notes: 'Anonymisation RGPD admin via /admin/members/:id/anonymize',
    })
  } catch (e) {
    logger.warn('admin.anonymize.audit_failed', {
      requestId,
      memberId,
      message: e instanceof Error ? e.message : String(e),
    })
  }

  logger.info('admin.anonymize.success', {
    requestId,
    actorOperatorId: user.sub,
    memberId,
    hash8: row.hash8,
    auditPurgeCount: row.audit_purge_count,
    tokensDeleted: row.tokens_deleted,
    draftsDeleted: row.drafts_deleted,
    emailPendingDeleted: row.email_pending_deleted,
    emailSentAnonymized: row.email_sent_anonymized,
  })

  res.status(200).json({
    member_id: row.member_id,
    anonymized_at: row.anonymized_at,
    hash8: row.hash8,
    audit_purge_count: row.audit_purge_count,
    tokens_deleted: row.tokens_deleted,
    drafts_deleted: row.drafts_deleted,
    email_pending_deleted: row.email_pending_deleted,
    email_sent_anonymized: row.email_sent_anonymized,
  })
}
