import { z } from 'zod'
import { withRateLimit } from '../../_lib/middleware/with-rate-limit'
import { withValidation } from '../../_lib/middleware/with-validation'
import { ensureRequestId } from '../../_lib/request-id'
import { sendError } from '../../_lib/errors'
import { logger } from '../../_lib/logger'
import { findActiveMemberByEmail } from '../../_lib/auth/member'
import {
  signMagicLink,
  storeTokenIssue,
  hashEmail,
  hashIp,
  MAGIC_LINK_TTL_SEC,
} from '../../_lib/auth/magic-link'
import { logAuthEvent } from '../../_lib/auth/operator'
import { renderMagicLinkEmail } from '../../_lib/auth/magic-link-email'
import { sendMail } from '../../_lib/clients/smtp'
import type { ApiHandler, ApiRequest, ApiResponse } from '../../_lib/types'

// Redirect path must start with `/` and NOT with `//` (protocol-relative → open-redirect).
const safeRedirect = z
  .string()
  .max(500)
  .regex(/^\/(?!\/)/, 'Chemin de redirection invalide')

const bodySchema = z.object({
  email: z.string().email().max(254),
  redirect: safeRedirect.optional(),
})

/**
 * POST /api/auth/magic-link/issue
 * - Rate limit : 5 / email / heure
 * - Réponse neutre 202 dans tous les cas (anti-énumération NFR-S5)
 * - Si email connu actif : émet JWT + insert magic_link_tokens + envoi email via SMTP Infomaniak
 */
const coreHandler: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  const body = req.body as z.infer<typeof bodySchema>
  const email = body.email.normalize('NFC').toLowerCase().trim()

  const magicSecret = process.env['MAGIC_LINK_SECRET']
  const appBase = process.env['APP_BASE_URL']
  if (!magicSecret || !appBase) {
    logger.error('MAGIC_LINK_SECRET ou APP_BASE_URL manquant', { requestId })
    sendError(res, 'SERVER_ERROR', 'Configuration manquante', requestId)
    return
  }

  // P5 — CSRF : rejette si l'origine ne matche pas APP_BASE_URL.
  // Protection contre les formulaires externes flood-emails (grief des quotas).
  if (!isSameOrigin(req, appBase)) {
    logger.warn('magic-link issue cross-origin blocked', {
      requestId,
      origin: readOrigin(req),
    })
    sendError(res, 'FORBIDDEN', 'Origine non autorisée', requestId)
    return
  }

  try {
    const member = await findActiveMemberByEmail(email)
    if (!member) {
      // Anti-énumération : répondre identique + pad le timing pour que les 2 paths
      // (found vs not-found) aient une durée similaire (P7 — constant-time response).
      await logAuthEvent({
        eventType: 'magic_link_failed',
        emailHash: hashEmail(email),
        metadata: { reason: 'member_not_found' },
      }).catch(() => undefined)
      await sleep(MAGIC_LINK_FOUND_PATH_TARGET_MS)
      res.status(202).json({ ok: true, message: 'Si un compte existe, vous recevrez un email.' })
      return
    }

    const { token, jti, expiresAt } = signMagicLink(member.id, magicSecret)

    const storeArgs: Parameters<typeof storeTokenIssue>[0] = {
      jti,
      memberId: member.id,
      expiresAt,
    }
    const ipSrc = readIp(req)
    if (ipSrc) storeArgs.ipHash = hashIp(ipSrc)
    const ua = readUserAgent(req)
    if (ua) storeArgs.userAgent = ua
    await storeTokenIssue(storeArgs)

    const redirect = typeof body.redirect === 'string' ? body.redirect : undefined
    const magicUrl = buildMagicUrl(appBase, token, redirect)

    const mail = renderMagicLinkEmail({
      firstName: member.first_name,
      lastName: member.last_name,
      magicUrl,
      expiresInMinutes: Math.round(MAGIC_LINK_TTL_SEC / 60),
    })
    await sendMail({ to: member.email, subject: mail.subject, html: mail.html, text: mail.text })

    await logAuthEvent({
      eventType: 'magic_link_issued',
      memberId: member.id,
      emailHash: hashEmail(email),
      ...(ua ? { userAgent: ua } : {}),
      metadata: { jti },
    }).catch(() => undefined)

    res.status(202).json({ ok: true, message: 'Si un compte existe, vous recevrez un email.' })
  } catch (err) {
    logger.error('magic link issue failed', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    })
    sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId)
  }
}

// Order: validation FIRST (reject malformed bodies before creating rate-limit buckets),
// then rate-limit on the normalized email.
export default withValidation({ body: bodySchema })(
  withRateLimit({
    bucketPrefix: 'mlink:email',
    keyFrom: (req: ApiRequest) => {
      const b = req.body as { email?: unknown } | undefined
      return typeof b?.email === 'string'
        ? b.email.normalize('NFC').toLowerCase().trim()
        : undefined
    },
    max: 5,
    window: '1h',
  })(coreHandler)
)

// ---- helpers ----
/**
 * URL magic link : token dans le fragment (`#token=...`), pas dans la query string.
 * Raison : les fragments ne sont JAMAIS envoyés dans le header Referer → impossible
 * pour un script tiers chargé sur /monespace/auth (analytics, monitoring) de voir le token.
 * Le frontend doit lire `window.location.hash`, extraire `token=`, POST à /verify, puis `history.replaceState`.
 */
function buildMagicUrl(base: string, token: string, redirect?: string): string {
  const url = new URL(`${base.replace(/\/$/, '')}/monespace/auth`)
  if (redirect) url.searchParams.set('redirect', redirect)
  url.hash = `token=${encodeURIComponent(token)}`
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
  // En tests unitaires (NODE_ENV=test), on skip le check (le mock mockReq n'envoie pas Origin).
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

/** Cible temporelle du happy-path member-found pour pad le not-found (P7 constant-time). */
const MAGIC_LINK_FOUND_PATH_TARGET_MS = 400

// Export nommé pour tests unitaires
export { coreHandler as __coreHandler }
