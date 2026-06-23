import { createHash, randomUUID } from 'node:crypto'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { recordAudit } from '../audit/record'
import { parseTargetId } from './parse-target-id'
import {
  signRgpdExport,
  type RgpdExport,
  type RgpdExportEnvelope,
} from './rgpd-export-canonical-json'
import type { ApiHandler } from '../types'

/**
 * Story 7-6 AC #1 + AC #2 + AC #5 — `POST /api/admin/members/:id/rgpd-export`
 * (op `admin-rgpd-export`).
 *
 * Décisions appliquées :
 *   D-1 : HMAC-SHA256 base64url canonical-JSON, secret env
 *         `RGPD_EXPORT_HMAC_SECRET` ≥ 32 bytes. Absent → 500
 *         `RGPD_SECRET_NOT_CONFIGURED` (fail-fast au runtime du 1er appel,
 *         testable per-it via `vi.stubEnv`).
 *   D-2 : 7 collections obligatoires (member, sav, sav_lines, sav_comments
 *         INCLUS internal, sav_files webUrls, credit_notes, auth_events).
 *   D-4 : pas de hard cap, warn log si payload > 5 MB (logger.warn sans
 *         le payload — anti-leak).
 *   D-6 : lookup member 404 anti-énumération (cohérent Story 1.5 D-1).
 *   D-7 : recordAudit handler-side `entity_type='member'` (singulier),
 *         `action='rgpd_export'`, diff = `{ exported_at, export_id,
 *         member_id, collection_counts }` — PAS le payload (anti double-leak).
 *         Best-effort try/catch.
 *   D-8 : RBAC defense-in-depth — sav-operator → 403 ROLE_NOT_ALLOWED.
 *
 * Réponses :
 *   200 → RgpdExport JSON complet (signé)
 *   403 ROLE_NOT_ALLOWED
 *   404 MEMBER_NOT_FOUND
 *   500 RGPD_SECRET_NOT_CONFIGURED | EXPORT_FAILED
 */

const PAYLOAD_WARN_BYTES = 5 * 1024 * 1024

function readSecret(): string | null {
  const raw = process.env['RGPD_EXPORT_HMAC_SECRET']
  if (typeof raw !== 'string' || raw.length < 32) return null
  return raw
}

// HARDEN-5 (CR F-5) — log SHA8 du secret au 1er appel handler (D-1 garde-fou
// ops + détection rotation involontaire). Memo module-level → 1 log par
// instance Vercel (cold-start). Jamais le secret raw.
let secretSha8Logged = false
function logSecretSha8Once(secret: string, requestId: string): void {
  if (secretSha8Logged) return
  secretSha8Logged = true
  const sha8 = createHash('sha256').update(secret).digest('hex').slice(0, 8)
  logger.info('admin.rgpd_export.secret_loaded', { requestId, secret_sha8: sha8 })
}

// HARDEN-2 (CR F-2) — Defensive query error checking. Step 3 ignorait
// `*Res.error` → un fail RLS/transient produisait `data: null` → fallback []
// → export SIGNÉ avec collection vide (D-2 violé). Throw → 500 EXPORT_FAILED.
class SelectQueryError extends Error {
  label: string
  constructor(label: string, message: string) {
    super(`${label}_QUERY_FAILED: ${message}`)
    this.label = label
  }
}
function assertSelectOk<T>(
  label: string,
  res: { data: T | null; error: { message: string } | null }
): T {
  if (res.error !== null) {
    throw new SelectQueryError(label, res.error.message)
  }
  return (res.data as T) ?? ([] as unknown as T)
}

