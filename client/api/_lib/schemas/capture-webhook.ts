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
