import { z } from 'zod'

/**
 * Story 7-3b — Zod schemas + types pour les handlers admin products
 * (`admin-products-list`, `admin-product-create`, `admin-product-update`,
 * `admin-product-delete`).
 *
 * Décisions portées :
 *   - D-2 : `tier_prices` array ≥ 1 entrée requise à la création, max 10,
 *     strict croissant par `tier`. Epic 4 calculs Excel ne tolèrent pas
 *     tier_prices=[].
 *   - D-5 : `origin` ISO 3166-1 alpha-2 (regex `^[A-Z]{2}$`, length=2).
 *     Nullable (rétrocompat avec produits pré-Story 7-3b).
 *
 * Le `code` est immutable (cf. update-handler 422 CODE_IMMUTABLE) — la FK
 * `sav_lines.product_code` text rendrait toute mutation casse-historique.
 */

const PRODUCT_CODE_RE = /^[A-Z0-9_-]+$/
const ISO_ALPHA2_RE = /^[A-Z]{2}$/

/**
 * Hardening W-7-3b-5 : cap `price_ht_cents` à 10_000_000 cents = 100 000 €
 * HT/unité. Sanity guard métier — au-dessus c'est forcément une faute de
 * frappe (ex: 999_999_999_999 trillion d'euros). Sans ce cap, un admin
 * peut soumettre un INSERT/UPDATE qui passe Zod mais devient incohérent
 * en aval (calculs Excel Epic 4, exports tarifs, etc.).
 */
export const PRICE_HT_CENTS_MAX = 10_000_000

export const tierPriceSchema = z
  .object({
    tier: z.number().int().min(1),
    price_ht_cents: z.number().int().min(0).max(PRICE_HT_CENTS_MAX),
  })
  .strict()
export type TierPrice = z.infer<typeof tierPriceSchema>

export const productListQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  supplier_code: z.string().trim().min(1).max(32).optional(),
  default_unit: z.enum(['kg', 'piece', 'liter']).optional(),
  origin: z.string().trim().toUpperCase().length(2).regex(ISO_ALPHA2_RE).optional(),
  is_deleted: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).max(10_000).optional().default(0),
})
export type ProductListQuery = z.infer<typeof productListQuerySchema>

/**
 * Schema partagé refine helpers — strict croissant tiers + piece_weight
 * conditionnel.
 */
function tiersStrictlyIncreasing(tiers: TierPrice[]): boolean {
  for (let i = 1; i < tiers.length; i += 1) {
    const prev = tiers[i - 1]
    const cur = tiers[i]
    if (prev === undefined || cur === undefined) return false
    if (cur.tier <= prev.tier) return false
  }
  return true
}

export const productCreateSchema = z
  .object({
    code: z.string().trim().min(1).max(64).regex(PRODUCT_CODE_RE),
    name_fr: z.string().trim().min(1).max(200),
    name_en: z.string().trim().max(200).nullable().optional(),
    name_es: z.string().trim().max(200).nullable().optional(),
    vat_rate_bp: z.number().int().min(0).max(10000).optional().default(550),
    default_unit: z.enum(['kg', 'piece', 'liter']),
    piece_weight_grams: z.number().int().positive().nullable().optional(),
    tier_prices: z.array(tierPriceSchema).min(1).max(10),
    // V1 : pas de whitelist supplier_code, ouvert pour V2 nouveaux
    // fournisseurs (cf. CR W-7-3b-4 OQ-2). Validation loose `string max 32`
    // suffit — un mauvais code ne casse rien (pas de FK contrainte côté
    // products, juste métadonnée d'origine).
    supplier_code: z.string().trim().min(1).max(32).nullable().optional(),
    // D-5 : ISO 3166-1 alpha-2. Nullable rétrocompat.
    origin: z
      .string()
      .trim()
      .length(2)
      .regex(ISO_ALPHA2_RE, 'origin doit être un code ISO 3166-1 alpha-2 (2 majuscules)')
      .nullable()
      .optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.default_unit !== 'piece' ||
      (data.piece_weight_grams !== null && data.piece_weight_grams !== undefined),
    {
      message: 'piece_weight_grams requis si default_unit=piece',
      path: ['piece_weight_grams'],
    }
  )
  .refine((data) => tiersStrictlyIncreasing(data.tier_prices), {
    message: 'tier_prices doit être strictement croissant par tier',
    path: ['tier_prices'],
  })
export type ProductCreateBody = z.infer<typeof productCreateSchema>

/**
 * Update partial. Tous les champs optionnels mais validés s'ils sont
 * présents. `code` est interdit (CODE_IMMUTABLE 422 côté handler — FK
 * `sav_lines.product_code` text). `deleted_at` accepté pour soft-delete
 * restore (admin re-désactive ou réactive).
 */
export const productUpdateSchema = z
  .object({
    name_fr: z.string().trim().min(1).max(200).optional(),
    name_en: z.string().trim().max(200).nullable().optional(),
    name_es: z.string().trim().max(200).nullable().optional(),
    vat_rate_bp: z.number().int().min(0).max(10000).optional(),
    default_unit: z.enum(['kg', 'piece', 'liter']).optional(),
    piece_weight_grams: z.number().int().positive().nullable().optional(),
    tier_prices: z.array(tierPriceSchema).min(1).max(10).optional(),
    // V1 : pas de whitelist supplier_code, ouvert pour V2 nouveaux
    // fournisseurs (cf. CR W-7-3b-4 OQ-2). Validation loose `string max 32`
    // suffit — un mauvais code ne casse rien (pas de FK contrainte côté
    // products, juste métadonnée d'origine).
    supplier_code: z.string().trim().min(1).max(32).nullable().optional(),
    origin: z
      .string()
      .trim()
      .length(2)
      .regex(ISO_ALPHA2_RE, 'origin doit être un code ISO 3166-1 alpha-2 (2 majuscules)')
      .nullable()
      .optional(),
    // PATCH deleted_at à null pour réactiver, ou ISO 8601 timestamp pour
    // re-désactiver manuellement (le DELETE handler set lui-même now()).
    // Hardening W-7-3b-2 : `.datetime()` strict — sinon un client peut
    // envoyer "garbage" qui passait Zod et faisait 500 PERSIST_FAILED côté
    // PG (cast timestamptz échoue). Maintenant 400 INVALID_BODY direct.
    // Hardening W-7-3b-1 : `product-update-handler` détecte la transition
    // de `deleted_at` (before vs after) et dispatch `action='deleted'` ou
    // `'restored'` sur recordAudit (cohérent FR58 non-répudiation).
    deleted_at: z.string().datetime().nullable().optional(),
  })
  .strict()
  .refine((data) => data.tier_prices === undefined || tiersStrictlyIncreasing(data.tier_prices), {
    message: 'tier_prices doit être strictement croissant par tier',
    path: ['tier_prices'],
  })
export type ProductUpdateBody = z.infer<typeof productUpdateSchema>

export interface ProductRow {
  id: number
  code: string
  name_fr: string
  name_en: string | null
  name_es: string | null
  vat_rate_bp: number
  default_unit: 'kg' | 'piece' | 'liter'
  piece_weight_grams: number | null
  tier_prices: TierPrice[]
  supplier_code: string | null
  origin: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}
