import { z } from 'zod'
import { withRateLimit } from '../middleware/with-rate-limit'
import { withValidation } from '../middleware/with-validation'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { SAV_STATUSES, getAllowedTransitions, type SavStatus } from '../business/sav-status-machine'
import type { ApiHandler, ApiRequest, ApiResponse } from '../types'

/**
 * Story 3.5 — handlers `PATCH /api/sav/:id/status` et `PATCH /api/sav/:id/assign`.
 *
 * Les deux passent par une RPC atomique (verrou optimiste CAS sur `version`).
 * Erreurs PG → HTTP mapping :
 *   NOT_FOUND           → 404
 *   VERSION_CONFLICT    → 409 CONFLICT
 *   INVALID_TRANSITION  → 422 BUSINESS_RULE
 *   LINES_BLOCKED       → 422 BUSINESS_RULE
 *   ASSIGNEE_NOT_FOUND  → 404
 */

// ---- Schemas ----

export const statusBodySchema = z.object({
  status: z.enum(['draft', 'received', 'in_progress', 'validated', 'closed', 'cancelled']),
  version: z.number().int().nonnegative(),
  note: z.string().max(500).optional(),
})

export const assignBodySchema = z.object({
  assigneeOperatorId: z.number().int().positive().nullable(),
  version: z.number().int().nonnegative(),
})

// ---- Helpers erreur PG → HTTP ----

interface PgRpcError {
  code?: string
  message?: string
  details?: string
}

function parseExceptionMessage(msg: string): { code: string; payload: Record<string, string> } {
  const [code, ...rest] = msg.split('|')
  const payload: Record<string, string> = {}
  for (const part of rest) {
    const eq = part.indexOf('=')
    if (eq > 0) payload[part.slice(0, eq)] = part.slice(eq + 1)
  }
  return { code: code ?? 'UNKNOWN', payload }
}

// ---- Status handler ----

function statusCore(savId: number): ApiHandler {
  return async (req: ApiRequest, res: ApiResponse) => {
    const requestId = ensureRequestId(req)
    const startedAt = Date.now()
    const user = req.user
    if (!user || user.type !== 'operator') {
      sendError(res, 'FORBIDDEN', 'Session opérateur requise', requestId)
      return
    }
    const body = req.body as z.infer<typeof statusBodySchema>

    try {
      const admin = supabaseAdmin()
      const { data, error } = await admin.rpc('transition_sav_status', {
        p_sav_id: savId,
        p_new_status: body.status,
        p_expected_version: body.version,
        p_actor_operator_id: user.sub,
        p_note: body.note ?? null,
      })

      if (error) {
        return mapRpcError(res, requestId, error as PgRpcError, body.status, savId, body.version)
      }

      const row = Array.isArray(data) ? data[0] : data
      if (!row) {
        sendError(res, 'SERVER_ERROR', 'RPC sans retour', requestId)
        return
      }

      const durationMs = Date.now() - startedAt
      logger.info('sav.status.transition', {
        requestId,
        savId,
        from: row.previous_status,
        to: row.new_status,
        version: body.version,
        newVersion: row.new_version,
        actorOperatorId: user.sub,
        durationMs,
        emailOutboxId: row.email_outbox_id,
      })

      res.status(200).json({
        data: {
          savId: row.sav_id,
          status: row.new_status,
          version: row.new_version,
          assignedTo: row.assigned_to,
          previousStatus: row.previous_status,
          emailOutboxId: row.email_outbox_id,
        },
      })
    } catch (err) {
      logger.error('sav.status.exception', {
        requestId,
        savId,
        error: err instanceof Error ? err.message : String(err),
      })
      sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId)
    }
  }
}

