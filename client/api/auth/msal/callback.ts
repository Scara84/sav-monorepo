import { createHash } from 'node:crypto'
import { exchangeCode, extractIdentity } from '../../_lib/auth/msal'
import { clearCookie } from '../../_lib/auth/cookies'
import { readCookie } from '../../_lib/middleware/with-auth'
import { findActiveOperator, operatorToSessionUser, logAuthEvent } from '../../_lib/auth/operator'
import { issueSessionCookie, OPERATOR_SESSION_TTL_SEC } from '../../_lib/auth/session'
import { ensureRequestId } from '../../_lib/request-id'
import { logger } from '../../_lib/logger'
import { sendError } from '../../_lib/errors'
import type { ApiRequest, ApiResponse } from '../../_lib/types'

/**
 * GET /api/auth/msal/callback?code=...&state=...
 * - Valide state (anti CSRF) contre cookie `sav_msal_pkce`
 * - Échange code → token via MSAL
 * - Lookup operators (azure_oid, is_active=true)
 *   - si trouvé → émet cookie session 8 h + redirect vers /admin
 *   - sinon → insère auth_events msal_denied, retourne HTML 403
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  const requestId = ensureRequestId(req)
  if (req.method !== 'GET') {
    sendError(res, 'VALIDATION_FAILED', 'Méthode non supportée', requestId)
    return
  }

  const base = process.env['APP_BASE_URL']
  const sessionSecret = process.env['SESSION_COOKIE_SECRET']
  if (!base || !sessionSecret) {
    logger.error('APP_BASE_URL ou SESSION_COOKIE_SECRET manquant', { requestId })
    sendError(res, 'SERVER_ERROR', 'Configuration manquante', requestId)
    return
  }
  const redirectUri = `${base.replace(/\/$/, '')}/api/auth/msal/callback`

  const code = stringParam(req.query?.['code'])
  const state = stringParam(req.query?.['state'])
  if (!code || !state) {
    sendError(res, 'VALIDATION_FAILED', 'Paramètres OAuth manquants', requestId)
    return
  }

  const pkceRaw = readCookie(req, 'sav_msal_pkce')
  if (!pkceRaw) {
    sendError(res, 'UNAUTHENTICATED', 'Cookie PKCE absent ou expiré', requestId)
    return
  }
  let pkce: { state?: unknown; verifier?: unknown }
  try {
    pkce = JSON.parse(pkceRaw)
  } catch {
    sendError(res, 'UNAUTHENTICATED', 'Cookie PKCE invalide', requestId)
    return
  }
  if (typeof pkce.state !== 'string' || typeof pkce.verifier !== 'string' || pkce.state !== state) {
    sendError(res, 'UNAUTHENTICATED', 'State OAuth non concordant', requestId)
    return
  }

  // Échange du code
  let identity: { azureOid: string; email: string; displayName: string }
  try {
    const tokens = await exchangeCode({ code, redirectUri, pkceVerifier: pkce.verifier })
    identity = extractIdentity(tokens)
  } catch (err) {
    logger.warn('MSAL exchange failed', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    })
    sendError(res, 'UNAUTHENTICATED', 'Échec échange OAuth', requestId)
    return
  }

  // Lookup operator
  const operator = await findActiveOperator(identity.azureOid)
  const pkceClear = clearCookie('sav_msal_pkce', {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
  })

  if (!operator) {
    const deniedEvent: Parameters<typeof logAuthEvent>[0] = {
      eventType: 'msal_denied',
      emailHash: createHash('sha256').update(identity.email).digest('hex'),
      metadata: { azure_oid: identity.azureOid, reason: 'not_in_operators_or_inactive' },
    }
    const ua = readUserAgent(req)
    if (ua) deniedEvent.userAgent = ua
    await logAuthEvent(deniedEvent).catch((err) =>
      logger.error('auth_events insert failed', {
        requestId,
        error: err instanceof Error ? err.message : String(err),
      })
    )
    res.setHeader('Set-Cookie', pkceClear)
    res
      .status(403)
      .setHeader('Content-Type', 'text/html; charset=utf-8')
      .end(
        `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Accès non autorisé</title></head><body style="font-family:system-ui;max-width:480px;margin:4rem auto;text-align:center"><h1>Accès non autorisé</h1><p>Votre compte Microsoft n'est pas autorisé à utiliser cette application.</p><p>Contactez l'administrateur SAV Fruitstock.</p></body></html>`
      )
    return
  }

  // Session signée, redirect /admin
  const sessionCookie = issueSessionCookie({
    user: operatorToSessionUser(operator),
    ttlSec: OPERATOR_SESSION_TTL_SEC,
    secret: sessionSecret,
  })

  const loginEvent: Parameters<typeof logAuthEvent>[0] = {
    eventType: 'msal_login',
    operatorId: operator.id,
    emailHash: createHash('sha256').update(operator.email).digest('hex'),
  }
  const loginUa = readUserAgent(req)
  if (loginUa) loginEvent.userAgent = loginUa
  await logAuthEvent(loginEvent).catch((err) =>
    logger.error('auth_events insert failed', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    })
  )

  res.setHeader('Set-Cookie', [pkceClear, sessionCookie] as unknown as string)
  res.setHeader('Location', '/admin')
  res.status(302).end()
}

function stringParam(v: string | string[] | undefined): string | undefined {
  if (typeof v === 'string') return v
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0]
  return undefined
}

function readUserAgent(req: ApiRequest): string | undefined {
  const ua = req.headers['user-agent']
  return Array.isArray(ua) ? ua[0] : ua
}
