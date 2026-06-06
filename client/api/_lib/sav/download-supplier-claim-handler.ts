/**
 * Story 8.5 — Handler GET download-supplier-claim
 *
 * GET /api/sav?op=download-supplier-claim&id=:savId&claimId=:claimId
 *
 * Flux :
 *   withRateLimit(10/60s) → checkGroupScope → GARDE IDOR (claim.sav_id === savId)
 *   → réponse 200 + blob raw → recordAudit best-effort
 *
 * Sécurité (AC #4) :
 *   - GARDE IDOR : si claim.sav_id !== savId → 404 NOT_FOUND (pas 403)
 *     Defense in depth : ne pas leaker l'existence d'une claim d'un autre SAV.
 *     Test discriminant DL-02a DOIT aller RED si cette garde est retirée.
 *
 * NFR-SEC : Cache-Control: private, no-store (données métier sensibles).
 *
 * Bytea contract (CR fix H1 — feedback_test_integration_gap.md) :
 *   Supabase/PostgREST retourne bytea en hexadécimal Postgres par défaut : '\x504b0304...'
 *   Supabase-js (REST path) peut aussi retourner une string base64 dans certains contextes.
 *   Ordre de priorité : hex Postgres (\x...) > bare hex > base64 (last-resort).
 *   Test discriminant DL-HEX-01 (pure unit, no DB) exerce tous les chemins.
 *
 * M3 fix — ordre audit/end : set headers → await recordAudit (best-effort) → nodeRes.end().
 *   Sur Vercel/serverless, la fonction peut être teardown après end() → audit dropped.
 *   L'audit est best-effort (échec → warning, pas 500), mais DOIT être awaité avant end().
 *
 * Décisions appliquées :
 *   DN-1 LOCKED : audit sav_supplier_claim_downloaded best-effort
 *   AC #2 : GET uniquement, ?id + ?claimId requis, headers xlsx + disposition + length + cache
 *   AC #4 (a,b,c,d) : withRateLimit 10/60s + checkGroupScope + GARDE IDOR
 */

import { withRateLimit } from '../middleware/with-rate-limit'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { recordAudit } from '../audit/record'
import { supabaseAdmin } from '../clients/supabase-admin'
import type { ApiHandler, ApiRequest, ApiResponse } from '../types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClaimRow {
  id: number
  sav_id: number
  filename: string
  document_blob: Buffer | string | null
  document_sha256: string | null
  total_importe_cents: number
  generated_by_operator_id: number
}

// ---------------------------------------------------------------------------
// RBAC — check group scope (same pattern as get-supplier-claim-history-handler)
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
// Bytea deserialization (CR fix H1 — feedback_test_integration_gap.md)
// Supabase/PostgREST retourne bytea dans 3 formats possibles :
//   1. Buffer  (SDK server direct ou Supabase realtime)
//   2. string '\x504b0304...' (Postgres hex — format par DÉFAUT de PostgREST)
//   3. string base64 (Supabase-js REST path dans certains contextes)
// Ordre : Buffer → hex Postgres (\x) → bare hex (sans préfixe) → base64 last-resort
//
// DISCRIMINANT : test DL-HEX-01 (pure unit, no DB) doit aller RED sur l'ancien code
// (base64-only) et GREEN après ce fix.
// ---------------------------------------------------------------------------

export function deserializeBlob(raw: Buffer | string | null): Buffer | null {
  if (raw === null || raw === undefined) return null
  if (Buffer.isBuffer(raw)) return raw
  // Uint8Array (possible dans certains contextes edge)
  if ((raw as unknown) instanceof Uint8Array) return Buffer.from(raw as unknown as Uint8Array)
  if (typeof raw === 'string') {
    if (raw.startsWith('\\x')) return Buffer.from(raw.slice(2), 'hex') // Postgres bytea hex (default)
    if (/^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0) return Buffer.from(raw, 'hex') // bare hex
    return Buffer.from(raw, 'base64') // last-resort (Supabase-js REST path)
  }
  return null
}

// ---------------------------------------------------------------------------
// claimId parser (from query — AC #2)
// Used when claimId is not passed as a parameter (e.g., direct handler calls in tests)
// ---------------------------------------------------------------------------

