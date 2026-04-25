import { z } from 'zod'
import { withAuth } from '../middleware/with-auth'
import { withRateLimit } from '../middleware/with-rate-limit'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { formatErrors } from '../middleware/with-validation'
import { recordAudit } from '../audit/record'
import type { ApiHandler, ApiRequest } from '../types'

/**
 * Story 2.4 handler extrait — POST /api/self-service/upload-complete.
 *
 * Story 5.2 AC #2 : logique déplacée du top-level `api/self-service/upload-complete.ts`
 * (retiré) vers cette library pure. Identique comportement ; seul l'emplacement
 * du code change (consolidation Vercel cap 12 functions).
 */

const TRUSTED_WEBURL_HOSTS = [
  /\.sharepoint\.com$/i,
  /\.sharepoint\.us$/i,
  /(^|\.)graph\.microsoft\.com$/i,
  /(^|\.)onedrive\.live\.com$/i,
  /\.files\.onedrive\.com$/i,
]
const webUrlSchema = z
  .string()
  .url()
  .max(2000)
  .refine(
    (u) => {
      try {
        const parsed = new URL(u)
        if (parsed.protocol !== 'https:') return false
        const host = parsed.hostname
        return TRUSTED_WEBURL_HOSTS.some((re) => re.test(host))
      } catch {
        return false
      }
    },
    { message: 'webUrl must point to a trusted Graph/SharePoint host' }
  )

const MAX_DRAFT_FILES = 20

const fileSchema = z.object({
  onedriveItemId: z.string().min(1).max(128),
  webUrl: webUrlSchema,
  originalFilename: z.string().min(1).max(255),
  sanitizedFilename: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive().max(26214400),
  mimeType: z.string().min(1).max(127),
})

const bodySchema = z
  .object({
    onedriveItemId: fileSchema.shape.onedriveItemId,
    webUrl: fileSchema.shape.webUrl,
    originalFilename: fileSchema.shape.originalFilename,
    sanitizedFilename: fileSchema.shape.sanitizedFilename,
    sizeBytes: fileSchema.shape.sizeBytes,
    mimeType: fileSchema.shape.mimeType,
    savReference: z
      .string()
      .regex(/^SAV-\d{4}-\d{5}$/)
      .optional(),
    draftAttachmentId: z.string().uuid().optional(),
  })
  .refine(
    (v) =>
      (v.savReference !== undefined && v.draftAttachmentId === undefined) ||
      (v.savReference === undefined && v.draftAttachmentId !== undefined),
    {
      message: 'exactly one of savReference/draftAttachmentId required',
      path: ['savReference'],
    }
  )

