import { z } from 'zod'
import { withAuth } from '../_lib/middleware/with-auth'
import { withRateLimit } from '../_lib/middleware/with-rate-limit'
import { ensureRequestId } from '../_lib/request-id'
import { sendError } from '../_lib/errors'
import { logger } from '../_lib/logger'
import { supabaseAdmin } from '../_lib/clients/supabase-admin'
import { formatErrors } from '../_lib/middleware/with-validation'
import type { ApiHandler, ApiRequest, ApiResponse } from '../_lib/types'
import { randomBytes } from 'node:crypto'
import { ensureFolderExists, createUploadSession } from '../_lib/onedrive-ts'
import { sanitizeFilename, sanitizeSavDossier } from '../_lib/sanitize-ts'
import { isMimeAllowed } from '../_lib/mime-ts'
import fileLimits from '../../shared/file-limits.json'

/**
 * POST /api/self-service/upload-session — Story 2.4
 *
 * Négocie une session d'upload OneDrive côté Graph pour un adhérent connecté
 * (magic-link). Équivalent du `api/upload-session.js` legacy API-key, mais scopé
 * à un membre authentifié et avec routage dossier brouillon / dossier SAV.
 *
 * Flow 3 étapes côté front :
 *   1. POST /upload-session → { uploadUrl, sanitizedFilename, storagePath }
 *   2. PUT chunks 4 MiB → uploadUrl (directement vers Graph)
 *   3. POST /upload-complete → persistance sav_files ou sav_drafts.data.files
 */

const bodySchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(127),
  size: z.number().int().positive(),
  // Optionnel : rattachement à un SAV existant du membre.
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

  // Scope check si rattachement à un SAV existant.
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
    // Upload dans un dossier brouillon isolé par membre.
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

export default withAuth({ types: ['member'] })(
  withRateLimit({
    bucketPrefix: 'upload:session',
    keyFrom: (req: ApiRequest) =>
      req.user && req.user.type === 'member' ? `member:${req.user.sub}` : undefined,
    max: 30,
    window: '1m',
  })(coreHandler)
)

export { coreHandler as __coreHandler }
