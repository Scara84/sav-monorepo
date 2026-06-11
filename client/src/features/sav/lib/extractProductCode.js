/**
 * Story V1.12 — Qualité du product_code capturé
 *
 * Pure helper extracting a Fruitstock catalogue product code from the head of a
 * product label, with a safe slice(0,32) fallback.
 *
 * Contract (AC#1 / AC#2 / AC#4) :
 *   - signature : extractProductCode(label: string) => string
 *   - pattern catalogue : ^([0-9]{3,5}(?:-[A-Z0-9]{1,6})?)\s
 *   - match → returns the captured code (e.g. `3010-2K`, `6162-400GR`)
 *   - no-match → returns label.slice(0, 32) (last resort, never empty)
 *   - never mutates the input label (JS strings are immutable; contract reaffirmed)
 *
 * Catalogue reference (Story 2.1, data.xlsx — 856 codes audited 2026-06-11) :
 *   - 621/856 codes (73 %) match the AC#1 regex as-is — including all UAT-cited
 *     codes (`3010-2K`, `3357-2K`, `6162-400GR`).
 *   - 215/856 codes (25 %) have a suffix > 6 chars (`4X500GR`, `12X500GR`,
 *     `1.5L`, `1100-1312-500GR`…). They fall back to slice(0,32) which still
 *     produces a non-empty string (legacy behavior preserved, no regression).
 *     V2 widening candidate (suffix `{1,12}` + multi-dash) tracked separately.
 *
 * Defensive entries : null, undefined, non-string → returns '' (empty string).
 * The caller (WebhookItemsList.vue) always supplies a fallback chain producing
 * a non-empty label (`factureItem.label || factureItem.product_name || 'Article
 * inconnu'`) so empty returns only occur with explicit empty-string input.
 *
 * Server mirror : `client/api/_lib/schemas/capture-webhook.ts` re-applies the
 * same regex in `normalizeCaptureItemUnit` (defense in depth, anti-drift
 * pattern CR 8.7).
 */

// Frozen catalogue pattern (AC#1). Anchored at start, requires a trailing
// whitespace to delimit the code from the label so we never capture a code
// "fused" with the description (`3010POMELO` → no match → fallback).
//
// EXPORTED for anti-drift parity sentinel (CR 8.7 pattern) — the server mirror
// `CATALOGUE_CODE_RE_SERVER` in `client/api/_lib/schemas/capture-webhook.ts`
// must keep `.source` and flags identical. A dedicated parity test asserts it.
export const CATALOGUE_CODE_RE = /^([0-9]{3,5}(?:-[A-Z0-9]{1,6})?)\s/

/**
 * @param {unknown} label
 * @returns {string}
 */
export function extractProductCode(label) {
  if (typeof label !== 'string') return ''
  if (label.length === 0) return ''
  const match = label.match(CATALOGUE_CODE_RE)
  if (match) return match[1]
  return label.slice(0, 32)
}

export default extractProductCode
