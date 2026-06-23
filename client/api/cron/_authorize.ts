import { timingSafeEqual } from 'node:crypto'
import type { ApiRequest } from '../_lib/types'

/**
 * Authentification cron via `Authorization: Bearer <CRON_SECRET>` positionné par
 * Vercel Cron. Pattern extrait des handlers Epic 1 (purge-tokens, cleanup-rate-limits)
 * pour réutilisation par le dispatcher unique (Story 2.3) + purge-drafts.
 */
export function authorizeCron(req: ApiRequest): boolean {
  const secret = process.env['CRON_SECRET']
  if (!secret) return false
  const header = req.headers['authorization']
  const raw = Array.isArray(header) ? header[0] : header
  if (!raw || !raw.startsWith('Bearer ')) return false
  const received = Buffer.from(raw.slice(7))
  const expected = Buffer.from(secret)
  if (received.length !== expected.length) return false
  return timingSafeEqual(received, expected)
}
