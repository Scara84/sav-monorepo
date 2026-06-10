import { z } from 'zod'

/**
 * Schéma Zod du payload webhook capture Make.com (Story 2.2 AC #5).
 *
 * Consommé par `client/api/webhooks/capture.ts` et aussi par la RPC Postgres
 * `capture_sav_from_webhook(jsonb)` (clés reprises telles quelles en jsonb).
 *
 * Unité `g` (UAT 2026-06-10) : le formulaire SPA propose les grammes mais la
 * contrainte DB `sav_lines_unit_check` n'accepte que kg/piece/liter — un item
 * en 'g' passait le Zod puis explosait au RPC (23514 → 500). Le schéma accepte
 * toujours 'g' à la frontière et le NORMALISE en kg via transform : qty/1000,
 * et si l'unité facturée est 'g', prix unitaire ×1000 (€/g → €/kg, reste int).
 * Le type de sortie ne contient plus jamais 'g'.
 */

type UnitCanonical = 'kg' | 'piece' | 'liter'

interface CaptureItemInput {
  productCode: string
  productName: string
  qtyRequested: number
  unit: UnitCanonical | 'g'
  cause?: string | undefined
  unitPriceTtcCents?: number | undefined
  vatRateBp?: number | undefined
  qtyInvoiced?: number | undefined
  invoiceLineId?: string | undefined
  unitInvoiced?: UnitCanonical | 'g' | undefined
}

export type CaptureItemNormalized = Omit<CaptureItemInput, 'unit' | 'unitInvoiced'> & {
  unit: UnitCanonical
  unitInvoiced?: UnitCanonical | undefined
}

export function normalizeCaptureItemUnit(it: CaptureItemInput): CaptureItemNormalized {
  const out = { ...it } as CaptureItemNormalized
  if (it.unit === 'g') {
    out.unit = 'kg'
    out.qtyRequested = it.qtyRequested / 1000
  }
  if (it.unitInvoiced === 'g') {
    out.unitInvoiced = 'kg'
    if (it.qtyInvoiced !== undefined) out.qtyInvoiced = it.qtyInvoiced / 1000
    // Prix par gramme → prix par kg (cents ×1000 : reste entier).
    if (it.unitPriceTtcCents !== undefined) out.unitPriceTtcCents = it.unitPriceTtcCents * 1000
  }
  return out
}
export const captureWebhookSchema = z.object({
  customer: z.object({
    email: z.string().email().max(254),
    pennylaneCustomerId: z.string().max(64).optional(),
    firstName: z.string().max(120).optional(),
    lastName: z.string().max(120).optional(),
    phone: z.string().max(32).optional(),
    // Story 5.7 — extension parité emails Make scenario 2.
    fullName: z.string().max(255).optional(),
    pennylaneSourceId: z.string().max(64).optional(),
  }),
  invoice: z
    .object({
      ref: z.string().max(64),
      date: z.string().datetime().optional(),
      // Story 5.7 — extension parité emails Make scenario 2.
      specialMention: z.string().max(64).optional(),
      label: z.string().max(255).optional(),
    })
    .optional(),
  items: z
    .array(
      z.object({
        productCode: z.string().min(1).max(64),
        productName: z.string().min(1).max(255),
        qtyRequested: z.number().positive().max(99999),
        unit: z.enum(['kg', 'piece', 'liter', 'g']),
        cause: z.string().max(500).optional(),
        // Story 4.7 — Capture des prix facture client (extension rétrocompatible)
        // Ces champs sont optionnels : un payload Make pre-4.7 sans ces champs reste valide.
        // La RPC INSERTe NULL pour les colonnes correspondantes si absents.
        unitPriceTtcCents: z.number().int().nonnegative().optional(), // prix unitaire HT en cents EUR (2500 = 25,00 €)
        vatRateBp: z.number().int().nonnegative().max(10000).optional(), // taux TVA en basis points (550 = 5,5 %, 2000 = 20 %)
        qtyInvoiced: z.number().nonnegative().optional(), // quantité effectivement facturée (peut différer de qtyRequested)
        invoiceLineId: z.string().max(255).optional(), // identifiant ligne facture Pennylane (traçabilité reconciliation, max 255 — DN-4 locked)
        // Story 4.7 fix — unitInvoiced requis par trigger trg_compute_sav_line_credit (D1 patch :
        // unit_invoiced IS NULL → 'to_calculate'). Si absent et unitPriceTtcCents est présent,
        // la RPC défautera à unit (même produit, même unité — sane default V1).
        // Si absent ET unitPriceTtcCents absent : NULL → 'to_calculate' (comportement legacy intentionnel).
        // Story 4.7 OQ-2 : enum tightenned to match `unit` (smaller blast radius).
        // Make MUST translate Pennylane-native strings ('Kilogramme') to one of the 4 enum values.
        // Prevents trigger comparison unit_requested != unit_invoiced firing 'unit_mismatch' wrongly.
        unitInvoiced: z.enum(['kg', 'piece', 'liter', 'g']).optional(), // unité facturée — même enum que `unit` (Pennylane → Make translate responsability)
      })
        .transform(normalizeCaptureItemUnit)
    )
    .min(1)
    .max(200),
  files: z
    .array(
      z.object({
        onedriveItemId: z.string().min(1).max(128),
        webUrl: z.string().url().max(2000),
        originalFilename: z.string().min(1).max(255),
        sanitizedFilename: z.string().min(1).max(255),
        sizeBytes: z.number().int().positive().max(26214400),
        mimeType: z.string().min(1).max(127),
      })
    )
    .max(20)
    .default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
})

export type CaptureWebhookPayload = z.infer<typeof captureWebhookSchema>
