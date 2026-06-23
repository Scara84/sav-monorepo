import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { recordAudit } from '../audit/record'
import { operatorCreateSchema, type OperatorRow } from './operators-schema'
import type { ApiHandler } from '../types'

/**
 * Story 7-3a AC #2 — `POST /api/admin/operators` (op `admin-operator-create`).
 *
 * Validation Zod ; INSERT ; remap unicité 23505 → 409 EMAIL_ALREADY_EXISTS
 * ou AZURE_OID_ALREADY_EXISTS via `error.constraint` (pattern Story 5.5).
 *
 * Audit : recordAudit() avec entity='operator', action='created',
 *   actor_operator_id = user.sub, diff={after}. Le trigger PG
 *   `trg_audit_operators` écrit aussi automatiquement (sans actor) — D-4
 *   double-écriture acceptée V1.
 *
 * Réponses :
 *   201 → { data: { operator: OperatorRow } }
 *   400 INVALID_BODY
 *   403 ROLE_NOT_ALLOWED
 *   409 EMAIL_ALREADY_EXISTS | AZURE_OID_ALREADY_EXISTS
 *   500 PERSIST_FAILED
 */

const EMAIL_CONSTRAINT_PATTERNS = [/operators_email/i]
const AZURE_OID_CONSTRAINT_PATTERNS = [/operators_azure_oid/i]

function classifyUniqueViolation(constraint: string | undefined): {
  code: 'EMAIL_ALREADY_EXISTS' | 'AZURE_OID_ALREADY_EXISTS' | null
} {
  if (typeof constraint !== 'string' || constraint.length === 0) {
    return { code: null }
  }
  for (const re of EMAIL_CONSTRAINT_PATTERNS) {
    if (re.test(constraint)) return { code: 'EMAIL_ALREADY_EXISTS' }
  }
  for (const re of AZURE_OID_CONSTRAINT_PATTERNS) {
    if (re.test(constraint)) return { code: 'AZURE_OID_ALREADY_EXISTS' }
  }
  return { code: null }
}

export const adminOperatorCreateHandler: ApiHandler = async (req, res) => {
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

  const parsed = operatorCreateSchema.safeParse(rawBody)
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
    email: body.email,
    display_name: body.display_name,
    role: body.role,
    is_active: true,
  }
  if (body.azure_oid !== undefined) {
    insertPayload['azure_oid'] = body.azure_oid
  }

  const admin = supabaseAdmin()
  const { data, error } = await admin
    .from('operators')
    .insert(insertPayload)
    .select('id, email, display_name, role, is_active, azure_oid, created_at')
    .single<OperatorRow>()

  if (error) {
    if (error.code === '23505') {
      const constraint = (error as { constraint?: string }).constraint
      const cls = classifyUniqueViolation(constraint)
      if (cls.code !== null) {
        logger.warn('admin.operators.create.unique_violation', {
          requestId,
          code: cls.code,
          constraint: constraint ?? null,
        })
        sendError(res, 'CONFLICT', 'Conflit unicité', requestId, { code: cls.code })
        return
      }
    }
    logger.error('admin.operators.create.persist_failed', {
      requestId,
      code: error.code,
      message: error.message,
    })
    sendError(res, 'SERVER_ERROR', 'Persistance opérateur échouée', requestId, {
      code: 'PERSIST_FAILED',
    })
    return
  }
  if (!data) {
    logger.error('admin.operators.create.persist_empty', { requestId })
    sendError(res, 'SERVER_ERROR', 'Persistance opérateur échouée', requestId, {
      code: 'PERSIST_FAILED',
    })
    return
  }

  // D-4 : audit explicite avec actor_operator_id (le trigger PG ne peut pas
  // capturer l'acteur via GUC pooler). On accepte la double-écriture V1.
  try {
    await recordAudit({
      entityType: 'operator',
      entityId: data.id,
      action: 'created',
      actorOperatorId: user.sub,
      diff: {
        after: {
          email: data.email,
          display_name: data.display_name,
          role: data.role,
          is_active: data.is_active,
          azure_oid: data.azure_oid,
        },
      },
    })
  } catch (e) {
    // L'INSERT a réussi, on log mais on ne fail pas la requête (l'opérateur
    // est créé ; le trigger PG a aussi écrit sans actor). Cohérent
    // pattern best-effort utilisé sur audit_trail.
    logger.warn('admin.operators.create.audit_failed', {
      requestId,
      operatorId: data.id,
      message: e instanceof Error ? e.message : String(e),
    })
  }

  logger.info('admin.operators.create.success', {
    requestId,
    actorOperatorId: user.sub,
    operatorId: data.id,
    role: data.role,
  })

  res.status(201).json({ data: { operator: data } })
}
