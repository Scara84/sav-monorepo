/**
 * Story 4.8 — AC #5 : Helper calcul marge unitaire HT
 *
 * Calcule la marge unitaire HT en cents à partir des colonnes d'une ligne SAV.
 *
 * Formule :
 *   sellHt = round(unitPriceTtcCents * 10000 / (10000 + vatRateBpSnapshot))
 *   margin = sellHt - supplierPurchasePriceHtCents
 *
 * Cette conversion TTC → HT réplique le calcul du trigger SQL compute_sav_line_credit
 * (cf. 20260516120000:99-108).
 *
 * Convention des unités :
 *   - unitPriceTtcCents : prix vente client TTC en cents EUR (ex: 2100 = 21,00 €)
 *   - vatRateBpSnapshot : taux TVA en points de base (ex: 550 = 5,5 %)
 *   - supplierPurchasePriceHtCents : prix achat fournisseur HT en cents EUR
 *   - retour : marge HT en cents EUR (peut être négatif), ou null si données incomplètes
 */

export interface MarginInput {
  unitPriceTtcCents: number | null
  vatRateBpSnapshot: number | null
  supplierPurchasePriceHtCents: number | null
}

/**
 * Calcule la marge unitaire HT en cents.
 *
 * Retourne null si l'un des 3 inputs est null (données incomplètes).
 * Retourne un entier (Math.round appliqué sur la conversion TTC→HT).
 *
 * @example
 *   unitMarginHtCents({ unitPriceTtcCents: 2100, vatRateBpSnapshot: 550, supplierPurchasePriceHtCents: 1000 })
 *   // HT = round(2100 * 10000 / 10550) = round(1990.52) = 1991
 *   // marge = 1991 - 1000 = 991 cents (+9,91 €)
 */
export function unitMarginHtCents(line: MarginInput): number | null {
  if (
    line.unitPriceTtcCents == null ||
    line.vatRateBpSnapshot == null ||
    line.supplierPurchasePriceHtCents == null
  ) {
    return null
  }
  const sellHt = Math.round((line.unitPriceTtcCents * 10000) / (10000 + line.vatRateBpSnapshot))
  return sellHt - line.supplierPurchasePriceHtCents
}