const coreHandler: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  const user = req.user
  if (!user || user.type !== 'member' || typeof user.sub !== 'number') {
    sendError(res, 'FORBIDDEN', 'Session non membre', requestId)
    return
  }

  const parse = bodySchema.safeParse(req.body)
  if (!parse.success) {
    sendError(res, 'VALIDATION_FAILED', 'Body invalide', requestId, formatErrors(parse.error))
    return
  }
  const body = parse.data
  const memberId = user.sub
  const admin = supabaseAdmin()

  if (body.savReference) {
    const { data: sav, error: selErr } = await admin
      .from('sav')
      .select('id, member_id')
      .eq('reference', body.savReference)
      .maybeSingle<{ id: number; member_id: number }>()
    if (selErr) {
      logger.error('upload-complete.sav_lookup_failed', { requestId, message: selErr.message })
      sendError(res, 'SERVER_ERROR', 'Lookup SAV échoué', requestId)
      return
    }
    if (!sav) {
      sendError(res, 'NOT_FOUND', 'SAV introuvable', requestId)
      return
    }
    if (sav.member_id !== memberId) {
      logger.warn('upload-complete.scope_violation', {
        requestId,
        memberId,
        savMemberId: sav.member_id,
      })
      sendError(res, 'FORBIDDEN', 'SAV hors de votre périmètre', requestId)
      return
    }

    const { data: inserted, error: insErr } = await admin
      .from('sav_files')
      .insert({
        sav_id: sav.id,
        original_filename: body.originalFilename,
        sanitized_filename: body.sanitizedFilename,
        onedrive_item_id: body.onedriveItemId,
        web_url: body.webUrl,
        size_bytes: body.sizeBytes,
        mime_type: body.mimeType,
        uploaded_by_member_id: memberId,
        source: 'member-add',
      })
      .select('id, created_at')
      .single<{ id: number; created_at: string }>()
    if (insErr || !inserted) {
      logger.error('upload-complete.sav_file_insert_failed', {
        requestId,
        message: insErr?.message ?? 'empty insert',
      })
      sendError(res, 'SERVER_ERROR', 'Insertion fichier échouée', requestId)
      return
    }

    await recordAudit({
      entityType: 'sav_file',
      entityId: inserted.id,
      action: 'created',
      actorMemberId: memberId,
      diff: {
        after: {
          savId: sav.id,
          sanitizedFilename: body.sanitizedFilename,
          sizeBytes: body.sizeBytes,
          source: 'member-add',
        },
      },
    }).catch((err) => {
      logger.error('upload-complete.audit_failed', {
        requestId,
        error: err instanceof Error ? err.message : String(err),
      })
    })

    res.status(200).json({
      data: { savFileId: inserted.id, createdAt: inserted.created_at },
    })
    return
  }

  if (body.draftAttachmentId) {
    const { data: draft, error: selErr } = await admin
      .from('sav_drafts')
      .select('data')
      .eq('member_id', memberId)
      .maybeSingle<{ data: { files?: unknown[] } & Record<string, unknown> }>()
    if (selErr) {
      logger.error('upload-complete.draft_lookup_failed', { requestId, message: selErr.message })
      sendError(res, 'SERVER_ERROR', 'Lookup brouillon échoué', requestId)
      return
    }

    const existingData: { files?: unknown[] } & Record<string, unknown> = draft?.data ?? {}
    const existingFiles = Array.isArray(existingData.files) ? existingData.files : []
    const filtered = existingFiles.filter(notSameId(body.draftAttachmentId))
    if (filtered.length >= MAX_DRAFT_FILES) {
      sendError(
        res,
        'VALIDATION_FAILED',
        `Brouillon a déjà ${MAX_DRAFT_FILES} pièces jointes`,
        requestId,
        [{ field: 'draftAttachmentId', message: `max ${MAX_DRAFT_FILES} files per draft` }]
      )
      return
    }
    const newAttachment = {
      id: body.draftAttachmentId,
      onedriveItemId: body.onedriveItemId,
      webUrl: body.webUrl,
      originalFilename: body.originalFilename,
      sanitizedFilename: body.sanitizedFilename,
      sizeBytes: body.sizeBytes,
      mimeType: body.mimeType,
    }
    const nextData = {
      ...existingData,
      files: [...filtered, newAttachment],
    }

    const nowIso = new Date().toISOString()
    const { error: upErr } = await admin
      .from('sav_drafts')
      .upsert(
        { member_id: memberId, data: nextData, last_saved_at: nowIso },
        { onConflict: 'member_id' }
      )
    if (upErr) {
      logger.error('upload-complete.draft_upsert_failed', { requestId, message: upErr.message })
      sendError(res, 'SERVER_ERROR', 'Ajout pièce au brouillon échoué', requestId)
      return
    }

    res.status(200).json({
      data: { draftAttachmentId: body.draftAttachmentId, createdAt: nowIso },
    })
    return
  }

  sendError(res, 'VALIDATION_FAILED', 'Mode invalide', requestId)
}

function notSameId(id: string) {
  return (entry: unknown): boolean => {
    if (typeof entry !== 'object' || entry === null) return true
    const e = entry as { id?: unknown }
    return e.id !== id
  }
}

export const uploadCompleteHandler: ApiHandler = withAuth({ types: ['member'] })(
  withRateLimit({
    bucketPrefix: 'upload:complete',
    keyFrom: (req: ApiRequest) =>
      req.user && req.user.type === 'member' ? `member:${req.user.sub}` : undefined,
    max: 30,
    window: '1m',
  })(coreHandler)
)

export { coreHandler as __uploadCompleteCore }
