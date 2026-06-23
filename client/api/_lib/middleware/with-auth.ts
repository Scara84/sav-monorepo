import { createHmac, timingSafeEqual } from 'node:crypto'
import { sendError } from '../errors'
import { ensureRequestId } from '../request-id'
import { logger } from '../logger'
import type { ApiHandler, ApiRequest, ApiResponse, SessionUser } from '../types'

export interface WithAuthOptions {
  /**
   * Types de session acceptés — REQUIS (explicite, pas de default).
   * Exemple : `['operator']` pour une route admin, `['member']` pour self-service adhérent.
   * Un endpoint accessible aux deux doit lister les deux explicitement.
   */
  types: Array<NonNullable<SessionUser['type']>>
  /** Rôles d'opérateurs autorisés. Si absent : tout rôle auth'd est OK (utile pour endpoints self-service). */
  roles?: Array<SessionUser['role']>
  /** Nom du cookie de session. Par défaut : `sav_session`. */
  cookieName?: string
}

const DEFAULT_COOKIE = 'sav_session'
const ALGO = 'HS256'

/**
 * Vérifie le cookie de session (JWT HS256).
 * - 401 UNAUTHENTICATED si cookie absent/invalide/expiré.
 * - 403 FORBIDDEN si le `role` ou `type` ne matche pas `roles`/`types` de WithAuthOptions.
 * Attache `req.user` au handler si OK.
 *
 * Le champ `types` est REQUIS — pas de default `[operator, member]` (footgun sur les routes admin
 * qui oublieraient de restreindre aux opérateurs et accepteraient des sessions member).
 */
export function withAuth(options: WithAuthOptions) {
  return (handler: ApiHandler): ApiHandler =>
    async (req: ApiRequest, res: ApiResponse) => {
      const requestId = ensureRequestId(req)
      const cookieName = options.cookieName ?? DEFAULT_COOKIE
      const secret = process.env['SESSION_COOKIE_SECRET']
      if (!secret) {
        logger.error('SESSION_COOKIE_SECRET missing', { requestId })
        sendError(res, 'SERVER_ERROR', 'Configuration manquante', requestId)
        return
      }

      const token = readCookie(req, cookieName)
      if (!token) {
        sendError(res, 'UNAUTHENTICATED', 'Session requise', requestId)
        return
      }

      const user = verifyJwt(token, secret)
      if (!user) {
        sendError(res, 'UNAUTHENTICATED', 'Session invalide', requestId)
        return
      }

      const now = Math.floor(Date.now() / 1000)
      if (user.exp <= now) {
        sendError(res, 'UNAUTHENTICATED', 'Session expirée', requestId)
        return
      }

      if (!options.types.includes(user.type)) {
        sendError(res, 'FORBIDDEN', 'Type de compte non autorisé', requestId)
        return
      }

      if (options.roles && options.roles.length > 0) {
        if (!user.role || !options.roles.includes(user.role)) {
          sendError(res, 'FORBIDDEN', 'Rôle non autorisé', requestId)
          return
        }
      }

      req.user = user
      return handler(req, res)
    }
}

// ---- helpers (exportés pour les tests) ----

export function readCookie(req: ApiRequest, name: string): string | undefined {
  if (req.cookies && req.cookies[name]) return req.cookies[name]
  const raw = req.headers['cookie']
  const header = Array.isArray(raw) ? raw.join('; ') : raw
  if (!header) return undefined
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const k = part.slice(0, eq).trim()
    if (k === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1))
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

function base64UrlDecode(s: string): string {
  const pad = '='.repeat((4 - (s.length % 4)) % 4)
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(b64, 'base64').toString('utf8')
}

function base64UrlEncode(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Vérifie un JWT HS256 signé avec `secret`. Retourne le payload typé ou undefined. */
export function verifyJwt(token: string, secret: string): SessionUser | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  const [h, p, s] = parts as [string, string, string]
  let header: { alg?: string; typ?: string }
  try {
    header = JSON.parse(base64UrlDecode(h))
  } catch {
    return undefined
  }
  if (header.alg !== ALGO) return undefined

  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest()
  let given: Buffer
  try {
    const pad = '='.repeat((4 - (s.length % 4)) % 4)
    const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/')
    given = Buffer.from(b64, 'base64')
  } catch {
    return undefined
  }
  if (expected.length !== given.length) return undefined
  if (!timingSafeEqual(expected, given)) return undefined

  let payload: unknown
  try {
    payload = JSON.parse(base64UrlDecode(p))
  } catch {
    return undefined
  }
  if (!isSessionUser(payload)) return undefined
  return payload
}

/** Signe un payload en JWT HS256. Utilisé par les endpoints d'issue (magic-link verify adhérent + opérateur). */
export function signJwt(payload: SessionUser, secret: string): string {
  const header = { alg: ALGO, typ: 'JWT' }
  const h = base64UrlEncode(JSON.stringify(header))
  const p = base64UrlEncode(JSON.stringify(payload))
  const s = base64UrlEncode(createHmac('sha256', secret).update(`${h}.${p}`).digest())
  return `${h}.${p}.${s}`
}

function isSessionUser(v: unknown): v is SessionUser {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  if (typeof o['sub'] !== 'number') return false
  if (o['type'] !== 'operator' && o['type'] !== 'member') return false
  if (typeof o['exp'] !== 'number') return false
  return true
}
