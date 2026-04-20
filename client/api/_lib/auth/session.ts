import { signJwt } from '../middleware/with-auth'
import { serializeCookie, clearCookie } from './cookies'
import type { SessionUser } from '../types'

export const SESSION_COOKIE_NAME = 'sav_session'

/** TTL session opérateur MSAL : 8 h (NFR-S3). */
export const OPERATOR_SESSION_TTL_SEC = 8 * 3600
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
