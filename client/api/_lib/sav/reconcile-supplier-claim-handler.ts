/**
 * Story 8.2 — Handler POST reconcile-supplier-claim
 *
 * POST /api/sav?op=reconcile-supplier-claim&id=:savId
 * body JSON { parsed: SupplierFileParseResult, options?: {...} }
 *
 * Flux :
 *   withAuth(['operator','admin']) → withRateLimit → checkGroupScope
 *   → charger sav_lines depuis DB
 *   → lookup bulk validation_lists (traduction motif, 1 SELECT)
 *   → reconcile() pur (helper injecté avec motifMap)
 *   → réponse 200 JSON preview (0 persistance — PATTERN-PARSE-PREVIEW-NO-PERSIST)
 *
 * Décisions appliquées :
 *   DN-1 = Option A — nouvelle op `reconcile-supplier-claim` (séparée de parse-supplier-file)
 *   DN-2 = Option A — BDD prioritaire (bdd.designationEs ?? fgRow.descripcionEs)
 *   DN-3 = Option C — 'otro' sur data drift, fail explicite 503 sur infra HS
 *   DN-4 = Option A — extractCodeToken strict (null → non apparié)
 *   OQ-1 — col DB = request_reason (pas cause), mappé en cause pour le helper pur
 *   OQ-2 — lookup validation_lists isolé + injecté via motifMap (PATTERN-BULK-VALIDATION-LOOKUP)
 *   AC #9 — 0 INSERT/UPDATE/DELETE, 0 recordAudit
 */

import { withAuth } from '../middleware/with-auth'
import { withRateLimit } from '../middleware/with-rate-limit'
import { ensureRequestId } from '../request-id'
import { supabaseAdmin } from '../clients/supabase-admin'
import { logger } from '../logger'
import { reconcile } from './reconcile-supplier-claim'
import type { SavLineInput, SupplierFileParseResult } from './reconcile-supplier-claim'
import type { ApiHandler, ApiRequest, ApiResponse } from '../types'
// FR12 fix (Sprint Change Proposal 2026-06-05) : clé motif normalisée (slug↔libellé)
import { normalizeCauseKey } from '../../../src/shared/validation/normalize-cause-key'

// ---------------------------------------------------------------------------
// RBAC — check group scope (réutilise pattern parse-supplier-file-handler.ts)
// savId inexistant → 404 NOT_FOUND (defense in depth)
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
  // Admin bypass (AC #2 — admin voit tous les SAV)
  if (operatorRole === 'admin') {
    return { status: 'allowed' }
  }

  const admin = supabaseAdmin()

  // Récupérer le group_id du SAV
  const { data: savRow, error: savError } = await admin
    .from('sav')
    .select('group_id')
    .eq('id', savId)
    .maybeSingle<{ group_id: number }>()

  if (savError) {
    return { status: 'not_found', reason: 'Erreur lecture SAV' }
  }

  if (!savRow) {
    // savId inexistant → 404 NOT_FOUND (defense in depth, pas de signal scope)
    return { status: 'not_found', reason: 'SAV introuvable' }
  }

  const savGroupId = savRow.group_id

  // Récupérer les groupes de l'opérateur
  const { data: opGroups, error: opGroupsError } = await admin
    .from('operator_groups')
    .select('group_id')
    .eq('operator_id', operatorId)

  if (opGroupsError) {
    return { status: 'forbidden', reason: 'Erreur lecture groupes opérateur' }
  }

  const operatorGroupIds = new Set((opGroups ?? []).map((g: { group_id: number }) => g.group_id))
  if (!operatorGroupIds.has(savGroupId)) {
    return { status: 'forbidden', reason: 'SAV hors scope groupe opérateur' }
  }

  return { status: 'allowed' }
}

// ---------------------------------------------------------------------------
// Bulk lookup validation_lists — OQ-2 (PATTERN-BULK-VALIDATION-LOOKUP)
// 1 seul SELECT pour tout le SAV (AC #4)
// DN-3 : throw si Supabase indisponible → handler retourne 503
// ---------------------------------------------------------------------------

