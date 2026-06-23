import { z } from 'zod'
import { withValidation } from '../../_lib/middleware/with-validation'
import { withRateLimit } from '../../_lib/middleware/with-rate-limit'
import { sendError } from '../../_lib/errors'
import { ensureRequestId } from '../../_lib/request-id'
import { logger } from '../../_lib/logger'
import {
  verifyMagicLink,
  consumeToken,
  findTokenByJti,
  hashEmail,
} from '../../_lib/auth/magic-link'
import { logAuthEvent } from '../../_lib/auth/operator'
import { issueSessionCookie, MEMBER_SESSION_TTL_SEC } from '../../_lib/auth/session'
import { supabaseAdmin } from '../../_lib/clients/supabase-admin'
import type { ApiHandler, ApiRequest } from '../../_lib/types'

// Redirect path must start with `/` and NOT with `//` (protocol-relative → open-redirect).
const safeRedirect = z
  .string()
  .max(500)
  .regex(/^\/(?!\/)/, 'Chemin de redirection invalide')

const bodySchema = z.object({
  token: z.string().min(10).max(4096),
  redirect: safeRedirect.optional(),
})

/**
 * POST /api/auth/magic-link/verify
 * - Vérifie signature + TTL JWT (MAGIC_LINK_SECRET)
 * - Marque jti consommé (idempotent)
 * - Émet cookie session 24 h + retourne redirect path
 *
 * Codes d'erreur :
 *   401 LINK_EXPIRED    — JWT exp < now
 *   410 LINK_CONSUMED   — jti déjà consommé
 *   401 UNAUTHENTICATED — signature KO ou jti inconnu
 */
const coreHandler: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  const body = req.body as z.infer<typeof bodySchema>

  const magicSecret = process.env['MAGIC_LINK_SECRET']
  const sessionSecret = process.env['SESSION_COOKIE_SECRET']
  if (!magicSecret || !sessionSecret) {
    logger.error('MAGIC_LINK_SECRET ou SESSION_COOKIE_SECRET manquant', { requestId })
    sendError(res, 'SERVER_ERROR', 'Configuration manquante', requestId)
    return
  }

  const ua = readUserAgent(req)
  const verified = verifyMagicLink(body.token, magicSecret)
  if (!verified.ok) {
    // Le build Vercel des Serverless Functions fait parfois un narrowing
    // défaillant sur les discriminated unions depuis un module importé.
    // `in` operator est plus portable (Vercel ET vue-tsc OK).
    const reason = 'reason' in verified ? (verified as { reason: string }).reason : 'unknown'
    if (reason === 'expired') {
      await logAuthEvent({
        eventType: 'magic_link_failed',
        metadata: { reason: 'expired' },
        ...(ua ? { userAgent: ua } : {}),
      }).catch(() => undefined)
      sendError(res, 'LINK_EXPIRED', 'Lien expiré', requestId)
      return
    }
    await logAuthEvent({
      eventType: 'magic_link_failed',
      metadata: { reason },
      ...(ua ? { userAgent: ua } : {}),
    }).catch(() => undefined)
    sendError(res, 'UNAUTHENTICATED', 'Lien invalide', requestId)
    return
  }

  // Cross-use protection (Story 5.8 CR fix) : un token operator ne doit pas
  // pouvoir ouvrir une session member, même si la signature JWT est valide
  // (`MAGIC_LINK_SECRET` est partagé entre les deux endpoints).
  // Pour les tokens pré-Story-5.8 (kind absent), la BDD `target_kind` rattrape ci-dessous.
  if (verified.payload.kind !== undefined && verified.payload.kind !== 'member') {
    await logAuthEvent({
      eventType: 'magic_link_failed',
      metadata: { reason: 'kind_mismatch', kind: verified.payload.kind },
      ...(ua ? { userAgent: ua } : {}),
    }).catch(() => undefined)
    sendError(res, 'UNAUTHENTICATED', 'Lien invalide', requestId)
    return
  }

  // Vérifier que le jti existe en BDD et n'est pas consommé
  const stored = await findTokenByJti(verified.payload.jti)
  if (!stored) {
    sendError(res, 'UNAUTHENTICATED', 'Lien inconnu', requestId)
    return
  }
  // Defense-in-depth (Story 5.8) : rejette aussi un row dont target_kind n'est pas 'member',
  // utile pour les tokens pré-5.8 dont le payload n'a pas de `kind` mais dont la row DB
  // serait `target_kind='operator'` (impossible en pratique mais protège contre bug futur).
  if (stored.target_kind !== 'member') {
    await logAuthEvent({
      eventType: 'magic_link_failed',
      metadata: { reason: 'wrong_target_kind', target_kind: stored.target_kind },
      ...(ua ? { userAgent: ua } : {}),
    }).catch(() => undefined)
    sendError(res, 'UNAUTHENTICATED', 'Lien invalide', requestId)
    return
  }
  if (stored.used_at !== null) {
    sendError(res, 'LINK_CONSUMED', 'Lien déjà utilisé', requestId)
    return
  }

  // Consommation atomique (UPDATE WHERE used_at IS NULL)
  const consumed = await consumeToken(verified.payload.jti)
  if (!consumed) {
    // Race condition : quelqu'un d'autre vient de le consommer
    sendError(res, 'LINK_CONSUMED', 'Lien déjà utilisé', requestId)
    return
  }

  // Récupère scope member → session
  const { data: member, error } = await supabaseAdmin()
    .from('members')
    .select('id, email, group_id, is_group_manager')
    .eq('id', verified.payload.sub)
    .is('anonymized_at', null)
    .maybeSingle()
  if (error || !member) {
    sendError(res, 'UNAUTHENTICATED', 'Compte introuvable', requestId)
    return
  }
  const memberRow = member as {
    id: number
    email: string
    group_id: number | null
    is_group_manager: boolean
  }

  const sessionCookie = issueSessionCookie({
    user: {
      sub: memberRow.id,
      type: 'member',
      email: memberRow.email,
      role: memberRow.is_group_manager ? 'group-manager' : 'member',
      scope: memberRow.is_group_manager ? 'group' : 'self',
      ...(memberRow.group_id !== null ? { groupId: memberRow.group_id } : {}),
    },
    ttlSec: MEMBER_SESSION_TTL_SEC,
    secret: sessionSecret,
  })

  await logAuthEvent({
    eventType: 'magic_link_verified',
    memberId: memberRow.id,
    emailHash: hashEmail(memberRow.email),
    ...(ua ? { userAgent: ua } : {}),
    metadata: { jti: verified.payload.jti },
  }).catch(() => undefined)

  res.setHeader('Set-Cookie', sessionCookie)
  const redirect = body.redirect ?? '/monespace'
  res.status(200).json({ ok: true, redirect })
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

// P6 — rate-limit anti-brute-force sur /verify. Clé IP, 20 tentatives/heure.
// Chaîne : validation → rate-limit → core. La validation passe en premier pour
// rejeter les bodies malformés sans toucher aux buckets.
export default withValidation({ body: bodySchema })(
  withRateLimit({
    bucketPrefix: 'mlink:verify:ip',
    keyFrom: (req) => readIp(req) ?? 'unknown',
    max: 20,
    window: '1h',
  })(coreHandler)
)

export { coreHandler as __coreHandler }
