import { z } from 'zod'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import type { ApiHandler, ApiRequest, ApiResponse } from '../types'

/**
 * Story 6.4 — `GET|PATCH /api/self-service/preferences`.
 *
 * Single op router-side (`op=preferences`) qui dispatche par méthode HTTP
 * (pattern Story 5.5 admin-settings-threshold) :
 *
 *   - GET   → lecture `members.notification_prefs` du member courant
 *   - PATCH → merge JSONB `||` partiel { status_updates?, weekly_recap? }
 *
 * Auth : router self-service applique déjà `withAuth({ types: ['member'] })`.
 * Le handler ne refait pas le check JWT — il lit `req.user` qui est garanti
 * non-null member par le middleware. Defense-in-depth tout de même : si
 * `req.user` absent ou type !== 'member', on retourne 401 (cas test sans
 * `req.user` injecté manuellement).
 *
 * Privacy NFR :
 *   - jamais d'email/display_name dans les logs (member_id seulement)
 *   - log info diff prefs pour observabilité (status_updates_before/after etc.)
 *   - filtre `anonymized_at IS NULL` empêche les members supprimés (RGPD) de
 *     muter leurs prefs
 *
 * Réponse :
 *   200 GET   → { data: { notificationPrefs: { status_updates, weekly_recap } } }
 *   200 PATCH → { data: { notificationPrefs: { status_updates, weekly_recap } } }
 *   400 VALIDATION_FAILED — Zod strict (clés inconnues, non-boolean, body vide)
 *   401 UNAUTHENTICATED   — pas de session member (defense-in-depth)
 *   404 NOT_FOUND         — member anonymized ou inexistant (anti-leak)
 *   500 SERVER_ERROR      — exception persistance
 */

interface MemberPrefsRow {
  id: number
  notification_prefs: { status_updates: boolean; weekly_recap: boolean }
  is_group_manager: boolean
  anonymized_at: string | null
}

const patchBodySchema = z
  .object({
    status_updates: z.boolean().optional(),
    weekly_recap: z.boolean().optional(),
  })
  .strict()
  .refine((obj) => Object.keys(obj).length > 0, { message: 'AT_LEAST_ONE_KEY_REQUIRED' })

function ensureMemberSession(req: ApiRequest, res: ApiResponse, requestId: string): number | null {
  const u = req.user
  if (!u || u.type !== 'member' || typeof u.sub !== 'number') {
    sendError(res, 'UNAUTHENTICATED', 'Session adhérent requise', requestId)
    return null
  }
  return u.sub
}

const getCore: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  const memberId = ensureMemberSession(req, res, requestId)
  if (memberId === null) return

  try {
    const admin = supabaseAdmin()
    const { data, error } = await admin
      .from('members')
      .select('id, notification_prefs, is_group_manager, anonymized_at')
      .eq('id', memberId)
      .is('anonymized_at', null)
      .maybeSingle()

    if (error) {
      logger.error('self-service.preferences.get_failed', {
        requestId,
        memberId,
        message: error.message,
      })
      sendError(res, 'SERVER_ERROR', 'Lecture préférences échouée', requestId)
      return
    }

    const row = (data ?? null) as MemberPrefsRow | null
    if (row === null) {
      // Anti-leak : 404 même si le member existe mais est anonymized.
      sendError(res, 'NOT_FOUND', 'Adhérent introuvable', requestId)
      return
    }

    const prefs = normalizePrefs(row.notification_prefs)
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({
      data: {
        notificationPrefs: prefs,
      },
    })
  } catch (err) {
    logger.error('self-service.preferences.get_exception', {
      requestId,
      memberId,
      error: err instanceof Error ? err.message : String(err),
    })
    sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId)
  }
}

