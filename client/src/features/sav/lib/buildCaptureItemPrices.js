/**
 * Story 4.7 — Pennylane invoice line price enrichment for the SAV capture payload.
 *
 * Extracted from WebhookItemsList.vue so the mapping logic is unit-testable in
 * isolation without mounting the component.
 *
 * Architecture note (why this is in the frontend):
 *   Story 5.7 commit 8d0bc7d cutover Make.com → the browser now POSTs directly
 *   to /api/webhooks/capture (no Make.com in the self-service live path).
 *   The member already sees invoice line prices in InvoiceDetails.vue (fetched
 *   from /api/invoices/lookup → Pennylane V2). This module forwards those prices
 *   into the webhook payload so the backend stores them without needing a
 *   server-side Pennylane re-fetch at submit time.
 *
 * Field mapping (source: docs/integrations/make-capture-flow.md):
 *   Pennylane line field     Webhook field        Conversion
 *   unit_amount (€ decimal)  unitPriceHtCents     × 100 + Math.round
 *   amount + quantity        unitPriceHtCents      fallback: (amount / qty) × 100 + round
 *   vat_rate (% like 5.5)   vatRateBp            × 100 + Math.round → basis points
 *   quantity                 qtyInvoiced          pass-through numeric
 *   id                       invoiceLineId        string, truncated to 255 chars (defensive)
 *   unit (string)            unitInvoiced         mapped to enum kg|piece|liter|g
 */

/**
 * Map a Pennylane-native unit string to the enum expected by captureWebhookSchema.
 *
 * Pennylane V2 may return localised or full-word values (e.g. "Kilogramme", "Pièces").
 * Returns null when the value cannot be mapped — the caller must not set unitInvoiced
 * in that case rather than send an invalid enum value that would cause a Zod 400.
 *
 * @param {string|null|undefined} pennylaneUnit
 * @returns {'kg'|'piece'|'liter'|'g'|null}
 */
export function mapPennylaneUnit(pennylaneUnit) {
  if (pennylaneUnit == null) return null
  const norm = String(pennylaneUnit).trim().toLowerCase()
  if (
    norm === 'kg' ||
    norm === 'kilogramme' ||
    norm === 'kilogrammes' ||
    norm === 'kilogram' ||
    norm === 'kilograms'
  ) {
    return 'kg'
  }
  if (
    norm === 'piece' ||
    norm === 'pieces' ||
    norm === 'pièce' ||
    norm === 'pièces' ||
    norm === 'unite' ||
    norm === 'unité' ||
    norm === 'u' ||
    norm === 'unit' ||
    norm === 'units'
  ) {
    return 'piece'
  }
  if (
    norm === 'liter' ||
    norm === 'liters' ||
    norm === 'litre' ||
    norm === 'litres' ||
    norm === 'l'
  ) {
    return 'liter'
  }
  if (
    norm === 'g' ||
    norm === 'gram' ||
    norm === 'grams' ||
    norm === 'gramme' ||
    norm === 'grammes'
  ) {
    return 'g'
  }
  return null
}

/**
 * Parse a Pennylane V2 `vat_rate` value into basis points.
 *
 * Pennylane returns coded strings (e.g. "FR_55" for 5.5%, "FR_200" for 20%)
 * where the trailing integer is `rate × 10`. We also tolerate plain numeric
 * input for forward compatibility.
 *
 * @param {string|number|null|undefined} vatRate
 * @returns {number|null}  basis points (0..10000), or null when unparseable
 */
export function parseVatRateToBp(vatRate) {
  if (vatRate == null) return null
  if (typeof vatRate === 'number' && Number.isFinite(vatRate)) {
    return Math.round(vatRate * 100)
  }
  const str = String(vatRate).trim()
  if (str === '') return null
  // Try direct numeric (e.g. "5.5") first.
  const direct = Number(str)
  if (Number.isFinite(direct)) {
    return Math.round(direct * 100)
  }
  // Pennylane coded format: "FR_55", "FR_200", etc. — match trailing digits.
  const match = str.match(/_(\d+(?:\.\d+)?)$/)
  if (match) {
    const codeNum = Number(match[1])
    if (Number.isFinite(codeNum)) {
      // FR_55 → 55 → /10 → 5.5% → ×100 → 550 bp
      return Math.round((codeNum / 10) * 100)
    }
  }
  return null
}

/**
 * Build the 5 price-related fields for a capture payload item from a Pennylane
 * invoice line already in component state.
 *
 * All returned fields are optional — if a Pennylane line lacks price data the
 * function returns an empty object and the RPC inserts NULL (legacy behaviour
 * preserved, rétrocompat Story 2.2/5.7).
 *
 * @param {Record<string, unknown>} factureItem  — Pennylane invoice line_item object
 * @returns {Partial<{
 *   unitPriceHtCents: number,
 *   vatRateBp: number,
 *   qtyInvoiced: number,
 *   invoiceLineId: string,
 *   unitInvoiced: 'kg'|'piece'|'liter'|'g',
 * }>}
 */
export function buildCaptureItemPrices(factureItem) {
  if (!factureItem || typeof factureItem !== 'object') return {}

  const prices = {}

  // unitPriceHtCents: prefer Pennylane direct unit_amount (€ HT per unit),
  // fall back to total amount ÷ quantity (both are available on the line).
  const unitAmountEuros =
    factureItem.unit_amount != null
      ? Number(factureItem.unit_amount)
      : factureItem.amount != null &&
          factureItem.quantity != null &&
          Number(factureItem.quantity) > 0
        ? Number(factureItem.amount) / Number(factureItem.quantity)
        : null
  if (unitAmountEuros != null && Number.isFinite(unitAmountEuros)) {
    prices.unitPriceHtCents = Math.round(unitAmountEuros * 100)
  }

  // vatRateBp: Pennylane V2 returns vat_rate as a country-coded string like
  // "FR_55" (5.5%), "FR_200" (20%), "FR_100" (10%), "FR_21" (2.1%). The format
  // is "<COUNTRY>_<rate × 10>" where rate is in percent. We parse the trailing
  // digits and divide by 10 → percent → × 100 → basis points.
  // Numeric input (e.g. raw 5.5) is also tolerated for forward compatibility.
  const vatRateBp = parseVatRateToBp(factureItem.vat_rate)
  if (vatRateBp != null) {
    prices.vatRateBp = vatRateBp
  }

  // qtyInvoiced: the quantity on the invoice line (may differ from member qtyRequested)
  const qtyInvoiced = factureItem.quantity != null ? Number(factureItem.quantity) : null
  if (qtyInvoiced != null && Number.isFinite(qtyInvoiced)) {
    prices.qtyInvoiced = qtyInvoiced
  }

  // invoiceLineId: Pennylane line UUID — capped at 255 chars (defensive, UUID=36 chars)
  if (factureItem.id != null) {
    prices.invoiceLineId = String(factureItem.id).slice(0, 255)
  }

  // unitInvoiced: mapped to enum, only set when prices are present (otherwise null
  // → 'to_calculate' is the intentional legacy behaviour per trigger logic)
  const mappedUnit = mapPennylaneUnit(factureItem.unit)
  if (mappedUnit && prices.unitPriceHtCents != null) {
    prices.unitInvoiced = mappedUnit
  }

  return prices
}
