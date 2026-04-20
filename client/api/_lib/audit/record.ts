import { supabaseAdmin } from '../clients/supabase-admin'

export interface AuditRecordInput {
  entityType: string
  entityId: number
  action: 'created' | 'updated' | 'deleted' | 'anonymized' | 'status_changed' | 'emitted' | string
  actorOperatorId?: number
  actorMemberId?: number
  actorSystem?: 'cron' | 'webhook-capture' | 'migration' | string
  diff?: { before?: unknown; after?: unknown }
  notes?: string
}

/**
 * Écrit explicitement une ligne dans `audit_trail`.
 *
 * Utilisation : quand l'endpoint serverless effectue une action qui n'est pas couverte
 * par un trigger automatique (ex : changement de statut SAV via RPC), ou quand on veut
 * rattacher un acteur (operator/member) que les triggers PG ne peuvent pas lire (Supabase
 * pooler ne persiste pas les GUC de session `SET LOCAL app.actor_*`).
 *
 * Les triggers `audit_changes()` (attachés en Story 1.2 aux tables operators, settings,
 * members, groups, validation_lists) continuent d'écrire automatiquement pour toute
 * mutation directe sur ces tables — mais avec `actor_operator_id = NULL` puisque le pooler
 * ne transmet pas le GUC. L'actor précis est reconstructible via join sur auth_events
 * proches (même opérateur, ±quelques secondes). Pour les audits critiques (comptables,
 * transitions SAV), passer **toujours** par ce helper avec `actorOperatorId` explicite.
 */
export async function recordAudit(input: AuditRecordInput): Promise<void> {
  const row: Record<string, unknown> = {
    entity_type: input.entityType,
    entity_id: input.entityId,
    action: input.action,
  }
  if (input.actorOperatorId !== undefined) row['actor_operator_id'] = input.actorOperatorId
  if (input.actorMemberId !== undefined) row['actor_member_id'] = input.actorMemberId
  if (input.actorSystem !== undefined) row['actor_system'] = input.actorSystem
  if (input.diff !== undefined) row['diff'] = input.diff
  if (input.notes !== undefined) row['notes'] = input.notes
  const { error } = await supabaseAdmin().from('audit_trail').insert(row)
  if (error) throw error
}
