import { supabaseAdmin } from '../_lib/_typed-shim'
import { ensureRequestId } from '../_lib/request-id'
import { logger } from '../_lib/logger'
import type { ApiRequest, ApiResponse } from '../_lib/types'
import { authorizeCron } from './_authorize'

/**
 * Logique métier : purge les rate_limit_buckets dont la fenêtre est expirée (> 2 h).
 * Exportée pour composition par le dispatcher unique (Story 2.3).
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

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  const requestId = ensureRequestId(req)
  if (!authorizeCron(req)) {
    res
      .status(401)
      .json({ error: { code: 'UNAUTHENTICATED', message: 'Cron non autorisé', requestId } })
    return
  }
  try {
    const { deleted } = await runCleanupRateLimits({ requestId })
    res.status(200).json({ ok: true, deleted })
  } catch (err) {
    logger.error('cron.cleanup_rate_limits.error', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    })
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Cleanup échoué', requestId } })
  }
}
