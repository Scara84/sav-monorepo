/**
 * Story 6.6 AC #5 — Dispatcher renderEmailTemplate(kind, data).
 *
 * Lookup table kind → fonction pure de rendu. Le runner retry-emails appelle
 * ce dispatcher avec le `kind` lu depuis `email_outbox` et le `template_data`
 * JSONB désérialisé.
 *
 * Renvoie `null` si le kind n'est pas connu — le runner log une erreur et
 * marque la ligne en failed définitif (un kind whitelist DB mais sans
 * template TS = bug code, à fixer).
 */

import { renderSavCancelled } from './sav-cancelled'
import { renderSavClosed } from './sav-closed'
import { renderSavCommentAdded } from './sav-comment-added'
import { renderSavInProgress } from './sav-in-progress'
import { renderSavReceivedOperator } from './sav-received-operator'
import { renderSavValidated } from './sav-validated'
import { renderWeeklyRecap, type WeeklyRecapEmailData } from './weekly-recap'
import type {
  CommentAddedEmailData,
  OperatorAlertEmailData,
  TransactionalEmailOutput,
  TransactionalKind,
  TransitionEmailData,
} from './types'

export type EmailTemplateData =
  | TransitionEmailData
  | OperatorAlertEmailData
  | CommentAddedEmailData
  | WeeklyRecapEmailData

export function renderEmailTemplate(
  kind: string,
  data: EmailTemplateData | Record<string, unknown>
): TransactionalEmailOutput | null {
  switch (kind as TransactionalKind) {
    case 'sav_in_progress':
      return renderSavInProgress(data as TransitionEmailData)
    case 'sav_validated':
      return renderSavValidated(data as TransitionEmailData)
    case 'sav_closed':
      return renderSavClosed(data as TransitionEmailData)
    case 'sav_cancelled':
      return renderSavCancelled(data as TransitionEmailData)
    case 'sav_received_operator':
      return renderSavReceivedOperator(data as OperatorAlertEmailData)
    case 'sav_comment_added':
      return renderSavCommentAdded(data as CommentAddedEmailData)
    case 'sav_comment_from_operator': {
      // Story V1.13 AC#7 — fix bug latent : enqueue d'`outbox-helpers.ts`
      // n'avait pas de case de render → unknown_kind → failed définitif. Le
      // destinataire est le membre — on map sur `renderSavCommentAdded` avec
      // recipientKind='member'.
      //
      // CR HIGH-2 V1.13 — MAPPING explicite (le spread n'est pas suffisant) :
      //   - Le producer (outbox-helpers.ts L66-72) pose `commentExcerpt`
      //     mais le template consomme `commentBody`. Sans mapping le mail
      //     partait avec un body vide.
      //   - Le producer pose maintenant `memberFirstName` (lookup ajouté côté
      //     producer — cf. enqueueOperatorCommentOutbox) ; on conserve un
      //     fallback `''` pour les rows legacy / pré-fix qui ne l'ont pas
      //     (le template gère `?? ''` proprement).
      //   - `operatorDisplayName` n'est pas consommé par le template membre
      //     (le greeting met seulement le prénom membre) — on l'ignore.
      const opData = data as Record<string, unknown>
      const memberData: CommentAddedEmailData = {
        ...(opData as CommentAddedEmailData),
        commentBody: (opData['commentExcerpt'] as string | undefined) ?? '',
        memberFirstName: (opData['memberFirstName'] as string | undefined) ?? '',
        recipientKind: 'member',
      }
      return renderSavCommentAdded(memberData)
    }
    case 'weekly_recap':
      return renderWeeklyRecap(data as WeeklyRecapEmailData)
    default:
      return null
  }
}

export const TRANSACTIONAL_KINDS: ReadonlyArray<TransactionalKind> = [
  'sav_in_progress',
  'sav_validated',
  'sav_closed',
  'sav_cancelled',
  'sav_received_operator',
  'sav_comment_added',
  'sav_comment_from_operator',
  'weekly_recap',
]
