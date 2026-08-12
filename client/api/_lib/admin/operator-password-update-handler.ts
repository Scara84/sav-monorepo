import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { hashPassword } from '../auth/password'
import { withRateLimit } from '../middleware/with-rate-limit'
import { operatorPasswordUpdateSchema } from './operators-schema'
import { parseTargetId } from './parse-target-id'
import type { ApiHandler } from '../types'

interface PasswordUpdateRpcRow {
  password_updated_at: string
}

interface PasswordUpdateRpcClient {
  rpc: (
    fn: string,
    args: Record<string, unknown>
  ) => Promise<{
    data: PasswordUpdateRpcRow[] | PasswordUpdateRpcRow | null
    error: { code?: string; message: string } | null
  }>
}

const persistPassword: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  const user = req.user!
  const targetId = parseTargetId(req)!
  const parsed = operatorPasswordUpdateSchema.safeParse(req.body)
  if (!parsed.success) {
    sendError(res, 'VALIDATION_FAILED', 'Body invalide', requestId, {
      code: 'INVALID_BODY',
      issues: parsed.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      })),
    })
    return
  }

  let passwordHash: string
  try {
    passwordHash = await hashPassword(parsed.data.password)
  } catch {
    logger.error('admin.operators.password.hash_failed', {
      requestId,
      actorOperatorId: user.sub,
      operatorId: targetId,
    })
    sendError(res, 'SERVER_ERROR', 'Mise à jour impossible', requestId, {
      code: 'PERSIST_FAILED',
    })
    return
  }

  let rpcResult: Awaited<ReturnType<PasswordUpdateRpcClient['rpc']>>
  try {
    rpcResult = await (supabaseAdmin() as unknown as PasswordUpdateRpcClient).rpc(
      'admin_set_operator_password',
      {
        p_actor_operator_id: user.sub,
        p_target_operator_id: targetId,
        p_password_hash: passwordHash,
      }
    )
  } catch {
    logger.error('admin.operators.password.rpc_failed', {
      requestId,
      actorOperatorId: user.sub,
      operatorId: targetId,
    })
    sendError(res, 'SERVER_ERROR', 'Mise à jour impossible', requestId, {
      code: 'PERSIST_FAILED',
    })
    return
  }

  if (rpcResult.error) {
    if (rpcResult.error.code === 'P0002') {
      sendError(res, 'NOT_FOUND', 'Opérateur introuvable', requestId, {
        code: 'OPERATOR_NOT_FOUND',
      })
      return
    }
    if (rpcResult.error.code === '42501') {
      sendError(res, 'FORBIDDEN', 'Rôle admin requis', requestId, {
        code: 'ROLE_NOT_ALLOWED',
      })
      return
    }
    logger.error('admin.operators.password.rpc_failed', {
      requestId,
      actorOperatorId: user.sub,
      operatorId: targetId,
      code: rpcResult.error.code,
    })
    sendError(res, 'SERVER_ERROR', 'Mise à jour impossible', requestId, {
      code: 'PERSIST_FAILED',
    })
    return
  }

  const updated = Array.isArray(rpcResult.data) ? rpcResult.data[0] : rpcResult.data
  if (!updated) {
    logger.error('admin.operators.password.rpc_empty', {
      requestId,
      actorOperatorId: user.sub,
      operatorId: targetId,
    })
    sendError(res, 'SERVER_ERROR', 'Mise à jour impossible', requestId, {
      code: 'PERSIST_FAILED',
    })
    return
  }

  logger.info('admin.operators.password.success', {
    requestId,
    actorOperatorId: user.sub,
    operatorId: targetId,
  })
  res.status(200).json({ data: { passwordUpdatedAt: updated.password_updated_at } })
}

const rateLimitedPersistPassword = withRateLimit({
  bucketPrefix: 'admin:operator-password',
  keyFrom: (req) => (req.user?.type === 'operator' ? String(req.user.sub) : undefined),
  max: 10,
  window: '1m',
})(persistPassword)

export const adminOperatorPasswordUpdateHandler: ApiHandler = async (req, res) => {
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
  if (targetId === user.sub) {
    sendError(res, 'BUSINESS_RULE', 'Action interdite sur soi-même', requestId, {
      code: 'CANNOT_UPDATE_OWN_PASSWORD',
    })
    return
  }

  return rateLimitedPersistPassword(req, res)
}
