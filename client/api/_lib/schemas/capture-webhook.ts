import { z } from 'zod'

/**
 * Schéma Zod du payload webhook capture Make.com (Story 2.2 AC #5).
 *
 * Consommé par `client/api/webhooks/capture.ts` et aussi par la RPC Postgres
 * `capture_sav_from_webhook(jsonb)` (clés reprises telles quelles en jsonb).
 */
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
        unitPriceHtCents: z.number().int().nonnegative().optional(), // prix unitaire HT en cents EUR (2500 = 25,00 €)
        vatRateBp: z.number().int().nonnegative().max(10000).optional(), // taux TVA en basis points (550 = 5,5 %, 2000 = 20 %)
        qtyInvoiced: z.number().nonnegative().optional(), // quantité effectivement facturée (peut différer de qtyRequested)
        invoiceLineId: z.string().max(255).optional(), // identifiant ligne facture Pennylane (traçabilité reconciliation, max 255 — DN-4 locked)
        // Story 4.7 fix — unitInvoiced requis par trigger trg_compute_sav_line_credit (D1 patch :
        // unit_invoiced IS NULL → 'to_calculate'). Si absent et unitPriceHtCents est présent,
        // la RPC défautera à unit (même produit, même unité — sane default V1).
        // Si absent ET unitPriceHtCents absent : NULL → 'to_calculate' (comportement legacy intentionnel).
        // Story 4.7 OQ-2 : enum tightenned to match `unit` (smaller blast radius).
        // Make MUST translate Pennylane-native strings ('Kilogramme') to one of the 4 enum values.
        // Prevents trigger comparison unit_requested != unit_invoiced firing 'unit_mismatch' wrongly.
        unitInvoiced: z.enum(['kg', 'piece', 'liter', 'g']).optional(), // unité facturée — même enum que `unit` (Pennylane → Make translate responsability)
      })
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
