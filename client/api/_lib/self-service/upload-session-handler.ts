import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { withAuth } from '../middleware/with-auth'
import { withRateLimit } from '../middleware/with-rate-limit'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { formatErrors } from '../middleware/with-validation'
import { ensureFolderExists, createUploadSession } from '../onedrive-ts'
import { sanitizeFilename, sanitizeSavDossier } from '../sanitize-ts'
import { isMimeAllowed } from '../mime-ts'
import fileLimits from '../../../shared/file-limits.json'
import type { ApiHandler, ApiRequest } from '../types'

/**
 * Story 2.4 handler extrait — POST /api/self-service/upload-session.
 *
 * Story 5.2 AC #2 : logique déplacée du top-level `api/self-service/upload-session.ts`
 * (retiré) vers cette library pure, pour libérer 1 slot Vercel Hobby
 * (cap 12 functions). Le router `api/self-service/draft.ts` dispatche
 * op=upload-session vers le handler exporté ci-dessous (auth + rate-limit
 * déjà composés — pas d'intervention supplémentaire côté router).
 */

const bodySchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(127),
  size: z.number().int().positive(),
  savReference: z
    .string()
    .regex(/^SAV-\d{4}-\d{5}$/, 'Format attendu SAV-YYYY-NNNNN')
    .optional(),
})

const coreHandler: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  const user = req.user
  if (!user || user.type !== 'member' || typeof user.sub !== 'number') {
    sendError(res, 'FORBIDDEN', 'Session non membre', requestId)
    return
  }

  const drivePath = process.env['MICROSOFT_DRIVE_PATH']
  if (!drivePath) {
    logger.error('upload-session.config_missing', { requestId })
    sendError(res, 'SERVER_ERROR', 'Configuration manquante', requestId)
    return
  }

  const parse = bodySchema.safeParse(req.body)
  if (!parse.success) {
    sendError(res, 'VALIDATION_FAILED', 'Body invalide', requestId, formatErrors(parse.error))
    return
  }
  const body = parse.data

  if (!isMimeAllowed(body.mimeType)) {
    sendError(res, 'VALIDATION_FAILED', `Type MIME non autorisé : ${body.mimeType}`, requestId, [
      { field: 'mimeType', message: 'not allowed', received: body.mimeType },
    ])
    return
  }
  if (body.size > fileLimits.maxFileSizeBytes) {
    sendError(res, 'VALIDATION_FAILED', `Taille > ${fileLimits.maxFileSizeMb} Mo`, requestId, [
      { field: 'size', message: `exceeds ${fileLimits.maxFileSizeBytes} bytes` },
    ])
    return
  }
  const sanitizedFilename = sanitizeFilename(body.filename)
  if (!sanitizedFilename) {
    sendError(res, 'VALIDATION_FAILED', 'Nom de fichier invalide après sanitization', requestId)
    return
  }

  let folderPath: string
  if (body.savReference) {
    const { data: sav, error } = await supabaseAdmin()
      .from('sav')
      .select('id, member_id, reference')
      .eq('reference', body.savReference)
      .maybeSingle<{ id: number; member_id: number; reference: string }>()
    if (error) {
      logger.error('upload-session.sav_lookup_failed', { requestId, message: error.message })
      sendError(res, 'SERVER_ERROR', 'Lookup SAV échoué', requestId)
      return
    }
    if (!sav) {
      sendError(res, 'NOT_FOUND', 'SAV introuvable', requestId)
      return
    }
    if (sav.member_id !== user.sub) {
      logger.warn('upload-session.scope_violation', {
        requestId,
        memberId: user.sub,
        savMemberId: sav.member_id,
      })
      sendError(res, 'FORBIDDEN', 'SAV hors de votre périmètre', requestId)
      return
    }
    const sanitizedRef = sanitizeSavDossier(body.savReference)
    if (!sanitizedRef) {
      sendError(res, 'SERVER_ERROR', 'Référence SAV invalide', requestId)
      return
    }
    folderPath = `${drivePath}/${sanitizedRef}`
  } else {
    const ts = new Date()
    const stamp = `${ts.getUTCFullYear()}${pad(ts.getUTCMonth() + 1)}${pad(ts.getUTCDate())}-${pad(ts.getUTCHours())}${pad(ts.getUTCMinutes())}${pad(ts.getUTCSeconds())}`
    const rand = randomBytes(3).toString('hex')
    folderPath = `${drivePath}/drafts/${user.sub}/${stamp}-${rand}`
  }

  try {
    const parentFolderId = await ensureFolderExists(folderPath)
    const session = await createUploadSession({
      parentFolderId,
      filename: sanitizedFilename,
    })
    res.status(200).json({
      data: {
        uploadUrl: session.uploadUrl,
        expiresAt: session.expirationDateTime,
        storagePath: `${folderPath}/${sanitizedFilename}`,
        sanitizedFilename,
      },
    })
  } catch (err) {
    logger.error('upload-session.graph_failed', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    })
    sendError(res, 'DEPENDENCY_DOWN', 'OneDrive indisponible', requestId)
  }
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

export const uploadSessionHandler: ApiHandler = withAuth({ types: ['member'] })(
  withRateLimit({
    bucketPrefix: 'upload:session',
    keyFrom: (req: ApiRequest) =>
      req.user && req.user.type === 'member' ? `member:${req.user.sub}` : undefined,
    max: 30,
    window: '1m',
  })(coreHandler)
)

export { coreHandler as __uploadSessionCore }
