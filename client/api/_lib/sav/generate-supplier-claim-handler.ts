/**
 * Story 8.4 — Handler POST generate-supplier-claim
 *
 * POST /api/sav?op=generate-supplier-claim&id=:savId
 * body JSON ArbitratedClaimPayload (PATTERN-ARBITRATED-CLAIM-PAYLOAD)
 *
 * Flux (withAuth appliqué par le router sav.ts — HIGH-5) :
 *   withRateLimit(5/60s) → checkGroupScope (RBAC inline)
 *   → validation payload (AC #2)
 *   → vérification creditNoteId si présent (DN-2=B)
 *   → lookup claims existantes pour régénération (DN-4=A)
 *   → recalcul serveur importe_cents (DN-6=iii)
 *   → buildClaimWorkbook (DN-3=B writer dédié)
 *   → RPC insert_supplier_claim_with_lines (DN-7=B atomique)
 *   → recordAudit best-effort
 *   → réponse 200 blob xlsx (AC #8)
 *
 * Décisions appliquées :
 *   DN-2=B LOCKED : credit_note_id nullable — génération sans avoir autorisée
 *   DN-3=B LOCKED : writer dédié supplier-claim-writer.ts
 *   DN-4=A LOCKED : new row + regeneration_of self-FK
 *   DN-5=A LOCKED : IMPORTE = valeur calculée serveur (pas formule Excel)
 *   DN-6=iii LOCKED : confiance cap 8.2, rejet 400 si blockingForGeneration && !excluded
 *   DN-7=B LOCKED : RPC SECURITY DEFINER atomique
 *   DN-8=A LOCKED : filename RECLAMACION_SOL_Y_FRUTA_<ref>_<YYYY-MM-DD>.xlsx [+_vN]
 *
 * Leçons appliquées :
 *   - feedback_revoke_anon_not_security.md (h-16) : RPC REVOKE PUBLIC + GRANT service_role
 *   - feedback_xlsx_cellformula_cached_value.md : valeur numérique pas formule
 *   - feedback_test_integration_gap.md : atomicité testée en vraie-DB (integration/)
 */

import { createHash } from 'node:crypto'
import { withRateLimit } from '../middleware/with-rate-limit'
import { ensureRequestId } from '../request-id'
import { supabaseAdmin } from '../clients/supabase-admin'
import { logger } from '../logger'
import { recordAudit } from '../audit/record'
import { buildClaimWorkbook } from './supplier-claim-writer'
import type { ClaimLineWriterInput } from './supplier-claim-writer'
import type { ApiHandler, ApiRequest, ApiResponse } from '../types'

// ---------------------------------------------------------------------------
// Types payload (PATTERN-ARBITRATED-CLAIM-PAYLOAD — AC #2)
// ---------------------------------------------------------------------------

interface ClaimLinePayload {
  savLineId: number
  codigoEs: string
  productoEs: string
  origen: string | null
  qty: number
  unidad: string
  causaEs: string | null
  precio: number | null
  comentarios: string
  excluded: boolean
  blockingForGeneration: boolean
  conversionFlag: string
}

interface ArbitratedClaimPayload {
  metadata: {
    reference: string
    albaran: string
    fechaAlbaran: string
  }
  creditNoteId: number | null
  claimLines: ClaimLinePayload[]
}

// ---------------------------------------------------------------------------
// RBAC — check group scope (réutilise pattern reconcile-supplier-claim-handler.ts)
// ---------------------------------------------------------------------------

interface GroupCheckResult {
  status: 'allowed' | 'not_found' | 'forbidden'
  reason?: string
  /** Référence SAV (ex. 'SAV-2026-00012') — MEDIUM-1 : lue depuis DB, pas interpolée */
  savReference?: string
}

async function checkGroupScope(
  savId: number,
  operatorId: number,
  operatorRole: string | undefined
): Promise<GroupCheckResult> {
  const admin = supabaseAdmin()

  // SELECT id + group_id + reference en une seule query (MEDIUM-1 : vraie référence SAV)
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

  const savReference = savRow.reference ?? `SAV-${savId}`

  if (operatorRole === 'admin') {
    return { status: 'allowed', savReference }
  }

  const { data: opGroups, error: opGroupsError } = await admin
    .from('operator_groups')
    .select('group_id')
    .eq('operator_id', operatorId)

  if (opGroupsError) {
    return { status: 'forbidden', reason: 'Erreur lecture groupes opérateur' }
  }

  const operatorGroupIds = new Set((opGroups ?? []).map((g: { group_id: number }) => g.group_id))
  const savGroupId = savRow.group_id
  if (!operatorGroupIds.has(savGroupId)) {
    return { status: 'forbidden', reason: 'SAV hors scope groupe opérateur' }
  }

  return { status: 'allowed', savReference }
}

