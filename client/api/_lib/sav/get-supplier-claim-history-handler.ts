/**
 * Story 8.5 — Handler GET get-supplier-claim-history
 *
 * GET /api/sav?op=get-supplier-claim-history&id=:savId
 *
 * Flux :
 *   withRateLimit(30/60s) → checkGroupScope (RBAC inline) → SELECT claims
 *   → calcul version ordinal en mémoire (DN-3 LOCKED = no-migration)
 *   → réponse 200 JSON { savId, claims: SupplierClaimHistoryItem[] }
 *
 * NFR-PERF : document_blob JAMAIS sélectionné (test discriminant HIST-08).
 *
 * Décisions appliquées :
 *   DN-3 LOCKED : tri + calcul version en mémoire (≤ 10 claims/SAV V1)
 *   AC #1 : GET uniquement (405 sinon)
 *   AC #4 (a,b,c) : withRateLimit 30/60s + checkGroupScope + admin bypass
 */

import { withRateLimit } from '../middleware/with-rate-limit'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import type { ApiHandler, ApiRequest, ApiResponse } from '../types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClaimRow {
  id: number
  sav_id: number
  generated_at: string
  total_importe_cents: number
  line_count: number
  filename: string
  regeneration_of: number | null
  document_sha256: string | null
  generated_by_operator_id: number
  // Supabase join can return single object or array depending on join type
  operators: { id: number; display_name: string } | { id: number; display_name: string }[] | null
}

export interface SupplierClaimHistoryItem {
  id: number
  generatedAt: string
  generatedByOperator: { id: number; fullName: string }
  totalImporteCents: number
  lineCount: number
  filename: string
  version: number
  regenerationOf: number | null
  isLatest: boolean
  hasDocument: boolean
}

// ---------------------------------------------------------------------------
// RBAC — check group scope (same pattern as generate-supplier-claim-handler)
// ---------------------------------------------------------------------------

interface GroupCheckResult {
  status: 'allowed' | 'not_found' | 'forbidden'
  reason?: string
}

async function checkGroupScope(
  savId: number,
  operatorId: number,
  operatorRole: string | undefined
): Promise<GroupCheckResult> {
  const admin = supabaseAdmin()

  const { data: savRow, error: savError } = await admin
    .from('sav')
    .select('id, group_id, reference')
    .eq('id', savId)
    .maybeSingle<{ id: number; group_id: number; reference: string | null }>()

  if (savError) {
    return { status: 'not_found', reason: 'Erreur lecture SAV' }
  }

  if (!savRow) {
    return { status: 'not_found', reason: 'SAV introuvable' }
  }

  // Admin bypass
  if (operatorRole === 'admin') {
    return { status: 'allowed' }
  }

  const { data: opGroups, error: opGroupsError } = await admin
    .from('operator_groups')
    .select('group_id')
    .eq('operator_id', operatorId)

  if (opGroupsError) {
    return { status: 'forbidden', reason: 'Erreur lecture groupes opérateur' }
  }

  const operatorGroupIds = new Set((opGroups ?? []).map((g: { group_id: number }) => g.group_id))
  if (!operatorGroupIds.has(savRow.group_id)) {
    return { status: 'forbidden', reason: 'SAV hors scope groupe opérateur' }
  }

  return { status: 'allowed' }
}

// ---------------------------------------------------------------------------
// Core handler
// ---------------------------------------------------------------------------

function getSupplierClaimHistoryCore(savId: number): ApiHandler {
  return async (req: ApiRequest, res: ApiResponse) => {
    const requestId = ensureRequestId(req)
    const user = req.user
    if (!user || user.type !== 'operator') {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Session opérateur requise', requestId } })
      return
    }

    // GET uniquement (AC #1)
    const method = (req.method ?? 'GET').toUpperCase()
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }

    // RBAC : checkGroupScope (AC #4c)
    try {
      const groupCheck = await checkGroupScope(savId, user.sub, user.role)
      if (groupCheck.status === 'not_found') {
        sendError(res, 'NOT_FOUND', groupCheck.reason ?? 'SAV introuvable', requestId)
        return
      }
      if (groupCheck.status === 'forbidden') {
        sendError(res, 'FORBIDDEN', groupCheck.reason ?? 'Accès refusé', requestId)
        return
      }
    } catch (err) {
      logger.error('sav.get-supplier-claim-history.group_check_error', {
        requestId, savId, error: err instanceof Error ? err.message : String(err),
      })
      sendError(res, 'SERVER_ERROR', 'Erreur vérification accès', requestId)
      return
    }

    const admin = supabaseAdmin()

    // SELECT claims — SANS document_blob (NFR-PERF, test discriminant HIST-08)
    const { data: rows, error: dbError } = await admin
      .from('sav_supplier_claims')
      .select(
        'id, sav_id, generated_at, total_importe_cents, line_count, filename, regeneration_of, document_sha256, generated_by_operator_id, operators(id, display_name)'
      )
      .eq('sav_id', savId)
      .order('generated_at', { ascending: false })

    if (dbError) {
      logger.error('sav.get-supplier-claim-history.db_error', {
        requestId, savId, error: dbError.message,
      })
      sendError(res, 'SERVER_ERROR', 'Erreur lecture historique réclamations', requestId)
      return
    }

    const claimRows = (rows ?? []) as unknown as ClaimRow[]

    // Calcul version ordinal en mémoire (DN-3 LOCKED : tri mémoire, ≤ 10 claims/SAV V1)
    // Les rows sont triées DESC (la plus récente en premier).
    // version = rang croissant par generated_at → la plus ancienne = version 1, la plus récente = version N
    // On inverse pour calculer les rangs : rows[rows.length-1] = v1, rows[0] = vN
    const total = claimRows.length

    const claims: SupplierClaimHistoryItem[] = claimRows.map((row, indexDesc) => {
      // indexDesc=0 → la plus récente → version=total ; indexDesc=total-1 → la plus ancienne → version=1
      const version = total - indexDesc
      const isLatest = indexDesc === 0

      // hasDocument = true ssi sha256 présent et non-vide (defense in depth V2)
      const hasDocument = Boolean(row.document_sha256 && row.document_sha256.length > 0)

      // Supabase join may return operators as object or as array (defensive)
      const opRecord = Array.isArray(row.operators) ? row.operators[0] ?? null : row.operators
      return {
        id: row.id,
        generatedAt: row.generated_at,
        generatedByOperator: {
          id: row.generated_by_operator_id,
          fullName: opRecord?.display_name ?? `Opérateur #${row.generated_by_operator_id}`,
        },
        totalImporteCents: row.total_importe_cents,
        lineCount: row.line_count,
        filename: row.filename,
        version,
        regenerationOf: row.regeneration_of,
        isLatest,
        hasDocument,
      }
    })

    res.status(200).json({ savId, claims })
  }
}

// ---------------------------------------------------------------------------
// Exported handler (withRateLimit 30/60s — AC #4b)
// withAuth est posé en amont par le router sav.ts
// ---------------------------------------------------------------------------

export function getSupplierClaimHistoryHandler(savId: number): ApiHandler {
  const core = getSupplierClaimHistoryCore(savId)
  return withRateLimit({
    bucketPrefix: 'sav:get-supplier-claim-history',
    keyFrom: (r: ApiRequest) =>
      r.user && r.user.type === 'operator' ? `op:${r.user.sub}` : undefined,
    max: 30,
    window: '1m',
  })(core)
}
