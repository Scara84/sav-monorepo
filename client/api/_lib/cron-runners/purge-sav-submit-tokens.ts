import { supabaseAdmin } from '../_typed-shim'
import { logger } from '../logger'

/**
 * Purge les sav_submit_tokens consommés OU expirés depuis > RETENTION_DAYS (Story H-02 / W78).
 *
 * Politique unifiée H-02 (D-1 / D-3) : RETENTION_DAYS = 7 jours appliqué côté SQL via
 * la RPC SECURITY DEFINER `purge_expired_sav_submit_tokens()` (D-3 Option C — pattern H-01) :
 *   - used_at IS NOT NULL AND used_at  < now() - 7 days   → token consommé hors fenêtre forensics
 *   - used_at IS NULL     AND expires_at < now() - 7 days → token expiré non-consommé hors fenêtre forensics
 *
 * Sémantique SQL pure (vs PostgREST `.or('and(...),and(...))') évite R-1 (syntaxe imbriquée
 * non-empirique dans le repo). Pattern aligné avec runPurgeTokens (cf. purge-tokens.ts H-02).
 *
 * Volume estimé : ~10 rows/jour purgées (1 token par submit SAV self-service Fruitstock).
 */
export async function runPurgeSavSubmitTokens({
  requestId,
}: {
  requestId: string
}): Promise<{ deleted: number }> {
  const { data, error } = await supabaseAdmin().rpc('purge_expired_sav_submit_tokens')
  if (error) throw error
  const deleted = Number(data ?? 0)
  logger.info('cron.purge_sav_submit_tokens.success', { requestId, deleted })
  return { deleted }
}
