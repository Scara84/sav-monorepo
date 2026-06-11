/**
 * Story V1.12 — Qualité du product_code capturé
 * Story V1.14 — Codes-poids décimaux + suffixes longs + multi-dash + backfill
 *
 * Pure helper extracting a Fruitstock catalogue product code from the head of a
 * product label, with a safe slice(0,32) fallback.
 *
 * Contract (V1.12 AC#1 / AC#2 / AC#4 + V1.14 AC#1 / AC#2 / AC#3) :
 *   - signature : extractProductCode(label: string) => string
 *   - pattern catalogue : ^([0-9]{3,5}(?:-[A-Z0-9]+(?:[.,][A-Z0-9]+)?)*)\s
 *     (V1.14 — élargi pour couvrir décimaux `.`/`,`, suffixes longs `4X500GR`,
 *     multi-dash `1100-1312-500GR`)
 *   - match → returns the captured code AVEC NORMALISATION séparateur décimal
 *     `,` → `.` (V1.14 D-1 : point canonique). Ex: `3745-3,5K` → `3745-3.5K`.
 *   - no-match → returns label.slice(0, 32) (last resort, never empty)
 *   - never mutates the input label (JS strings are immutable; contract reaffirmed)
 *
 * Catalogue reference (Story V1.14, data.xlsx — recount CR fix-round 2026-06-11) :
 *   - 856 raw codes au total dans data.xlsx (cf. story V1.14 #3).
 *   - 18 codes « junk » 1–2 chiffres (`1`…`18`) sont structurellement non-
 *     matchables et exclus par design (verrou V1.12 AC#3 = `[0-9]{3,5}`).
 *   - Dénominateur effectif = 856 − 18 = 838 codes catalogue réels.
 *   - 833 / 838 = 99.4 % match propre — au-dessus de la cible AC#2 ≥ 98 %
 *     (lecture proportionnelle au dénominateur réel ; la lecture littérale
 *     « ≥ 98 % des 856 » est inatteignable par design — cf. story V1.14 AC#3
 *     qui verrouille [0-9]{3,5}).
 *   - Couverture V1.14 : décimaux point (`3745-3.5K`, `6594-1.5L`, 10 codes),
 *     suffixes longs (`4X500GR`, `12X500GR`, 191 codes), multi-dash
 *     (`1100-1312-500GR`, 11 codes), + tous les V1.12 (`3010-2K`, `6162-400GR`).
 *   - 5 / 838 codes restent en fallback `slice(0,32)` — design retenu pour
 *     éviter sur-match. Liste exhaustive (recount CR fix-round 2026-06-11) :
 *       1. `5006-SA.-1K`           (double-suffix : point ET tiret final)
 *       2. `5006-SA.-5K`           (idem variante)
 *       3. `6600-4x400GR`          (lowercase `x` — regex case-sensitive)
 *       4. `3635 - 3383-2K`        (espaces autour du tiret interne)
 *       5. `3635 - 3383-5K`        (idem variante)
 *     Cf. story V1.14 AC#2 « lesquels restent en fallback » — déferé V2.
 *
 * Défense V1.14 — séparateur décimal canonique = point (PO Antho 2026-06-11) :
 *   - On reconnaît `.` ET `,` en entrée (la virgule est la forme française vue
 *     dans les labels capturés Pennylane). Le pattern accepte donc `[.,]` dans
 *     les sous-segments décimaux.
 *   - La normalisation `,` → `.` est appliquée uniquement à la VALEUR RETOURNÉE
 *     (capture group), JAMAIS au label source. Le label/désignation reste
 *     strictement intact (V1.12 AC#2 préservé).
 *
 * Defensive entries : null, undefined, non-string → returns '' (empty string).
 * The caller (WebhookItemsList.vue) always supplies a fallback chain producing
 * a non-empty label (`factureItem.label || factureItem.product_name || 'Article
 * inconnu'`) so empty returns only occur with explicit empty-string input.
 *
 * Server mirror : `client/api/_lib/schemas/capture-webhook.ts` re-applies the
 * same regex (et la même normalisation) dans `normalizeCaptureItemUnit`
 * (défense en profondeur, anti-drift pattern CR 8.7 — sentinelle parité
 * `.source`/`.flags` + table comportementale V1.14 AC#4).
 */

// Frozen catalogue pattern V1.14. Anchored at start, requires a trailing
// whitespace to delimit the code from the label so we never capture a code
// "fused" with the description (`3010POMELO` → no match → fallback).
//
// Structure (audit data.xlsx — 856 raw codes, 18 junk 1–2-digit exclus par
// design AC#3 = 838 codes catalogue réels — recount CR fix-round 2026-06-11) :
//   ^[0-9]{3,5}                                    leading 3-5 digits
//   (?:-[A-Z0-9]+(?:[.,][A-Z0-9]+)?)*              zero or more `-SEGMENT`
//                                                  segments, each with optional
//                                                  decimal suffix `.5K` / `,5K`
//   \s                                             whitespace delimiter
//
// EXPORTED for anti-drift parity sentinel (CR 8.7 pattern) — the server mirror
// `CATALOGUE_CODE_RE_SERVER` in `client/api/_lib/schemas/capture-webhook.ts`
// must keep `.source` and flags identical. A dedicated parity test asserts it.
export const CATALOGUE_CODE_RE = /^([0-9]{3,5}(?:-[A-Z0-9]+(?:[.,][A-Z0-9]+)?)*)\s/

/**
 * Normalise le séparateur décimal d'une capture catalogue : virgule → point.
 * Appliqué uniquement à la valeur retournée (pas au label source).
 * @param {string} captured
 * @returns {string}
 */
function normalizeDecimalSeparator(captured) {
  return captured.replace(/,/g, '.')
}

/**
 * @param {unknown} label
 * @returns {string}
 */
export function extractProductCode(label) {
  if (typeof label !== 'string') return ''
  if (label.length === 0) return ''
  const match = label.match(CATALOGUE_CODE_RE)
  if (match) return normalizeDecimalSeparator(match[1])
  return label.slice(0, 32)
}

export default extractProductCode