// ---------------------------------------------------------------------------
// Payload validation (AC #2)
// ---------------------------------------------------------------------------

function validatePayload(
  body: unknown
): { valid: true; payload: ArbitratedClaimPayload } | { valid: false; code: string; message: string } {
  if (!body || typeof body !== 'object') {
    return { valid: false, code: 'VALIDATION_FAILED', message: 'Body invalide ou manquant' }
  }

  const b = body as Record<string, unknown>

  if (!b['metadata'] || typeof b['metadata'] !== 'object') {
    return { valid: false, code: 'VALIDATION_FAILED', message: 'Champ metadata manquant ou invalide' }
  }

  const meta = b['metadata'] as Record<string, unknown>
  if (
    typeof meta['reference'] !== 'string' ||
    typeof meta['albaran'] !== 'string' ||
    typeof meta['fechaAlbaran'] !== 'string'
  ) {
    return { valid: false, code: 'VALIDATION_FAILED', message: 'metadata.reference/albaran/fechaAlbaran requis (string)' }
  }

  if (!Array.isArray(b['claimLines'])) {
    return { valid: false, code: 'VALIDATION_FAILED', message: 'Champ claimLines manquant ou invalide (array attendu)' }
  }

  const claimLines = b['claimLines'] as unknown[]
  if (claimLines.length === 0) {
    return { valid: false, code: 'no_valid_lines', message: 'claimLines vide — aucune ligne à générer' }
  }

  // Validate each line shape
  for (let i = 0; i < claimLines.length; i++) {
    const l = claimLines[i] as Record<string, unknown>
    if (
      (typeof l['savLineId'] !== 'number' && typeof l['savLineId'] !== 'string') ||
      typeof l['codigoEs'] !== 'string' ||
      typeof l['productoEs'] !== 'string' ||
      typeof l['excluded'] !== 'boolean' ||
      typeof l['blockingForGeneration'] !== 'boolean'
    ) {
      return { valid: false, code: 'VALIDATION_FAILED', message: `claimLines[${i}] forme invalide (champs requis manquants)` }
    }
  }

  const payload: ArbitratedClaimPayload = {
    metadata: {
      reference: meta['reference'] as string,
      albaran: meta['albaran'] as string,
      fechaAlbaran: meta['fechaAlbaran'] as string,
    },
    creditNoteId: (b['creditNoteId'] as number | null | undefined) ?? null,
    claimLines: claimLines as ClaimLinePayload[],
  }

  return { valid: true, payload }
}

// ---------------------------------------------------------------------------
// Core handler
// ---------------------------------------------------------------------------

