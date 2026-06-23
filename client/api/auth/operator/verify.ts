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
  hashIp,
  isSafeReturnTo,
} from '../../_lib/auth/magic-link'
import { findOperatorById, logAuthEvent, operatorToSessionUser } from '../../_lib/auth/operator'
import { issueSessionCookie, OPERATOR_SESSION_TTL_SEC } from '../../_lib/auth/session'
import type { ApiHandler, ApiRequest, ApiResponse } from '../../_lib/types'

const querySchema = z.object({
  token: z.string().min(20).max(4096),
})

/**
 * GET /api/auth/operator/verify?token=<jwt> (Story 5.8)
 *
 * - Vérifie signature + TTL JWT (MAGIC_LINK_SECRET) + kind='operator'
 * - Marque jti consommé (idempotent)
 * - Émet cookie session (TTL = OPERATOR_SESSION_TTL_HOURS * 3600, défaut 8h)
 * - Redirect 302 vers returnTo (claim JWT) ou /admin sur succès
 *
 * Codes d'erreur (H-04 AC#1 : redirect 302 /admin/login?error=<code>) :
 *   expired  — JWT exp < now
 *   consumed — jti déjà consommé
 *   invalid  — bad_signature, malformed, bad_payload, jti inconnu, kind mismatch, opérateur désactivé
 *
 * Exceptions conservées en JSON sendError (PATTERN-H04-VERIFY-REDIRECT-VS-JSON-ERROR) :
 *   400 — token absent/malformé (Zod) → pas un opérateur légitime
 *   405 — METHOD_NOT_ALLOWED → dev/crawler
 *   500 — SERVER_ERROR → config cassée, un redirect masquerait l'incident
 */
const coreHandler: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)

  if (req.method !== 'GET') {
    sendError(res, 'METHOD_NOT_ALLOWED', 'GET attendu', requestId)
    return
  }

  const query = req.query as { token: string }
  const token = query.token

  const magicSecret = process.env['MAGIC_LINK_SECRET']
  const sessionSecret = process.env['SESSION_COOKIE_SECRET']
  if (!magicSecret || !sessionSecret) {
    logger.error('MAGIC_LINK_SECRET ou SESSION_COOKIE_SECRET manquant', { requestId })
    sendError(res, 'SERVER_ERROR', 'Configuration manquante', requestId)
    return
  }

  const ua = readUserAgent(req)
  const ipSrc = readIp(req)
  const ipHash = ipSrc ? hashIp(ipSrc) : undefined

  const verified = verifyMagicLink(token, magicSecret)
  if (!verified.ok) {
    const reason = verified.reason
    if (reason === 'expired') {
      await logAuthEvent({
        eventType: 'operator_magic_link_failed',
        ...(ipHash ? { ipHash } : {}),
        ...(ua ? { userAgent: ua } : {}),
        metadata: { reason: 'expired' },
      }).catch(() => undefined)
      // H-04 AC#1 : redirect 302 /admin/login?error=expired
      redirectToLoginError(res, 'expired')
      return
    }
    await logAuthEvent({
      eventType: 'operator_magic_link_failed',
      ...(ipHash ? { ipHash } : {}),
      ...(ua ? { userAgent: ua } : {}),
      metadata: { reason },
    }).catch(() => undefined)
    // H-04 AC#1 : signature KO, malformed, bad_payload → code 'invalid'
    redirectToLoginError(res, 'invalid')
    return
  }

  // Cross-use protection : un token adhérent ne peut pas ouvrir une session opérateur.
  // `kind` est optionnel pour rétrocompat (tokens pré-5.8) mais ces tokens
  // référencent member_id donc le check stored.target_kind ci-dessous les rejettera.
  if (verified.payload.kind !== undefined && verified.payload.kind !== 'operator') {
    await logAuthEvent({
      eventType: 'operator_magic_link_failed',
      ...(ipHash ? { ipHash } : {}),
      ...(ua ? { userAgent: ua } : {}),
      metadata: { reason: 'kind_mismatch', kind: verified.payload.kind },
    }).catch(() => undefined)
    // H-04 AC#1 : kind_mismatch → code 'invalid'
    redirectToLoginError(res, 'invalid')
    return
  }

  const stored = await findTokenByJti(verified.payload.jti)
  if (!stored) {
    await logAuthEvent({
      eventType: 'operator_magic_link_failed',
      ...(ipHash ? { ipHash } : {}),
      ...(ua ? { userAgent: ua } : {}),
      metadata: { reason: 'jti_unknown' },
    }).catch(() => undefined)
    // H-04 AC#1 : jti_unknown → code 'invalid'
    redirectToLoginError(res, 'invalid')
    return
  }
  if (stored.target_kind !== 'operator') {
    // Defense-in-depth : rejette un token member même si la signature est valide
    // (utile pour les tokens pré-5.8 sans `kind` dans le payload).
    await logAuthEvent({
      eventType: 'operator_magic_link_failed',
      ...(ipHash ? { ipHash } : {}),
      ...(ua ? { userAgent: ua } : {}),
      metadata: { reason: 'wrong_target_kind', target_kind: stored.target_kind },
    }).catch(() => undefined)
    // H-04 AC#1 : wrong_target_kind → code 'invalid'
    redirectToLoginError(res, 'invalid')
    return
  }
  if (stored.used_at !== null) {
    await logAuthEvent({
      eventType: 'operator_magic_link_failed',
      ...(ipHash ? { ipHash } : {}),
      ...(ua ? { userAgent: ua } : {}),
      metadata: { reason: 'already_consumed' },
    }).catch(() => undefined)
    // H-04 AC#1 : already_consumed → code 'consumed'
    redirectToLoginError(res, 'consumed')
    return
  }

  // CR fix anti-TOCTOU : consume AVANT le check is_active. Sinon entre la lecture
  // is_active=true et le UPDATE consume, l'admin peut désactiver le compte —
  // le UPDATE passe quand même (filtre WHERE used_at IS NULL), cookie émis 8h.
  // Avec consume d'abord : si désactivé entre consume et le check ci-dessous,
  // le token est foutu (single-use), mais aucune session n'est ouverte.
  const consumed = await consumeToken(verified.payload.jti)
  if (!consumed) {
    // Race condition (2 clicks simultanés) ou ré-consommation
    // H-04 AC#1 : race consumed → code 'consumed'
    redirectToLoginError(res, 'consumed')
    return
  }

  // Re-vérifie is_active APRÈS consume (un opérateur désactivé après émission
  // ne doit pas pouvoir ouvrir une session, même si le token était valide).
  const operator = await findOperatorById(verified.payload.sub)
  if (!operator || !operator.is_active) {
    await logAuthEvent({
      eventType: 'operator_magic_link_failed',
      ...(ipHash ? { ipHash } : {}),
      ...(ua ? { userAgent: ua } : {}),
      metadata: { reason: 'operator_disabled', jti_consumed: verified.payload.jti },
    }).catch(() => undefined)
    // H-04 AC#1 : operator_disabled → code 'invalid'
    redirectToLoginError(res, 'invalid')
    return
  }

  const ttlSec = readOperatorSessionTtlSec()
  const sessionCookie = issueSessionCookie({
    user: operatorToSessionUser(operator),
    ttlSec,
    secret: sessionSecret,
  })

  // H-04 AC#4 : lire le claim returnTo + re-valider defense-in-depth
  const claimedReturnTo = verified.payload.returnTo
  const safeReturnTo = isSafeReturnTo(claimedReturnTo) ? claimedReturnTo : '/admin'

  await logAuthEvent({
    eventType: 'operator_magic_link_verified',
    operatorId: operator.id,
    emailHash: hashEmail(operator.email),
    ...(ipHash ? { ipHash } : {}),
    ...(ua ? { userAgent: ua } : {}),
    // H-04 AC#4(c) : telemetry return_to_used
    metadata: {
      jti: verified.payload.jti,
      ttl_sec: ttlSec,
      return_to_used: safeReturnTo === '/admin' ? 'default' : 'custom',
    },
  }).catch(() => undefined)

  res.setHeader('Set-Cookie', sessionCookie)
  res.setHeader('Location', safeReturnTo)
  res.status(302).end()
}

