import { sendError } from '../../_lib/errors'
import { operatorPasswordLoginHandler } from '../../_lib/auth/operator-login-handler'
import { ensureRequestId } from '../../_lib/request-id'
import type { ApiHandler } from '../../_lib/types'

/**
 * POST /api/auth/operator/issue
 *
 * H-19 désactive le magic-link opérateur legacy. Le seul chemin back-office
 * autorisé est le login email + mot de passe, exposé par rewrite Vercel via
 * /api/auth/operator/login -> /api/auth/operator/issue?op=password-login.
 *
 * Les endpoints adhérents /api/auth/magic-link/* restent séparés et inchangés.
 */
const dispatchHandler: ApiHandler = (req, res) => {
  const op = Array.isArray(req.query?.['op']) ? req.query?.['op'][0] : req.query?.['op']
  if (op === 'password-login') return operatorPasswordLoginHandler(req, res)
  return disabledOperatorMagicLinkHandler(req, res)
}

const disabledOperatorMagicLinkHandler: ApiHandler = (req, res) => {
  const requestId = ensureRequestId(req)
  if (req.method !== 'POST') {
    sendError(res, 'METHOD_NOT_ALLOWED', 'POST attendu', requestId)
    return
  }
  sendError(res, 'NOT_FOUND', 'Authentification opérateur par mot de passe requise', requestId)
}

export default dispatchHandler
