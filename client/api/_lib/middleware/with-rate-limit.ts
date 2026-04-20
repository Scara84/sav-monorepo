import { createHash } from 'node:crypto'
import { sendError } from '../errors'
import { ensureRequestId } from '../request-id'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import type { ApiHandler, ApiRequest, ApiResponse } from '../types'

export type RateLimitWindow = '1m' | '15m' | '1h' | '24h'

/** Contrat minimal attendu du client Supabase pour les rate limits. Permet l'injection en test. */
export interface RateLimitClient {
  from: (table: string) => unknown
}

export interface WithRateLimitOptions {
  /** Préfixe du bucket, ex: 'mlink:email' ou 'verify:ip'. */
  bucketPrefix: string
  /** Fonction qui extrait la clé brute de la requête (ex: email, IP hash). */
  keyFrom: (req: ApiRequest) => string | undefined
  /** Nombre max de hits dans la fenêtre. */
  max: number
  /** Longueur de la fenêtre. */
  window: RateLimitWindow
  /** Si true, ne hash pas la clé (utile pour IPs déjà hashées). Par défaut : hash SHA-256. */
  skipHash?: boolean
  /** Injection pour tests ; par défaut utilise supabaseAdmin(). */
  getClient?: () => RateLimitClient
}

const WINDOW_SECONDS: Record<RateLimitWindow, number> = {
  '1m': 60,
  '15m': 900,
  '1h': 3600,
  '24h': 86400,
}

/**
 * Rate-limit Postgres-backed via `rate_limit_buckets`.
 * Clé finale = `<bucketPrefix>:<sha256(keyFrom(req))>`.
 * Fenêtre glissante arrondie à la seconde via `window_from` en BDD.
 *
 * - 400 VALIDATION_FAILED si keyFrom retourne undefined
 * - 429 RATE_LIMITED + header `Retry-After` si dépassement
 * - 500 SERVER_ERROR si Supabase down (fail-closed pour la sécurité)
 */
export function withRateLimit(options: WithRateLimitOptions) {
  return (handler: ApiHandler): ApiHandler =>
    async (req: ApiRequest, res: ApiResponse) => {
      const requestId = ensureRequestId(req)
      const raw = options.keyFrom(req)
      if (!raw) {
        sendError(res, 'VALIDATION_FAILED', 'Clé rate limit manquante', requestId)
        return
      }
      const hashed =
        options.skipHash === true ? raw : createHash('sha256').update(raw).digest('hex')
      const bucketKey = `${options.bucketPrefix}:${hashed}`
      const windowSec = WINDOW_SECONDS[options.window]

      try {
        const client = options.getClient
          ? options.getClient()
          : (supabaseAdmin() as unknown as RateLimitClient)
        const { allowed, retryAfter } = await checkAndIncrement(
          client,
          bucketKey,
          options.max,
          windowSec
        )
        if (!allowed) {
          res.setHeader('Retry-After', retryAfter)
          sendError(res, 'RATE_LIMITED', 'Trop de requêtes', requestId, {
            bucket: options.bucketPrefix,
            retryAfterSeconds: retryAfter,
          })
          return
        }
      } catch (err) {
        logger.error('rate-limit check failed', {
          requestId,
          bucket: options.bucketPrefix,
          error: err instanceof Error ? err.message : String(err),
        })
        sendError(res, 'SERVER_ERROR', 'Rate limiter indisponible', requestId)
        return
      }

      return handler(req, res)
    }
}

interface CheckResult {
  allowed: boolean
  /** seconds jusqu'au prochain reset de la fenêtre */
  retryAfter: number
}

interface BucketRow {
  key: string
  count: number
  window_from: string
}

interface BucketUpsert {
  key: string
  count: number
  window_from: string
  updated_at: string
}

interface BucketUpdate {
  count: number
  updated_at: string
}

/**
 * Atomique : upsert du bucket avec reset de la fenêtre si expirée.
 * Exporté pour tests unitaires.
 */
export async function checkAndIncrement(
  client: RateLimitClient,
  bucketKey: string,
  max: number,
  windowSec: number
): Promise<CheckResult> {
  const supa = client as {
    from: (t: string) => {
      select: (cols: string) => {
        eq: (
          col: string,
          val: string
        ) => {
          maybeSingle: () => Promise<{ data: BucketRow | null; error: unknown }>
        }
      }
      upsert: (row: BucketUpsert) => Promise<{ error: unknown }>
      update: (row: BucketUpdate) => {
        eq: (col: string, val: string) => Promise<{ error: unknown }>
      }
    }
  }
  const now = new Date()

  // Lecture de l'état courant
  const { data: existing, error: readErr } = await supa
    .from('rate_limit_buckets')
    .select('key, count, window_from')
    .eq('key', bucketKey)
    .maybeSingle()
  if (readErr) throw readErr

  const windowStartMs = existing?.window_from ? new Date(existing.window_from).getTime() : 0
  const windowElapsedMs = now.getTime() - windowStartMs
  const inWindow = existing !== null && windowElapsedMs < windowSec * 1000

  if (!inWindow) {
    // Nouvelle fenêtre : upsert count=1, window_from=now
    const { error } = await supa.from('rate_limit_buckets').upsert({
      key: bucketKey,
      count: 1,
      window_from: now.toISOString(),
      updated_at: now.toISOString(),
    })
    if (error) throw error
    return { allowed: true, retryAfter: windowSec }
  }

  // Même fenêtre : incrément si sous quota
  if (existing.count >= max) {
    const retryAfter = Math.max(1, Math.ceil((windowSec * 1000 - windowElapsedMs) / 1000))
    return { allowed: false, retryAfter }
  }

  const { error } = await supa
    .from('rate_limit_buckets')
    .update({ count: existing.count + 1, updated_at: now.toISOString() })
    .eq('key', bucketKey)
  if (error) throw error

  const retryAfter = Math.max(1, Math.ceil((windowSec * 1000 - windowElapsedMs) / 1000))
  return { allowed: true, retryAfter }
}
