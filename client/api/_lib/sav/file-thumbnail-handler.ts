/**
 * Story V1.5 — AC #1, #2, #4, #5
 * Handler `GET /api/sav/files/:id/thumbnail` — backend proxy Graph API thumbnails.
 *
 * PATTERN-V5 : tout asset OneDrive consommé en <img> passe par ce proxy qui :
 *   1. Autorise via session opérateur + RBAC scopée groupe
 *   2. Re-fetch via Graph API avec token applicatif Bearer
 *   3. Stream effectif (PAS redirect 302) avec Content-Type: image/jpeg forcé
 *      + Cache-Control: private, max-age=300
 *
 * Précédents :
 *   - ESM import graph.js — interceptable par Vitest vi.mock() (Story V1.5 fix)
 *   - RBAC scopée groupe — Story 7-3a/b/c + savDetailHandler pattern
 *   - forceRefreshAccessToken W35 — Story 4.5
 *   - Readable.fromWeb() — Node 18+ (confirmé OQ-1)
 *   - role 'admin' uniquement pour bypass cross-group (OQ-2 : 'sav-operator-admin' absent de types.ts)
 */

import { ensureRequestId } from '../request-id'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { readCookie, verifyJwt } from '../middleware/with-auth'
import type { ApiHandler, ApiRequest, ApiResponse, SessionUser } from '../types'
// ESM import allows Vitest vi.mock() to intercept this module in tests.
// In production (Vercel Node.js), this is a regular ESM->CJS interop import.
import * as graphModule from '../graph.js'

// ---------------------------------------------------------------------------
// Error helpers (inline pour éviter l'import de sendError qui ne couvre pas
// les codes non-standard GRAPH_UNAVAILABLE, NOT_AN_IMAGE, BAD_GATEWAY)
// ---------------------------------------------------------------------------

function sendJson(
  res: ApiResponse,
  status: number,
  code: string,
  message: string,
  requestId: string
): void {
  res.status(status).json({ error: { code, message, requestId } })
}

// ---------------------------------------------------------------------------
// Security: sanitize error messages before logging to prevent token leaks
// Strips Bearer tokens and JWT-like patterns from error messages / strings.
// ---------------------------------------------------------------------------

