import { z } from 'zod'
import { withRateLimit } from '../middleware/with-rate-limit'
import { withValidation } from '../middleware/with-validation'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { mapLineRpcError, type PgRpcError } from './_line-error-mapper'
import type { ApiHandler, ApiRequest, ApiResponse } from '../types'

/**
 * Story 3.6b AC #2/#6 — `POST /api/sav/:id/lines`.
 *
 * Crée une ligne SAV via RPC atomique `create_sav_line` (CAS sur sav.version,
 * F50 actor check, D6 SAV_LOCKED, trigger compute Epic 4.2 écrit
 * validation_status + credit_amount_cents).
 *
 * Defaults RPC-side : credit_coefficient=1, credit_coefficient_label='TOTAL'.
 * line_number auto-assigné par trigger trg_assign_sav_line_number (MAX+1).
 *
 * F52 (CR Epic 3) maintenu — validation_status/validation_message/
 * credit_amount_cents jamais client-writable (Zod strict + whitelist RPC).
 */
export const lineCreateBodySchema = z
  .object({
    productId: z.number().int().positive().optional(),
    productCodeSnapshot: z.string().min(1).max(64),
    productNameSnapshot: z.string().min(1).max(200),
    qtyRequested: z.number().positive().max(99999),
    unitRequested: z.enum(['kg', 'piece', 'liter']),
    qtyInvoiced: z.number().nonnegative().max(99999).optional(),
    unitInvoiced: z.enum(['kg', 'piece', 'liter']).optional(),
    unitPriceHtCents: z.number().int().nonnegative().max(100000000).optional(),
    vatRateBpSnapshot: z.number().int().min(0).max(10000).optional(),
    creditCoefficient: z.number().min(0).max(1).optional(),
    creditCoefficientLabel: z.string().max(32).optional(),
    pieceToKgWeightG: z.number().int().positive().max(100000).optional(),
    version: z.number().int().nonnegative(),
  })
  .strict()

function lineCreateCore(savId: number): ApiHandler {
  return async (req: ApiRequest, res: ApiResponse) => {
    const requestId = ensureRequestId(req)
    const startedAt = Date.now()
    const user = req.user
    if (!user || user.type !== 'operator') {
      sendError(res, 'FORBIDDEN', 'Session opérateur requise', requestId)
      return
    }
    const body = req.body as z.infer<typeof lineCreateBodySchema>
    const { version, ...patchFields } = body

    try {
      const admin = supabaseAdmin()
      const { data, error } = await admin.rpc('create_sav_line', {
        p_sav_id: savId,
        p_patch: patchFields,
        p_expected_version: version,
        p_actor_operator_id: user.sub,
      })

      if (error) {
        const handled = mapLineRpcError(res, error as PgRpcError, {
          requestId,
          savId,
          lineId: null,
          expectedVersion: version,
          actorOperatorId: user.sub,
          logTag: 'sav.line.create',
        })
        if (handled) return
        logger.error('sav.line.create.rpc_error', {
          requestId,
          savId,
          message: (error as PgRpcError).message,
        })
        sendError(res, 'SERVER_ERROR', 'Erreur RPC', requestId)
        return
      }

      const row = Array.isArray(data) ? data[0] : data
      if (!row) {
        sendError(res, 'SERVER_ERROR', 'RPC sans retour', requestId)
        return
      }

      const durationMs = Date.now() - startedAt
      logger.info('sav.line.created', {
        requestId,
        savId,
        lineId: row.line_id,
        validationStatus: row.validation_status,
        durationMs,
      })

      res.status(201).json({
        data: {
          savId: row.sav_id,
          lineId: row.line_id,
          version: row.new_version,
          validationStatus: row.validation_status,
        },
      })
    } catch (err) {
      logger.error('sav.line.create.exception', {
        requestId,
        savId,
        error: err instanceof Error ? err.message : String(err),
      })
      sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId)
    }
  }
}

export function savLineCreateHandler(savId: number): ApiHandler {
  const core = lineCreateCore(savId)
  return withRateLimit({
    bucketPrefix: 'sav:line:create',
    keyFrom: (r: ApiRequest) =>
      r.user && r.user.type === 'operator' ? `op:${r.user.sub}` : undefined,
    max: 60,
    window: '1m',
  })(withValidation({ body: lineCreateBodySchema })(core))
}
