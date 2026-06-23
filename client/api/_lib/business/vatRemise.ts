/**
 * Story 4.2 — calculs TVA + remise responsable 4 % (FR27, FR28).
 *
 * Module PUR. La remise responsable s'applique sur le HT AVANT TVA (PRD
 * §Fiscalité L418). Les totaux sont produits par `computeCreditNoteTotals`
 * qui est consommé par Story 4.3 (preview) + Story 4.4 (émission avoir, qui
 * passe les 4 totaux à la RPC `issue_credit_number`).
 */

const BP_BASE = 10000 as const // 100 % = 10 000 basis points

function assertInteger(value: number, name: string): void {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${name} doit être un entier (reçu ${value})`)
  }
}

function assertNonNegative(value: number, name: string): void {
  if (value < 0) {
    throw new TypeError(`${name} doit être >= 0 (reçu ${value})`)
  }
}

/** TTC cents = round(HT cents × (1 + vatRateBp / 10000)). */
export function computeTtcCents(htCents: number, vatRateBp: number): number {
  assertInteger(htCents, 'htCents')
  assertInteger(vatRateBp, 'vatRateBp')
  assertNonNegative(vatRateBp, 'vatRateBp')
  return Math.round(htCents * (1 + vatRateBp / BP_BASE))
}

/** Remise responsable en cents (HT × discount_bp / 10 000). */
export function computeGroupManagerDiscountCents(
  htCents: number,
  groupManagerDiscountBp: number
): number {
  assertInteger(htCents, 'htCents')
  assertInteger(groupManagerDiscountBp, 'groupManagerDiscountBp')
  assertNonNegative(groupManagerDiscountBp, 'groupManagerDiscountBp')
  if (groupManagerDiscountBp > BP_BASE) {
    throw new TypeError(
      `groupManagerDiscountBp doit être <= ${BP_BASE} (100 %) — reçu ${groupManagerDiscountBp}`
    )
  }
  return Math.round((htCents * groupManagerDiscountBp) / BP_BASE)
}

export type CreditNoteTotals = {
  total_ht_cents: number
  discount_cents: number
  vat_cents: number
  total_ttc_cents: number
}

/**
 * Calcule les 4 totaux d'un avoir à partir des lignes OK et du contexte
 * responsable. La remise s'applique au HT **avant** TVA (PRD §F&A L418).
 *
 * Pour gérer correctement les taux TVA multi-lignes (PRD §L417), la TVA est
 * calculée LIGNE PAR LIGNE sur le HT net (après application du ratio de
 * remise), puis sommée. La `discount_cents` retournée est la somme globale
 * des remises par ligne (arrondies individuellement pour éviter les écarts
 * d'agrégation).
 */
export function computeCreditNoteTotals(args: {
  linesHtCents: readonly number[]
  lineVatRatesBp: readonly number[]
  groupManagerDiscountBp: number | null
}): CreditNoteTotals {
  const { linesHtCents, lineVatRatesBp, groupManagerDiscountBp } = args

  if (linesHtCents.length !== lineVatRatesBp.length) {
    throw new TypeError(
      `computeCreditNoteTotals: linesHtCents.length (${linesHtCents.length}) != lineVatRatesBp.length (${lineVatRatesBp.length})`
    )
  }

  const discountBp = groupManagerDiscountBp ?? 0
  if (discountBp < 0 || discountBp > BP_BASE) {
    throw new TypeError(
      `groupManagerDiscountBp hors [0, ${BP_BASE}] (reçu ${groupManagerDiscountBp})`
    )
  }

  let total_ht_cents = 0
  let discount_cents = 0
  let vat_cents = 0

  for (let i = 0; i < linesHtCents.length; i++) {
    const ht = linesHtCents[i] as number
    const vatBp = lineVatRatesBp[i] as number
    assertInteger(ht, `linesHtCents[${i}]`)
    assertInteger(vatBp, `lineVatRatesBp[${i}]`)
    assertNonNegative(vatBp, `lineVatRatesBp[${i}]`)

    const discountLine = Math.round((ht * discountBp) / BP_BASE)
    const htNet = ht - discountLine
    const vatLine = Math.round((htNet * vatBp) / BP_BASE)

    total_ht_cents += ht
    discount_cents += discountLine
    vat_cents += vatLine
  }

  const total_ttc_cents = total_ht_cents - discount_cents + vat_cents
  return { total_ht_cents, discount_cents, vat_cents, total_ttc_cents }
}
