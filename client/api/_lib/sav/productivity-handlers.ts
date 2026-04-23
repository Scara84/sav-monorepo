import { z } from 'zod'
import { withRateLimit } from '../middleware/with-rate-limit'
import { withValidation } from '../middleware/with-validation'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import type { ApiHandler, ApiRequest, ApiResponse } from '../types'

/**
 * Story 3.7 V1 — handlers productivité back-office :
 *   - PATCH /api/sav/:id/tags      → update_sav_tags RPC
 *   - POST  /api/sav/:id/comments  → INSERT direct sav_comments (append-only)
 *   - POST  /api/sav/:id/duplicate → duplicate_sav RPC
 *
 * Non livrés V1 : upload opérateur, suggestions tags endpoint, composants UI.
 */

interface PgRpcError {
  code?: string
  message?: string
}
function parseExc(msg: string): { code: string; payload: Record<string, string> } {
  const [code, ...rest] = msg.split('|')
  const payload: Record<string, string> = {}
  for (const p of rest) {
    const eq = p.indexOf('=')
    if (eq > 0) payload[p.slice(0, eq)] = p.slice(eq + 1)
  }
  return { code: code ?? 'UNKNOWN', payload }
}

// ---- Tags ----

// F16 (CR Epic 3) : regex étendue pour rejeter les unicode directional
// overrides (U+200E/200F/202A-E) — vecteurs de display-spoofing dans les
// chips/URL — en plus des control chars et `<>`. Normalisation `trim()`
// + `toLowerCase()` appliquée côté handler avant RPC pour éviter la
// fragmentation de taxonomie (`Urgent` vs `urgent`).
const TAG_FORBIDDEN_RE = /^[^\x00-\x1f<>\u200E\u200F\u202A-\u202E]+$/

export const tagsBodySchema = z
  .object({
    add: z
      .array(z.string().trim().min(1).max(64).regex(TAG_FORBIDDEN_RE, 'Caractères interdits'))
      .max(10)
      .default([]),
    remove: z.array(z.string().trim().min(1).max(64)).max(10).default([]),
    version: z.number().int().nonnegative(),
  })
  .refine((d) => d.add.length + d.remove.length > 0, { message: 'Aucun tag à modifier' })

