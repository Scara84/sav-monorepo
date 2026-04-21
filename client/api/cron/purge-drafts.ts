import { supabaseAdmin } from '../_lib/_typed-shim'
import { ensureRequestId } from '../_lib/request-id'
import { logger } from '../_lib/logger'
import type { ApiRequest, ApiResponse } from '../_lib/types'
import { authorizeCron } from './_authorize'

/**
 * Logique métier : purge les sav_drafts créés depuis > 30 jours (Story 2.3 AC #10).
 *
 * Compteur basé sur `created_at` (1er save) et non `updated_at` — un brouillon
 * ouvert il y a 31 j avec auto-save quotidien est purgé. Soit l'adhérent
 * soumet, soit il abandonne ; pas de zombie permanent. Cf. Dev Notes Story 2.3.
 */
export async function runPurgeDrafts({
  requestId,
}: {
  requestId: string
}): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
  const { count, error } = await supabaseAdmin()
    .from('sav_drafts')
    .delete({ count: 'exact' })
    .lt('created_at', cutoff)
  if (error) throw error
  const deleted = count ?? 0
  logger.info('cron.purge_drafts.success', { requestId, deleted })
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
    const { deleted } = await runPurgeDrafts({ requestId })
    res.status(200).json({ ok: true, deleted })
  } catch (err) {
    logger.error('cron.purge_drafts.error', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    })
    res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Purge échouée', requestId } })
  }
}