function parseClaimIdFromQuery(req: ApiRequest): number | null {
  const raw = (req.query as Record<string, unknown> | undefined)?.['claimId']
  if (raw === undefined || raw === null) return null
  const str = Array.isArray(raw) ? String(raw[0]) : String(raw)
  if (!/^\d+$/.test(str) || str.length > 15) return null
  const n = Number(str)
  if (!Number.isInteger(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER) return null
  return n
}

// ---------------------------------------------------------------------------
// Core handler
// claimIdOverride: when provided by the router (after query cleanup), use directly.
// Otherwise parse from req.query (direct handler calls in tests).
// ---------------------------------------------------------------------------

function downloadSupplierClaimCore(savId: number, claimIdOverride: number | null = null): ApiHandler {
  return async (req: ApiRequest, res: ApiResponse) => {
    const requestId = ensureRequestId(req)
    const user = req.user
    if (!user || user.type !== 'operator') {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Session opérateur requise', requestId } })
      return
    }

    // GET uniquement (AC #2)
    const method = (req.method ?? 'GET').toUpperCase()
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }

    // claimId requis (AC #2) — from override (router) or from query (direct test call)
    const claimId = claimIdOverride ?? parseClaimIdFromQuery(req)
    if (claimId === null) {
      sendError(res, 'VALIDATION_FAILED', 'claimId invalide ou manquant', requestId)
      return
    }

    // RBAC : checkGroupScope sur le SAV (AC #4c)
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
      logger.error('sav.download-supplier-claim.group_check_error', {
        requestId, savId, error: err instanceof Error ? err.message : String(err),
      })
      sendError(res, 'SERVER_ERROR', 'Erreur vérification accès', requestId)
      return
    }

    const admin = supabaseAdmin()

    // Charger la claim avec le blob
    const { data: claimRow, error: claimError } = await admin
      .from('sav_supplier_claims')
      .select('id, sav_id, filename, document_blob, document_sha256, total_importe_cents, generated_by_operator_id')
      .eq('id', claimId)
      .maybeSingle<ClaimRow>()

    if (claimError || !claimRow) {
      sendError(res, 'NOT_FOUND', 'Réclamation introuvable', requestId)
      return
    }

    // GARDE IDOR (AC #4d) — DISCRIMINANT : ce check DOIT être présent
    // Si claim.sav_id !== savId : un opérateur légitime sur savId tente d'accéder
    // à une claim appartenant à un autre SAV (IDOR cross-SAV)
    // → 404 (pas 403) pour ne pas leaker l'existence de la claim
    if (claimRow.sav_id !== savId) {
      sendError(res, 'NOT_FOUND', 'Réclamation introuvable', requestId)
      return
    }

    // Désérialisation bytea (leçon feedback_test_integration_gap.md)
    const blobBuffer = deserializeBlob(claimRow.document_blob)
    if (!blobBuffer || blobBuffer.length === 0) {
      sendError(res, 'NOT_FOUND', 'Document non disponible', requestId)
      return
    }

    // Réponse 200 + headers (AC #2) — set avant l'audit pour que les headers soient prêts
    res.status(200)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${claimRow.filename}"`)
    res.setHeader('Content-Length', String(blobBuffer.length))
    res.setHeader('Cache-Control', 'private, no-store') // NFR-SEC

    // Audit best-effort AVANT end() (CR fix M3 — sur Vercel/serverless, la fonction
    // peut être teardown après end() → audit dropped si on auditait après).
    // DN-1 LOCKED = A : audit failure ne bloque PAS le téléchargement (catch + warn).
    try {
      await recordAudit({
        action: 'sav_supplier_claim_downloaded',
        entityType: 'sav_supplier_claim',
        entityId: claimId,
        actorOperatorId: user.sub,
        diff: {
          savId,
          claimId,
          filename: claimRow.filename,
        },
      })
    } catch (auditErr) {
      // Best-effort : audit failure ne bloque pas le téléchargement (pattern 4.8 / 8.4)
      logger.warn('sav.download-supplier-claim.audit_failed', {
        requestId, claimId, error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      })
    }

    // Envoyer le blob après l'audit (M3 : end() est la DERNIÈRE instruction)
    const nodeRes = res as unknown as { end: (chunk?: Buffer | string) => void }
    nodeRes.end(blobBuffer)
  }
}

// ---------------------------------------------------------------------------
// Exported handler (withRateLimit 10/60s — AC #4b, DN-1=A)
// withAuth est posé en amont par le router sav.ts
// claimIdOverride: injected by the router before query cleanup
// ---------------------------------------------------------------------------

export function downloadSupplierClaimHandler(savId: number, claimIdOverride: number | null = null): ApiHandler {
  const core = downloadSupplierClaimCore(savId, claimIdOverride)
  return withRateLimit({
    bucketPrefix: 'sav:download-supplier-claim',
    keyFrom: (r: ApiRequest) =>
      r.user && r.user.type === 'operator' ? `op:${r.user.sub}` : undefined,
    max: 10,
    window: '1m',
  })(core)
}
