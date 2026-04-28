import { createHash, createHmac, randomUUID } from 'node:crypto'
import { withRateLimit } from '../middleware/with-rate-limit'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { hashIp } from '../auth/magic-link'
import type { ApiHandler, ApiRequest } from '../types'

/**
 * Story 5.7 AC #9 — `GET /api/self-service/draft?op=submit-token`.
 *
 * Délivre un capture-token éphémère (JWT HS256, scope `sav-submit`, exp 5
 * min, single-use) que le front utilise pour appeler
 * `POST /api/webhooks/capture` avec `X-Capture-Token: <jwt>` à la place de
 * la signature HMAC `MAKE_WEBHOOK_HMAC_SECRET` (que le browser ne peut pas
 * calculer — secret server-side).
 *
 * Anonyme (pas d'auth, pas de cookie). Protections :
 *   - rate-limit 10 req/min/IP
 *   - INSERT row dans `sav_submit_tokens` (jti uuid, ip_hash, user_agent)
 *     pour la consume atomique côté capture.ts
 *   - jamais de jti / token loggé en clair
 */

export const SAV_SUBMIT_TOKEN_TTL_SEC = (() => {
  const raw = process.env['SAV_SUBMIT_TOKEN_TTL_SEC']
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 && n <= 3600 ? Math.floor(n) : 300
})()

export const SAV_SUBMIT_SCOPE = 'sav-submit' as const

interface CaptureTokenPayload {
  scope: typeof SAV_SUBMIT_SCOPE
  jti: string
  iat: number
  exp: number
}

