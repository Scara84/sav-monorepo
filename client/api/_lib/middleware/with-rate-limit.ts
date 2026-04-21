import { createHash } from 'node:crypto'
import { sendError } from '../errors'
import { ensureRequestId } from '../request-id'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import type { ApiHandler, ApiRequest, ApiResponse } from '../types'

export type RateLimitWindow = '1m' | '15m' | '1h' | '24h'

/** Contrat minimal attendu du client Supabase pour les rate limits. Permet l'injection en test. */
export interface RateLimitClient {
  rpc: (fn: string, args: Record<string, unknown>) => unknown
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

/** Shape retour du RPC `increment_rate_limit`. */
interface RpcRow {
  allowed: boolean
  retry_after: number
}

/**
 * Appelle la fonction Postgres `increment_rate_limit(key, max, window_sec)`.
 * Atomique : ON CONFLICT DO UPDATE acquiert un row lock, pas de race condition.
 * Le count est incrémenté AVANT le check `<= max` → pas de lost-increment.
 * Exporté pour tests unitaires.
 */
export async function checkAndIncrement(
  client: RateLimitClient,
  bucketKey: string,
  max: number,
  windowSec: number
): Promise<CheckResult> {
  const supa = client as {
    rpc: (
      fn: string,
      args: Record<string, unknown>
    ) => Promise<{ data: RpcRow[] | RpcRow | null; error: unknown }>
  }
  const { data, error } = await supa.rpc('increment_rate_limit', {
    p_key: bucketKey,
    p_max: max,
    p_window_sec: windowSec,
  })
  if (error) throw error
  const row: RpcRow | null = Array.isArray(data) ? (data[0] ?? null) : data
  if (!row) throw new Error('increment_rate_limit returned empty result')
  return { allowed: row.allowed, retryAfter: row.retry_after }
}
