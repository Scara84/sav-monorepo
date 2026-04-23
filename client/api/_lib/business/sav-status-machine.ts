/**
 * Story 3.5 — state-machine SAV (mirror TS du check PL/pgSQL `transition_sav_status`).
 *
 * La source de vérité reste la RPC côté DB (défense-en-profondeur). Ce helper
 * permet une validation précoce côté handler avant le round-trip Supabase.
 */

export type SavStatus = 'draft' | 'received' | 'in_progress' | 'validated' | 'closed' | 'cancelled'

export const SAV_STATUSES: readonly SavStatus[] = [
  'draft',
  'received',
  'in_progress',
  'validated',
  'closed',
  'cancelled',
] as const

const ALLOWED: Record<SavStatus, SavStatus[]> = {
  draft: ['received', 'cancelled'],
  received: ['in_progress', 'cancelled'],
  in_progress: ['validated', 'cancelled', 'received'], // rollback technique
  validated: ['closed', 'cancelled'],
  closed: [],
  cancelled: [],
}

export function isTransitionAllowed(from: SavStatus, to: SavStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false
}

export function getAllowedTransitions(from: SavStatus): SavStatus[] {
  return [...(ALLOWED[from] ?? [])]
}
