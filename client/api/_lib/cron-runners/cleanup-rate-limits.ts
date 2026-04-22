import { supabaseAdmin } from '../_typed-shim'
import { logger } from '../logger'

/**
 * Purge les rate_limit_buckets dont la fenêtre est expirée (> 2 h).
 *
 * Helper déplacé depuis `api/cron/cleanup-rate-limits.ts` vers
 * `api/_lib/cron-runners/` pour ne pas compter comme Serverless Function Vercel.
 */
export async function runCleanupRateLimits({
  requestId,
}: {
  requestId: string
}): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - 2 * 3600 * 1000).toISOString()
  const { count, error } = await supabaseAdmin()
    .from('rate_limit_buckets')
    .delete({ count: 'exact' })
    .lt('window_from', cutoff)
  if (error) throw error
  const deleted = count ?? 0
  logger.info('cron.cleanup_rate_limits.success', { requestId, deleted })
  return { deleted }
}
