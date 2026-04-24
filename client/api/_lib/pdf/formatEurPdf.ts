/**
 * Story 4.5 — formatage des montants euro pour le PDF bon SAV.
 *
 * Locale fr-FR exigée (espace insécable pour les milliers, virgule
 * décimale). `0 cents` formate en `0,00 €` (et non `—`) — le `—` est
 * réservé aux lignes dont `credit_amount_cents IS NULL`.
 *
 * Pur, stateless, aucun I/O. Consommé uniquement par `CreditNotePdf.tsx`.
 */

const EUR_FMT = new Intl.NumberFormat('fr-FR', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function formatEurFromCents(cents: number): string {
  return EUR_FMT.format(cents / 100)
}

/**
 * Format PDF : `DD/MM/YYYY` locale fr-FR, sans heure (un bon SAV vaut pour
 * une journée comptable). Accepte ISO 8601 ou Date natif.
 */
export function formatDateFr(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  if (Number.isNaN(d.getTime())) return ''
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const yyyy = d.getUTCFullYear()
  return `${dd}/${mm}/${yyyy}`
}
