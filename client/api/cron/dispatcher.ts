import { ensureRequestId } from '../_lib/request-id'
import { logger } from '../_lib/logger'
import type { ApiRequest, ApiResponse } from '../_lib/types'
import { authorizeCron } from './_authorize'
import { runCleanupRateLimits } from './cleanup-rate-limits'
import { runPurgeTokens } from './purge-tokens'
import { runPurgeDrafts } from './purge-drafts'

/**
 * Cron unique horaire (Story 2.3 décision Antho 2026-04-21).
 *
 * Pourquoi un dispatcher unique : Vercel Hobby plafonne à 2 crons ; Epic 2.3 ajoute
 * purge-drafts, ce qui ferait 3. Pour éviter l'upgrade Pro (20 $/mois non justifié
 * à ce volume), on centralise derrière un seul point d'entrée programmé à `0 * * * *`
 * et on route en fonction de l'heure UTC courante.
 *
 * Cadence effective :
 * - Chaque heure : `cleanupRateLimits` (libération rapide des buckets expirés)
 * - 03:00 UTC     : `purgeTokens` + `purgeDrafts` (jobs quotidiens consolidés)
 *
 * Résilience : chaque job est try/catch isolé — un job qui plante ne bloque pas les
 * suivants. Les erreurs sont loggées mais le dispatcher renvoie toujours 200 avec le
 * détail par job dans le body (Vercel Cron est alors considéré comme « ok », pas de
 * retry agressif sur erreur métier).
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
  const hour = new Date().getUTCHours()
  const results: Record<string, unknown> = {}

  await safeRun(results, 'cleanupRateLimits', () => runCleanupRateLimits({ requestId }), requestId)

  if (hour === 3) {
    await safeRun(results, 'purgeTokens', () => runPurgeTokens({ requestId }), requestId)
    await safeRun(results, 'purgeDrafts', () => runPurgeDrafts({ requestId }), requestId)
  }

  const durationMs = Date.now() - startedAt
  logger.info('cron.dispatcher.success', { requestId, hour, results, ms: durationMs })
  res.status(200).json({ ok: true, hour, results, durationMs })
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
