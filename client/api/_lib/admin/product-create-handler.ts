import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { recordAudit } from '../audit/record'
import { productCreateSchema, type ProductRow } from './products-schema'
import type { ApiHandler } from '../types'

/**
 * Story 7-3b AC #2 — `POST /api/admin/products` (op `admin-product-create`).
 *
 * Validation Zod (D-2 + D-5) :
 *   - code regex `^[A-Z0-9_-]+$`
 *   - tier_prices array ≥ 1 strict croissant (D-2)
 *   - piece_weight_grams requis si default_unit='piece' (D-2 conditionnel)
 *   - origin ISO 3166-1 alpha-2 nullable (D-5)
 *
 * Audit best-effort : si recordAudit() throw, l'INSERT a déjà réussi → on
 * log warn et on retourne 201 quand même (cohérent G-2 Story 7-3a). Le
 * trigger PG `audit_changes` (Story 1.2) écrit aussi automatiquement
 * sans actor_operator_id (D-4 double-écriture acceptée V1).
 *
 * Réponses :
 *   201 → { data: { product: ProductRow } }
 *   400 INVALID_BODY
 *   403 ROLE_NOT_ALLOWED
 *   409 CODE_ALREADY_EXISTS
 *   500 PERSIST_FAILED
 */

export const adminProductCreateHandler: ApiHandler = async (req, res) => {
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

  const parsed = productCreateSchema.safeParse(rawBody)
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
  const body = parsed.data

  const insertPayload: Record<string, unknown> = {
    code: body.code,
    name_fr: body.name_fr,
    vat_rate_bp: body.vat_rate_bp,
    default_unit: body.default_unit,
    tier_prices: body.tier_prices,
  }
  if (body.name_en !== undefined) insertPayload['name_en'] = body.name_en
  if (body.name_es !== undefined) insertPayload['name_es'] = body.name_es
  if (body.piece_weight_grams !== undefined)
    insertPayload['piece_weight_grams'] = body.piece_weight_grams
  if (body.supplier_code !== undefined) insertPayload['supplier_code'] = body.supplier_code
  if (body.origin !== undefined) insertPayload['origin'] = body.origin

  const admin = supabaseAdmin()
  const { data, error } = await admin
    .from('products')
    .insert(insertPayload)
    .select(
      'id, code, name_fr, name_en, name_es, vat_rate_bp, default_unit, ' +
        'piece_weight_grams, tier_prices, supplier_code, origin, ' +
        'created_at, updated_at, deleted_at'
    )
    .single<ProductRow>()

  if (error) {
    if (error.code === '23505') {
      logger.warn('admin.products.create.unique_violation', {
        requestId,
        constraint: (error as { constraint?: string }).constraint ?? null,
      })
      sendError(res, 'CONFLICT', 'Code produit déjà utilisé', requestId, {
        code: 'CODE_ALREADY_EXISTS',
      })
      return
    }
    logger.error('admin.products.create.persist_failed', {
      requestId,
      code: error.code,
      message: error.message,
    })
    sendError(res, 'SERVER_ERROR', 'Persistance produit échouée', requestId, {
      code: 'PERSIST_FAILED',
    })
    return
  }
  if (!data) {
    logger.error('admin.products.create.persist_empty', { requestId })
    sendError(res, 'SERVER_ERROR', 'Persistance produit échouée', requestId, {
      code: 'PERSIST_FAILED',
    })
    return
  }

  // D-4 : audit explicite avec actor_operator_id. Best-effort : l'INSERT
  // a réussi, on ne fail pas la requête si l'audit échoue.
  try {
    await recordAudit({
      entityType: 'product',
      entityId: data.id,
      action: 'created',
      actorOperatorId: user.sub,
      diff: {
        after: {
          code: data.code,
          name_fr: data.name_fr,
          name_en: data.name_en,
          name_es: data.name_es,
          vat_rate_bp: data.vat_rate_bp,
          default_unit: data.default_unit,
          piece_weight_grams: data.piece_weight_grams,
          tier_prices: data.tier_prices,
          supplier_code: data.supplier_code,
          origin: data.origin,
        },
      },
    })
  } catch (e) {
    logger.warn('admin.products.create.audit_failed', {
      requestId,
      productId: data.id,
      message: e instanceof Error ? e.message : String(e),
    })
  }

  logger.info('admin.products.create.success', {
    requestId,
    actorOperatorId: user.sub,
    productId: data.id,
    code: data.code,
  })

  res.status(201).json({ data: { product: data } })
}
