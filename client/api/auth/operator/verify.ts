import { z } from 'zod'
import { withValidation } from '../../_lib/middleware/with-validation'
import { withRateLimit } from '../../_lib/middleware/with-rate-limit'
import { sendError } from '../../_lib/errors'
import { ensureRequestId } from '../../_lib/request-id'
import { hashIp } from '../../_lib/auth/magic-link'
import { logAuthEvent } from '../../_lib/auth/operator'
import type { ApiHandler, ApiRequest, ApiResponse } from '../../_lib/types'

const querySchema = z.object({
  token: z.string().min(20).max(4096),
})

/**
 * GET /api/auth/operator/verify?token=<jwt>
 *
 * H-19 ferme le magic-link opérateur legacy. Un token présenté ici ne peut
 * plus ouvrir de session back-office, même s'il est signé ou présent en DB.
 */
const coreHandler: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)

  if (req.method !== 'GET') {
    sendError(res, 'METHOD_NOT_ALLOWED', 'GET attendu', requestId)
    return
  }

  const ua = readUserAgent(req)
  const ipSrc = readIp(req)
  const ipHash = ipSrc ? hashIp(ipSrc) : undefined

  await logAuthEvent({
    eventType: 'operator_magic_link_failed',
    ...(ipHash ? { ipHash } : {}),
    ...(ua ? { userAgent: ua } : {}),
    metadata: { reason: 'operator_magic_link_disabled' },
  }).catch(() => undefined)

  redirectToLoginError(res, 'invalid')
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
