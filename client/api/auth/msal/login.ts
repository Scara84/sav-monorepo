import { buildAuthUrl, generatePkce, generateState } from '../../_lib/auth/msal'
import { serializeCookie } from '../../_lib/auth/cookies'
import { ensureRequestId } from '../../_lib/request-id'
import { logger } from '../../_lib/logger'
import { sendError } from '../../_lib/errors'
import type { ApiRequest, ApiResponse } from '../../_lib/types'

/**
 * GET /api/auth/msal/login
 * - Génère state + PKCE verifier
 * - Stocke les deux dans un cookie HttpOnly court (10 min)
 * - Redirige 302 vers Microsoft authorize URL
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  const requestId = ensureRequestId(req)
  if (req.method !== 'GET') {
    sendError(res, 'VALIDATION_FAILED', 'Méthode non supportée', requestId)
    return
  }

  const base = process.env['APP_BASE_URL']
  if (!base) {
    logger.error('APP_BASE_URL manquant', { requestId })
    sendError(res, 'SERVER_ERROR', 'Configuration manquante', requestId)
    return
  }
  const redirectUri = `${base.replace(/\/$/, '')}/api/auth/msal/callback`

  try {
    const state = generateState()
    const { verifier, challenge } = generatePkce()
    const authUrl = await buildAuthUrl({ redirectUri, state, pkceChallenge: challenge })

    // Stocke state + verifier dans un cookie HttpOnly 10 min
    const pkceCookie = serializeCookie('sav_msal_pkce', JSON.stringify({ state, verifier }), {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 600,
    })

    res.setHeader('Set-Cookie', pkceCookie)
    res.setHeader('Location', authUrl)
    res.status(302).end()
  } catch (err) {
    logger.error('MSAL login setup failed', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    })
    sendError(res, 'SERVER_ERROR', 'Initialisation SSO impossible', requestId)
  }
}
