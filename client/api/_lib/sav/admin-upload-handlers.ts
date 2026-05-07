/**
 * Story 3.7b — AC #5 — Endpoints upload opérateur back-office.
 *
 * adminUploadSessionHandler  — POST /api/admin/sav-files/upload-session
 *   (op=admin-upload-session dans api/sav.ts)
 *
 * adminUploadCompleteHandler — POST /api/admin/sav-files/upload-complete
 *   (op=admin-upload-complete dans api/sav.ts)
 *
 * PATTERN-D defense-in-depth : upload-session persiste le binding
 * (uploadSessionId, savId, operatorId) dans sav_upload_sessions ;
 * upload-complete vérifie ce binding AVANT la whitelist webUrl.
 *
 * Contrainte Vercel 12/12 : hébergés dans api/sav.ts (slot existant),
 * ZERO nouveau fichier api/*.ts.
 */

import crypto from 'node:crypto'
import { z } from 'zod'
import { withAuth } from '../middleware/with-auth'
import { withRateLimit } from '../middleware/with-rate-limit'
import { withValidation } from '../middleware/with-validation'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { ensureFolderExists, createUploadSession } from '../onedrive-ts'
import { isOneDriveWebUrlTrusted } from '../../../src/shared/utils/onedrive-whitelist'
import { verifyUploadSessionBinding } from './upload-session-store'
import type { ApiHandler, ApiRequest, ApiResponse } from '../types'

// ---------------------------------------------------------------------------
// MIME whitelist — image + PDF + Office (AC #5.1)
// ---------------------------------------------------------------------------
const ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
])

function isAllowedMime(mime: string): boolean {
  if (ALLOWED_MIMES.has(mime)) return true
  // Office OpenXML (.docx, .xlsx, .pptx, etc.)
  if (mime.startsWith('application/vnd.openxmlformats-officedocument.')) return true
  return false
}

// ---------------------------------------------------------------------------
// Statuts SAV bloquants (SAV_LOCKED)
// ---------------------------------------------------------------------------
const LOCKED_STATUSES = new Set(['cancelled', 'closed'])

// ---------------------------------------------------------------------------
// Sanitize filename (strip path separators, truncate)
// ---------------------------------------------------------------------------
function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 200)
}

// ---------------------------------------------------------------------------
// Body schemas (Zod)
// ---------------------------------------------------------------------------
const uploadSessionBodySchema = z.object({
  savId: z.number().int().positive(),
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(120),
  size: z
    .number()
    .int()
    .min(1)
    .max(50 * 1024 * 1024),
})

const uploadCompleteBodySchema = z.object({
  savId: z.number().int().positive(),
  uploadSessionId: z.string().min(1).max(200),
  onedriveItemId: z.string().min(1).max(200),
  webUrl: z.string().url(),
  originalFilename: z.string().min(1).max(255),
  sanitizedFilename: z.string().min(1).max(255),
  sizeBytes: z
    .number()
    .int()
    .min(1)
    .max(50 * 1024 * 1024),
  mimeType: z.string().min(1).max(120),
})

// ---------------------------------------------------------------------------
// SAV lookup helper
// ---------------------------------------------------------------------------
interface SavRow {
  id: number
  reference: string
  status: string
  member_id: number
}

async function lookupSav(savId: number): Promise<SavRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('sav')
    .select('id, reference, status, member_id')
    .eq('id', savId)
    .maybeSingle<SavRow>()

  if (error || !data) return null
  return data
}

// ---------------------------------------------------------------------------
// Core: upload-session
// ---------------------------------------------------------------------------
function adminUploadSessionCore(): ApiHandler {
  return async (req: ApiRequest, res: ApiResponse) => {
    const requestId = ensureRequestId(req)
    const user = req.user

    // Auth guard — operator only (withAuth already checked type, but belt+suspenders)
    if (!user || user.type !== 'operator') {
      sendError(res, 'FORBIDDEN', 'Session opérateur requise', requestId)
      return
    }

    const body = req.body as z.infer<typeof uploadSessionBodySchema>

    try {
      // 1. SAV lookup
      const savRow = await lookupSav(body.savId)
      if (!savRow) {
        sendError(res, 'NOT_FOUND', 'SAV introuvable', requestId)
        return
      }

      // 2. SAV_LOCKED check
      if (LOCKED_STATUSES.has(savRow.status)) {
        sendError(res, 'BUSINESS_RULE', 'SAV verrouillé — opération impossible', requestId, {
          code: 'SAV_LOCKED',
          status: savRow.status,
        })
        return
      }

      // 3. MIME whitelist
      if (!isAllowedMime(body.mimeType)) {
        sendError(res, 'VALIDATION_FAILED', 'Type MIME non autorisé', requestId, {
          code: 'MIME_NOT_ALLOWED',
          mimeType: body.mimeType,
        })
        return
      }

      // 4. Créer le dossier OneDrive + upload-session Graph
      const sanitized = sanitizeFilename(body.filename)
      const drivePath = process.env['MICROSOFT_DRIVE_PATH'] ?? 'SAV_Images'
      const folderPath = `${drivePath}/${sanitizeFilename(savRow.reference)}/operator-adds`
      const parentFolderId = await ensureFolderExists(folderPath)
      const graphSession = await createUploadSession({ parentFolderId, filename: sanitized })

      // 5. Générer uploadSessionId + persister le binding (PATTERN-D)
      // Insert direct dans sav_upload_sessions (auditable, test-capturable via mock supabase).
      const uploadSessionId = crypto.randomUUID()
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
      await supabaseAdmin().from('sav_upload_sessions').insert({
        id: uploadSessionId,
        sav_id: body.savId,
        operator_id: user.sub,
        expires_at: expiresAt,
      })

      logger.info('sav.admin_upload.session_created', {
        requestId,
        savId: body.savId,
        uploadSessionId,
        actorOperatorId: user.sub,
      })

      res.status(200).json({
        data: {
          uploadUrl: graphSession.uploadUrl,
          sanitizedFilename: sanitized,
          storagePath: `${folderPath}/${sanitized}`,
          uploadSessionId,
        },
      })
    } catch (err) {
      logger.error('sav.admin_upload.session_error', {
        requestId,
        savId: body.savId,
        error: err instanceof Error ? err.message : String(err),
      })
      sendError(res, 'SERVER_ERROR', 'Erreur création upload-session', requestId)
    }
  }
}

