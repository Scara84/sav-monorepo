/**
 * UAT V1.8 deferred — extension PATTERN-V5 (Story V1.5).
 * Handler `GET /api/sav/files/:id/download` — backend proxy Graph API
 * pour le **contenu complet** d'un fichier SAV (image full-size, PDF, autre).
 *
 * Différences vs file-thumbnail-handler :
 *   - URL Graph : `/items/{id}/content` (PAS `/thumbnails/0/medium/content`)
 *   - Content-Type : passe-thru `mime_type` stocké en DB (autorité = upload)
 *   - Cache-Control : `private, max-age=60` (60s vs 300s thumbnail — un download
 *     se reclique rarement)
 *   - MAX_BYTES : 25 MB (vs 5 MB thumbnail — couvre photos full + PDF)
 *   - Pas de filtrage `image/*` : tous les types uploadés (image, PDF, doc) OK
 *   - `Content-Disposition: inline` pour permettre le rendu inline dans le browser
 *     (cohérent attente "Ouvrir" : photo/PDF s'ouvre dans nouvel onglet sans download)
 *
 * Mêmes garde-fous que thumbnail :
 *   - RBAC scopée groupe (operator non-admin → check operator_groups)
 *   - 401 retry via forceRefreshAccessToken (Story 4.5 W35)
 *   - Token leak défense : pas de log Bearer/JWT
 *   - DoS : timeout 5s + content-length cap + runtime byte counter
 */

import { ensureRequestId } from '../request-id'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { readCookie, verifyJwt } from '../middleware/with-auth'
import type { ApiHandler, ApiRequest, ApiResponse, SessionUser } from '../types'
import * as graphModule from '../graph.js'

function sendJson(
  res: ApiResponse,
  status: number,
  code: string,
  message: string,
  requestId: string
): void {
  res.status(status).json({ error: { code, message, requestId } })
}

function sanitizeForLog(value: unknown): string {
  let str = value instanceof Error ? (value.message ?? '') : String(value)
  str = str.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
  str = str.replace(/eyJ[A-Za-z0-9._-]+/g, '[JWT_REDACTED]')
  return str
}

/**
 * RFC 5987 — encoder un filename pour Content-Disposition. On strippe les
 * caractères de contrôle, on échappe les guillemets et on plafonne à 200 chars.
 * Le filename* (UTF-8) est servi en parallèle pour les browsers modernes.
 */
