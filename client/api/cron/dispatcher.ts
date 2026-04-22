import { ensureRequestId } from '../_lib/request-id'
import { logger } from '../_lib/logger'
import type { ApiRequest, ApiResponse } from '../_lib/types'
import { authorizeCron } from './_authorize'
import { runCleanupRateLimits } from './cleanup-rate-limits'
import { runPurgeTokens } from './purge-tokens'
import { runPurgeDrafts } from './purge-drafts'

/**
 * Cron unique quotidien (Story 2.3 — ajusté 2026-04-22).
 *
 * Pourquoi un dispatcher unique : Vercel Hobby plafonne à 2 crons ; Epic 2.3 ajoute
 * purge-drafts, ce qui ferait 3. On centralise derrière un seul point d'entrée.
 *
 * Pourquoi quotidien et pas horaire : Vercel Hobby n'autorise que des crons au
 * maximum journaliers (`0 * * * *` est rejeté au deploy avec "Hobby accounts are
 * limited to daily cron jobs"). Trade-off accepté : `cleanupRateLimits` tourne
 * désormais 1×/j à 03:00 UTC au lieu de chaque heure — les buckets rate_limit
 * expirés restent un peu plus longtemps en base (max 24 h vs 1 h avant), UX
 * marginalement dégradée sur les utilisateurs blacklistés par erreur. Acceptable
 * V1 ; upgrade Pro reconsidérée quand le volume l'exigera.
 *
 * Cadence effective : les 3 jobs tournent 1×/j à 03:00 UTC (schedule `0 3 * * *`).
 *
 * Résilience : chaque job est try/catch isolé — un job qui plante ne bloque pas
 * les suivants. Le dispatcher renvoie toujours 200 avec le détail par job.
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  const requestId = ensureRequestId(req)
  if (!authorizeCron(req)) {
    res
      .status(401)
      .json({ error: { code: 'UNAUTHENTICATED', message: 'Cron non autorisé', requestId } })
    return
  }

  const startedAt = Date.now()
  const results: Record<string, unknown> = {}

  await safeRun(results, 'cleanupRateLimits', () => runCleanupRateLimits({ requestId }), requestId)
  await safeRun(results, 'purgeTokens', () => runPurgeTokens({ requestId }), requestId)
  await safeRun(results, 'purgeDrafts', () => runPurgeDrafts({ requestId }), requestId)

  const durationMs = Date.now() - startedAt
  logger.info('cron.dispatcher.success', { requestId, results, ms: durationMs })
  res.status(200).json({ ok: true, results, durationMs })
}

async function safeRun(
  results: Record<string, unknown>,
  jobName: string,
  fn: () => Promise<unknown>,
  requestId: string
): Promise<void> {
  try {
    results[jobName] = await fn()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`cron.dispatcher.${jobName}.failed`, { requestId, error: message })
    results[jobName] = { error: message }
  }
}
