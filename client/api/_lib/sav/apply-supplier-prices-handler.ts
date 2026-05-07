/**
 * Story 4.8 — AC #3 : Handler PATCH apply prix fournisseur
 *
 * PATCH /api/sav/:id?op=apply-supplier-prices
 *
 * Applique les prix fournisseur via RPC SECURITY DEFINER (DN-2 = Option A).
 * Transaction atomique côté DB, check group scope explicite côté handler.
 *
 * Décisions appliquées :
 *   DN-2 : apply via RPC SECURITY DEFINER (atomicité)
 *   OQ-1 : op key = 'apply-supplier-prices'
 *   RBAC : withAuth operator + group scope check
 *   AC #3(b) : admin bypass group scope
 *   AC #3(d) : 409 LINES_NOT_FOUND si mismatch
 *   AC #3(e) : recordAudit 'sav_supplier_prices_imported'
 *   AC #3(f) : réponse { updatedCount, totalSupplierAmountCents, newMarginTotalCents }
 */

import { z } from 'zod'
import { withAuth } from '../middleware/with-auth'
import { withRateLimit } from '../middleware/with-rate-limit'
import { withValidation } from '../middleware/with-validation'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { supabaseAdmin } from '../clients/supabase-admin'
import { recordAudit } from '../audit/record'
import { logger } from '../logger'
import type { ApiHandler, ApiRequest, ApiResponse } from '../types'

// ---------------------------------------------------------------------------
// Schéma Zod du body (AC #3(a))
// ---------------------------------------------------------------------------

export const applySupplierPricesBodySchema = z.object({
  items: z
    .array(
      z.object({
        lineId: z.number().int().positive(),
        supplierPriceHtCents: z.number().int().min(0), // 0 accepté (geste commercial)
        supplierReference: z.string().max(255).optional(),
        supplierPriceSource: z.string().min(1).max(255),
      })
    )
    .min(1)
    .max(200), // cap webhook capture AC #3(a)
  filename: z.string().min(1).max(255),
})

// ---------------------------------------------------------------------------
// Helper : check group scope (RBAC + AC #3(b) admin bypass)
// ---------------------------------------------------------------------------

interface GroupCheckResult {
  allowed: boolean
  reason?: string
}

async function checkGroupScope(
  savId: number,
  operatorId: number,
  operatorRole: string | undefined
): Promise<GroupCheckResult> {
  // Admin bypass : admin voit tous les groupes
  if (operatorRole === 'admin') {
    return { allowed: true }
  }

  const admin = supabaseAdmin()

  // Récupérer le group_id du SAV
  const { data: savRow, error: savError } = await admin
    .from('sav')
    .select('group_id')
    .eq('id', savId)
    .maybeSingle<{ group_id: number }>()

  if (savError || !savRow) {
    return { allowed: false, reason: 'SAV introuvable' }
  }

  const savGroupId = savRow.group_id

  // Récupérer les groupes de l'opérateur
  const { data: opGroups, error: opGroupsError } = await admin
    .from('operator_groups')
    .select('group_id')
    .eq('operator_id', operatorId)

  if (opGroupsError) {
    return { allowed: false, reason: 'Erreur lecture groupes opérateur' }
  }

  const operatorGroupIds = new Set((opGroups ?? []).map((g: { group_id: number }) => g.group_id))
  if (!operatorGroupIds.has(savGroupId)) {
    return { allowed: false, reason: 'SAV hors scope groupe opérateur' }
  }

  return { allowed: true }
}

// ---------------------------------------------------------------------------
// Core handler
// ---------------------------------------------------------------------------

