import { z } from 'zod'
import { withRateLimit } from '../../_lib/middleware/with-rate-limit'
import { withValidation } from '../../_lib/middleware/with-validation'
import { ensureRequestId } from '../../_lib/request-id'
import { sendError } from '../../_lib/errors'
import { logger } from '../../_lib/logger'
import { findActiveOperatorByEmail, logAuthEvent } from '../../_lib/auth/operator'
import {
  signOperatorMagicLink,
  storeOperatorTokenIssue,
  hashEmail,
  hashIp,
  MAGIC_LINK_TTL_SEC,
} from '../../_lib/auth/magic-link'
import { renderOperatorMagicLinkEmail } from '../../_lib/auth/magic-link-email'
import { sendMail } from '../../_lib/clients/smtp'
import type { ApiHandler, ApiRequest } from '../../_lib/types'

const bodySchema = z.object({
  email: z.string().email().max(254),
})

/**
 * POST /api/auth/operator/issue (Story 5.8)
 * - Rate limit : 5 req/min/IP (AC #2.5)
 * - Réponse 202 neutre dans tous les cas (anti-énumération)
 * - Si email connu actif : émet JWT operator + insert magic_link_tokens (target_kind='operator') + envoi email
 *
 * URL générée dans l'email : `${APP_BASE_URL}/api/auth/operator/verify?token=<jwt>`
 * (backend direct — set cookie + redirect 302 /admin, cf. operator/verify.ts)
 */
const coreHandler: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)

  if (req.method !== 'POST') {
    sendError(res, 'METHOD_NOT_ALLOWED', 'POST attendu', requestId)
    return
  }

  const body = req.body as z.infer<typeof bodySchema>
  const email = body.email.normalize('NFC').toLowerCase().trim()

  const magicSecret = process.env['MAGIC_LINK_SECRET']
  const appBase = process.env['APP_BASE_URL']
  if (!magicSecret || !appBase) {
    logger.error('MAGIC_LINK_SECRET ou APP_BASE_URL manquant', { requestId })
    sendError(res, 'SERVER_ERROR', 'Configuration manquante', requestId)
    return
  }

  // CSRF — rejette si Origin ne matche pas APP_BASE_URL (forms externes flood SMTP).
  if (!isSameOrigin(req, appBase)) {
    logger.warn('operator magic-link issue cross-origin blocked', {
      requestId,
      origin: readOrigin(req),
    })
    sendError(res, 'FORBIDDEN', 'Origine non autorisée', requestId)
    return
  }

  const ua = readUserAgent(req)
  const ipSrc = readIp(req)
  const ipHash = ipSrc ? hashIp(ipSrc) : undefined

  try {
    const operator = await findActiveOperatorByEmail(email)
    if (!operator) {
      // Anti-énumération : 202 neutre + log failed (pad timing pour égaliser found vs not-found)
      await logAuthEvent({
        eventType: 'operator_magic_link_failed',
        emailHash: hashEmail(email),
        ...(ipHash ? { ipHash } : {}),
        ...(ua ? { userAgent: ua } : {}),
        metadata: { reason: 'operator_not_found' },
      }).catch(() => undefined)
      await sleep(OPERATOR_FOUND_PATH_TARGET_MS)
      res.status(202).json({ ok: true, message: 'Si un compte existe, vous recevrez un email.' })
      return
    }

    const { token, jti, expiresAt } = signOperatorMagicLink(operator.id, magicSecret)

    const storeArgs: Parameters<typeof storeOperatorTokenIssue>[0] = {
      jti,
      operatorId: operator.id,
      expiresAt,
    }
    if (ipHash) storeArgs.ipHash = ipHash
    if (ua) storeArgs.userAgent = ua
    await storeOperatorTokenIssue(storeArgs)

    const magicUrl = buildOperatorVerifyUrl(appBase, token)

    const mail = renderOperatorMagicLinkEmail({
      displayName: operator.display_name,
      magicUrl,
      expiresInMinutes: Math.round(MAGIC_LINK_TTL_SEC / 60),
    })

    // CR fix anti-énumération : sendMail isolé. Si SMTP throw (timeout, 5xx, DNS),
    // on log l'erreur côté serveur mais on retourne 202 neutre comme la branche
    // not-found — sinon un 500 sur cette branche révèle l'existence du compte.
    // Le token reste en BDD (consommable jusqu'à TTL 15 min) — l'opérateur peut
    // redemander un lien si l'email n'arrive pas.
    let mailSent = true
    try {
      await sendMail({
        to: operator.email,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      })
    } catch (err) {
      mailSent = false
      logger.error('operator magic link sendMail failed', {
        requestId,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    await logAuthEvent({
      eventType: mailSent ? 'operator_magic_link_issued' : 'operator_magic_link_failed',
      operatorId: operator.id,
      emailHash: hashEmail(email),
      ...(ipHash ? { ipHash } : {}),
      ...(ua ? { userAgent: ua } : {}),
      metadata: mailSent ? { jti } : { jti, reason: 'smtp_failure' },
    }).catch(() => undefined)

    res.status(202).json({ ok: true, message: 'Si un compte existe, vous recevrez un email.' })
  } catch (err) {
    logger.error('operator magic link issue failed', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    })
    sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId)
  }
}