function base64UrlEncode(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(s: string): string {
  const pad = '='.repeat((4 - (s.length % 4)) % 4)
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(b64, 'base64').toString('utf8')
}

export function signCaptureToken(jti: string, secret: string, now: number, ttlSec: number): string {
  const header = { alg: 'HS256', typ: 'JWT' }
  const payload: CaptureTokenPayload = {
    scope: SAV_SUBMIT_SCOPE,
    jti,
    iat: now,
    exp: now + ttlSec,
  }
  const h = base64UrlEncode(JSON.stringify(header))
  const p = base64UrlEncode(JSON.stringify(payload))
  const s = base64UrlEncode(createHmac('sha256', secret).update(`${h}.${p}`).digest())
  return `${h}.${p}.${s}`
}

export type VerifyCaptureResult =
  | { ok: true; payload: CaptureTokenPayload }
  | {
      ok: false
      reason: 'malformed' | 'bad_signature' | 'expired' | 'bad_payload' | 'invalid_scope'
    }

export function verifyCaptureToken(
  token: string,
  secret: string,
  now: number = Math.floor(Date.now() / 1000)
): VerifyCaptureResult {
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed' }
  const [h, p, s] = parts as [string, string, string]
  let header: { alg?: string; typ?: string }
  try {
    header = JSON.parse(base64UrlDecode(h))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (header.alg !== 'HS256') return { ok: false, reason: 'malformed' }
  // Story 5.7 patch P10 — durcir l'header : `typ` doit être 'JWT' ou absent.
  if (header.typ !== undefined && header.typ !== 'JWT') {
    return { ok: false, reason: 'malformed' }
  }

  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest()
  let given: Buffer
  try {
    const pad = '='.repeat((4 - (s.length % 4)) % 4)
    const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/')
    given = Buffer.from(b64, 'base64')
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (expected.length !== given.length) return { ok: false, reason: 'bad_signature' }
  // Comparaison constant-time
  let diff = 0
  for (let i = 0; i < expected.length; i++) {
    diff |= (expected[i] ?? 0) ^ (given[i] ?? 0)
  }
  if (diff !== 0) return { ok: false, reason: 'bad_signature' }

  let payload: unknown
  try {
    payload = JSON.parse(base64UrlDecode(p))
  } catch {
    return { ok: false, reason: 'bad_payload' }
  }
  if (!isCaptureTokenPayload(payload)) return { ok: false, reason: 'bad_payload' }
  if (payload.scope !== SAV_SUBMIT_SCOPE) return { ok: false, reason: 'invalid_scope' }
  if (payload.exp <= now) return { ok: false, reason: 'expired' }
  return { ok: true, payload }
}

/**
 * Consume atomique d'un capture-token : `UPDATE sav_submit_tokens SET used_at
 * = now() WHERE jti = $1 AND used_at IS NULL AND expires_at > now()` (single-
 * use). Retourne true si la row a été marquée (token valide & non encore
 * consommé), false sinon (race condition : double-submit, ou token expiré
 * en BDD).
 */
export async function consumeCaptureToken(
  client: { from: (table: string) => unknown },
  jti: string
): Promise<boolean> {
  const builder = client.from('sav_submit_tokens') as {
    update: (row: Record<string, unknown>) => {
      eq: (
        col: string,
        val: string
      ) => {
        is: (
          col: string,
          val: null
        ) => {
          gt: (
            col: string,
            val: string
          ) => {
            select: (cols: string) => Promise<{ data: unknown[] | null; error: unknown }>
          }
        }
      }
    }
  }
  const nowIso = new Date().toISOString()
  const { data, error } = await builder
    .update({ used_at: nowIso })
    .eq('jti', jti)
    .is('used_at', null)
    .gt('expires_at', nowIso)
    .select('jti')
  if (error) throw error
  return Array.isArray(data) && data.length > 0
}

function isCaptureTokenPayload(v: unknown): v is CaptureTokenPayload {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  if (typeof o['jti'] !== 'string') return false
  if (typeof o['iat'] !== 'number') return false
  if (typeof o['exp'] !== 'number') return false
  if (typeof o['scope'] !== 'string') return false
  return true
}

function readUserAgent(req: ApiRequest): string | null {
  const raw = req.headers['user-agent']
  const v = Array.isArray(raw) ? raw[0] : raw
  if (typeof v !== 'string' || v.length === 0) return null
  return v.slice(0, 512)
}

function readIp(req: ApiRequest): string {
  if (req.ip && req.ip.length > 0) return req.ip
  const fwd = req.headers['x-forwarded-for']
  const joined = Array.isArray(fwd) ? fwd.join(',') : fwd
  if (typeof joined === 'string' && joined.length > 0) {
    const parts = joined
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
    const rightmost = parts[parts.length - 1]
    if (rightmost) return rightmost
  }
  return 'unknown'
}

const submitTokenCore: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  const start = Date.now()

  // Story 5.7 patch P5 — Cache-Control posé en amont pour couvrir TOUS les
  // chemins de réponse (succès + erreurs). Une CDN mal configurée pourrait
  // sinon cacher un 500 et bloquer tous les utilisateurs derrière.
  res.setHeader('Cache-Control', 'no-store')

  if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
    res.setHeader('Allow', 'GET')
    sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
    return
  }

  const secret = process.env['MAGIC_LINK_SECRET']
  if (!secret || secret.length === 0) {
    logger.error('submit-token.config_missing', { requestId })
    sendError(res, 'SERVER_ERROR', 'Configuration manquante', requestId)
    return
  }

  const jti = randomUUID()
  const now = Math.floor(Date.now() / 1000)
  const expiresAt = new Date((now + SAV_SUBMIT_TOKEN_TTL_SEC) * 1000)
  const token = signCaptureToken(jti, secret, now, SAV_SUBMIT_TOKEN_TTL_SEC)

  const ip = readIp(req)
  const ipH = hashIp(ip)
  const ua = readUserAgent(req)

  try {
    const row: Record<string, unknown> = {
      jti,
      expires_at: expiresAt.toISOString(),
      ip_hash: ipH,
    }
    if (ua) row['user_agent'] = ua
    const { error } = await supabaseAdmin().from('sav_submit_tokens').insert(row)
    if (error) {
      logger.error('submit-token.insert_failed', {
        requestId,
        error: error.message ?? String(error),
        ms: Date.now() - start,
      })
      sendError(res, 'SERVER_ERROR', 'Token persistence échouée', requestId)
      return
    }
  } catch (err) {
    logger.error('submit-token.insert_exception', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
      ms: Date.now() - start,
    })
    sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId)
    return
  }

  const jtiPrefix = jti.slice(0, 8)
  logger.info('submit-token.issued', {
    requestId,
    jtiPrefix,
    ttlSec: SAV_SUBMIT_TOKEN_TTL_SEC,
    ms: Date.now() - start,
  })

  res.setHeader('X-Request-Id', requestId)
  res.status(200).json({ data: { token, expiresIn: SAV_SUBMIT_TOKEN_TTL_SEC } })
}

export const submitTokenHandler: ApiHandler = withRateLimit({
  bucketPrefix: 'sav-submit-token:ip',
  keyFrom: readIp,
  max: 10,
  window: '1m',
})(submitTokenCore)

export { submitTokenCore as __submitTokenCore }
