import { verifyJwt, readCookie } from '../middleware/with-auth'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import type { ApiHandler, SessionUser } from '../types'

/**
 * Story 6.2 AC #13 — `GET /api/auth/me` (op=me dans router self-service).
 *
 * Endpoint léger nécessaire au guard Vue : le cookie `sav_session` est
 * HttpOnly (Story 1.5), le frontend ne peut donc pas lire l'état d'auth
 * en JS. Cet endpoint retourne `{ user: { sub, type, role, scope, groupId } }`
 * (200) ou 401 UNAUTHENTICATED (cookie absent / invalide / expiré).
 *
 * Story 6.4 — extension `isGroupManager` :
 *   Le JWT ne contient PAS `is_group_manager` (cf. issue-handler magic-link).
 *   Pour que `MemberPreferencesView` puisse conditionner l'affichage du toggle
 *   `weekly_recap` (réservé aux responsables), on ajoute un lookup DB pour
 *   les members. Operators ne consomment pas cette info — pas de lookup.
 *
 * Spécificité : il accepte **member ET operator** (le guard Vue rejette
 * `type !== 'member'` côté front). On utilise donc `verifyJwt` directement
 * plutôt que `withAuth({ types: [...] })` qui forcerait une discrimination
 * 403 en amont.
 */

const COOKIE_NAME = 'sav_session'

const meCore: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)

  const secret = process.env['SESSION_COOKIE_SECRET']
  if (!secret) {
    logger.error('me.config_missing', { requestId })
    sendError(res, 'SERVER_ERROR', 'Configuration manquante', requestId)
    return
  }

  const token = readCookie(req, COOKIE_NAME)
  if (!token) {
    sendError(res, 'UNAUTHENTICATED', 'Session requise', requestId)
    return
  }

  const user = verifyJwt(token, secret)
  if (!user) {
    sendError(res, 'UNAUTHENTICATED', 'Session invalide', requestId)
    return
  }

  const now = Math.floor(Date.now() / 1000)
  if (user.exp <= now) {
    sendError(res, 'UNAUTHENTICATED', 'Session expirée', requestId)
    return
  }

  // Réponse minimale — on expose uniquement ce dont le guard Vue a besoin.
  // Pas d'email en clair (PII).
  const safe: Pick<SessionUser, 'sub' | 'type'> &
    Partial<Pick<SessionUser, 'role' | 'scope' | 'groupId'>> & {
      isGroupManager?: boolean
    } = {
    sub: user.sub,
    type: user.type,
  }
  if (user.role !== undefined) safe.role = user.role
  if (user.scope !== undefined) safe.scope = user.scope
  if (user.groupId !== undefined) safe.groupId = user.groupId

  // Story 6.4 — lookup `is_group_manager` pour les members uniquement.
  // Les operators n'ont pas de notion de "responsable de groupe" côté
  // self-service ; on n'expose pas le champ.
  if (user.type === 'member' && typeof user.sub === 'number') {
    try {
      const admin = supabaseAdmin()
      const { data, error } = await admin
        .from('members')
        .select('is_group_manager')
        .eq('id', user.sub)
        .is('anonymized_at', null)
        .maybeSingle()
      if (error) {
        logger.warn('me.is_group_manager_lookup_failed', {
          requestId,
          memberId: user.sub,
          message: error.message,
        })
        // Non bloquant : on défalloute à false, le frontend traitera
        // comme un non-manager (toggle weekly_recap masqué).
        safe.isGroupManager = false
      } else {
        const row = (data ?? null) as { is_group_manager: boolean | null } | null
        safe.isGroupManager = row !== null && row.is_group_manager === true
      }
    } catch (err) {
      logger.warn('me.is_group_manager_lookup_exception', {
        requestId,
        memberId: user.sub,
        error: err instanceof Error ? err.message : String(err),
      })
      safe.isGroupManager = false
    }
  }

  res.setHeader('Cache-Control', 'no-store')
  res.status(200).json({ user: safe })
}

export const meHandler: ApiHandler = meCore
export { meCore as __meCore }
