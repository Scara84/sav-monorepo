import { supabaseAdmin } from '../_lib/_typed-shim'
import { ensureRequestId } from '../_lib/request-id'
import { logger } from '../_lib/logger'
import type { ApiRequest, ApiResponse } from '../_lib/types'

/**
 * Cron horaire : purge les rate_limit_buckets dont la fenêtre est expirée (> 2h).
 * Évite l'accumulation infinie de clés sur un projet actif.
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  const requestId = ensureRequestId(req)
  const secret = process.env['CRON_SECRET']
  const header = req.headers['authorization']
  const raw = Array.isArray(header) ? header[0] : header
  if (!secret || !raw || raw !== `Bearer ${secret}`) {
    res
      .status(401)
      .json({ error: { code: 'UNAUTHENTICATED', message: 'Cron non autorisé', requestId } })
    return
  }

  const cutoff = new Date(Date.now() - 2 * 3600 * 1000).toISOString()
  try {
    const { count, error } = await supabaseAdmin()
      .from('rate_limit_buckets')
      .delete({ count: 'exact' })
      .lt('window_from', cutoff)
    if (error) throw error
    logger.info('cron.cleanup_rate_limits.success', { requestId, deleted: count ?? 0 })
    res.status(200).json({ ok: true, deleted: count ?? 0 })
  } catch (err) {
    logger.error('cron.cleanup_rate_limits.error', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    })
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Cleanup échoué', requestId } })
  }
}
