import { supabaseAdmin } from '../_lib/_typed-shim'
import { ensureRequestId } from '../_lib/request-id'
import { logger } from '../_lib/logger'
import type { ApiRequest, ApiResponse } from '../_lib/types'

/**
 * Cron horaire : purge les magic_link_tokens expirés ou consommés depuis > 24 h.
 * Protection : vérifie le header `Authorization: Bearer <CRON_SECRET>` (set by Vercel Cron).
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  const requestId = ensureRequestId(req)
  if (!authorize(req)) {
    res
      .status(401)
      .json({ error: { code: 'UNAUTHENTICATED', message: 'Cron non autorisé', requestId } })
    return
  }

  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  try {
    const { count, error } = await supabaseAdmin()
      .from('magic_link_tokens')
      .delete({ count: 'exact' })
      .or(`expires_at.lt.${new Date().toISOString()},used_at.lt.${cutoff}`)
    if (error) throw error
    logger.info('cron.purge_tokens.success', { requestId, deleted: count ?? 0 })
    res.status(200).json({ ok: true, deleted: count ?? 0 })
  } catch (err) {
    logger.error('cron.purge_tokens.error', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    })
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Purge échouée', requestId } })
  }
}

function authorize(req: ApiRequest): boolean {
  const secret = process.env['CRON_SECRET']
  if (!secret) return false
  const header = req.headers['authorization']
  const raw = Array.isArray(header) ? header[0] : header
  if (!raw || !raw.startsWith('Bearer ')) return false
  return raw.slice(7) === secret
}
