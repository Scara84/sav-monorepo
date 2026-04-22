import { supabaseAdmin } from '../_typed-shim'
import { logger } from '../logger'

/**
 * Purge les magic_link_tokens expirés ou consommés depuis > 24 h.
 *
 * Helper déplacé depuis `api/cron/purge-tokens.ts` vers `api/_lib/cron-runners/`
 * pour ne pas compter comme Serverless Function Vercel (prefix `_` ignoré).
 * Contrainte Hobby plan : max 12 Serverless Functions par déploiement.
 */
export async function runPurgeTokens({
  requestId,
}: {
  requestId: string
}): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  const { count, error } = await supabaseAdmin()
    .from('magic_link_tokens')
    .delete({ count: 'exact' })
    .or(`expires_at.lt.${new Date().toISOString()},used_at.lt.${cutoff}`)
  if (error) throw error
  const deleted = count ?? 0
  logger.info('cron.purge_tokens.success', { requestId, deleted })
  return { deleted }
}