/**
 * Lit OPERATOR_SESSION_TTL_HOURS (défaut OPERATOR_SESSION_TTL_SEC / 3600 = 8h).
 * AC #6 — paramétrable sans migration. Bornes [1, 24*7] (1h min, 1 semaine max).
 */
function readOperatorSessionTtlSec(): number {
  const raw = process.env['OPERATOR_SESSION_TTL_HOURS']
  if (!raw) return OPERATOR_SESSION_TTL_SEC
  const hours = Number.parseInt(raw, 10)
  if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 7) {
    logger.warn('OPERATOR_SESSION_TTL_HOURS invalide, fallback 8h', { raw })
    return OPERATOR_SESSION_TTL_SEC
  }
  return hours * 3600
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

// ---- helpers ----

/**
 * H-04 AC#1 (DN-2 Option A — inline verify.ts) — Redirige vers la page login
 * avec un code d'erreur contextualisé au lieu de renvoyer du JSON brut.
 *
 * Mapping reason → code URL (cf. AC#1(h)) :
 *   expired            → /admin/login?error=expired
 *   already_consumed   → /admin/login?error=consumed
 *   bad_signature | malformed | bad_payload | jti_unknown | kind_mismatch |
 *   wrong_target_kind | operator_disabled → /admin/login?error=invalid
 *
 * Note : extraire dans _lib/auth/redirect-helpers.ts si 2e callsite apparaît
 * (PATTERN-RULE-OF-THREE).
 */
function redirectToLoginError(res: ApiResponse, code: 'expired' | 'consumed' | 'invalid'): void {
  res.setHeader('Location', `/admin/login?error=${code}`)
  res.status(302).end()
}

// Rate-limit anti-brute-force : 20 tentatives/heure/IP (calque adhérent verify).
// Validation passe en premier pour rejeter les bodies malformés sans toucher aux buckets.
export default withValidation({ query: querySchema })(
  withRateLimit({
    bucketPrefix: 'mlink-op:verify:ip',
    keyFrom: (req) => readIp(req) ?? 'unknown',
    max: 20,
    window: '1h',
  })(coreHandler)
)

export { coreHandler as __coreHandler }
