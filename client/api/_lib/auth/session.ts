import { signJwt } from '../middleware/with-auth'
import { serializeCookie, clearCookie } from './cookies'
import type { SessionUser } from '../types'

export const SESSION_COOKIE_NAME = 'sav_session'

/** Story H-19 — TTL session opérateur par défaut : 30 jours. */
export const OPERATOR_SESSION_TTL_SEC = 30 * 24 * 3600
/** TTL session self-service magic link : 24 h. */
export const MEMBER_SESSION_TTL_SEC = 24 * 3600

export interface IssueSessionOptions {
  user: Omit<SessionUser, 'exp'>
  ttlSec: number
  secret: string
}

/** Émet un cookie de session signé (JWT HS256) HttpOnly/Secure/SameSite=Strict. */
export function issueSessionCookie(options: IssueSessionOptions): string {
  const exp = Math.floor(Date.now() / 1000) + options.ttlSec
  const payload: SessionUser = { ...options.user, exp }
  const jwt = signJwt(payload, options.secret)
  return serializeCookie(SESSION_COOKIE_NAME, jwt, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: options.ttlSec,
  })
}

export function clearSessionCookie(): string {
  return clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/',
  })
}

/**
 * Lit OPERATOR_SESSION_TTL_DAYS (défaut 30 jours). Bornes [1, 30].
 * OPERATOR_SESSION_TTL_HOURS reste supporté uniquement en compat, borné à 30 jours.
 */
export function readOperatorSessionTtlSec(): number {
  const rawDays = process.env['OPERATOR_SESSION_TTL_DAYS']
  if (rawDays) {
    const days = Number.parseInt(rawDays, 10)
    if (Number.isFinite(days) && days >= 1 && days <= 30) return days * 24 * 3600
    return OPERATOR_SESSION_TTL_SEC
  }

  const rawHours = process.env['OPERATOR_SESSION_TTL_HOURS']
  if (rawHours) {
    const hours = Number.parseInt(rawHours, 10)
    if (Number.isFinite(hours) && hours >= 1 && hours <= 24 * 30) return hours * 3600
  }

  return OPERATOR_SESSION_TTL_SEC
}