function encodeContentDisposition(filename: string): string {
  const safe = filename
    .replace(/[\r\n"\\]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '_')
    .slice(0, 200)
  const encoded = encodeURIComponent(filename).replace(/['()]/g, escape).slice(0, 400)
  return `inline; filename="${safe}"; filename*=UTF-8''${encoded}`
}

interface SavFileRow {
  id: number
  onedrive_item_id: string
  web_url: string | null
  mime_type: string
  original_filename: string
  sav_id: number
  sav: { group_id: number | null } | null
}

interface GraphModule {
  getAccessToken: () => Promise<string>
  forceRefreshAccessToken: () => Promise<string>
}

const MAX_BYTES = 25 * 1024 * 1024 // 25 MB
const FETCH_TIMEOUT_MS = 8000

export function fileDownloadHandler(fileId: number): ApiHandler {
  return async (req: ApiRequest, res: ApiResponse): Promise<void> => {
    const requestId = ensureRequestId(req)

    if (!Number.isInteger(fileId) || fileId <= 0) {
      sendJson(res, 400, 'VALIDATION_FAILED', 'fileId invalide', requestId)
      return
    }

    const admin = supabaseAdmin()
    const { data: fileRow, error: fileError } = await admin
      .from('sav_files')
      .select(
        'id, onedrive_item_id, web_url, mime_type, original_filename, sav_id, sav:sav(group_id)'
      )
      .eq('id', fileId)
      .maybeSingle()

    if (fileError) {
      logger.error('sav.file.download.db_error', {
        requestId,
        fileId,
        message: fileError.message,
      })
      sendJson(res, 500, 'SERVER_ERROR', 'Erreur lecture fichier', requestId)
      return
    }

    if (!fileRow) {
      sendJson(res, 404, 'NOT_FOUND', 'Fichier introuvable', requestId)
      return
    }

    const row = fileRow as unknown as SavFileRow

    // RBAC — fallback cookie parse pour appels directs (tests).
    let user: SessionUser | undefined = req.user
    if (!user) {
      const secret = process.env['SESSION_COOKIE_SECRET']
      if (!secret) {
        sendJson(res, 401, 'UNAUTHENTICATED', 'Session requise', requestId)
        return
      }
      const token = readCookie(req, 'sav_session')
      if (!token) {
        sendJson(res, 401, 'UNAUTHENTICATED', 'Session requise', requestId)
        return
      }
      const verified = verifyJwt(token, secret)
      if (!verified) {
        sendJson(res, 401, 'UNAUTHENTICATED', 'Session invalide ou expirée', requestId)
        return
      }
      const now = Math.floor(Date.now() / 1000)
      if (verified.exp <= now) {
        sendJson(res, 401, 'UNAUTHENTICATED', 'Session expirée', requestId)
        return
      }
      user = verified
    }
    if (user.type !== 'operator') {
      sendJson(res, 403, 'FORBIDDEN', 'Session opérateur requise', requestId)
      return
    }

    const isAdmin = user.role === 'admin'
    if (!isAdmin) {
      const groupId = row.sav?.group_id ?? null
      if (groupId !== null) {
        const { data: operatorGroups, error: groupError } = await admin
          .from('operator_groups')
          .select('group_id')
          .eq('operator_id', user.sub)
          .eq('group_id', groupId)

        if (groupError) {
          logger.error('sav.file.download.group_check_error', {
            requestId,
            fileId,
            message: groupError.message,
          })
          sendJson(res, 500, 'SERVER_ERROR', 'Erreur vérification accès', requestId)
          return
        }

        if (!operatorGroups || operatorGroups.length === 0) {
          logger.warn('sav.file.download.cross_group_blocked', {
            requestId,
            fileId,
            operatorId: user.sub,
            groupId,
          })
          sendJson(res, 403, 'FORBIDDEN', 'Accès interdit (groupe non autorisé)', requestId)
          return
        }
      }
    }

    const driveId = process.env['MICROSOFT_DRIVE_ID']
    if (!driveId) {
      logger.error('sav.file.download.missing_drive_id', { requestId, fileId })
      sendJson(res, 500, 'SERVER_ERROR', 'Configuration Microsoft Drive manquante', requestId)
      return
    }

    const graph = graphModule as unknown as GraphModule
    let token: string
    try {
      token = await graph.getAccessToken()
    } catch (err) {
      logger.error('sav.file.download.token_error', {
        requestId,
        fileId,
        message: sanitizeForLog(err),
      })
      sendJson(
        res,
        503,
        'GRAPH_UNAVAILABLE',
        'Service de téléchargement temporairement indisponible',
        requestId
      )
      return
    }

    // Cohérent thumbnail : prefer /shares/u!{base64url(webUrl)}/driveItem/content
    // (capture flow stocke parfois filename comme onedrive_item_id, bug data 5-7).
    let graphUrl: string
    if (row.web_url && row.web_url.length > 0) {
      const base64Url = Buffer.from(row.web_url, 'utf-8')
        .toString('base64')
        .replace(/=+$/, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
      graphUrl = `https://graph.microsoft.com/v1.0/shares/u!${base64Url}/driveItem/content`
    } else {
      graphUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${row.onedrive_item_id}/content`
    }

    const fetchGraph = async (bearer: string): Promise<Response> => {
      return fetch(graphUrl, {
        headers: { Authorization: `Bearer ${bearer}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'follow',
      })
    }

    let graphResponse: Response
    try {
      graphResponse = await fetchGraph(token)
    } catch (err) {
      const isAbort =
        err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
      logger.warn('sav.file.download.graph_unavailable', {
        requestId,
        fileId,
        reason: isAbort ? 'timeout' : 'fetch_error',
        message: sanitizeForLog(err),
      })
      sendJson(
        res,
        503,
        'GRAPH_UNAVAILABLE',
        'Service de téléchargement temporairement indisponible',
        requestId
      )
      return
    }

    // 401 → refresh + 1 retry (Story 4.5 W35).
    if (graphResponse.status === 401) {
      try {
        token = await graph.forceRefreshAccessToken()
      } catch (err) {
        logger.warn('sav.file.download.graph_unavailable', {
          requestId,
          fileId,
          status: 401,
          reason: 'token_refresh_failed',
          message: sanitizeForLog(err),
        })
        sendJson(
          res,
          503,
          'GRAPH_UNAVAILABLE',
          'Service de téléchargement temporairement indisponible',
          requestId
        )
        return
      }
      try {
        graphResponse = await fetchGraph(token)
      } catch (err) {
        logger.warn('sav.file.download.graph_unavailable', {
          requestId,
          fileId,
          reason: 'retry_fetch_error',
          message: sanitizeForLog(err),
        })
        sendJson(
          res,
          503,
          'GRAPH_UNAVAILABLE',
          'Service de téléchargement temporairement indisponible',
          requestId
        )
        return
      }
      if (graphResponse.status === 401) {
        logger.warn('sav.file.download.graph_unavailable', {
          requestId,
          fileId,
          status: 401,
          reason: 'retry_still_401',
        })
        sendJson(
          res,
          503,
          'GRAPH_UNAVAILABLE',
          'Service de téléchargement temporairement indisponible',
          requestId
        )
        return
      }
    }

    if (!graphResponse.ok) {
      logger.warn('sav.file.download.graph_unavailable', {
        requestId,
        fileId,
        status: graphResponse.status,
      })
      sendJson(
        res,
        503,
        'GRAPH_UNAVAILABLE',
        'Service de téléchargement temporairement indisponible',
        requestId
      )
      return
    }

    const contentLengthHeader = graphResponse.headers.get('content-length')
    if (contentLengthHeader !== null) {
      const contentLength = parseInt(contentLengthHeader, 10)
      if (!isNaN(contentLength) && contentLength > MAX_BYTES) {
        logger.warn('sav.file.download.content_too_large', {
          requestId,
          fileId,
          contentLength,
        })
        sendJson(res, 502, 'BAD_GATEWAY', 'Fichier trop volumineux', requestId)
        return
      }
    }

    // Pass-thru du mime_type DB (autorité d'upload, pas de surprise).
    // Whitelist défensive : si la valeur DB n'est pas un mime_type plausible,
    // on retombe sur application/octet-stream pour ne pas exécuter du HTML servi
    // par accident depuis SharePoint.
    const safeMime = /^[a-z]+\/[a-z0-9.+-]+$/i.test(row.mime_type)
      ? row.mime_type
      : 'application/octet-stream'

    res.setHeader('Content-Type', safeMime)
    res.setHeader('Cache-Control', 'private, max-age=60')
    res.setHeader('X-Request-Id', requestId)
    res.setHeader('Content-Disposition', encodeContentDisposition(row.original_filename))

    const nodeRes = res as unknown as {
      statusCode: number
      write: (chunk: Buffer | string) => boolean
      end: (chunk?: string | Buffer) => void
    }
    nodeRes.statusCode = 200

    if (!graphResponse.body) {
      nodeRes.end()
      return
    }

    const reader = graphResponse.body.getReader()
    let bytesWritten = 0
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          bytesWritten += value.byteLength
          if (bytesWritten > MAX_BYTES) {
            await reader.cancel()
            nodeRes.end()
            logger.warn('sav.file.download.runtime_size_exceeded', {
              requestId,
              fileId,
              bytesWritten,
            })
            return
          }
          nodeRes.write(Buffer.from(value))
        }
      }
      nodeRes.end()
    } catch (err) {
      logger.warn('sav.file.download.stream_error', {
        requestId,
        fileId,
        message: sanitizeForLog(err),
      })
      nodeRes.end()
    } finally {
      reader.releaseLock()
    }
  }
}
