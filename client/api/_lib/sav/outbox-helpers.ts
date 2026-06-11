/**
 * Story 3.7b — Helper partagé enqueue email_outbox.
 *
 * Centralise l'enqueue d'une row dans email_outbox pour les commentaires
 * opérateur→membre (kind='sav_comment_from_operator', AC #6.6).
 *
 * Pattern symétrique à Story 6.3 (member→op direction).
 * Best-effort : un INSERT raté (ex: unique_violation dedup) est logué
 * mais ne bloque PAS la réponse 201 du commentaire.
 *
 * Idempotence : l'index UNIQUE partiel idx_email_outbox_dedup_pending
 * (Story 3 F51 — sur (sav_id, kind) WHERE status='pending') protège
 * contre les doublons si 2 commentaires visibility=all sont postés en
 * succession rapide avant qu'un email soit envoyé.
 *
 * Note Story 6.6 (Decision D-6) : le dispatcher Story 6.6 doit mapper
 * kind='sav_comment_from_operator' vers le template Resend
 * sav-comment-added.html avec flag senderType='operator'. Si Story 6.6
 * utilise un switch fermé, ajouter le mapping template dans dispatcher.ts.
 * Hand-off complet dans :
 *   _bmad-output/implementation-artifacts/3-7b-ui-tags-compose-duplicate-upload-operateur.md
 *   (section "Decision Tokens > D-6 > Follow-up Story 6.6")
 */

import { supabaseAdmin } from '../clients/supabase-admin'
import { logger } from '../logger'

export interface EnqueueCommentOutboxParams {
  savId: number
  savReference: string
  memberEmail: string
  memberMemberId: number
  /**
   * Story V1.13 CR HIGH-2 — prénom membre pour le greeting du template
   * `renderSavCommentAdded` (mappé depuis `sav_comment_from_operator`).
   * Optionnel : si absent (legacy caller), le template tombe sur `'Bonjour ,'`
   * — dégradé mais non-bloquant.
   */
  memberFirstName?: string
  commentBody: string
  operatorDisplayName: string
  requestId: string
}

/**
 * Enqueue une notification email_outbox pour un commentaire opérateur→membre.
 * Kind: 'sav_comment_from_operator'
 * Best-effort : les erreurs sont catchées et loguées.
 */
export async function enqueueOperatorCommentOutbox(
  params: EnqueueCommentOutboxParams
): Promise<void> {
  const {
    savId,
    savReference,
    memberEmail,
    memberMemberId,
    memberFirstName,
    commentBody,
    operatorDisplayName,
    requestId,
  } = params

  const commentExcerpt = commentBody.slice(0, 140)

  try {
    const { error } = await supabaseAdmin().from('email_outbox').insert({
      kind: 'sav_comment_from_operator',
      recipient_email: memberEmail,
      recipient_member_id: memberMemberId,
      account: 'sav',
      sav_id: savId,
      scheduled_at: new Date().toISOString(),
      template_data: {
        savId,
        savReference,
        commentExcerpt,
        // Story V1.13 CR HIGH-2 — propage `memberFirstName` pour le template
        // membre (renderSavCommentAdded). Le caller (productivity-handlers)
        // ajoute la 1ère cellule à la sélection `member:members(email, first_name)`.
        memberFirstName: memberFirstName ?? '',
        operatorDisplayName,
        memberEmail,
      },
    })

    if (error) {
      // Unique violation (dedup) → log info, not error (expected behavior)
      const isDedup =
        (error as { code?: string }).code === '23505' ||
        (error as { message?: string }).message?.includes('unique')

      if (isDedup) {
        logger.info('sav.outbox.op_comment.dedup_skipped', {
          requestId,
          savId,
          reason: 'unique_violation — another pending outbox row exists for this SAV+kind',
        })
      } else {
        logger.warn('sav.outbox.op_comment.insert_failed', {
          requestId,
          savId,
          message: (error as { message?: string }).message,
        })
      }
    }
  } catch (err) {
    // Best-effort : catch all errors — comment INSERT already succeeded
    logger.warn('sav.outbox.op_comment.exception', {
      requestId,
      savId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
