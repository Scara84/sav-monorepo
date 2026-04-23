import { z } from 'zod'

/**
 * Story 3.2 — query schema pour `GET /api/sav`.
 *
 * La normalisation query-string (`status=a,b` → `['a','b']`) est faite par
 * `normalizeListQuery` avant `safeParse` — le schéma accepte les deux formes.
 */

export const savStatusEnum = z.enum([
  'draft',
  'received',
  'in_progress',
  'validated',
  'closed',
  'cancelled',
])

export const listSavQuerySchema = z.object({
  status: z.union([savStatusEnum, z.array(savStatusEnum).min(1).max(6)]).optional(),
  from: z.string().datetime().optional(), // ISO 8601, received_at >=
  to: z.string().datetime().optional(), // ISO 8601, received_at <=
  invoiceRef: z.string().min(1).max(64).optional(),
  memberId: z.coerce.number().int().positive().optional(),
  groupId: z.coerce.number().int().positive().optional(),
  assignedTo: z.union([z.coerce.number().int().positive(), z.literal('unassigned')]).optional(),
  tag: z.string().min(1).max(64).optional(),
  q: z.string().trim().min(1).max(200).optional(), // `.trim()` bloque les variantes whitespace-only
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(256).optional(),
})

export type ListSavQuery = z.infer<typeof listSavQuerySchema>

/**
 * Shape du cursor décodé. Validée post-`JSON.parse` pour éviter une injection
 * via un cursor forgé (un `rec` non-ISO serait injecté verbatim dans `.or()`
 * du builder Supabase).
 */
export const listSavCursorShape = z.object({
  rec: z.string().datetime(),
  id: z.number().int().positive(),
})

export type ListSavCursor = z.infer<typeof listSavCursorShape>

/**
 * Normalise les variantes query-string avant `safeParse` :
 *   - `status=a,b` (CSV) → `['a','b']`
 *   - `status=a&status=b` (répétition) → `['a','b']` (déjà en array par Vercel)
 *   - `status=a` (unique) → reste string (le schéma accepte `string | string[]`)
 *
 * `limit`, `memberId`, `groupId`, `assignedTo` viennent en string et sont
 * coerced par Zod (`z.coerce.number()`).
 */
export function normalizeListQuery(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw }
  const status = out['status']
  if (typeof status === 'string' && status.includes(',')) {
    out['status'] = status
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }
  return out
}
