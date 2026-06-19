/**
 * Story 6.6 AC #5 — Types des payloads templates transactionnels.
 *
 * Chaque template est une fonction pure `(data) => { subject, html, text }`.
 * Le runner retry-emails lit `email_outbox.template_data` (JSONB) et le
 * passe au dispatcher `renderEmailTemplate(kind, data)` qui type-narrow.
 */

export interface TransactionalEmailOutput {
  subject: string
  html: string
  text: string
}

/**
 * Données pour les transitions adhérent (in_progress / validated / closed /
 * cancelled). Posée par RPC `transition_sav_status` migration 6.6.
 */
export interface TransitionEmailData {
  savReference?: string
  savId?: number
  memberId?: number
  memberFirstName?: string
  memberLastName?: string
  newStatus?: string
  previousStatus?: string
  totalAmountCents?: number
  /** Construit côté runner à partir de APP_BASE_URL + savId. */
  dossierUrl?: string | null
  /** Construit côté runner à partir de APP_BASE_URL + /monespace/preferences. */
  unsubscribeUrl?: string | null
  /**
   * Story V1.10 AC#2 + AC#8 — flag injecté par le runner retry-emails quand un
   * avoir EXISTE pour ce SAV mais la résolution de la PJ a échoué (download
   * Graph KO, pdf_web_url NULL, > 10 MB, sav_id absent côté row legacy). Le
   * template `sav-closed` bascule alors sur le libellé « disponible dans votre
   * espace » avec lien dossierUrl, au lieu de la mention « pièce jointe ».
   * Sans ce flag (ou `false`) → chemin nominal PJ.
   * Spécifique à `sav_closed` ; ignoré par les autres kinds.
   */
  pdfFallback?: boolean
  /**
   * Story V1.10 CR FIX 3 — flag injecté par le runner retry-emails quand
   * AUCUN avoir n'existe pour ce SAV (cas SAV clôturé sans remboursement).
   * Le template `sav-closed` s'abstient alors de toute mention « bon SAV »
   * (anti-mensonge utilisateur — comportement 6.6 d'avant V1.10).
   * Spécifique à `sav_closed` ; ignoré par les autres kinds.
   */
  noCreditNote?: boolean
  /** Injecté uniquement après confirmation effective du crédit wallet. */
  walletCreditConfirmed?: boolean
}

/**
 * Données pour la notif opérateur "nouveau SAV". Posée par RPC
 * `enqueue_new_sav_alerts` migration 6.6.
 */
export interface OperatorAlertEmailData {
  savReference?: string
  savId?: number
  memberId?: number
  memberFirstName?: string
  memberLastName?: string
  totalAmountCents?: number
  dossierUrl?: string | null
}

/**
 * Données pour notification commentaire (Story 6.3 producer). `recipientKind`
 * détermine le ton du template : 'member' | 'operator'.
 */
export interface CommentAddedEmailData {
  savReference?: string
  savId?: number
  memberFirstName?: string
  memberLastName?: string
  commentBody?: string
  recipientKind?: 'member' | 'operator'
  dossierUrl?: string | null
  unsubscribeUrl?: string | null
}

/** Whitelist des kinds renderables par le dispatcher render.ts. */
export type TransactionalKind =
  | 'sav_in_progress'
  | 'sav_validated'
  | 'sav_closed'
  | 'sav_cancelled'
  | 'sav_received_operator'
  | 'sav_comment_added'
  // V1.13 AC#7 — mappé sur renderSavCommentAdded(recipientKind='member').
  | 'sav_comment_from_operator'
  | 'weekly_recap'
