import { z } from 'zod'

/**
 * Story 7-3c — Zod schemas + types pour les handlers admin validation_lists
 * (`admin-validation-lists-list`, `admin-validation-list-create`,
 * `admin-validation-list-update`).
 *
 * Décisions portées :
 *   - D-7 : `list_code` enum strict V1 = `['sav_cause', 'bon_type', 'unit']`.
 *     Rationale : éviter explosion incontrôlée des codes. Ajout de nouveaux
 *     codes hors enum = story dédiée future (Q-5).
 *   - D-8 : `value` + `list_code` immutables (UPDATE rejette → 422). Soft-
 *     delete via `is_active=false` (pas de DELETE physique). `value` est un
 *     text non-FK ; supprimer/muter une entrée référencée par `sav.metadata`
 *     casserait la cohérence historique.
 *
 * Schema FR + ES uniquement — **pas de `value_en`** (D-6 retirée du scope V1,
 * Q-4=non YAGNI : V1 UI back-office FR seul, exports Rufino ES seul).
 */

export const VALIDATION_LIST_CODES = ['sav_cause', 'bon_type', 'unit'] as const
export type ValidationListCode = (typeof VALIDATION_LIST_CODES)[number]

export const validationListListQuerySchema = z.object({
  active_only: z.enum(['true', 'false']).optional(),
})
export type ValidationListListQuery = z.infer<typeof validationListListQuerySchema>

export const validationListCreateSchema = z
  .object({
    // D-7 enum strict V1
    list_code: z.enum(VALIDATION_LIST_CODES),
    // FR : non vide ≤ 100 (trim)
    value: z.string().trim().min(1).max(100),
    // ES optionnel ≤ 100 (nullable). Pas de `value_en` (D-6 retirée).
    value_es: z.string().trim().max(100).nullable().optional(),
    // sort_order int ≥ 0, défaut 100 (préserve la convention seed)
    sort_order: z.number().int().min(0).default(100),
    // is_active boolean, défaut true
    is_active: z.boolean().default(true),
  })
  .strict()
export type ValidationListCreateBody = z.infer<typeof validationListCreateSchema>

/**
 * D-8 : `value` + `list_code` immutables. Le handler check explicitement
 * AVANT le Zod parse pour produire 422 VALUE_IMMUTABLE / LIST_CODE_IMMUTABLE
 * dédiés (cohérent product-update CODE_IMMUTABLE).
 *
 * `.strict()` rejette tout autre champ inconnu.
 */
export const validationListUpdateSchema = z
  .object({
    value_es: z.string().trim().max(100).nullable().optional(),
    sort_order: z.number().int().min(0).optional(),
    is_active: z.boolean().optional(),
  })
  .strict()
export type ValidationListUpdateBody = z.infer<typeof validationListUpdateSchema>

/**
 * Schema actuel `validation_lists` (migration `20260419120000` lignes 161-169) :
 * pas de colonnes `created_at` / `updated_at` (cf. snapshot W113 audit). Si un
 * besoin apparaît, story dédiée future ajoutera la migration.
 */
export interface ValidationListEntryRow {
  id: number
  list_code: ValidationListCode
  value: string
  value_es: string | null
  sort_order: number
  is_active: boolean
}

/**
 * Hardening W-7-3c-4 — normalise `value_es` reçu en body.
 *
 * Zod `z.string().trim().max(100).nullable().optional()` accepte `""` (empty
 * string) après trim. Or côté exports Rufino (`supplierExportBuilder.ts`),
 * le code consumer suppose `value_es === null` pour fallback FR. Une chaîne
 * vide casserait la sémantique et produirait des cellules vides au lieu du
 * label FR.
 *
 * Helper centralisé : si la valeur (post-trim Zod) est `""`, on la normalise
 * en `null`. Appelé par les handlers create + update avant l'INSERT/UPDATE.
 *
 * Renvoie :
 *   - `null` si v === null OU v === ""
 *   - `undefined` si v === undefined (= "ne pas toucher" côté update)
 *   - `string` sinon
 */
export function normalizeValueEs(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  if (v.length === 0) return null
  return v
}