// ---------------------------------------------------------------------------
// Core: upload-complete
// ---------------------------------------------------------------------------
function adminUploadCompleteCore(): ApiHandler {
  return async (req: ApiRequest, res: ApiResponse) => {
    const requestId = ensureRequestId(req)
    const user = req.user

    if (!user || user.type !== 'operator') {
      sendError(res, 'FORBIDDEN', 'Session opérateur requise', requestId)
      return
    }

    const body = req.body as z.infer<typeof uploadCompleteBodySchema>

    try {
      // 1. PATTERN-D — Session→savId binding check AVANT toute autre vérification.
      //    Mismatch ou expiré → 403 UPLOAD_SESSION_SAV_MISMATCH (test TU-05bis).
      const binding = await verifyUploadSessionBinding({
        sessionId: body.uploadSessionId,
        savId: body.savId,
        operatorId: user.sub,
      })
      if (!binding.valid) {
        res.status(403).json({
          error: {
            code: 'UPLOAD_SESSION_SAV_MISMATCH',
            message: `Session binding invalide : ${binding.reason ?? 'unknown'}`,
            requestId,
          },
        })
        return
      }

      // 2. webUrl whitelist (defense-in-depth couche 2, test TU-05)
      if (!isOneDriveWebUrlTrusted(body.webUrl)) {
        sendError(res, 'VALIDATION_FAILED', 'URL non approuvée', requestId, {
          code: 'WEBURL_NOT_TRUSTED',
          webUrl: body.webUrl,
        })
        return
      }

      // 3. SAV lookup + SAV_LOCKED check (race condition defense, test TU-02b)
      const savRow = await lookupSav(body.savId)
      if (!savRow) {
        sendError(res, 'NOT_FOUND', 'SAV introuvable', requestId)
        return
      }
      if (LOCKED_STATUSES.has(savRow.status)) {
        sendError(res, 'BUSINESS_RULE', 'SAV verrouillé — opération impossible', requestId, {
          code: 'SAV_LOCKED',
          status: savRow.status,
        })
        return
      }

      // 4. INSERT sav_files (source='operator-add', uploaded_by_operator_id=user.sub)
      const { data: fileRow, error: insertError } = await supabaseAdmin()
        .from('sav_files')
        .insert({
          sav_id: body.savId,
          uploaded_by_operator_id: user.sub,
          uploaded_by_member_id: null,
          onedrive_item_id: body.onedriveItemId,
          web_url: body.webUrl,
          file_name: body.sanitizedFilename,
          original_filename: body.originalFilename,
          mime_type: body.mimeType,
          size_bytes: body.sizeBytes,
          source: 'operator-add',
        })
        .select('id, created_at, source')
        .single<{ id: number; created_at: string; source: string }>()

      if (insertError) {
        logger.error('sav.admin_upload.complete_insert_error', {
          requestId,
          savId: body.savId,
          message: (insertError as { message?: string }).message,
        })
        sendError(res, 'SERVER_ERROR', 'Échec enregistrement fichier', requestId)
        return
      }

      logger.info('sav.admin_upload.complete_ok', {
        requestId,
        savId: body.savId,
        savFileId: fileRow.id,
        actorOperatorId: user.sub,
      })

      res.status(201).json({
        data: {
          savFileId: fileRow.id,
          createdAt: fileRow.created_at,
          source: fileRow.source,
        },
      })
    } catch (err) {
      logger.error('sav.admin_upload.complete_error', {
        requestId,
        savId: body.savId,
        error: err instanceof Error ? err.message : String(err),
      })
      sendError(res, 'SERVER_ERROR', 'Erreur traitement upload', requestId)
    }
  }
}

// ---------------------------------------------------------------------------
// Exported handlers (wrapped with middleware)
// ---------------------------------------------------------------------------

export const adminUploadSessionHandler: ApiHandler = withAuth({
  types: ['operator'],
})(
  withRateLimit({
    bucketPrefix: 'admin:upload-session',
    keyFrom: (r: ApiRequest) =>
      r.user && r.user.type === 'operator' ? `op:${r.user.sub}` : undefined,
    max: 30,
    window: '1m',
  })(withValidation({ body: uploadSessionBodySchema })(adminUploadSessionCore()))
)

export const adminUploadCompleteHandler: ApiHandler = withAuth({
  types: ['operator'],
})(withValidation({ body: uploadCompleteBodySchema })(adminUploadCompleteCore()))