/**
 * Charge la table de traduction motif depuis validation_lists.
 * 1 seul SELECT bulk (AC #4 — pas N+1).
 * Cache dans un Map<value, value_es> pour la durée de la requête.
 *
 * @throws Error si Supabase indisponible (DN-3 Option C : fail explicite → 503)
 */
async function buildMotifMap(): Promise<Map<string, string | null>> {
  const admin = supabaseAdmin()

  // FR12 fix : la cause stockée est un SLUG (`abime`) alors que validation_lists.value
  // est un LIBELLÉ (`Abîmé`) → on NE PEUT PAS filtrer `.in('value', causes)` (0 match).
  // On charge tous les motifs sav_cause actifs (≤10 lignes) et on keye sur la clé
  // normalisée (normalizeCauseKey) — la jointure se fait ensuite côté lookup pur.
  // is_active=true : exclut les entrées désactivées (ex. anciens motifs archivés).
  const { data, error } = await admin
    .from('validation_lists')
    .select('value, value_es')
    .eq('list_code', 'sav_cause')
    .eq('is_active', true)

  if (error) {
    // DN-3 Option C : Supabase indisponible → throw (handler retourne 503)
    throw new Error(`validation_lists unavailable: ${error.message}`)
  }

  const motifMap = new Map<string, string | null>()
  for (const row of data ?? []) {
    if (typeof row.value === 'string') {
      motifMap.set(normalizeCauseKey(row.value), row.value_es ?? null)
    }
  }
  return motifMap
}

// ---------------------------------------------------------------------------
// Core handler
// ---------------------------------------------------------------------------

