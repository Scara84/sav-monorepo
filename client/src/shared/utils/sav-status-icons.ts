/**
 * Story 6.2 — mapping pictogrammes statut SAV pour l'espace adhérent.
 *
 * Réutilisé par MemberSavListView.vue (et plus tard MemberSavDetailView).
 * Émojis V1 : pas de dépendance icon-pack supplémentaire (poids bundle 0).
 *
 *  received    🕓
 *  in_progress 🔄
 *  validated   ✅
 *  closed      📦
 *  cancelled   ❌
 */

export type SavStatus = 'received' | 'in_progress' | 'validated' | 'closed' | 'cancelled'

export const SAV_STATUS_ICON: Record<string, string> = {
  received: '🕓',
  in_progress: '🔄',
  validated: '✅',
  closed: '📦',
  cancelled: '❌',
}

export const SAV_STATUS_LABEL: Record<string, string> = {
  received: 'Reçu',
  in_progress: 'En cours',
  validated: 'Validé',
  closed: 'Clôturé',
  cancelled: 'Annulé',
}

/** Bucket statut "ouvert" / "fermé" pour le filtre client-side. */
export const STATUS_OPEN: SavStatus[] = ['received', 'in_progress', 'validated']
export const STATUS_CLOSED: SavStatus[] = ['closed', 'cancelled']

export function statusIcon(status: string): string {
  return SAV_STATUS_ICON[status] ?? '•'
}

export function statusLabel(status: string): string {
  return SAV_STATUS_LABEL[status] ?? status
}

export function isOpenStatus(status: string): boolean {
  return (STATUS_OPEN as string[]).includes(status)
}

export function isClosedStatus(status: string): boolean {
  return (STATUS_CLOSED as string[]).includes(status)
}