export const adminRgpdExportHandler: ApiHandler = async (req, res) => {
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

  const secret = readSecret()
  if (secret === null) {
    logger.error('admin.rgpd_export.secret_not_configured', { requestId })
    sendError(res, 'SERVER_ERROR', 'RGPD secret non configuré', requestId, {
      code: 'RGPD_SECRET_NOT_CONFIGURED',
    })
    return
  }
  // HARDEN-5 (CR F-5) — D-1 secret SHA8 boot log (1× par instance).
  logSecretSha8Once(secret, requestId)

  const memberId = parseTargetId(req)
  if (memberId === null) {
    sendError(res, 'VALIDATION_FAILED', 'Member ID invalide', requestId, {
      code: 'INVALID_MEMBER_ID',
    })
    return
  }

  const admin = supabaseAdmin()

  // D-6 lookup member 404 anti-énumération.
  const { data: member, error: memberErr } = (await admin
    .from('members')
    .select('*')
    .eq('id', memberId)
    .maybeSingle()) as unknown as {
    data: Record<string, unknown> | null
    error: { message: string } | null
  }
  if (memberErr) {
    logger.error('admin.rgpd_export.member_lookup_failed', {
      requestId,
      memberId,
      message: memberErr.message,
    })
    sendError(res, 'SERVER_ERROR', 'Lecture membre impossible', requestId, {
      code: 'EXPORT_FAILED',
    })
    return
  }
  if (member === null) {
    sendError(res, 'NOT_FOUND', 'Member introuvable', requestId, {
      code: 'MEMBER_NOT_FOUND',
    })
    return
  }

  // D-2 — 6 SELECT en parallèle. sav d'abord pour récupérer les sav_id
  // (jointures sav_lines/sav_comments/sav_files via .in('sav_id', [...])).
  // HARDEN-2 (CR F-2) — assertSelectOk lit `*Res.error` et throw si non-null
  // → catch → 500 EXPORT_FAILED. Évite l'export SIGNÉ avec collections vides.
  let savRows: Array<Record<string, unknown>>
  let savLinesRows: Array<Record<string, unknown>>
  let savCommentsRows: Array<Record<string, unknown>>
  let savFilesRows: Array<Record<string, unknown>>
  let creditNotesRows: Array<Record<string, unknown>>
  let authEventsRows: Array<Record<string, unknown>>
  try {
    const [savRes, creditNotesRes, authEventsRes] = await Promise.all([
      admin.from('sav').select('*').eq('member_id', memberId) as unknown as Promise<{
        data: Array<Record<string, unknown>> | null
        error: { message: string } | null
      }>,
      admin.from('credit_notes').select('*').eq('member_id', memberId) as unknown as Promise<{
        data: Array<Record<string, unknown>> | null
        error: { message: string } | null
      }>,
      admin.from('auth_events').select('*').eq('member_id', memberId) as unknown as Promise<{
        data: Array<Record<string, unknown>> | null
        error: { message: string } | null
      }>,
    ])
    savRows = assertSelectOk('sav', savRes)
    creditNotesRows = assertSelectOk('credit_notes', creditNotesRes)
    authEventsRows = assertSelectOk('auth_events', authEventsRes)

    const savIds = savRows.map((s) => s['id']).filter((v): v is number => typeof v === 'number')

    const [savLinesRes, savCommentsRes, savFilesRes] = await Promise.all([
      savIds.length > 0
        ? (admin.from('sav_lines').select('*').in('sav_id', savIds) as unknown as Promise<{
            data: Array<Record<string, unknown>> | null
            error: { message: string } | null
          }>)
        : Promise.resolve({ data: [], error: null }),
      savIds.length > 0
        ? (admin.from('sav_comments').select('*').in('sav_id', savIds) as unknown as Promise<{
            data: Array<Record<string, unknown>> | null
            error: { message: string } | null
          }>)
        : Promise.resolve({ data: [], error: null }),
      savIds.length > 0
        ? (admin.from('sav_files').select('*').in('sav_id', savIds) as unknown as Promise<{
            data: Array<Record<string, unknown>> | null
            error: { message: string } | null
          }>)
        : Promise.resolve({ data: [], error: null }),
    ])
    savLinesRows = assertSelectOk('sav_lines', savLinesRes)
    savCommentsRows = assertSelectOk('sav_comments', savCommentsRes)
    savFilesRows = assertSelectOk('sav_files', savFilesRes)
  } catch (e) {
    const label = e instanceof SelectQueryError ? e.label : 'unknown'
    logger.error('admin.rgpd_export.select_failed', {
      requestId,
      memberId,
      label,
      message: e instanceof Error ? e.message : String(e),
    })
    sendError(res, 'SERVER_ERROR', 'Lecture données impossible', requestId, {
      code: 'EXPORT_FAILED',
    })
    return
  }

  const envelope: RgpdExportEnvelope = {
    export_version: '1.0',
    export_id: `rgpd-${randomUUID()}`,
    exported_at: new Date().toISOString(),
    exported_by_operator_id: user.sub,
    member_id: memberId,
    data: {
      member,
      sav: savRows,
      sav_lines: savLinesRows,
      sav_comments: savCommentsRows,
      sav_files: savFilesRows,
      credit_notes: creditNotesRows,
      auth_events: authEventsRows,
    },
  }

  const signature = signRgpdExport(envelope, secret)
  const fullExport: RgpdExport = { ...envelope, signature }

  // D-4 — warn log si payload > 5 MB (sans payload, anti-leak).
  const payloadBytes = JSON.stringify(fullExport).length
  if (payloadBytes > PAYLOAD_WARN_BYTES) {
    logger.warn('admin.rgpd_export.large_payload', {
      requestId,
      member_id: memberId,
      payload_bytes: payloadBytes,
      sav_count: envelope.data.sav.length,
      sav_lines_count: envelope.data.sav_lines.length,
      sav_files_count: envelope.data.sav_files.length,
    })
  }

  // D-7 — recordAudit best-effort (pas le payload, juste les counts).
  // Pour `rgpd_export` (read-only), le diff est flat (`exported_at`,
  // `export_id`, `collection_counts`) plutôt que before/after — anti-leak :
  // PAS le payload export, juste les volumétries pour audit forensique
  // (cohérent contrat AuditTrailView Story 7-5 qui parse diff opaque).
  try {
    await recordAudit({
      entityType: 'member',
      entityId: memberId,
      action: 'rgpd_export',
      actorOperatorId: user.sub,
      diff: {
        exported_at: envelope.exported_at,
        export_id: envelope.export_id,
        member_id: memberId,
        collection_counts: {
          sav: envelope.data.sav.length,
          sav_lines: envelope.data.sav_lines.length,
          sav_comments: envelope.data.sav_comments.length,
          sav_files: envelope.data.sav_files.length,
          credit_notes: envelope.data.credit_notes.length,
          auth_events: envelope.data.auth_events.length,
        },
      },
      notes: 'Export RGPD admin via /admin/members/:id/rgpd-export',
    })
  } catch (e) {
    logger.warn('admin.rgpd_export.audit_failed', {
      requestId,
      memberId,
      message: e instanceof Error ? e.message : String(e),
    })
  }

  logger.info('admin.rgpd_export.success', {
    requestId,
    actorOperatorId: user.sub,
    memberId,
    exportId: envelope.export_id,
    payloadBytes,
  })

  res.status(200).json(fullExport)
}
