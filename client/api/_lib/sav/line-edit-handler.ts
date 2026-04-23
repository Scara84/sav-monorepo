import { z } from 'zod'
import { withRateLimit } from '../middleware/with-rate-limit'
import { withValidation } from '../middleware/with-validation'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import type { ApiHandler, ApiRequest, ApiResponse } from '../types'

/**
 * Story 3.6 V1 — `PATCH /api/sav/:id/lines/:lineId`.
 *
 * Édite partiellement une ligne SAV via RPC atomique `update_sav_line` qui
 * applique CAS sur `sav.version` et incrémente. Les colonnes éditables sont
 * whitelistées côté RPC.
 *
 * Le compute `credit_amount_cents` + validation_status sont la responsabilité
 * d'Epic 4 (moteur avoir). V1 laisse l'opérateur remplir `validation_status`
 * explicitement s'il le souhaite (sinon hérite de l'état actuel).
 */

// Review F52 (CR Epic 3 2026-04-23) — `validationStatus` retiré du wire.
// Permettre au client de patcher ce champ permet de contourner la garde
// `LINES_BLOCKED` de `transition_sav_status` en forçant `ok` avant
// transition vers `validated`. Le champ reste écrit uniquement par le
// trigger compute (Epic 4). Idem `validationMessages` qui n'est jamais
// utilisateur-éditable.
export const lineEditBodySchema = z
  .object({
    qtyRequested: z.number().positive().max(99999).optional(),
    unit: z.enum(['kg', 'piece', 'liter']).optional(),
    qtyBilled: z.number().nonnegative().max(99999).optional(),
    unitPriceHtCents: z.number().int().nonnegative().max(100000000).optional(),
    vatRateBp: z.number().int().min(0).max(10000).optional(),
    creditCoefficientBp: z.number().int().min(0).max(10000).optional(),
    position: z.number().int().nonnegative().max(999).optional(),
    version: z.number().int().nonnegative(),
  })
  .refine((d) => Object.keys(d).length > 1, {
    message: 'Au moins un champ à modifier (hors version)',
  })

interface PgRpcError {
  code?: string
  message?: string
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

function lineEditCore(savId: number, lineId: number): ApiHandler {
  return async (req: ApiRequest, res: ApiResponse) => {
    const requestId = ensureRequestId(req)
    const startedAt = Date.now()
    const user = req.user
    if (!user || user.type !== 'operator') {
      sendError(res, 'FORBIDDEN', 'Session opérateur requise', requestId)
      return
    }
    const body = req.body as z.infer<typeof lineEditBodySchema>
    const { version, ...patchFields } = body
    try {
      const admin = supabaseAdmin()
      const { data, error } = await admin.rpc('update_sav_line', {
        p_sav_id: savId,
        p_line_id: lineId,
        p_patch: patchFields,
        p_expected_version: version,
        p_actor_operator_id: user.sub,
      })

      if (error) {
        const { code, payload } = parseExceptionMessage((error as PgRpcError).message ?? '')
        if (code === 'NOT_FOUND') {
          sendError(res, 'NOT_FOUND', 'SAV ou ligne introuvable', requestId)
          return
        }
        if (code === 'VERSION_CONFLICT') {
          const currentVersion = Number(payload['current'])
          logger.warn('sav.line.conflict', {
            requestId,
            savId,
            lineId,
            expectedVersion: version,
            currentVersion,
          })
          sendError(res, 'CONFLICT', 'Version périmée', requestId, {
            code: 'VERSION_CONFLICT',
            expectedVersion: version,
            currentVersion,
          })
          return
        }
        if (code === 'SAV_LOCKED') {
          // D6 (CR Epic 3) — édition interdite en statut terminal.
          sendError(res, 'BUSINESS_RULE', 'SAV verrouillé', requestId, {
            code: 'SAV_LOCKED',
            status: payload['status'] ?? null,
          })
          return
        }
        if (code === 'ACTOR_NOT_FOUND') {
          // F50 (CR Epic 3) — actor id forgé / inconnu.
          logger.error('sav.line.actor_not_found', {
            requestId,
            savId,
            actorOperatorId: user.sub,
          })
          sendError(res, 'FORBIDDEN', 'Acteur inconnu', requestId)
          return
        }
        logger.error('sav.line.rpc_error', {
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
      logger.info('sav.line.updated', {
        requestId,
        savId,
        lineId,
        fields: Object.keys(patchFields),
        validationStatus: row.validation_status,
        durationMs,
      })
      if (row.validation_status !== 'ok') {
        logger.warn('sav.line.validation_failed', {
          savId,
          lineId,
          validationStatus: row.validation_status,
        })
      }

      res.status(200).json({
        data: {
          savId: row.sav_id,
          lineId: row.line_id,
          version: row.new_version,
          validationStatus: row.validation_status,
        },
      })
    } catch (err) {
      logger.error('sav.line.exception', {
        requestId,
        savId,
        lineId,
        error: err instanceof Error ? err.message : String(err),
      })
      sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId)
    }
  }
}

export function savLineEditHandler(savId: number, lineId: number): ApiHandler {
  const core = lineEditCore(savId, lineId)
  return withRateLimit({
    bucketPrefix: 'sav:line:edit',
    keyFrom: (r: ApiRequest) =>
      r.user && r.user.type === 'operator' ? `op:${r.user.sub}` : undefined,
    max: 300,
    window: '1m',
  })(withValidation({ body: lineEditBodySchema })(core))
}