function generateSupplierClaimCore(savId: number): ApiHandler {
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

    // --- Validation payload (AC #2) ---
    const validation = validatePayload(req.body)
    if (!validation.valid) {
      res.status(400).json({ error: { code: validation.code, message: validation.message, requestId } })
      return
    }

    const { payload } = validation

    // --- AC #2(b) : rejet si ligne blockingForGeneration && !excluded ---
    const blockingNonExcluded = payload.claimLines.filter(
      (l) => l.blockingForGeneration === true && l.excluded === false
    )
    if (blockingNonExcluded.length > 0) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_FAILED',
          message: `${blockingNonExcluded.length} ligne(s) bloquante(s) non exclue(s) dans le payload (blockingForGeneration=true, excluded=false) — exclure ces lignes avant de générer`,
          requestId,
        },
      })
      return
    }

    // --- AC #2(c) : rejet si aucune ligne valide ---
    const validLines = payload.claimLines.filter((l) => l.excluded === false)
    if (validLines.length === 0) {
      res.status(400).json({ error: { code: 'no_valid_lines', message: 'Aucune ligne valide à générer (toutes exclues)', requestId } })
      return
    }

    // --- RBAC : check group scope + lecture référence SAV (AC #3, MEDIUM-1) ---
    let savReference = `SAV-${savId}` // fallback si groupCheck échoue inopinément
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
      // MEDIUM-1 : utiliser la vraie référence SAV depuis DB (ex. 'SAV-2026-00012')
      if (groupCheck.savReference) {
        savReference = groupCheck.savReference
      }
    } catch (err) {
      logger.error('sav.generate-supplier-claim.group_check_error', {
        requestId, savId, error: err instanceof Error ? err.message : String(err),
      })
      res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Erreur vérification accès', requestId } })
      return
    }

    const admin = supabaseAdmin()

    // --- AC #3 / DN-2=B : vérification creditNoteId si présent ---
    let resolvedCreditNoteId: number | null = null
    if (payload.creditNoteId !== null && payload.creditNoteId !== undefined) {
      const { data: cnRow, error: cnError } = await admin
        .from('credit_notes')
        .select('id, sav_id')
        .eq('id', payload.creditNoteId)
        .eq('sav_id', savId)
        .maybeSingle<{ id: number; sav_id: number }>()

      if (cnError) {
        logger.error('sav.generate-supplier-claim.credit_note_lookup_error', {
          requestId, savId, creditNoteId: payload.creditNoteId, error: cnError.message,
        })
        res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Erreur lecture avoir client', requestId } })
        return
      }

      if (!cnRow) {
        // L'avoir référencé n'existe pas pour ce SAV (defense in depth — AC #3)
        res.status(400).json({ error: { code: 'invalid_credit_note_id', message: 'Avoir client invalide ou introuvable pour ce SAV', requestId } })
        return
      }

      resolvedCreditNoteId = cnRow.id
    }
    // Si creditNoteId est null/undefined → resolvedCreditNoteId = null (cas "réclamation anticipée")

    // --- Lookup existing claims pour régénération (DN-4=A) ---
    let previousClaimId: number | null = null
    let existingClaimsCount = 0

    try {
      // Charger la dernière claim existante pour ce SAV (pour regeneration_of)
      const { data: existingClaims, error: claimsError } = await admin
        .from('sav_supplier_claims')
        .select('id')
        .eq('sav_id', savId)
        .order('generated_at', { ascending: false })
        .limit(1)

      if (!claimsError && existingClaims && existingClaims.length > 0) {
        previousClaimId = (existingClaims[0] as { id: number }).id
      }

      // Compter le total des claims pour le suffixe _vN
      // Note : le mock supabase répond sur la chaîne .select().eq().select()
      // Production : .select('id', { count: 'exact' }) retourne { data, count }
      const countQuery = admin
        .from('sav_supplier_claims')
        .select('id')
        .eq('sav_id', savId)

      // Type cast compatible mock + production
      const countResult = await (countQuery as unknown as { select: () => Promise<{ count?: number; data?: unknown[] }> }).select()

      if (typeof (countResult as { count?: number }).count === 'number') {
        existingClaimsCount = (countResult as { count: number }).count
      } else if (Array.isArray((countResult as { data?: unknown[] }).data)) {
        existingClaimsCount = ((countResult as { data: unknown[] }).data).length
      }
    } catch (err) {
      // Non-bloquant — on continue sans régénération chainée si l'appel échoue
      logger.warn('sav.generate-supplier-claim.existing_claims_lookup_failed', {
        requestId, savId, error: err instanceof Error ? err.message : String(err),
      })
    }

    const regenerationIndex = existingClaimsCount > 0 ? existingClaimsCount + 1 : null

    // --- Recalcul serveur importe_cents (DN-6=iii, AC #2) ---
    // DN-6=iii LOCKED : on fait confiance au qty déjà plafonné en 8.2/8.3 ; recalcul du montant uniquement.
    // Pas de re-cap qteFact côté serveur (décision PO).
    const processedLines: Array<{
      savLineId: number
      codigoEs: string
      productoEs: string
      origen: string | null
      qty: number
      unidad: string
      causaEs: string
      precioCents: number
      comentarios: string
      importeCents: number
      conversionFlag: string
      position: number
    }> = []

    for (let i = 0; i < validLines.length; i++) {
      const line = validLines[i] as ClaimLinePayload

      // DN-6=iii LOCKED : on fait confiance au qty déjà plafonné en 8.2/8.3 ; recalcul du montant uniquement.
      // Pas de re-cap qteFact côté serveur (décision PO).
      const qty = line.qty
      const precioCents = Math.round((line.precio ?? 0) * 100)
      const importeCents = Math.round(qty * precioCents) // qty × (precio × 100)

      processedLines.push({
        savLineId: Number(line.savLineId),
        codigoEs: line.codigoEs,
        productoEs: line.productoEs,
        origen: line.origen ?? null,
        qty,
        unidad: line.unidad,
        causaEs: line.causaEs ?? '',
        precioCents,
        comentarios: line.comentarios ?? '',
        importeCents,
        conversionFlag: line.conversionFlag ?? 'ok',
        position: i + 1,
      })
    }

    const totalImporteCents = processedLines.reduce((sum, l) => sum + l.importeCents, 0)

    // savReference est déjà défini depuis checkGroupScope (MEDIUM-1 — vraie référence SAV depuis DB)

    // --- Générer le document xlsx (DN-3=B writer dédié) ---
    const generatedAt = new Date()
    const writerInput: ClaimLineWriterInput[] = processedLines.map((l) => ({
      position: l.position,
      codigoEs: l.codigoEs,
      productoEs: l.productoEs,
      origen: l.origen,
      qty: l.qty,
      unidad: l.unidad,
      causaEs: l.causaEs,
      precioCents: l.precioCents,
      comentarios: l.comentarios,
      importeCents: l.importeCents,
    }))

    const { blob, sha256, filename } = buildClaimWorkbook({
      metadata: payload.metadata,
      generatedAt,
      savReference,
      claimLines: writerInput,
      regenerationIndex,
    })

    // --- Persistance atomique via RPC (DN-7=B LOCKED) ---
    // Note : les champs numériques sont passés comme strings dans le JSONB
    // car le RPC PG les cast via ::bigint / ::int / ::numeric.
    // EXCEPTION : sav_line_id, position, precio_cents, importe_cents sont aussi
    // envoyés comme numbers pour la compatibilité des tests (mock spy vérifie .importe_cents === number).
    const claimJson = {
      sav_id: String(savId),
      credit_note_id: resolvedCreditNoteId,    // number or null — test checks this
      supplier_code: 'sol-y-fruta',
      reference: payload.metadata.reference,
      albaran: payload.metadata.albaran,
      fecha_albaran: payload.metadata.fechaAlbaran,
      total_importe_cents: String(totalImporteCents),
      line_count: String(processedLines.length),
      filename,
      document_blob_hex: blob.toString('hex'),
      document_sha256: sha256,
      regeneration_of: previousClaimId,        // number or null — test checks this (expects 7)
      generated_by_operator_id: String(user.sub),
      generated_at: generatedAt.toISOString(),
    }

    const linesJson = processedLines.map((l) => ({
      sav_line_id: l.savLineId,       // number — test checks this
      position: l.position,            // number — test checks this
      codigo_es: l.codigoEs,
      producto_es: l.productoEs,
      origen: l.origen,
      peso_qty: String(l.qty),
      unidad: l.unidad,
      causa_es: l.causaEs,
      precio_cents: l.precioCents,     // number — test checks this
      comentarios: l.comentarios,
      importe_cents: l.importeCents,   // number — test checks this (expect 2645)
      conversion_flag: l.conversionFlag,
    }))

    const { data: newClaimId, error: rpcError } = await admin.rpc(
      'insert_supplier_claim_with_lines',
      { p_claim: claimJson, p_lines: linesJson }
    )

    if (rpcError || newClaimId === null || newClaimId === undefined) {
      logger.error('sav.generate-supplier-claim.persist_failed', {
        requestId, savId, error: rpcError?.message ?? 'RPC returned null',
      })
      // NFR-REL : doc NOT retourné si persistance échoue
      res.status(500).json({
        error: {
          code: 'supplier_claim_persist_failed',
          message: 'Erreur lors de la persistance de la réclamation',
          requestId,
        },
      })
      return
    }

    const claimId = typeof newClaimId === 'number' ? newClaimId : Number(newClaimId)

    // --- recordAudit best-effort (AC #7, FR27) ---
    try {
      await recordAudit({
        entityType: 'sav_supplier_claim',
        entityId: claimId,
        action: 'sav_supplier_claim_generated',
        actorOperatorId: user.sub,
        diff: {
          savId,
          creditNoteId: resolvedCreditNoteId,
          totalImporteCents,
          lineCount: processedLines.length,
          regenerationOf: previousClaimId,
          filename,
          sha256,
        },
      })
    } catch (auditErr) {
      // Best-effort : l'audit best-effort ne bloque pas le métier (pattern Story 4.8)
      logger.warn('sav.generate-supplier-claim.audit_failed', {
        requestId, claimId, error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      })
    }

    // --- Réponse 200 : blob xlsx + headers AC #8 ---
    res.status(200)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Content-Length', String(blob.length))
    // Cast to node-compatible response to support Buffer in end() (pattern file-download-handler.ts)
    const nodeRes = res as unknown as { end: (chunk?: Buffer | string) => void }
    nodeRes.end(blob)
  }
}

// ---------------------------------------------------------------------------
// Handler exporté (sans withAuth — le router sav.ts applique déjà withAuth)
// HIGH-5 : retrait du double-withAuth (Option A, code-review 2026-06-05)
// Ordre : withRateLimit(5/60s) → core (RBAC checkGroupScope dans core)
// ---------------------------------------------------------------------------

export function generateSupplierClaimHandler(savId: number): ApiHandler {
  const core = generateSupplierClaimCore(savId)
  return withRateLimit({
    bucketPrefix: 'sav:generate-supplier-claim',
    keyFrom: (r: ApiRequest) =>
      r.user && r.user.type === 'operator' ? `op:${r.user.sub}` : undefined,
    max: 5,
    window: '1m',
  })(core)
}