function applySupplierPricesCore(savId: number): ApiHandler {
  return async (req: ApiRequest, res: ApiResponse) => {
    const requestId = ensureRequestId(req)
    const user = req.user
    if (!user || user.type !== 'operator') {
      sendError(res, 'FORBIDDEN', 'Session opérateur requise', requestId)
      return
    }

    const body = req.body as z.infer<typeof applySupplierPricesBodySchema>

    try {
      // --- AC #3(b) : RBAC + group scope check ---
      const groupCheck = await checkGroupScope(savId, user.sub, user.role)
      if (!groupCheck.allowed) {
        sendError(res, 'FORBIDDEN', groupCheck.reason ?? 'Accès refusé', requestId)
        return
      }

      // --- M-5 : Handler-level pre-check : tous les lineIds appartiennent à ce SAV ---
      const requestedLineIds = body.items.map((item) => item.lineId)
      const { data: savLines, error: savLinesError } = await supabaseAdmin()
        .from('sav_lines')
        .select('id')
        .eq('sav_id', savId)

      if (savLinesError) {
        logger.error('sav.apply_supplier_prices.savlines_fetch_error', {
          requestId,
          savId,
          error: savLinesError.message,
        })
        sendError(res, 'SERVER_ERROR', 'Erreur lecture lignes SAV', requestId)
        return
      }

      const knownLineIds = new Set((savLines ?? []).map((l: { id: number }) => l.id))
      const foreignLineIds = requestedLineIds.filter((id) => !knownLineIds.has(id))
      if (foreignLineIds.length > 0) {
        res.status(422).json({
          error: {
            code: 'LINE_NOT_IN_SAV',
            message: "Une ou plusieurs lignes n'appartiennent pas à ce SAV.",
            requestId,
            foreignLineIds,
          },
        })
        return
      }

      // --- AC #3(c) : UPDATE via RPC atomique (DN-A=A3 : single SQL UPDATE-FROM-jsonb) ---
      // La RPC apply_supplier_prices_for_sav prend en charge :
      // - La transaction atomique (tous les UPDATE ou aucun)
      // - La defense in depth WHERE sav_id = :savId (cross-SAV protection)
      // - Le calcul newMarginTotalCents côté DB

      const rpcArgs = {
        p_sav_id: savId,
        p_items: body.items.map((item) => ({
          line_id: item.lineId,
          supplier_price_ht_cents: item.supplierPriceHtCents,
          supplier_reference: item.supplierReference ?? null,
          supplier_price_source: item.supplierPriceSource,
        })),
        p_filename: body.filename,
        p_actor: user.sub,
      }

      const { data: rpcData, error: rpcError } = (await supabaseAdmin().rpc(
        'apply_supplier_prices_for_sav',
        rpcArgs as Record<string, unknown>
      )) as { data: unknown; error: unknown }

      // --- AC #3(d) : Gestion 409 LINES_NOT_FOUND ---
      if (rpcError) {
        const err = rpcError as { code?: string; message?: string }
        // La RPC renvoie RAISE EXCEPTION avec un message structuré quand des lignes manquent
        if (err.message && err.message.includes('LINES_NOT_FOUND')) {
          // Extraire les IDs manquants du message si disponibles
          const missingMatch = err.message.match(/missingIds=([0-9,]+)/)
          const missingLineIds = missingMatch ? (missingMatch[1]?.split(',').map(Number) ?? []) : []
          res.status(409).json({
            error: {
              code: 'LINES_NOT_FOUND',
              message:
                "Une ou plusieurs lignes introuvables — elles ont peut-être été supprimées entre le preview et l'apply.",
              requestId,
              missingLineIds,
            },
          })
          return
        }

        logger.error('sav.apply_supplier_prices.rpc_error', {
          requestId,
          savId,
          error: err.message ?? String(rpcError),
        })
        sendError(res, 'SERVER_ERROR', 'Erreur application prix fournisseur', requestId)
        return
      }

      // --- AC #3(e) : Audit trail via recordAudit (M-6) ---
      const totalAmountCents =
        (rpcData as { total_supplier_amount_cents?: number } | null)?.total_supplier_amount_cents ??
        0
      try {
        await recordAudit({
          entityType: 'sav',
          entityId: savId,
          action: 'sav_supplier_prices_imported',
          actorOperatorId: user.sub,
          diff: {
            after: {
              savId,
              lineCount: body.items.length,
              filename: body.filename,
              totalAmountCents,
            },
          },
        })
      } catch (auditErr) {
        // Audit non bloquant — log et continue
        logger.warn('sav.apply_supplier_prices.audit_failed', {
          requestId,
          savId,
          error: auditErr instanceof Error ? auditErr.message : String(auditErr),
        })
      }

      // --- AC #3(f) : Réponse 200 ---
      const data = rpcData as {
        updated_count?: number
        total_supplier_amount_cents?: number
        new_margin_total_cents?: number
      } | null

      res.status(200).json({
        updatedCount: data?.updated_count ?? body.items.length,
        totalSupplierAmountCents: data?.total_supplier_amount_cents ?? totalAmountCents,
        newMarginTotalCents: data?.new_margin_total_cents ?? null,
      })
    } catch (err) {
      logger.error('sav.apply_supplier_prices.exception', {
        requestId,
        savId,
        error: err instanceof Error ? err.message : String(err),
      })
      sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId)
    }
  }
}

// ---------------------------------------------------------------------------
// Handler exporté (avec middleware)
// ---------------------------------------------------------------------------

export function applySupplierPricesHandler(savId: number): ApiHandler {
  const core = applySupplierPricesCore(savId)
  return withAuth({ types: ['operator'] })(
    withRateLimit({
      bucketPrefix: 'sav:apply-supplier-prices',
      keyFrom: (r: ApiRequest) =>
        r.user && r.user.type === 'operator' ? `op:${r.user.sub}` : undefined,
      max: 30,
      window: '1m',
    })(withValidation({ body: applySupplierPricesBodySchema })(core))
  )
}