function mapRpcError(
  res: ApiResponse,
  requestId: string,
  err: PgRpcError,
  newStatus: string,
  savId: number,
  expectedVersion: number
): void {
  const msg = err.message ?? ''
  const { code, payload } = parseExceptionMessage(msg)
  if (code === 'NOT_FOUND') {
    sendError(res, 'NOT_FOUND', 'SAV introuvable', requestId)
    return
  }
  if (code === 'VERSION_CONFLICT') {
    const currentVersion = Number(payload['current'])
    logger.warn('sav.status.conflict', { requestId, savId, expectedVersion, currentVersion })
    sendError(res, 'CONFLICT', 'Version périmée', requestId, {
      code: 'VERSION_CONFLICT',
      expectedVersion,
      currentVersion,
    })
    return
  }
  if (code === 'INVALID_TRANSITION') {
    const from = payload['from'] as SavStatus
    const to = payload['to'] as SavStatus
    logger.warn('sav.status.invalid_transition', { requestId, savId, from, to })
    sendError(res, 'BUSINESS_RULE', 'Transition non autorisée', requestId, {
      code: 'INVALID_TRANSITION',
      from,
      to,
      allowed: getAllowedTransitions(from),
    })
    return
  }
  if (code === 'LINES_BLOCKED') {
    const idsRaw = payload['ids'] ?? ''
    const blockedLineIds = idsRaw
      .replace(/[{}]/g, '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n))
    sendError(res, 'BUSINESS_RULE', 'Lignes bloquantes pour valider', requestId, {
      code: 'LINES_BLOCKED',
      blockedLineIds,
    })
    return
  }
  if (code === 'ASSIGNEE_NOT_FOUND') {
    sendError(res, 'NOT_FOUND', 'Opérateur destinataire introuvable', requestId, {
      code: 'ASSIGNEE_NOT_FOUND',
    })
    return
  }
  logger.error('sav.status.rpc_error', {
    requestId,
    savId,
    newStatus,
    pgCode: err.code,
    message: msg,
  })
  sendError(res, 'SERVER_ERROR', 'Erreur RPC', requestId)
}

export function savStatusHandler(savId: number): ApiHandler {
  const core = statusCore(savId)
  return withRateLimit({
    bucketPrefix: 'sav:status',
    keyFrom: (r: ApiRequest) =>
      r.user && r.user.type === 'operator' ? `op:${r.user.sub}` : undefined,
    max: 60,
    window: '1m',
  })(withValidation({ body: statusBodySchema })(core))
}

// ---- Assign handler ----

function assignCore(savId: number): ApiHandler {
  return async (req: ApiRequest, res: ApiResponse) => {
    const requestId = ensureRequestId(req)
    const user = req.user
    if (!user || user.type !== 'operator') {
      sendError(res, 'FORBIDDEN', 'Session opérateur requise', requestId)
      return
    }
    const body = req.body as z.infer<typeof assignBodySchema>

    try {
      const admin = supabaseAdmin()
      const { data, error } = await admin.rpc('assign_sav', {
        p_sav_id: savId,
        p_assignee: body.assigneeOperatorId,
        p_expected_version: body.version,
        p_actor_operator_id: user.sub,
      })

      if (error) {
        return mapRpcError(res, requestId, error as PgRpcError, 'assign', savId, body.version)
      }

      const row = Array.isArray(data) ? data[0] : data
      if (!row) {
        sendError(res, 'SERVER_ERROR', 'RPC sans retour', requestId)
        return
      }

      logger.info('sav.assigned', {
        requestId,
        savId,
        from: row.previous_assignee,
        to: row.new_assignee,
        actorOperatorId: user.sub,
      })

      res.status(200).json({
        data: {
          savId: row.sav_id,
          assignedTo: row.new_assignee,
          previousAssignee: row.previous_assignee,
          version: row.new_version,
        },
      })
    } catch (err) {
      logger.error('sav.assign.exception', {
        requestId,
        savId,
        error: err instanceof Error ? err.message : String(err),
      })
      sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId)
    }
  }
}

export function savAssignHandler(savId: number): ApiHandler {
  const core = assignCore(savId)
  return withRateLimit({
    bucketPrefix: 'sav:assign',
    keyFrom: (r: ApiRequest) =>
      r.user && r.user.type === 'operator' ? `op:${r.user.sub}` : undefined,
    max: 60,
    window: '1m',
  })(withValidation({ body: assignBodySchema })(core))
}

// Export suppression TS unused
export { SAV_STATUSES }
