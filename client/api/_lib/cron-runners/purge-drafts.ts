import { supabaseAdmin } from '../_typed-shim'
import { logger } from '../logger'

/**
 * Purge les sav_drafts créés depuis > 30 jours (Story 2.3 AC #10).
 *
 * Helper déplacé depuis `api/cron/purge-drafts.ts` vers `api/_lib/cron-runners/`
 * pour ne pas compter comme Serverless Function Vercel.
 *
 * Compteur sur `created_at` (1er save) — un brouillon auto-saved quotidiennement
 * mais créé il y a 31 j est purgé. Décision V1.
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
