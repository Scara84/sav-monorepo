import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import {
  validationListListQuerySchema,
  VALIDATION_LIST_CODES,
  type ValidationListEntryRow,
  type ValidationListCode,
} from './validation-lists-schema'
import type { ApiHandler } from '../types'

/**
 * Story 7-3c AC #1 — `GET /api/admin/validation-lists` (op
 * `admin-validation-lists-list`).
 *
 * Contrat (cohérent /api/admin Stories 7-3a/7-3b) :
 *   200 → { data: { lists: Record<list_code, ValidationListEntry[]> } }
 *     - Groupé par `list_code` (codes V1 connus : sav_cause, bon_type, unit)
 *     - Chaque groupe trié par `sort_order ASC, value ASC` (côté DB).
 *
 * Filtre is_active : par défaut, retourne tout (admin peut voir les inactifs
 * pour réactiver). Un query param `?active_only=true` filtre côté DB via
 * `.eq('is_active', true)`.
 *
 * Pagination : aucune. Volumétrie cible ~40 entrées V1 (sav_cause ~10,
 * bon_type ~3, unit ~3, autres ~24). Group-by client-side après fetch
 * suffit — pas de besoin de cursor / range côté DB.
 *
 * Auth : router `pilotage.ts` applique `withAuth({ types:['operator'] })`
 * + check role admin via Set `ADMIN_ONLY_OPS` + helper `requireAdminRole`.
 * Le handler ré-applique le check (defense-in-depth — pattern Story 7-3a).
 *
 * Réponses :
 *   200 → { data: { lists: Record<list_code, ValidationListEntryRow[]> } }
 *   400 INVALID_PARAMS
 *   403 ROLE_NOT_ALLOWED
 *   500 QUERY_FAILED
 */

export const adminValidationListsListHandler: ApiHandler = async (req, res) => {
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

  const parsed = validationListListQuerySchema.safeParse(req.query ?? {})
  if (!parsed.success) {
    sendError(res, 'VALIDATION_FAILED', 'Paramètres invalides', requestId, {
      code: 'INVALID_PARAMS',
      issues: parsed.error.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      })),
    })
    return
  }
  const { active_only } = parsed.data

  const admin = supabaseAdmin()
  let query = admin
    .from('validation_lists')
    .select('id, list_code, value, value_es, sort_order, is_active')

  if (active_only === 'true') {
    query = (
      query as unknown as {
        eq: (col: string, val: unknown) => typeof query
      }
    ).eq('is_active', true)
  }

  // Tri DB : sort_order ASC puis value ASC (cohérent UI groupé). Le 2e
  // .order() est terminal côté PostgREST et déclenche la résolution de
  // la requête.
  const orderable = query as unknown as {
    order: (
      col: string,
      opts: { ascending: boolean }
    ) => {
      order: (
        col2: string,
        opts2: { ascending: boolean }
      ) => Promise<{
        data: ValidationListEntryRow[] | null
        error: { code?: string; message: string } | null
      }>
    }
  }
  const { data, error } = await orderable
    .order('sort_order', { ascending: true })
    .order('value', { ascending: true })

  if (error) {
    logger.error('admin.validation_lists.list.query_failed', {
      requestId,
      code: error.code,
      message: error.message,
    })
    sendError(res, 'SERVER_ERROR', 'Lecture impossible', requestId, {
      code: 'QUERY_FAILED',
    })
    return
  }

  const rows = (data ?? []) as ValidationListEntryRow[]

  // Group by list_code côté handler — UI consomme directement Record<code, []>.
  // Hardening W-7-3c-6 : filtre strict sur l'enum V1 (D-7) pour éviter de
  // leak vers le client des `list_code` orphelins (seed manuel, migration
  // future). La View ne rend que sav_cause/bon_type/unit ; le handler reste
  // cohérent avec ce contrat.
  const lists: Record<string, ValidationListEntryRow[]> = {}
  for (const code of VALIDATION_LIST_CODES) {
    lists[code] = []
  }
  const allowedCodes = VALIDATION_LIST_CODES as readonly string[]
  for (const row of rows) {
    if (!allowedCodes.includes(row.list_code)) continue
    const bucket = lists[row.list_code]
    if (bucket) bucket.push(row)
  }

  res.status(200).json({ data: { lists } })
}
