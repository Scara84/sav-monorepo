import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { recordAudit } from '../audit/record'
import { operatorUpdateSchema, type OperatorRow } from './operators-schema'
import { parseTargetId } from './parse-target-id'
import type { ApiHandler } from '../types'

/**
 * Story 7-3a AC #3 — `PATCH /api/admin/operators/:id` (op `admin-operator-update`).
 *
 * Garde-fous :
 *   - 422 CANNOT_DEACTIVATE_SELF si target.id === user.sub && is_active=false
 *   - 422 CANNOT_DEMOTE_SELF si target.id === user.sub && role !== 'admin'
 *   - 422 LAST_ADMIN_PROTECTION si on désactive ou rétrograde le dernier
 *     admin actif (count `WHERE role='admin' AND is_active=true` doit
 *     rester ≥ 1 après UPDATE — D-1ter race acceptée V1).
 *   - D-1 : soft-delete via is_active=false (pas DELETE physique).
 *
 * Audit : recordAudit() avec entity='operator', diff={before, after}
 *   (uniquement champs modifiés). action ∈
 *   {'deactivated','reactivated','role_changed','updated'}.
 *
 * Réponses :
 *   200 → { data: { operator } }
 *   400 INVALID_BODY | INVALID_PARAMS
 *   403 ROLE_NOT_ALLOWED
 *   404 NOT_FOUND
 *   422 CANNOT_DEACTIVATE_SELF | CANNOT_DEMOTE_SELF | LAST_ADMIN_PROTECTION
 *   500 PERSIST_FAILED
 */

interface SupabaseAdminLike {
  from: (table: string) => unknown
}

async function fetchOperator(
  admin: SupabaseAdminLike,
  id: number
): Promise<{ row: OperatorRow | null; error: { message: string } | null }> {
  const builder = admin.from('operators') as {
    select: (cols: string) => {
      eq: (
        col: string,
        val: unknown
      ) => {
        single: () => Promise<{ data: OperatorRow | null; error: { message: string } | null }>
      }
    }
  }
  const { data, error } = await builder
    .select('id, email, display_name, role, is_active, azure_oid, created_at')
    .eq('id', id)
    .single()
  return { row: data, error }
}

async function countActiveAdmins(admin: SupabaseAdminLike): Promise<number> {
  const builder = admin.from('operators') as {
    select: (cols: string, opts: { count: string; head: boolean }) => unknown
  }
  // Chained: .select('*', {count:'exact', head:true}).eq('role','admin').eq('is_active', true)
  const q1 = builder.select('*', { count: 'exact', head: true }) as {
    eq: (col: string, val: unknown) => unknown
  }
  const q2 = q1.eq('role', 'admin') as {
    eq: (col: string, val: unknown) => Promise<{ count: number | null; error: unknown }>
  }
  const result = await q2.eq('is_active', true)
  return typeof result.count === 'number' ? result.count : 0
}

export const adminOperatorUpdateHandler: ApiHandler = async (req, res) => {
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
    sendError(res, 'VALIDATION_FAILED', 'ID opérateur manquant', requestId, {
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

  const parsed = operatorUpdateSchema.safeParse(rawBody)
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

  // 1) Récupérer l'état AVANT pour (a) garde-fous, (b) audit diff.
  const { row: before } = await fetchOperator(admin, targetId)
  if (!before) {
    sendError(res, 'NOT_FOUND', 'Opérateur introuvable', requestId, {
      code: 'OPERATOR_NOT_FOUND',
    })
    return
  }

  // 2) Garde-fous self.
  if (before.id === user.sub) {
    if (patch.is_active === false) {
      sendError(res, 'BUSINESS_RULE', 'Action interdite sur soi-même', requestId, {
        code: 'CANNOT_DEACTIVATE_SELF',
      })
      return
    }
    if (patch.role !== undefined && patch.role !== before.role && patch.role !== 'admin') {
      sendError(res, 'BUSINESS_RULE', 'Action interdite sur soi-même', requestId, {
        code: 'CANNOT_DEMOTE_SELF',
      })
      return
    }
  }

  // 3) Garde-fou last-admin (D-1ter — race acceptée V1).
  // Déclenché si la cible EST un admin actif ET le patch la désactive
  // ou la rétrograde, ET le count d'admins actifs <= 1.
  const isTargetActiveAdmin = before.role === 'admin' && before.is_active === true
  const willDeactivate = patch.is_active === false
  const willDemote = patch.role !== undefined && patch.role !== 'admin'
  if (isTargetActiveAdmin && (willDeactivate || willDemote)) {
    const count = await countActiveAdmins(admin)
    if (count <= 1) {
      sendError(res, 'BUSINESS_RULE', 'Au moins un admin actif requis', requestId, {
        code: 'LAST_ADMIN_PROTECTION',
      })
      return
    }
  }

  // 4) UPDATE.
  const updatePayload: Record<string, unknown> = {}
  if (patch.display_name !== undefined) updatePayload['display_name'] = patch.display_name
  if (patch.role !== undefined) updatePayload['role'] = patch.role
  if (patch.is_active !== undefined) updatePayload['is_active'] = patch.is_active
  if (patch.azure_oid !== undefined) updatePayload['azure_oid'] = patch.azure_oid

  const updateBuilder = admin.from('operators') as {
    update: (payload: unknown) => {
      eq: (
        col: string,
        val: unknown
      ) => {
        select: (cols: string) => {
          single: () => Promise<{
            data: OperatorRow | null
            error: { code?: string; message: string } | null
          }>
        }
      }
    }
  }
  const { data: after, error: updateError } = await updateBuilder
    .update(updatePayload)
    .eq('id', targetId)
    .select('id, email, display_name, role, is_active, azure_oid, created_at')
    .single()

  if (updateError) {
    logger.error('admin.operators.update.persist_failed', {
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
    logger.error('admin.operators.update.persist_empty', { requestId })
    sendError(res, 'SERVER_ERROR', 'Mise à jour impossible', requestId, {
      code: 'PERSIST_FAILED',
    })
    return
  }

  // 5) Audit — action dérivée du patch (priorité role_changed > deactivated/reactivated > updated).
  const action = (() => {
    if (patch.role !== undefined && patch.role !== before.role) return 'role_changed'
    if (patch.is_active === false && before.is_active === true) return 'deactivated'
    if (patch.is_active === true && before.is_active === false) return 'reactivated'
    return 'updated'
  })()

  const diffBefore: Record<string, unknown> = {}
  const diffAfter: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    diffBefore[k] = (before as unknown as Record<string, unknown>)[k]
    diffAfter[k] = v
  }

  try {
    await recordAudit({
      entityType: 'operator',
      entityId: after.id,
      action,
      actorOperatorId: user.sub,
      diff: { before: diffBefore, after: diffAfter },
    })
  } catch (e) {
    logger.warn('admin.operators.update.audit_failed', {
      requestId,
      operatorId: after.id,
      message: e instanceof Error ? e.message : String(e),
    })
  }

  logger.info('admin.operators.update.success', {
    requestId,
    actorOperatorId: user.sub,
    operatorId: after.id,
    action,
  })

  res.status(200).json({ data: { operator: after } })
}
