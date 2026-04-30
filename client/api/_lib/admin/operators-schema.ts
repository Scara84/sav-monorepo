import { z } from 'zod'

/**
 * Story 7-3a — Zod schemas + types pour les handlers admin operators
 * (`admin-operators-list`, `admin-operator-create`, `admin-operator-update`).
 *
 * Email : trim + toLowerCase. La colonne PG est `CITEXT` côté DB ; on
 * normalise quand même pour cohérence client/serveur (recherche +
 * affichage). UUID v4 pour `azure_oid` (cohérent migration 5.8).
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const operatorRoleSchema = z.enum(['admin', 'sav-operator'])
export type OperatorRole = z.infer<typeof operatorRoleSchema>

export const operatorListQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  role: z.union([operatorRoleSchema, z.literal('all')]).optional(),
  is_active: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
  offset: z.coerce.number().int().min(0).max(10_000).optional().default(0),
})
export type OperatorListQuery = z.infer<typeof operatorListQuerySchema>

export const operatorCreateSchema = z
  .object({
    email: z.string().trim().toLowerCase().min(3).max(254).email(),
    display_name: z.string().trim().min(1).max(100),
    role: operatorRoleSchema,
    azure_oid: z
      .string()
      .trim()
      .regex(UUID_V4, 'azure_oid doit être un UUID v4')
      .nullable()
      .optional(),
  })
  .strict()
export type OperatorCreateBody = z.infer<typeof operatorCreateSchema>

export const operatorUpdateSchema = z
  .object({
    display_name: z.string().trim().min(1).max(100).optional(),
    role: operatorRoleSchema.optional(),
    is_active: z.boolean().optional(),
    azure_oid: z
      .string()
      .trim()
      .regex(UUID_V4, 'azure_oid doit être un UUID v4')
      .nullable()
      .optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.display_name !== undefined ||
      v.role !== undefined ||
      v.is_active !== undefined ||
      v.azure_oid !== undefined,
    { message: 'Au moins un champ requis' }
  )
export type OperatorUpdateBody = z.infer<typeof operatorUpdateSchema>

export interface OperatorRow {
  id: number
  email: string
  display_name: string
  role: OperatorRole
  is_active: boolean
  azure_oid: string | null
  created_at: string
}