function tagsCore(savId: number): ApiHandler {
  return async (req: ApiRequest, res: ApiResponse) => {
    const requestId = ensureRequestId(req)
    const user = req.user
    if (!user || user.type !== 'operator') {
      sendError(res, 'FORBIDDEN', 'Session opérateur requise', requestId)
      return
    }
    const body = req.body as z.infer<typeof tagsBodySchema>
    try {
      const { data, error } = await supabaseAdmin().rpc('update_sav_tags', {
        p_sav_id: savId,
        p_add: body.add,
        p_remove: body.remove,
        p_expected_version: body.version,
        p_actor_operator_id: user.sub,
      })
      if (error) {
        const { code, payload } = parseExc((error as PgRpcError).message ?? '')
        if (code === 'NOT_FOUND') {
          sendError(res, 'NOT_FOUND', 'SAV introuvable', requestId)
          return
        }
        if (code === 'VERSION_CONFLICT') {
          sendError(res, 'CONFLICT', 'Version périmée', requestId, {
            code: 'VERSION_CONFLICT',
            expectedVersion: body.version,
            currentVersion: Number(payload['current']),
          })
          return
        }
        if (code === 'TAGS_LIMIT') {
          sendError(res, 'BUSINESS_RULE', 'Maximum 30 tags par SAV', requestId, {
            code: 'TAGS_LIMIT',
            count: Number(payload['count']),
            max: 30,
          })
          return
        }
        logger.error('sav.tags.rpc_error', {
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
      logger.info('sav.tags.updated', {
        requestId,
        savId,
        added: body.add,
        removed: body.remove,
        actorOperatorId: user.sub,
      })
      res.status(200).json({ data: { tags: row.new_tags, version: row.new_version } })
    } catch (err) {
      logger.error('sav.tags.exception', {
        requestId,
        savId,
        error: err instanceof Error ? err.message : String(err),
      })
      sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId)
    }
  }
}

export function savTagsHandler(savId: number): ApiHandler {
  return withRateLimit({
    bucketPrefix: 'sav:tags',
    keyFrom: (r: ApiRequest) =>
      r.user && r.user.type === 'operator' ? `op:${r.user.sub}` : undefined,
    max: 120,
    window: '1m',
  })(withValidation({ body: tagsBodySchema })(tagsCore(savId)))
}

// ---- Comments POST ----

export const commentsBodySchema = z.object({
  body: z.string().trim().min(1).max(5000),
  visibility: z.enum(['all', 'internal']),
})

function commentsCore(savId: number): ApiHandler {
  return async (req: ApiRequest, res: ApiResponse) => {
    const requestId = ensureRequestId(req)
    const user = req.user
    if (!user || user.type !== 'operator') {
      sendError(res, 'FORBIDDEN', 'Session opérateur requise', requestId)
      return
    }
    const body = req.body as z.infer<typeof commentsBodySchema>
    try {
      const admin = supabaseAdmin()
      // Note V1 : l'audit trigger `trg_audit_sav_comments` lit `app.actor_operator_id` ;
      // nous n'avons pas de GUC auto-setter par le client Supabase JS. L'audit row
      // aura donc `actor_operator_id=NULL` — acceptable V1 puisque `author_operator_id`
      // est stocké dans la row elle-même (défense en profondeur).
      const { data, error } = await admin
        .from('sav_comments')
        .insert({
          sav_id: savId,
          author_operator_id: user.sub,
          visibility: body.visibility,
          body: body.body,
        })
        .select('id, created_at, visibility, body')
        .single<{ id: number; created_at: string; visibility: string; body: string }>()

      if (error) {
        // FK violation sur sav_id → SAV inexistant
        if ((error as { code?: string }).code === '23503') {
          sendError(res, 'NOT_FOUND', 'SAV introuvable', requestId)
          return
        }
        logger.error('sav.comment.insert_error', {
          requestId,
          savId,
          message: (error as { message?: string }).message,
        })
        sendError(res, 'SERVER_ERROR', 'Échec création commentaire', requestId)
        return
      }

      logger.info('sav.comment.posted', {
        requestId,
        savId,
        commentId: data.id,
        visibility: data.visibility,
        actorOperatorId: user.sub,
      })
      res.status(201).json({
        data: {
          commentId: data.id,
          createdAt: data.created_at,
          visibility: data.visibility,
          body: data.body,
          authorOperator: { id: user.sub },
        },
      })
    } catch (err) {
      logger.error('sav.comment.exception', {
        requestId,
        savId,
        error: err instanceof Error ? err.message : String(err),
      })
      sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId)
    }
  }
}

export function savCommentsPostHandler(savId: number): ApiHandler {
  return withRateLimit({
    bucketPrefix: 'sav:comments',
    keyFrom: (r: ApiRequest) =>
      r.user && r.user.type === 'operator' ? `op:${r.user.sub}` : undefined,
    max: 60,
    window: '1m',
  })(withValidation({ body: commentsBodySchema })(commentsCore(savId)))
}

// ---- Duplicate ----

function duplicateCore(sourceSavId: number): ApiHandler {
  return async (req: ApiRequest, res: ApiResponse) => {
    const requestId = ensureRequestId(req)
    const user = req.user
    if (!user || user.type !== 'operator') {
      sendError(res, 'FORBIDDEN', 'Session opérateur requise', requestId)
      return
    }
    try {
      const { data, error } = await supabaseAdmin().rpc('duplicate_sav', {
        p_source_sav_id: sourceSavId,
        p_actor_operator_id: user.sub,
      })
      if (error) {
        const { code } = parseExc((error as PgRpcError).message ?? '')
        if (code === 'NOT_FOUND') {
          sendError(res, 'NOT_FOUND', 'SAV source introuvable', requestId)
          return
        }
        logger.error('sav.duplicate.rpc_error', {
          requestId,
          sourceSavId,
          message: (error as PgRpcError).message,
        })
        sendError(res, 'SERVER_ERROR', 'Erreur duplication', requestId)
        return
      }
      const row = Array.isArray(data) ? data[0] : data
      if (!row) {
        sendError(res, 'SERVER_ERROR', 'RPC sans retour', requestId)
        return
      }
      logger.info('sav.duplicated', {
        requestId,
        sourceSavId,
        newSavId: row.new_sav_id,
        newReference: row.new_reference,
        actorOperatorId: user.sub,
      })
      res.status(201).json({
        data: { newSavId: row.new_sav_id, newReference: row.new_reference },
      })
    } catch (err) {
      logger.error('sav.duplicate.exception', {
        requestId,
        sourceSavId,
        error: err instanceof Error ? err.message : String(err),
      })
      sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId)
    }
  }
}

export function savDuplicateHandler(sourceSavId: number): ApiHandler {
  return withRateLimit({
    bucketPrefix: 'sav:duplicate',
    keyFrom: (r: ApiRequest) =>
      r.user && r.user.type === 'operator' ? `op:${r.user.sub}` : undefined,
    max: 20,
    window: '1m',
  })(duplicateCore(sourceSavId))
}
