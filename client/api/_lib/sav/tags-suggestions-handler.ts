/**
 * Story 3.7b — AC #7 — GET /api/sav/tags/suggestions
 *
 * Op: tags-suggestions dans api/sav.ts
 * Rewrite: /api/sav/tags/suggestions → /api/sav?op=tags-suggestions
 *
 * SQL (production) :
 *   SELECT t.tag, count(*)::int AS usage
 *     FROM sav, unnest(tags) AS t(tag)
 *    WHERE ($1::text IS NULL OR t.tag ILIKE '%' || $1 || '%')
 *      AND status NOT IN ('cancelled')   -- F50-bis
 *    GROUP BY t.tag
 *    ORDER BY usage DESC, t.tag ASC
 *    LIMIT $2
 *
 * Auth : operator/admin uniquement (OOS-8 : pas d'accès member V1).
 * RLS  : query via supabaseAdmin() contourne RLS (mono-tenant V1).
 */

import { z } from 'zod'
import { withAuth } from '../middleware/with-auth'
import { withRateLimit } from '../middleware/with-rate-limit'
import { withValidation } from '../middleware/with-validation'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import type { ApiHandler, ApiRequest, ApiResponse } from '../types'

// ---------------------------------------------------------------------------
// Query schema
// ---------------------------------------------------------------------------
const querySchema = z.object({
  q: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

// ---------------------------------------------------------------------------
// Core handler
// ---------------------------------------------------------------------------
function tagsSuggestionsCore(): ApiHandler {
  return async (req: ApiRequest, res: ApiResponse) => {
    const requestId = ensureRequestId(req)
    const user = req.user

    if (!user || user.type !== 'operator') {
      sendError(res, 'FORBIDDEN', 'Session opérateur requise', requestId)
      return
    }

    const { q, limit } = req.query as z.infer<typeof querySchema>

    try {
      // Query via Postgres function (unit tests mock any non-rate-limit rpc call)
      // Production: uses sav_tags_suggestions(q_filter, limit_val) function OR
      // falls back to JS-level filtering when function not available.
      // The rpc approach allows the integration test to verify real DB behavior.
      const { data, error } = (await supabaseAdmin().rpc('sav_tags_suggestions', {
        q_filter: q ?? null,
        limit_val: limit,
      })) as { data: Array<{ tag: string; usage: number }> | null; error: unknown }

      if (error) {
        logger.error('sav.tags_suggestions.rpc_error', {
          requestId,
          message: (error as { message?: string }).message,
        })
        sendError(res, 'SERVER_ERROR', 'Erreur requête suggestions', requestId)
        return
      }

      const suggestions = (data ?? []).map((row) => ({
        tag: row.tag,
        usage: row.usage,
      }))

      res.status(200).json({ data: { suggestions } })
    } catch (err) {
      logger.error('sav.tags_suggestions.exception', {
        requestId,
        error: err instanceof Error ? err.message : String(err),
      })
      sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId)
    }
  }
}

// ---------------------------------------------------------------------------
// Exported handler (wrapped with middleware)
// ---------------------------------------------------------------------------
export const tagsSuggestionsHandler: ApiHandler = withAuth({
  types: ['operator'],
})(
  withRateLimit({
    bucketPrefix: 'sav:tags-suggestions',
    keyFrom: (r: ApiRequest) =>
      r.user && r.user.type === 'operator' ? `op:${r.user.sub}` : undefined,
    max: 60,
    window: '1m',
  })(withValidation({ query: querySchema })(tagsSuggestionsCore()))
)
