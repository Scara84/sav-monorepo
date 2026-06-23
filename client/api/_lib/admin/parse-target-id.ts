import type { ApiRequest } from '../types'

/**
 * Story 7-3b Hardening Round 1 (W-7-3b-3) — DRY helper partagé par les
 * handlers admin (operators + products) pour parser `req.query.id`.
 *
 * Garde-fous :
 *   - `null` retourné si query.id absent / vide / non-entier / négatif / 0.
 *   - Bound check PG INTEGER (`int4` max = 2_147_483_647) — évite un 500
 *     PERSIST_FAILED quand l'admin envoie un id supérieur au max int4.
 *     Cohérent avec 7-3a hardening W-7-3a-2 (offset H-2).
 *
 * Avant ce helper, 4 copies identiques étaient maintenues
 * (operator-update, product-update, product-delete, et l'ancien
 * operator-deactivate inlined dans operator-update). Une seule source de
 * vérité réduit le risque de régression sur les autres targets futurs
 * (7-3c lists-validation).
 *
 * Renvoie `null` plutôt qu'un throw afin que les handlers controlent eux-mêmes
 * la sémantique HTTP (400 INVALID_PARAMS / INVALID_TARGET_ID selon contrat).
 */

/**
 * PG `int4` max = 2^31 - 1 = 2_147_483_647. Les colonnes `id` des tables
 * `operators` et `products` sont `bigserial` mais le PostgREST builder
 * encode le param via querystring → `Number(trimmed)` peut dépasser
 * `Number.MAX_SAFE_INTEGER` (2^53 - 1) avec perte de précision. On clamp
 * à `int4` pour V1 (cohérent avec workflows métier — pas de produit ou
 * opérateur au-delà du milliard d'enregistrements).
 */
export const PG_INT4_MAX = 2_147_483_647

export function parseTargetId(req: ApiRequest): number | null {
  const raw = (req.query as Record<string, unknown> | undefined)?.['id']
  if (raw === undefined || raw === null) return null
  const str = Array.isArray(raw) ? String(raw[0]) : String(raw)
  const trimmed = str.trim()
  if (trimmed.length === 0) return null
  const n = Number(trimmed)
  if (!Number.isInteger(n) || n <= 0) return null
  if (n > PG_INT4_MAX) return null
  return n
}