function reconcileSupplierClaimCore(savId: number): ApiHandler {
  return async (req: ApiRequest, res: ApiResponse) => {
    const requestId = ensureRequestId(req)
    const user = req.user
    if (!user || user.type !== 'operator') {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Session opérateur requise', requestId } })
      return
    }

    // --- Méthode HTTP : POST uniquement (AC #1) ---
    const method = (req.method ?? 'GET').toUpperCase()
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST')
      res.status(405).json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Méthode non supportée', requestId } })
      return
    }

    // --- Lire body ---
    const body = req.body as Record<string, unknown> | undefined
    const parsed = body?.['parsed'] as SupplierFileParseResult | undefined

    if (!parsed || !parsed.factureGroupe || !parsed.bdd) {
      res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'Champ parsed manquant ou invalide', requestId } })
      return
    }

    // --- RBAC : check group scope (AC #2) ---
    // L-5 ACCEPTED: checkGroupScope runs inside core rather than between withRateLimit and core.
    // This is safe because: (1) rate-limit bucket is keyed per operator (op:<sub>), not per
    // operation result; (2) the 403/404 early-exit after scope check still prevents any data
    // processing for unauthorized callers. Moving it to middleware would require extracting
    // savId from the query before withRateLimit wraps core — adding complexity for no security
    // gain given the per-operator rate-limit key. Current ordering is accepted.
    try {
      const groupCheck = await checkGroupScope(savId, user.sub, user.role)
      if (groupCheck.status === 'not_found') {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: groupCheck.reason ?? 'SAV introuvable', requestId } })
        return
      }
      if (groupCheck.status === 'forbidden') {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: groupCheck.reason ?? 'Accès refusé', requestId } })
        return
      }
    } catch (err) {
      logger.error('sav.reconcile-supplier-claim.group_check_error', {
        requestId,
        savId,
        error: err instanceof Error ? err.message : String(err),
      })
      res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Erreur vérification accès', requestId } })
      return
    }

    // --- Charger les sav_lines du SAV (OQ-1 : lire request_reason, mapper en cause) ---
    // H-1 FIX: .order('position') pour ordre déterministe (AC #7 — sav_lines non ordonnées = non-déterministe)
    // position confirmé col sav_lines migration 20260421140000 + index idx_sav_lines_sav_position
    // NEW-DEFER-1: secondary sort by id (ascending) for deterministic tie-break on equal/null position
    const admin = supabaseAdmin()
    const { data: rawSavLines, error: savLinesError } = await admin
      .from('sav_lines')
      .select('id, product_code_snapshot, product_name_snapshot, qty_arbitrated, qty_invoiced, unit_arbitrated, request_reason')
      .eq('sav_id', savId)
      .order('position', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true })

    if (savLinesError) {
      logger.error('sav.reconcile-supplier-claim.sav_lines_error', {
        requestId,
        savId,
        error: savLinesError.message,
      })
      res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Erreur lecture lignes SAV', requestId } })
      return
    }

    // OQ-1 : mapper request_reason → cause pour le helper pur
    const savLines: SavLineInput[] = (rawSavLines ?? []).map((row: {
      id: string | number
      product_code_snapshot: string | null
      product_name_snapshot: string | null
      qty_arbitrated: number | null
      qty_invoiced: number | null
      unit_arbitrated: string | null
      request_reason: string | null
    }) => ({
      id: row.id,
      productCodeSnapshot: row.product_code_snapshot,
      productNameSnapshot: row.product_name_snapshot,
      qtyArbitrated: row.qty_arbitrated,
      qtyInvoiced: row.qty_invoiced,
      unitArbitrated: row.unit_arbitrated,
      cause: row.request_reason, // OQ-1 : request_reason → cause
    }))

    // --- Lookup bulk validation_lists (OQ-2, AC #4, PATTERN-BULK-VALIDATION-LOOKUP) ---
    // Collecter les causes uniques pour le SELECT bulk
    const uniqueCauses = [...new Set(
      savLines
        .map((l) => l.cause)
        .filter((c): c is string => c !== null && c !== undefined && c !== '')
    )]

    let motifMap: Map<string, string | null>
    try {
      // Pas de cause à traduire → pas de requête validation_lists (préserve le no-op).
      motifMap = uniqueCauses.length > 0 ? await buildMotifMap() : new Map()
    } catch (err) {
      // DN-3 Option C : Supabase indisponible → fail explicite 503
      logger.error('sav.reconcile-supplier-claim.validation_lists_error', {
        requestId,
        savId,
        error: err instanceof Error ? err.message : String(err),
      })
      res.status(503).json({
        error: {
          code: 'DEPENDENCY_DOWN',
          message: 'validation_lists unavailable',
          requestId,
        },
      })
      return
    }

    // --- Réconciliation pure (PATTERN-RECONCILE-PURE) ---
    const result = reconcile({
      savId,
      savLines,
      parsed,
      motifMap,
    })

    // --- AC #7 : Réponse 200 JSON ---
    logger.info('sav.reconcile-supplier-claim.ok', {
      requestId,
      savId,
      matched: result.meta.reconciliation.matched,
      unmatched: result.meta.reconciliation.unmatched,
    })

    res.status(200).json({
      metadata: {
        reference: parsed.metadata.reference,
        albaran: parsed.metadata.albaran,
        fechaAlbaran: parsed.metadata.fechaAlbaran,
        warnings: parsed.metadata.warnings,
      },
      claimLines: result.claimLines,
      unmatchedSavLines: result.unmatchedSavLines,
      unusedSupplierLines: result.unusedSupplierLines,
      totals: result.totals,
      meta: result.meta,
    })
  }
}

// ---------------------------------------------------------------------------
// Handler exporté (avec middleware — ordre strict AC #2)
// withAuth → withRateLimit → core
// ---------------------------------------------------------------------------

export function reconcileSupplierClaimHandler(savId: number): ApiHandler {
  const core = reconcileSupplierClaimCore(savId)
  return withAuth({ types: ['operator'] })(
    withRateLimit({
      bucketPrefix: 'sav:reconcile-supplier-claim',
      keyFrom: (r: ApiRequest) =>
        r.user && r.user.type === 'operator' ? `op:${r.user.sub}` : undefined,
      max: 20,
      window: '1m',
    })(core)
  )
}