const patchCore: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  const memberId = ensureMemberSession(req, res, requestId)
  if (memberId === null) return

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

  const parsed = patchBodySchema.safeParse(rawBody)
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

  // Story 6.4 — patch partiel JSONB merge `||` côté SQL. On envoie uniquement
  // les clés présentes (Zod a déjà refusé tout ce qui n'est pas
  // status_updates|weekly_recap). Le merge `||` côté Postgres préserve les
  // clés non touchées (UPDATE jsonb set = jsonb || $patch).
  const patch: Record<string, boolean> = {}
  if (parsed.data.status_updates !== undefined) patch['status_updates'] = parsed.data.status_updates
  if (parsed.data.weekly_recap !== undefined) patch['weekly_recap'] = parsed.data.weekly_recap

  try {
    const admin = supabaseAdmin()
    // 1) Lookup pour le `before` (logging) + détection member anonymized → 404
    //    anti-leak. La RPC member_prefs_merge filtre déjà `anonymized_at IS
    //    NULL` mais retourne NULL silencieusement ; on conserve ce read pour
    //    distinguer 404 (member inconnu/anonymized) vs SERVER_ERROR.
    const { data: existingData, error: existingError } = await admin
      .from('members')
      .select('id, notification_prefs, is_group_manager, anonymized_at')
      .eq('id', memberId)
      .is('anonymized_at', null)
      .maybeSingle()

    if (existingError) {
      logger.error('self-service.preferences.patch_lookup_failed', {
        requestId,
        memberId,
        message: existingError.message,
      })
      sendError(res, 'SERVER_ERROR', 'Lecture préférences échouée', requestId)
      return
    }
    const existing = (existingData ?? null) as MemberPrefsRow | null
    if (existing === null) {
      sendError(res, 'NOT_FOUND', 'Adhérent introuvable', requestId)
      return
    }

    const before = normalizePrefs(existing.notification_prefs)

    // 2) Merge atomique JSONB `||` côté Postgres via RPC SECURITY DEFINER
    //    (Story 6.4 W104). Élimine la race last-writer-wins du read-modify-
    //    write applicatif ; AC #7 spec respecté à la lettre. La RPC retourne
    //    `notification_prefs` post-merge directement.
    const { data: rpcData, error: rpcError } = await admin.rpc('member_prefs_merge', {
      p_member_id: memberId,
      p_patch: patch,
    })

    if (rpcError) {
      logger.error('self-service.preferences.patch_rpc_failed', {
        requestId,
        memberId,
        message: rpcError.message,
      })
      sendError(res, 'SERVER_ERROR', 'Mise à jour préférences échouée', requestId)
      return
    }

    // RPC retourne directement le jsonb (PostgREST déballe le scalar) ;
    // si null, le member a été anonymized entre le SELECT (1) et l'UPDATE
    // RPC — race rare mais traitable comme 404.
    if (rpcData === null || rpcData === undefined) {
      sendError(res, 'NOT_FOUND', 'Adhérent introuvable', requestId)
      return
    }

    const after = normalizePrefs(rpcData)

    logger.info('self-service.preferences.updated', {
      requestId,
      memberId,
      before,
      after,
      isGroupManager: existing.is_group_manager,
    })

    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({
      data: {
        notificationPrefs: after,
      },
    })
  } catch (err) {
    logger.error('self-service.preferences.patch_exception', {
      requestId,
      memberId,
      error: err instanceof Error ? err.message : String(err),
    })
    sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId)
  }
}

function normalizePrefs(raw: unknown): { status_updates: boolean; weekly_recap: boolean } {
  // Defense-in-depth — si la colonne JSONB contient des valeurs partielles
  // (cas pré-Story 6.1 ou corruption), on défalloute aux valeurs Story 6.1.
  if (typeof raw !== 'object' || raw === null) {
    return { status_updates: true, weekly_recap: false }
  }
  const obj = raw as Record<string, unknown>
  return {
    status_updates: typeof obj['status_updates'] === 'boolean' ? obj['status_updates'] : true,
    weekly_recap: typeof obj['weekly_recap'] === 'boolean' ? obj['weekly_recap'] : false,
  }
}

/**
 * Handler unique — dispatche GET/PATCH sur `req.method`. Le router self-service
 * (`api/self-service/draft.ts`) appelle ce handler pour `op=preferences`.
 */
export const preferencesHandler: ApiHandler = async (req, res) => {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method === 'GET') return getCore(req, res)
  if (method === 'PATCH') return patchCore(req, res)
  const requestId = ensureRequestId(req)
  res.setHeader('Allow', 'GET, PATCH')
  sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
}

export const __testables = {
  patchBodySchema,
  normalizePrefs,
  getCore,
  patchCore,
}