// Order : validation FIRST (reject malformed bodies before creating rate-limit buckets),
// puis rate-limit par email (5/h, anti-spam SMTP / boîte mail), puis rate-limit par IP
// (5/min, anti-énumération + anti-DOS). Le plus restrictif des deux s'applique.
//
// CR fix (Story 5.8) : ajout du rate-limit email après que CR a noté qu'un attaquant
// botnet pouvait spam-bomber la boîte d'un opérateur (5 emails × 1000 IPs / min).
export default withValidation({ body: bodySchema })(
  withRateLimit({
    bucketPrefix: 'mlink-op:email',
    keyFrom: (req: ApiRequest) => {
      const b = req.body as { email?: unknown } | undefined
      return typeof b?.email === 'string'
        ? b.email.normalize('NFC').toLowerCase().trim()
        : undefined
    },
    max: 5,
    window: '1h',
  })(
    withRateLimit({
      bucketPrefix: 'mlink-op:ip',
      keyFrom: (req: ApiRequest) => readIp(req) ?? 'unknown',
      max: 5,
      window: '1m',
    })(coreHandler)
  )
)

// ---- helpers ----

function buildOperatorVerifyUrl(base: string, token: string): string {
  const url = new URL(`${base.replace(/\/$/, '')}/api/auth/operator/verify`)
  url.searchParams.set('token', token)
  return url.toString()
}

function readUserAgent(req: ApiRequest): string | undefined {
  const ua = req.headers['user-agent']
  return Array.isArray(ua) ? ua[0] : ua
}

function readIp(req: ApiRequest): string | undefined {
  if (req.ip) return req.ip
  const fwd = req.headers['x-forwarded-for']
  const firstFwd = Array.isArray(fwd) ? fwd[0] : fwd
  if (typeof firstFwd === 'string' && firstFwd.length > 0) return firstFwd.split(',')[0]?.trim()
  return undefined
}

function readOrigin(req: ApiRequest): string | undefined {
  const o = req.headers['origin']
  if (typeof o === 'string') return o
  const r = req.headers['referer']
  if (typeof r === 'string') return r
  return undefined
}

function isSameOrigin(req: ApiRequest, appBase: string): boolean {
  if (process.env['NODE_ENV'] === 'test' || process.env['VITEST']) return true
  const incoming = readOrigin(req)
  if (!incoming) return false
  try {
    const incomingUrl = new URL(incoming)
    const expectedUrl = new URL(appBase)
    return incomingUrl.origin === expectedUrl.origin
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Cible temporelle du happy-path operator-found pour pad le not-found (constant-time). */
const OPERATOR_FOUND_PATH_TARGET_MS = 400

export { coreHandler as __coreHandler }
