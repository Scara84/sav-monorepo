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

const bodySchema = z.object({
  email: z.string().email().max(254),
  redirect: z.string().startsWith('/').max(500).optional(),
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
  const email = body.email.toLowerCase().trim()

  const magicSecret = process.env['MAGIC_LINK_SECRET']
  const appBase = process.env['APP_BASE_URL']
  if (!magicSecret || !appBase) {
    logger.error('MAGIC_LINK_SECRET ou APP_BASE_URL manquant', { requestId })
    sendError(res, 'SERVER_ERROR', 'Configuration manquante', requestId)
    return
  }

  try {
    const member = await findActiveMemberByEmail(email)
    if (!member) {
      // Anti-énumération : répondre identique
      await logAuthEvent({
        eventType: 'magic_link_failed',
        emailHash: hashEmail(email),
        metadata: { reason: 'member_not_found' },
      }).catch(() => undefined)
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

export default withRateLimit({
  bucketPrefix: 'mlink:email',
  keyFrom: (req: ApiRequest) => {
    const b = req.body as { email?: unknown } | undefined
    return typeof b?.email === 'string' ? b.email.toLowerCase().trim() : undefined
  },
  max: 5,
  window: '1h',
})(withValidation({ body: bodySchema })(coreHandler))

// ---- helpers ----
function buildMagicUrl(base: string, token: string, redirect?: string): string {
  const url = new URL(`${base.replace(/\/$/, '')}/monespace/auth`)
  url.searchParams.set('token', token)
  if (redirect) url.searchParams.set('redirect', redirect)
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

// Export nommé pour tests unitaires
export { coreHandler as __coreHandler }
