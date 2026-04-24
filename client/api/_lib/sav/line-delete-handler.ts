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
 * Story 3.6b AC #3/#7 — `DELETE /api/sav/:id/lines/:lineId`.
 *
 * Supprime une ligne SAV via RPC `delete_sav_line` (CAS sur sav.version,
 * F50, D6). Le trigger AFTER DELETE recompute_sav_total met à jour
 * sav.total_amount_cents. L'audit trigger trg_audit_sav_lines capture la suppression.
 */
export const lineDeleteBodySchema = z
  .object({
    version: z.number().int().nonnegative(),
  })
  .strict()

function lineDeleteCore(savId: number, lineId: number): ApiHandler {
  return async (req: ApiRequest, res: ApiResponse) => {
    const requestId = ensureRequestId(req)
    const startedAt = Date.now()
    const user = req.user
    if (!user || user.type !== 'operator') {
      sendError(res, 'FORBIDDEN', 'Session opérateur requise', requestId)
      return
    }
    const body = req.body as z.infer<typeof lineDeleteBodySchema>

    try {
      const admin = supabaseAdmin()
      const { data, error } = await admin.rpc('delete_sav_line', {
        p_sav_id: savId,
        p_line_id: lineId,
        p_expected_version: body.version,
        p_actor_operator_id: user.sub,
      })

      if (error) {
        const handled = mapLineRpcError(res, error as PgRpcError, {
          requestId,
          savId,
          lineId,
          expectedVersion: body.version,
          actorOperatorId: user.sub,
          logTag: 'sav.line.delete',
        })
        if (handled) return
        logger.error('sav.line.delete.rpc_error', {
          requestId,
          savId,
          lineId,
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
      logger.info('sav.line.deleted', {
        requestId,
        savId,
        lineId,
        durationMs,
      })

      res.status(200).json({
        data: {
          savId: row.sav_id,
          version: row.new_version,
        },
      })
    } catch (err) {
      logger.error('sav.line.delete.exception', {
        requestId,
        savId,
        lineId,
        error: err instanceof Error ? err.message : String(err),
      })
      sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId)
    }
  }
}

export function savLineDeleteHandler(savId: number, lineId: number): ApiHandler {
  const core = lineDeleteCore(savId, lineId)
  return withRateLimit({
    bucketPrefix: 'sav:line:delete',
    keyFrom: (r: ApiRequest) =>
      r.user && r.user.type === 'operator' ? `op:${r.user.sub}` : undefined,
    max: 60,
    window: '1m',
  })(withValidation({ body: lineDeleteBodySchema })(core))
}
