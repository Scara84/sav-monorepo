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
  | 'awaiting_arbitration'

export type SavLineInput = {
  qty_requested: number
  unit_requested: Unit
  qty_invoiced: number | null
  unit_invoiced: Unit | null
  // V1.9-B — arbitrage opérateur (COALESCE source effective)
  qty_arbitrated?: number | null
  unit_arbitrated?: Unit | null
  unit_price_ttc_cents: number | null
  // V1.9-B.2 — override opérateur PU TTC (Row 3). NULL/absent = utilise unit_price_ttc_cents (facture).
  unit_price_ttc_arbitrated_cents?: number | null
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
 * W18 (2026-05-04) — formate une quantité numérique pour affichage UX
 * sans afficher de zéros de précision parasites :
 *   - 6        → "6"
 *   - 6.5      → "6.5"
 *   - 6.123    → "6.123"
 *   - 6.1234   → "6.123" (toFixed(3) tronque/arrondit)
 *   - 100      → "100"
 *
 * Utilisé dans `validation_message` (qty_exceeds_invoice). Mirror SQL
 * dans le trigger `compute_sav_line_credit` via `regexp_replace(qty::text,
 * '\.?0+$', '')` (cf. migration 20260504140000).
 */
export function formatQty(value: number): string {
  if (!Number.isFinite(value)) return String(value)
  return value.toFixed(3).replace(/\.?0+$/, '')
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
    unit_price_ttc_cents,
    vat_rate_bp_snapshot,
    credit_coefficient,
    piece_to_kg_weight_g,
  } = input

  // V1.9-B.2 — PU TTC source effective : COALESCE(arbitrated, invoiced).
  // L'opérateur peut override le prix Pennylane via Row 3. Si NULL/absent → fallback facture.
  const unit_price_ttc_arbitrated =
    input.unit_price_ttc_arbitrated_cents !== undefined &&
    input.unit_price_ttc_arbitrated_cents !== null
      ? input.unit_price_ttc_arbitrated_cents
      : null
  const unit_price_ttc_effective =
    unit_price_ttc_arbitrated !== null ? unit_price_ttc_arbitrated : unit_price_ttc_cents

  // V1.9-B — Source effective : COALESCE(qty_arbitrated, qty_invoiced)
  // Si qty_arbitrated ABSENT du input (champ optionnel, ancien appelant V1.9-A) →
  // on considère que l'arbitrage = qty_invoiced (backward compat, pas d'awaiting_arbitration).
  // Si qty_arbitrated PRÉSENT et null explicitement → awaiting_arbitration (DN-1 Option A).
  const hasArbitration = 'qty_arbitrated' in input
  const qty_arbitrated = hasArbitration ? (input.qty_arbitrated ?? null) : undefined
  const unit_arbitrated = hasArbitration ? (input.unit_arbitrated ?? null) : undefined

  // 0. Defense Error Handling Rule 4 : jamais de fallback silencieux sur
  //    données financières. Si les inputs contiennent NaN/Infinity (bug
  //    sérialisation amont), on rejette en 'to_calculate' avec message
  //    explicite plutôt que propager un résultat corrompu.
  const numericInputs = [
    qty_requested,
    credit_coefficient,
    qty_invoiced,
    // qty_arbitrated peut être undefined (champ optionnel) — exclude undefined de la vérification
    qty_arbitrated !== undefined ? qty_arbitrated : null,
    unit_price_ttc_cents,
    unit_price_ttc_arbitrated,
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
  //    - unit_price_ttc_cents ou vat_rate_bp_snapshot NULL → capture Make.com
  //      en attente du webhook facture (Epic 2 — double webhook capture+facture).
  //    - qty_invoiced / unit_invoiced NULL : pareil, facture pas encore matchée.
  //      Sans facture, la défense FR24 (qty_requested <= qty_invoiced) ne peut
  //      pas être évaluée → 'to_calculate' force l'opérateur à attendre que le
  //      webhook facture remplisse les colonnes avant de valider.
  if (
    unit_price_ttc_cents === null ||
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

  // V1.9-B — awaiting_arbitration : facture présente + PU+VAT set + qty_arbitrated explicitement NULL
  // Uniquement quand le champ qty_arbitrated est présent dans l'input MAIS null (pas absent).
  // Si absent (ancien appelant V1.9-A sans connaissance de ce champ) → backward compat.
  // DN-1 Option A : badge orange 'awaiting_arbitration'.
  if (hasArbitration && qty_arbitrated === null) {
    return {
      credit_amount_cents: null,
      validation_status: 'awaiting_arbitration',
      validation_message: 'Arbitrage opérateur requis (Row 3)',
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

  // V1.8 — Conversion TTC → HT.
  // Pennylane V2 envoie le prix unitaire TTC (cf. capture-webhook schema). Le
  // moteur doit travailler en HT pour que `computeCreditNoteTotals` puisse
  // ré-appliquer la TVA sans double-comptage. La conversion s'appuie sur le
  // snapshot TVA de la ligne (vat_rate_bp_snapshot, en basis points).
  //   unit_price_ht_cents = unit_price_ttc_cents / (1 + vat_rate_bp / 10000)
  // V1.9-B.2 — utilise la source effective (COALESCE arbitrated→invoiced)
  const unit_price_ht_cents = roundCents(
    ((unit_price_ttc_effective as number) * 10000) / (10000 + vat_rate_bp_snapshot)
  )

  // V1.9-B — Source effective après COALESCE :
  //   qty effective = COALESCE(qty_arbitrated, qty_invoiced)
  //   unit effective = COALESCE(unit_arbitrated, unit_invoiced)
  // Si qty_arbitrated est undefined (champ absent, backward compat V1.9-A) → qty_invoiced
  // Si qty_arbitrated est un nombre (non-null) → qty_arbitrated (guard awaiting déjà passé)
  const qty_effective_source: number =
    qty_arbitrated !== undefined && qty_arbitrated !== null ? qty_arbitrated : qty_invoiced // backward compat : qty_arbitrated absent → qty_invoiced
  const unit_effective_source: Unit = (
    unit_arbitrated !== undefined && unit_arbitrated !== null ? unit_arbitrated : unit_invoiced
  ) as Unit

  // 3+4. Résolution des unités : même unité OU conversion pièce↔kg
  // La résolution s'appuie sur la source effective (arbitrée).
  let price_effective = unit_price_ht_cents
  let qty_invoiced_converted: number | null = qty_effective_source

  if (unit_effective_source !== unit_requested) {
    const hasWeight = piece_to_kg_weight_g !== null && piece_to_kg_weight_g > 0
    const weight_g = piece_to_kg_weight_g as number

    if (unit_requested === 'kg' && unit_effective_source === 'piece' && hasWeight) {
      // Cas A : adhérent demande en kg, arbitré en pièces
      price_effective = roundCents((unit_price_ht_cents * 1000) / weight_g)
      qty_invoiced_converted = roundQty3((qty_effective_source * weight_g) / 1000)
    } else if (unit_requested === 'piece' && unit_effective_source === 'kg' && hasWeight) {
      // Cas B : adhérent demande en pièces, arbitré en kg
      price_effective = roundCents((unit_price_ht_cents * weight_g) / 1000)
      qty_invoiced_converted = roundQty3((qty_effective_source * 1000) / weight_g)
    } else {
      // Pas de conversion définie → unit_mismatch bloquant
      const sourceUnitLabel = hasArbitration ? 'arbitrée' : 'facturée'
      return {
        credit_amount_cents: null,
        validation_status: 'unit_mismatch',
        validation_message: `Unité demandée (${unit_requested}) ≠ unité ${sourceUnitLabel} (${unit_effective_source}) — conversion indisponible`,
      }
    }
  }

  // 5. qty_exceeds_invoice (comparaison DANS l'unité demandée, après conversion)
  // V1.9-A backward compat (hasArbitration=false) : compare qty_requested vs qty_invoiced_converted.
  // V1.9-B avec arbitrage (hasArbitration=true) : l'opérateur décide librement — pas de check
  // qty_requested vs qty_arbitrated (l'opérateur peut accorder moins OU plus que demandé).
  // Le check qty_exceeds n'a de sens qu'en mode facturer sans arbitrage explicite.
  if (
    !hasArbitration &&
    qty_invoiced_converted !== null &&
    qty_requested > qty_invoiced_converted
  ) {
    return {
      credit_amount_cents: null,
      validation_status: 'qty_exceeds_invoice',
      // W18 — formatQty évite les zéros de précision parasites (`6` plutôt
      // que `6.000` quand qty_requested vient d'un numeric(12,3)).
      validation_message: `Quantité demandée (${formatQty(qty_requested)}) > quantité facturée (${formatQty(qty_invoiced_converted)})`,
    }
  }

  // 6. Happy path ok
  const qty_final = qty_invoiced_converted ?? qty_requested
  const credit = roundCents(qty_final * price_effective * credit_coefficient)
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
