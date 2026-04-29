/**
 * Story 6.6 HARDENING I3 — Constantes partagées des `kind` email_outbox.
 *
 * Centralise les sets MEMBER_KINDS / OPERATOR_KINDS / ALL_KINDS pour éviter
 * la dérive entre `retry-emails.ts` et toute autre callsite qui voudrait
 * vérifier la cible (member vs operator) d'un kind donné.
 *
 * Chaque kind doit aussi être présent dans la whitelist DB (CHECK constraint
 * Story 6.1 sur `email_outbox.kind`). Toute évolution de cette whitelist
 * doit propager ici ET dans la migration DB associée.
 *
 * NOTE : `sav_comment_added` est polymorphique — peut cibler member OU
 * operator selon `recipient_member_id` vs `recipient_operator_id`. Le runner
 * détermine au runtime via la présence de l'ID. Il est listé dans
 * MEMBER_KINDS pour le check opt-out (si recipient_member_id set), mais le
 * runner inclut un guard supplémentaire.
 */

/** Kinds destinés aux adhérents : opt-out check via notification_prefs.status_updates. */
export const MEMBER_KINDS: ReadonlySet<string> = new Set([
  'sav_in_progress',
  'sav_validated',
  'sav_closed',
  'sav_cancelled',
  'sav_received',
  'sav_comment_added',
  'weekly_recap',
])

/** Kinds destinés aux opérateurs : pas de filtre opt-out (notif business). */
export const OPERATOR_KINDS: ReadonlySet<string> = new Set([
  'sav_received_operator',
  'threshold_alert',
])

/** Union — utilisé pour validation défensive si un nouveau kind apparaît. */
export const ALL_KINDS: ReadonlySet<string> = new Set([...MEMBER_KINDS, ...OPERATOR_KINDS])
