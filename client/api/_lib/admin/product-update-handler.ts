import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { recordAudit } from '../audit/record'
import { productUpdateSchema, type ProductRow } from './products-schema'
import { parseTargetId } from './parse-target-id'
import type { ApiHandler } from '../types'

/**
 * Story 7-3b AC #3 — `PATCH /api/admin/products/:id` (op `admin-product-update`).
 *
 * Garde-fous :
 *   - 422 CODE_IMMUTABLE si body inclut `code` (FK `sav_lines.product_code`
 *     text, mutation casserait l'historique). On check AVANT le Zod parse :
 *     les tests vérifient qu'aucune validation Zod ne masque le 422.
 *   - Zod partial (productUpdateSchema) — tous champs optionnels.
 *
 * Audit : `action='updated'` avec `diff={before, after}` filtré aux champs
 * réellement présents dans le patch.
 *
 * Réponses :
 *   200 → { data: { product: ProductRow } }
 *   400 INVALID_BODY | INVALID_PARAMS
 *   403 ROLE_NOT_ALLOWED
 *   404 NOT_FOUND
 *   422 CODE_IMMUTABLE
 *   500 PERSIST_FAILED
 */

interface SupabaseAdminLike {
  from: (table: string) => unknown
}

async function fetchProduct(
  admin: SupabaseAdminLike,
  id: number
): Promise<{ row: ProductRow | null }> {
  const builder = admin.from('products') as {
    select: (cols: string) => {
      eq: (
        col: string,
        val: unknown
      ) => {
        single: () => Promise<{ data: ProductRow | null; error: unknown }>
      }
    }
  }
  const { data } = await builder
    .select(
      'id, code, name_fr, name_en, name_es, vat_rate_bp, default_unit, ' +
        'piece_weight_grams, tier_prices, supplier_code, origin, ' +
        'created_at, updated_at, deleted_at'
    )
    .eq('id', id)
    .single()
  return { row: data }
}

export const adminProductUpdateHandler: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  const user = req.user
  if (!user || user.type !== 'operator') {
    sendError(res, 'FORBIDDEN', 'Session opérateur requise', requestId)
    return
  }
  if (user.role !== 'admin') {
    sendError(res, 'FORBIDDEN', 'Rôle admin requis', requestId, {
      code: 'ROLE_NOT_ALLOWED',
    })
    return
  }

  const targetId = parseTargetId(req)
  if (targetId === null) {
    sendError(res, 'VALIDATION_FAILED', 'ID produit manquant', requestId, {
      code: 'INVALID_PARAMS',
    })
    return
  }

  const rawBody = req.body
  if (
    rawBody === undefined ||
    rawBody === null ||
    typeof rawBody !== 'object' ||
    Array.isArray(rawBody)
  ) {
    sendError(res, 'VALIDATION_FAILED', 'Body JSON requis', requestId, {
      code: 'INVALID_BODY',
    })
    return
  }

  // Garde-fou CODE_IMMUTABLE — check explicite avant Zod parse (les tests
  // exigent un 422 dédié et que NO UPDATE soit envoyé à Supabase).
  const bodyAsRecord = rawBody as Record<string, unknown>
  if ('code' in bodyAsRecord) {
    sendError(res, 'BUSINESS_RULE', 'Le code produit est immutable', requestId, {
      code: 'CODE_IMMUTABLE',
    })
    return
  }

  const parsed = productUpdateSchema.safeParse(rawBody)
  if (!parsed.success) {
    sendError(res, 'VALIDATION_FAILED', 'Body invalide', requestId, {
      code: 'INVALID_BODY',
      issues: parsed.error.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      })),
    })
    return
  }
  const patch = parsed.data

  const admin = supabaseAdmin() as SupabaseAdminLike

  const { row: before } = await fetchProduct(admin, targetId)
  if (!before) {
    sendError(res, 'NOT_FOUND', 'Produit introuvable', requestId, {
      code: 'PRODUCT_NOT_FOUND',
    })
    return
  }

  const updatePayload: Record<string, unknown> = {}
  if (patch.name_fr !== undefined) updatePayload['name_fr'] = patch.name_fr
  if (patch.name_en !== undefined) updatePayload['name_en'] = patch.name_en
  if (patch.name_es !== undefined) updatePayload['name_es'] = patch.name_es
  if (patch.vat_rate_bp !== undefined) updatePayload['vat_rate_bp'] = patch.vat_rate_bp
  if (patch.default_unit !== undefined) updatePayload['default_unit'] = patch.default_unit
  if (patch.piece_weight_grams !== undefined)
    updatePayload['piece_weight_grams'] = patch.piece_weight_grams
  if (patch.tier_prices !== undefined) updatePayload['tier_prices'] = patch.tier_prices
  if (patch.supplier_code !== undefined) updatePayload['supplier_code'] = patch.supplier_code
  if (patch.origin !== undefined) updatePayload['origin'] = patch.origin
  if (patch.deleted_at !== undefined) updatePayload['deleted_at'] = patch.deleted_at

  const updateBuilder = admin.from('products') as {
    update: (payload: unknown) => {
      eq: (
        col: string,
        val: unknown
      ) => {
        select: (cols: string) => {
          single: () => Promise<{
            data: ProductRow | null
            error: { code?: string; message: string } | null
          }>
        }
      }
    }
  }
  const { data: after, error: updateError } = await updateBuilder
    .update(updatePayload)
    .eq('id', targetId)
    .select(
      'id, code, name_fr, name_en, name_es, vat_rate_bp, default_unit, ' +
        'piece_weight_grams, tier_prices, supplier_code, origin, ' +
        'created_at, updated_at, deleted_at'
    )
    .single()

  if (updateError) {
    logger.error('admin.products.update.persist_failed', {
      requestId,
      code: updateError.code,
      message: updateError.message,
    })
    sendError(res, 'SERVER_ERROR', 'Mise à jour impossible', requestId, {
      code: 'PERSIST_FAILED',
    })
    return
  }
  if (!after) {
    logger.error('admin.products.update.persist_empty', { requestId })
    sendError(res, 'SERVER_ERROR', 'Mise à jour impossible', requestId, {
      code: 'PERSIST_FAILED',
    })
    return
  }

  // Diff filtré aux champs réellement présents dans le patch.
  const diffBefore: Record<string, unknown> = {}
  const diffAfter: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    diffBefore[k] = (before as unknown as Record<string, unknown>)[k]
    diffAfter[k] = v
  }

  // Hardening W-7-3b-1 : dispatch action audit selon transition deleted_at.
  // Cohérent 7-3a G-4 action priority pattern (role_changed > deactivated >
  // reactivated > updated). Non-répudiation FR58 — un soft-delete via PATCH
  // doit produire `action='deleted'` (pas `'updated'`).
  const action = (() => {
    if (patch.deleted_at !== undefined) {
      const wasDeleted = before.deleted_at !== null
      const isNowDeleted = patch.deleted_at !== null
      if (!wasDeleted && isNowDeleted) return 'deleted'
      if (wasDeleted && !isNowDeleted) return 'restored'
    }
    return 'updated'
  })()

  try {
    await recordAudit({
      entityType: 'product',
      entityId: after.id,
      action,
      actorOperatorId: user.sub,
      diff: { before: diffBefore, after: diffAfter },
    })
  } catch (e) {
    logger.warn('admin.products.update.audit_failed', {
      requestId,
      productId: after.id,
      message: e instanceof Error ? e.message : String(e),
    })
  }

  logger.info('admin.products.update.success', {
    requestId,
    actorOperatorId: user.sub,
    productId: after.id,
    action,
  })

  res.status(200).json({ data: { product: after } })
}
