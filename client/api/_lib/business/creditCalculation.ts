/**
 * Story 4.2 — moteur calcul avoir ligne (port TS des formules Excel historiques).
 *
 * Module PUR : aucun import IO (Supabase, Graph, SMTP, fs, axios). La règle
 * ESLint `no-restricted-imports` (override `_lib/business/**`) l'impose.
 *
 * Source de vérité fonctionnelle = PRD §FR21-FR28 + fixture
 * `client/tests/fixtures/excel-calculations.json` (≥ 20 cas). Le trigger PG
 * `compute_sav_line_credit` (migration 20260426120000) est le MIROIR SQL strict
 * de ce module — tout changement ici impose la mise à jour du trigger + ré-
 * génération du fichier `_generated_fixture_cases.sql` (step CI
 * `check-fixture-sql-sync`).
 *
 * Ordre de résolution `validation_status` (corrigé vs spec AC #2 initiale ;
 * cf. Debug Log story 4.2) :
 *   1. to_calculate         (unit_price OR vat_rate snapshot manquant)
 *   2. blocked              (coefficient hors [0,1] — défense en profondeur
 *                             vs CHECK DB + Zod amont)
 *   3. unit_mismatch        (unités différentes ET pas de conversion possible)
 *   4. Résolution conversion pièce↔kg si applicable (calcul price + qty_invoiced
 *      équivalent dans l'unité demandée)
 *   5. qty_exceeds_invoice  (qty_requested > qty_invoiced_converted strict,
 *                             comparaison DANS L'UNITÉ DEMANDÉE)
 *   6. ok (nominal ou conversion réussie)
 */

export type Unit = 'kg' | 'piece' | 'liter'

export type ValidationStatus =
  | 'ok'
  | 'unit_mismatch'
  | 'qty_exceeds_invoice'
  | 'to_calculate'
  | 'blocked'

export type SavLineInput = {
  qty_requested: number
  unit_requested: Unit
  qty_invoiced: number | null
  unit_invoiced: Unit | null
  unit_price_ht_cents: number | null
  vat_rate_bp_snapshot: number | null
  credit_coefficient: number
  piece_to_kg_weight_g: number | null
}

export type SavLineComputed = {
  credit_amount_cents: number | null
  validation_status: ValidationStatus
  validation_message: string | null
}

function roundCents(value: number): number {
  return Math.round(value)
}

/**
 * Arrondi à 3 décimales (match `numeric(12,3)` côté PG). Utilisé sur
 * `qty_invoiced_converted` pour éviter la divergence silencieuse entre JS
 * double (ex: `(10*3)/1000 = 0.02999999999999999`) et PG numeric exact
 * (`0.030`) au moment de la comparaison `qty_exceeds_invoice`.
 */
function roundQty3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * Calcule `credit_amount_cents` + `validation_status` pour une ligne SAV.
 * Déterministe, ne mute pas son argument, ne lance pas d'exception.
 */
