import { supabaseAdmin } from '../_typed-shim'
import { logger } from '../logger'

/**
 * Purge les magic_link_tokens consommés OU expirés depuis > RETENTION_DAYS (Story H-02 / W40).
 *
 * Mise à niveau H-02 (D-2) : politique 7 jours unifiée avec sav_submit_tokens (vs 24h
 * pré-H-02 — politique d'origine Story 6.6 sans rationale documenté, supprimait les rows
 * trop agressivement pour le debug "magic link n'a pas marché hier").
 *
 * Implémentation via RPC SECURITY DEFINER `purge_expired_magic_link_tokens()` (D-3 Option C) —
 * sémantique SQL pure aligned PATTERN-H02-POLITIQUE-RETENTION-UNIFIEE.
 */
export async function runPurgeTokens({
  requestId,
}: {
  requestId: string
}): Promise<{ deleted: number }> {
  const { data, error } = await supabaseAdmin().rpc('purge_expired_magic_link_tokens')
  if (error) throw error
  const deleted = Number(data ?? 0)
  logger.info('cron.purge_tokens.success', { requestId, deleted })
  return { deleted }
}
