import { sendError } from '../errors'
import { ensureRequestId } from '../request-id'
import type { ApiHandler, ApiRequest, ApiResponse, SessionUser } from '../types'

export interface WithRbacOptions {
  roles: Array<NonNullable<SessionUser['role']>>
}

/**
 * Vérifie que `req.user.role` ∈ options.roles.
 * **Doit être appelé APRÈS withAuth** (dépend de `req.user`).
 * - 401 UNAUTHENTICATED si `req.user` absent (auth n'a pas tourné).
 * - 403 FORBIDDEN si le rôle ne matche pas.
 */
export function withRbac(options: WithRbacOptions) {
  return (handler: ApiHandler): ApiHandler =>
    async (req: ApiRequest, res: ApiResponse) => {
      const requestId = ensureRequestId(req)
      if (!req.user) {
        sendError(res, 'UNAUTHENTICATED', 'withRbac requiert withAuth en amont', requestId)
        return
      }
      if (!req.user.role || !options.roles.includes(req.user.role)) {
        sendError(res, 'FORBIDDEN', 'Rôle insuffisant', requestId)
        return
      }
      return handler(req, res)
    }
}
