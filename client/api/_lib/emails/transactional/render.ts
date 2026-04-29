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
import type {
  CommentAddedEmailData,
  OperatorAlertEmailData,
  TransactionalEmailOutput,
  TransactionalKind,
  TransitionEmailData,
} from './types'

export type EmailTemplateData = TransitionEmailData | OperatorAlertEmailData | CommentAddedEmailData

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
]