function sanitizeForLog(value: unknown): string {
  let str = value instanceof Error ? (value.message ?? '') : String(value)
  // Strip Bearer tokens (e.g. "Bearer eyJabc.def.ghi")
  str = str.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
  // Strip JWT-like patterns (eyJxxx.yyy.zzz) — standalone JWT values
  str = str.replace(/eyJ[A-Za-z0-9._-]+/g, '[JWT_REDACTED]')
  return str
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SavFileRow {
  id: number
  onedrive_item_id: string
  web_url: string | null
  mime_type: string
  sav_id: number
  sav: { group_id: number | null } | null
}

interface GraphModule {
  getAccessToken: () => Promise<string>
  forceRefreshAccessToken: () => Promise<string>
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * `fileThumbnailHandler(fileId)` retourne un ApiHandler.
 *
 * Le `fileId` est fourni par le router après `parseBigintId()`.
 * Validation défensive : si fileId est invalide (NaN, <= 0, non-entier) → 400.
 */
export function fileThumbnailHandler(fileId: number): ApiHandler {
  return async (req: ApiRequest, res: ApiResponse): Promise<void> => {
    const requestId = ensureRequestId(req)

    // ── Step a: Validate fileId ──────────────────────────────────────────────
    // Defense-in-depth: router calls parseBigintId() before passing fileId here,
    // but we validate again in case of test/direct invocation with invalid values.
    if (!Number.isInteger(fileId) || fileId <= 0) {
      sendJson(res, 400, 'VALIDATION_FAILED', 'fileId invalide', requestId)
      return
    }

    // ── Step b: Fetch sav_files row (with sav.group_id join) ─────────────────
    const admin = supabaseAdmin()
    const { data: fileRow, error: fileError } = await admin
      .from('sav_files')
      .select('id, onedrive_item_id, web_url, mime_type, sav_id, sav:sav(group_id)')
      .eq('id', fileId)
      .maybeSingle()

    if (fileError) {
      logger.error('sav.file.thumbnail.db_error', { requestId, fileId, message: fileError.message })
      sendJson(res, 500, 'SERVER_ERROR', 'Erreur lecture fichier', requestId)
      return
    }

    if (!fileRow) {
      sendJson(res, 404, 'NOT_FOUND', 'Fichier introuvable', requestId)
      return
    }

    const row = fileRow as unknown as SavFileRow

    // ── Step c: Validate mime_type ───────────────────────────────────────────
    if (!row.mime_type || !row.mime_type.startsWith('image/')) {
      sendJson(res, 400, 'NOT_AN_IMAGE', "Ce fichier n'est pas une image", requestId)
      return
    }

    // ── Step d: RBAC — scopée groupe ─────────────────────────────────────────
    // req.user is set by withAuth at router level (production path).
    // Fallback: parse cookie directly (test path where handler is called directly).
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

    // OQ-2: 'sav-operator-admin' does not exist in SessionUser['role'] types.ts
    // Using 'admin' ONLY for bypass cross-group, per OQ-2 resolution.
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
          logger.error('sav.file.thumbnail.group_check_error', {
            requestId,
            fileId,
            message: groupError.message,
          })
          sendJson(res, 500, 'SERVER_ERROR', 'Erreur vérification accès', requestId)
          return
        }

        if (!operatorGroups || operatorGroups.length === 0) {
          // DN-2=B: warn logger only (no audit_trail row)
          logger.warn('sav.file.thumbnail.cross_group_blocked', {
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

    // ── Step e: Read MICROSOFT_DRIVE_ID ──────────────────────────────────────
    const driveId = process.env['MICROSOFT_DRIVE_ID']
    if (!driveId) {
      logger.error('sav.file.thumbnail.missing_drive_id', { requestId, fileId })
      sendJson(res, 500, 'SERVER_ERROR', 'Configuration Microsoft Drive manquante', requestId)
      return
    }

    const onedriveItemId = row.onedrive_item_id
    const webUrl = row.web_url

    // ── Step f: Get access token via ESM-imported graph module ────────────────
    // graphModule is imported at module-level (ESM), allowing Vitest vi.mock()
    // to intercept it. In production, Node ESM->CJS interop loads the real module.
    const graph = graphModule as unknown as GraphModule
    let token: string
    try {
      token = await graph.getAccessToken()
    } catch (err) {
      logger.error('sav.file.thumbnail.token_error', {
        requestId,
        fileId,
        message: sanitizeForLog(err),
      })
      sendJson(
        res,
        503,
        'GRAPH_UNAVAILABLE',
        'Service de vignettes temporairement indisponible',
        requestId
      )
      return
    }

    // ── Step g: Build Graph URL ───────────────────────────────────────────────
    // PATTERN-V5 — Resolve via /shares/u!{base64url(webUrl)}/driveItem when web_url
    // is available (capture flow legacy stockait filename comme onedrive_item_id —
    // bug data Story 5-7 ; webUrl est canonique). Fallback /drives/.../items/...
    // pour rétro-compat (Story 4.5 PDFs où onedrive_item_id est un vrai Graph ID).
    let graphUrl: string
    if (webUrl && webUrl.length > 0) {
      const base64Url = Buffer.from(webUrl, 'utf-8')
        .toString('base64')
        .replace(/=+$/, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
      const shareId = `u!${base64Url}`
      graphUrl = `https://graph.microsoft.com/v1.0/shares/${shareId}/driveItem/thumbnails/0/medium/content`
    } else {
      graphUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${onedriveItemId}/thumbnails/0/medium/content`
    }

    // ── Step h/i: Fetch Graph (with AbortController timeout 5s) ──────────────
    let graphResponse: Response
    try {
      graphResponse = await fetch(graphUrl, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
        redirect: 'follow',
      })
    } catch (err) {
      const isAbort =
        err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
      logger.warn('sav.file.thumbnail.graph_unavailable', {
        requestId,
        fileId,
        reason: isAbort ? 'timeout' : 'fetch_error',
        message: sanitizeForLog(err),
      })
      sendJson(
        res,
        503,
        'GRAPH_UNAVAILABLE',
        'Service de vignettes temporairement indisponible',
        requestId
      )
      return
    }

    // ── Step j: Handle 401 → forceRefreshAccessToken + 1 retry (W35) ─────────
    if (graphResponse.status === 401) {
      try {
        token = await graph.forceRefreshAccessToken()
      } catch (err) {
        logger.warn('sav.file.thumbnail.graph_unavailable', {
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
          'Service de vignettes temporairement indisponible',
          requestId
        )
        return
      }

      // Retry with refreshed token
      try {
        graphResponse = await fetch(graphUrl, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
          redirect: 'follow',
        })
      } catch (err) {
        logger.warn('sav.file.thumbnail.graph_unavailable', {
          requestId,
          fileId,
          reason: 'retry_fetch_error',
        })
        sendJson(
          res,
          503,
          'GRAPH_UNAVAILABLE',
          'Service de vignettes temporairement indisponible',
          requestId
        )
        return
      }

      if (graphResponse.status === 401) {
        logger.warn('sav.file.thumbnail.graph_unavailable', {
          requestId,
          fileId,
          status: 401,
          reason: 'retry_still_401',
        })
        sendJson(
          res,
          503,
          'GRAPH_UNAVAILABLE',
          'Service de vignettes temporairement indisponible',
          requestId
        )
        return
      }
    }

    // ── Step k: Handle Graph error responses (5xx, other non-ok) ─────────────
    if (!graphResponse.ok) {
      // V1.5 DEBUG (temporaire) : capturer body Graph pour diagnostic preview
      let graphBody = ''
      try {
        graphBody = (await graphResponse.text()).slice(0, 500)
      } catch {
        graphBody = '<read failed>'
      }
      logger.warn('sav.file.thumbnail.graph_unavailable', {
        requestId,
        fileId,
        status: graphResponse.status,
        graphBody,
        graphUrl: graphUrl.slice(0, 200),
      })
      // DEBUG temporaire — expose graphStatus + graphBody dans la response
      res.status(503).json({
        error: {
          code: 'GRAPH_UNAVAILABLE',
          message: 'Service de vignettes temporairement indisponible',
          requestId,
          debug: {
            graphStatus: graphResponse.status,
            graphBody,
            graphUrlPreview: graphUrl.slice(0, 200),
          },
        },
      })
      return
    }

    // ── Step l: Content-Length cap (5 MB) → 502 BAD_GATEWAY ─────────────────
    const MAX_BYTES = 5 * 1024 * 1024 // 5 MB
    const contentLengthHeader = graphResponse.headers.get('content-length')
    if (contentLengthHeader !== null) {
      const contentLength = parseInt(contentLengthHeader, 10)
      if (!isNaN(contentLength) && contentLength > MAX_BYTES) {
        logger.warn('sav.file.thumbnail.content_too_large', {
          requestId,
          fileId,
          contentLength,
        })
        sendJson(res, 502, 'BAD_GATEWAY', 'Vignette trop volumineuse', requestId)
        return
      }
    }

    // ── Step m: Set headers BEFORE streaming (OQ-5 — headers before pipe) ────
    // DN-5=A: force Content-Type: image/jpeg regardless of Graph response
    // Header whitelist: ONLY Content-Type, Cache-Control, X-Request-Id (AC #1.b.7)
    res.setHeader('Content-Type', 'image/jpeg')
    res.setHeader('Cache-Control', 'private, max-age=300')
    res.setHeader('X-Request-Id', requestId)

    // Set statusCode to 200 on the underlying response object
    const nodeRes = res as unknown as {
      statusCode: number
      write: (chunk: Buffer | string) => boolean
      end: (chunk?: string | Buffer) => void
    }
    nodeRes.statusCode = 200

    // ── Step n: Stream response body via ReadableStream reader ───────────────
    // Token leak defense: we NEVER log response body, Authorization header, or token variable.
    // HARDEN-1: Runtime byte counter guards against chunked transfer encoding with
    // no Content-Length header (DoS defense — complements the upfront pre-check step l).
    if (!graphResponse.body) {
      // No body (shouldn't happen on ok response, but defensive)
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
            // Headers already flushed — cannot send a new status code.
            // End the connection so the client receives a truncated (unusable) image.
            nodeRes.end()
            logger.warn('sav.file.thumbnail.runtime_size_exceeded', {
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
      logger.warn('sav.file.thumbnail.stream_error', {
        requestId,
        fileId,
        message: sanitizeForLog(err),
      })
      // Headers already sent at this point — cannot send error response
      nodeRes.end()
    } finally {
      reader.releaseLock()
    }
  }
}
