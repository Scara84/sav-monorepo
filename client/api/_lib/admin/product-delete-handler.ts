import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { recordAudit } from '../audit/record'
import { type ProductRow } from './products-schema'
import { parseTargetId } from './parse-target-id'
import type { ApiHandler } from '../types'

/**
 * Story 7-3b AC #3 — `DELETE /api/admin/products/:id` (op `admin-product-delete`).
 *
 * Soft-delete : `UPDATE products SET deleted_at=now()`. Hard delete
 * interdit (préserve FK `sav_lines.product_code` et historique). Audit
 * `action='deleted'`.
 *
 * Réponses :
 *   200 → { data: { product: ProductRow } }
 *   400 INVALID_PARAMS
 *   403 ROLE_NOT_ALLOWED
 *   404 NOT_FOUND
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

export const adminProductDeleteHandler: ApiHandler = async (req, res) => {
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

  const admin = supabaseAdmin() as SupabaseAdminLike

  const { row: before } = await fetchProduct(admin, targetId)
  if (!before) {
    sendError(res, 'NOT_FOUND', 'Produit introuvable', requestId, {
      code: 'PRODUCT_NOT_FOUND',
    })
    return
  }

  const deletedAt = new Date().toISOString()

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
    .update({ deleted_at: deletedAt })
    .eq('id', targetId)
    .select(
      'id, code, name_fr, name_en, name_es, vat_rate_bp, default_unit, ' +
        'piece_weight_grams, tier_prices, supplier_code, origin, ' +
        'created_at, updated_at, deleted_at'
    )
    .single()

  if (updateError) {
    logger.error('admin.products.delete.persist_failed', {
      requestId,
      code: updateError.code,
      message: updateError.message,
    })
    sendError(res, 'SERVER_ERROR', 'Suppression impossible', requestId, {
      code: 'PERSIST_FAILED',
    })
    return
  }
  if (!after) {
    logger.error('admin.products.delete.persist_empty', { requestId })
    sendError(res, 'SERVER_ERROR', 'Suppression impossible', requestId, {
      code: 'PERSIST_FAILED',
    })
    return
  }

  try {
    await recordAudit({
      entityType: 'product',
      entityId: after.id,
      action: 'deleted',
      actorOperatorId: user.sub,
      diff: {
        before: { deleted_at: before.deleted_at },
        after: { deleted_at: after.deleted_at },
      },
    })
  } catch (e) {
    logger.warn('admin.products.delete.audit_failed', {
      requestId,
      productId: after.id,
      message: e instanceof Error ? e.message : String(e),
    })
  }

  logger.info('admin.products.delete.success', {
    requestId,
    actorOperatorId: user.sub,
    productId: after.id,
  })

  res.status(200).json({ data: { product: after } })
}
