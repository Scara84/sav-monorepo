import { supabaseAdmin } from '../clients/supabase-admin'
import { logger } from '../logger'

/**
 * Story 6.5 AC #11 — défense-en-profondeur Layer 2.
 *
 * Le JWT `scope='group'` + `groupId` sont figés à l'émission (verify.ts
 * magic-link). Si un admin :
 *   - révoque `members.is_group_manager = false`, OU
 *   - transfère le membre dans un autre groupe (`members.group_id := <new>`),
 * la session reste active jusqu'à expiration cookie (24h). Pour éviter qu'un
 * manager révoqué OU transféré garde l'accès `scope=group` à l'ANCIEN groupe
 * durant cette fenêtre, on re-vérifie À LA FOIS le flag manager ET le
 * groupId DB AVANT d'appliquer le filtre `group`.
 *
 * Coût : 1 SELECT par requête `scope=group`, ~5-15ms — acceptable
 * (cf. Dev Notes story 6.5 § « Sécurité — défense en profondeur »).
 *
 * Retour :
 *   - { active: true,  groupId: <db_value> } → caller doit assert qu'il
 *     matche le `groupId` claim JWT ; sinon traiter comme révoqué (manager
 *     transféré entre groupes).
 *   - { active: false, groupId: null }       → membre inexistant, anonymisé
 *     ou non manager.
 *
 * En cas d'erreur Supabase : retourne `{ active:false, groupId:null }`
 * (fail-closed) + log warn.
 *
 * CR Story 6.5 (2026-04-29) — P1 : ajout du `groupId` retourné pour permettre
 * au caller d'assert l'égalité avec le claim JWT, fermant la faille « admin
 * transfère manager entre groupes, JWT figé garde stale access ».
 */
export interface ManagerCheckResult {
  active: boolean
  groupId: number | null
}

export async function requireActiveManager(memberId: number): Promise<ManagerCheckResult> {
  if (!Number.isInteger(memberId) || memberId <= 0) {
    return { active: false, groupId: null }
  }
  try {
    const admin = supabaseAdmin()
    const { data, error } = (await admin
      .from('members')
      .select('is_group_manager, anonymized_at, group_id')
      .eq('id', memberId)
      .maybeSingle()) as {
      data: {
        is_group_manager: boolean | null
        anonymized_at: string | null
        group_id: number | null
      } | null
      error: { code?: string } | null
    }
    if (error) {
      logger.warn('auth.require_active_manager.lookup_failed', {
        memberId,
        // CR P6 — pas de message brut Supabase (peut contenir PII).
        errorCode: error.code ?? 'unknown',
      })
      return { active: false, groupId: null }
    }
    if (!data) return { active: false, groupId: null }
    if (data.anonymized_at !== null) return { active: false, groupId: null }
    if (data.is_group_manager !== true) return { active: false, groupId: null }
    return { active: true, groupId: data.group_id }
  } catch (err) {
    logger.warn('auth.require_active_manager.exception', {
      memberId,
      // CR P6 — pas de message brut.
      errorType: err instanceof Error ? err.constructor.name : 'unknown',
    })
    return { active: false, groupId: null }
  }
}