export function computeSavLineCredit(input: SavLineInput): SavLineComputed {
  const {
    qty_requested,
    unit_requested,
    qty_invoiced,
    unit_invoiced,
    unit_price_ht_cents,
    vat_rate_bp_snapshot,
    credit_coefficient,
    piece_to_kg_weight_g,
  } = input

  // 0. Defense Error Handling Rule 4 : jamais de fallback silencieux sur
  //    données financières. Si les inputs contiennent NaN/Infinity (bug
  //    sérialisation amont), on rejette en 'to_calculate' avec message
  //    explicite plutôt que propager un résultat corrompu.
  const numericInputs = [
    qty_requested,
    credit_coefficient,
    qty_invoiced,
    unit_price_ht_cents,
    vat_rate_bp_snapshot,
    piece_to_kg_weight_g,
  ]
  for (const n of numericInputs) {
    if (n !== null && !Number.isFinite(n)) {
      return {
        credit_amount_cents: null,
        validation_status: 'to_calculate',
        validation_message: 'Valeur numérique invalide (NaN ou Infinity) dans les inputs',
      }
    }
  }

  // 1. to_calculate : information manquante (capture incomplète)
  //    - unit_price_ht_cents ou vat_rate_bp_snapshot NULL → capture Make.com
  //      en attente du webhook facture (Epic 2 — double webhook capture+facture).
  //    - qty_invoiced / unit_invoiced NULL : pareil, facture pas encore matchée.
  //      Sans facture, la défense FR24 (qty_requested <= qty_invoiced) ne peut
  //      pas être évaluée → 'to_calculate' force l'opérateur à attendre que le
  //      webhook facture remplisse les colonnes avant de valider.
  if (
    unit_price_ht_cents === null ||
    vat_rate_bp_snapshot === null ||
    qty_invoiced === null ||
    unit_invoiced === null
  ) {
    return {
      credit_amount_cents: null,
      validation_status: 'to_calculate',
      validation_message:
        'Données facture incomplètes (prix, TVA ou quantité/unité facturée manquants)',
    }
  }

  // 2. blocked : coefficient hors plage (défense en profondeur)
  if (credit_coefficient < 0 || credit_coefficient > 1) {
    return {
      credit_amount_cents: null,
      validation_status: 'blocked',
      validation_message: 'Coefficient avoir hors plage [0,1]',
    }
  }

  // 3+4. Résolution des unités : même unité OU conversion pièce↔kg
  let price_effective = unit_price_ht_cents
  let qty_invoiced_converted: number | null = qty_invoiced

  if (unit_invoiced !== null && unit_requested !== unit_invoiced) {
    const hasWeight = piece_to_kg_weight_g !== null && piece_to_kg_weight_g > 0
    const weight_g = piece_to_kg_weight_g as number

    if (unit_requested === 'kg' && unit_invoiced === 'piece' && hasWeight) {
      // Cas A : adhérent demande en kg, facturé en pièces
      price_effective = roundCents((unit_price_ht_cents * 1000) / weight_g)
      qty_invoiced_converted = roundQty3((qty_invoiced * weight_g) / 1000)
    } else if (unit_requested === 'piece' && unit_invoiced === 'kg' && hasWeight) {
      // Cas B : adhérent demande en pièces, facturé en kg
      price_effective = roundCents((unit_price_ht_cents * weight_g) / 1000)
      qty_invoiced_converted = roundQty3((qty_invoiced * 1000) / weight_g)
    } else {
      // Pas de conversion définie → unit_mismatch bloquant
      return {
        credit_amount_cents: null,
        validation_status: 'unit_mismatch',
        validation_message: `Unité demandée (${unit_requested}) ≠ unité facturée (${unit_invoiced}) — conversion indisponible`,
      }
    }
  }

  // 5. qty_exceeds_invoice (comparaison DANS l'unité demandée, après conversion)
  if (qty_invoiced_converted !== null && qty_requested > qty_invoiced_converted) {
    return {
      credit_amount_cents: null,
      validation_status: 'qty_exceeds_invoice',
      validation_message: `Quantité demandée (${qty_requested}) > quantité facturée (${qty_invoiced_converted})`,
    }
  }

  // 6. Happy path ok
  const qty_effective = qty_invoiced_converted ?? qty_requested
  const credit = roundCents(qty_effective * price_effective * credit_coefficient)
  return {
    credit_amount_cents: credit,
    validation_status: 'ok',
    validation_message: null,
  }
}

/**
 * Somme `credit_amount_cents` des lignes en `validation_status='ok'`.
 * Utilisé pour preview live (Story 4.3) et calcul totaux avoir (Story 4.4).
 */
export function computeSavTotal(lines: readonly SavLineComputed[]): number {
  let total = 0
  for (const line of lines) {
    if (
      line.validation_status === 'ok' &&
      line.credit_amount_cents !== null &&
      Number.isFinite(line.credit_amount_cents)
    ) {
      total += line.credit_amount_cents
    }
  }
  return total
}
