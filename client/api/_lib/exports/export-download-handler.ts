import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import type { ApiHandler } from '../types'

// CR 5.2 P5 — allowlist hosts OneDrive/Graph avant 302. Défense-en-
// profondeur : si un flux admin future insère un `supplier_exports.web_url`
// malformé ou compromis, l'endpoint ne doit pas devenir un open redirect
// vers un domaine attaquant. Mirror le pattern Story 2.4 upload-complete.
const TRUSTED_WEBURL_HOSTS: RegExp[] = [
  /\.sharepoint\.com$/i,
  /\.sharepoint\.us$/i,
  /(^|\.)graph\.microsoft\.com$/i,
  /(^|\.)onedrive\.live\.com$/i,
  /\.files\.onedrive\.com$/i,
]

function isTrustedOneDriveUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    const host = parsed.hostname
    return TRUSTED_WEBURL_HOSTS.some((re) => re.test(host))
  } catch {
    return false
  }
}

/**
 * Story 5.2 AC #8 — `GET /api/exports/supplier/:id/download`.
 *
 * Renvoie un 302 redirect vers le `web_url` OneDrive — aucun stream
 * binaire côté serveur (décharge Vercel, pattern Epic 4.4 credit-notes PDF).
 */

export function exportDownloadHandler(idInput: string): ApiHandler {
  return async (req, res) => {
    const requestId = ensureRequestId(req)
    const user = req.user
    if (!user || user.type !== 'operator') {
      sendError(res, 'FORBIDDEN', 'Session opérateur requise', requestId)
      return
    }

    const trimmed = idInput.trim()
    if (!/^\d{1,15}$/.test(trimmed)) {
      sendError(res, 'VALIDATION_FAILED', 'ID export invalide', requestId, {
        code: 'INVALID_EXPORT_ID',
      })
      return
    }
    const id = Number(trimmed)
    if (!Number.isInteger(id) || id <= 0) {
      sendError(res, 'VALIDATION_FAILED', 'ID export invalide', requestId, {
        code: 'INVALID_EXPORT_ID',
      })
      return
    }

    const admin = supabaseAdmin()
    const { data, error } = await admin
      .from('supplier_exports')
      .select('id, web_url, file_name')
      .eq('id', id)
      .limit(1)
      .maybeSingle<{ id: number; web_url: string | null; file_name: string }>()
    if (error) {
      logger.error('export.download.query_failed', {
        requestId,
        exportId: id,
        message: error.message,
      })
      sendError(res, 'SERVER_ERROR', 'Lecture export échouée', requestId, {
        code: 'DOWNLOAD_QUERY_FAILED',
      })
      return
    }
    if (data === null) {
      sendError(res, 'NOT_FOUND', 'Export introuvable', requestId, {
        code: 'EXPORT_NOT_FOUND',
      })
      return
    }
    if (data.web_url === null || data.web_url.length === 0) {
      logger.warn('export.download.file_unavailable', {
        requestId,
        exportId: id,
        fileName: data.file_name,
      })
      sendError(res, 'NOT_FOUND', 'Fichier indisponible', requestId, {
        code: 'EXPORT_FILE_UNAVAILABLE',
      })
      return
    }
    // CR 5.2 P5 — host allowlist avant 302 (anti open-redirect).
    if (!isTrustedOneDriveUrl(data.web_url)) {
      logger.warn('export.download.untrusted_url', {
        requestId,
        exportId: id,
        prefix: data.web_url.slice(0, 64),
      })
      sendError(res, 'NOT_FOUND', 'Fichier indisponible', requestId, {
        code: 'EXPORT_FILE_UNAVAILABLE',
      })
      return
    }

    res.setHeader('Location', data.web_url)
    res.status(302).end()
  }
}
