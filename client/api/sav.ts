import { withAuth } from './_lib/middleware/with-auth'
import { ensureRequestId } from './_lib/request-id'
import { sendError } from './_lib/errors'
import { listSavHandler } from './_lib/sav/list-handler'
import { savDetailHandler } from './_lib/sav/detail-handler'
import { savStatusHandler, savAssignHandler } from './_lib/sav/transition-handlers'
import { savLineEditHandler } from './_lib/sav/line-edit-handler'
import { savLineCreateHandler } from './_lib/sav/line-create-handler'
import { savLineDeleteHandler } from './_lib/sav/line-delete-handler'
import {
  savTagsHandler,
  savCommentsPostHandler,
  savDuplicateHandler,
} from './_lib/sav/productivity-handlers'
import { emitCreditNoteHandler } from './_lib/credit-notes/emit-handler'
import { fileThumbnailHandler } from './_lib/sav/file-thumbnail-handler'
import type { ApiHandler, ApiRequest, ApiResponse } from './_lib/types'

/**
 * Router catch-all pour toutes les routes `/api/sav/*` (Epic 3).
 *
 * Contrainte Vercel : hobby plan capé à 12 Serverless Functions (cf. commit
 * `26f31b7`). Stories 3.2 → 3.7 ajouteraient 5+ endpoints SAV indépendants →
 * dépassement. Solution : un seul catch-all qui dispatche vers des handlers
 * library dans `api/_lib/sav/*` selon `method + slug`.
 *
 * Mapping initial (Story 3.2) :
 *   GET    /api/sav                              → listSavHandler
 *
 * À venir (Stories 3.4 → 3.7) :
 *   GET    /api/sav/:id                          → detailHandler
 *   PATCH  /api/sav/:id/status                   → statusHandler
 *   PATCH  /api/sav/:id/assign                   → assignHandler
 *   PATCH  /api/sav/:id/lines/:lineId            → lineEditHandler
 *   PATCH  /api/sav/:id/tags                     → tagsHandler
 *   POST   /api/sav/:id/comments                 → commentCreateHandler
 *   GET    /api/sav/:id/comments                 → commentListHandler
 *   POST   /api/sav/:id/duplicate                → duplicateHandler
 *   POST   /api/sav/:id/credit-notes             → emitCreditNoteHandler (Story 4.4)
 *
 * `withAuth({ types: ['operator'] })` est posé au niveau router (toutes les
 * routes back-office exigent un opérateur). Les `roles` (admin vs sav-operator)
 * sont vérifiés dans chaque handler si une autorisation plus fine est requise.
 */

/**
 * Dispatching via `req.query.op` + éventuel `req.query.id` + `req.query.lineId`,
 * tous injectés par les rewrites Vercel (cf. vercel.json `rewrites`).
 *
 * Pourquoi pas un catch-all `[...slug].ts` : Vercel file-system routing hors
 * framework Next.js ne détecte pas les dynamic catch-all comme une Serverless
 * Function (testé empiriquement : `lambdaRuntimeStats: nodejs:11` malgré le
 * fichier présent). Seule une URL statique fonctionne → on utilise `api/sav.ts`
 * plat + rewrites qui réécrivent les URLs REST vers ce fichier avec query-params.
 *
 * Mapping rewrites (vercel.json) :
 *   /api/sav                              → /api/sav?op=list
 *   /api/sav/:id                          → /api/sav?op=detail&id=:id
 *   /api/sav/:id/status                   → /api/sav?op=status&id=:id
 *   /api/sav/:id/assign                   → /api/sav?op=assign&id=:id
 *   /api/sav/:id/tags                     → /api/sav?op=tags&id=:id
 *   /api/sav/:id/comments                 → /api/sav?op=comments&id=:id
 *   /api/sav/:id/duplicate                → /api/sav?op=duplicate&id=:id
 *   /api/sav/:id/lines/:lineId            → /api/sav?op=line&id=:id&lineId=:lineId
 */
// F20 (CR Epic 3) : rejet précoce d'un `id` dépassant MAX_SAFE_INTEGER
// (précision JS perdue au-delà). Un bigint DB peut être > 2^53 ; on
// rejette en dessous pour éviter de requêter la mauvaise row.
function parseBigintId(str: string): number | null {
  if (!/^\d+$/.test(str) || str.length > 15) return null
  const n = Number(str)
  if (!Number.isInteger(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER) return null
  return n
}

function parseSavId(req: ApiRequest): number | null {
  const raw = (req.query as Record<string, unknown> | undefined)?.['id']
  if (raw === undefined || raw === null) return null
  const str = Array.isArray(raw) ? String(raw[0]) : String(raw)
  return parseBigintId(str)
}

function parseLineId(req: ApiRequest): number | null {
  const raw = (req.query as Record<string, unknown> | undefined)?.['lineId']
  if (raw === undefined || raw === null) return null
  const str = Array.isArray(raw) ? String(raw[0]) : String(raw)
  return parseBigintId(str)
}

function parseFileId(req: ApiRequest): number | null {
  const raw = (req.query as Record<string, unknown> | undefined)?.['fileId']
  if (raw === undefined || raw === null) return null
  const str = Array.isArray(raw) ? String(raw[0]) : String(raw)
  return parseBigintId(str)
}

// F19/F95 (CR Epic 3) : `op` doit provenir des rewrites vercel.json.
// Absence = requête directe sur /api/sav (list) — autorisée, défaut `list`.
// Une valeur inconnue doit retourner 404 explicite au lieu de silently
// tomber sur `list` (risque : /api/sav/abc/xyz non rewrité retourne la liste).
const ALLOWED_OPS = new Set([
  'list',
  'detail',
  'status',
  'assign',
  'line',
  'tags',
  'comments',
  'duplicate',
  'credit-notes',
  'file-thumbnail',
])

function parseOp(req: ApiRequest): string | null {
  const raw = (req.query as Record<string, unknown> | undefined)?.['op']
  if (typeof raw === 'string') return ALLOWED_OPS.has(raw) ? raw : null
  if (Array.isArray(raw) && typeof raw[0] === 'string')
    return ALLOWED_OPS.has(raw[0]) ? raw[0] : null
  return 'list'
}

const dispatch: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  const method = (req.method ?? 'GET').toUpperCase()

  // Lecture des params de routing AVANT cleanup — sinon parseSavId retourne null.
  const op = parseOp(req)
  if (op === null) {
    // F19/F95 (CR Epic 3) : op inconnu → 404 plutôt que fallback silencieux
    // sur list (qui masquait toute URL mal-rewrite en retour de liste).
    sendError(res, 'NOT_FOUND', 'Route non disponible', requestId)
    return
  }
  const savId = parseSavId(req)
  const lineId = parseLineId(req)
  const fileId = parseFileId(req)

  // Nettoyage : le router ne doit pas polluer `req.query` des handlers avec
  // nos params de routing.
  if (req.query && typeof req.query === 'object') {
    const q = req.query as Record<string, unknown>
    delete q['op']
    delete q['id']
    delete q['lineId']
    delete q['fileId']
  }

  // op=list → GET /api/sav
  if (op === 'list') {
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return listSavHandler(req, res)
  }

  // Story V1.5 — op=file-thumbnail → GET /api/sav/files/:id/thumbnail
  if (op === 'file-thumbnail') {
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    if (fileId === null) {
      sendError(res, 'VALIDATION_FAILED', 'ID fichier invalide ou manquant', requestId)
      return
    }
    return fileThumbnailHandler(fileId)(req, res)
  }

  // Toutes les autres ops exigent un savId valide.
  if (savId === null) {
    sendError(res, 'VALIDATION_FAILED', 'ID SAV invalide ou manquant', requestId, [
      { field: 'id', message: 'Entier positif attendu' },
    ])
    return
  }

  if (op === 'detail') {
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return savDetailHandler(savId)(req, res)
  }

  if (op === 'status') {
    if (method !== 'PATCH') {
      res.setHeader('Allow', 'PATCH')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return savStatusHandler(savId)(req, res)
  }

  if (op === 'assign') {
    if (method !== 'PATCH') {
      res.setHeader('Allow', 'PATCH')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return savAssignHandler(savId)(req, res)
  }

  if (op === 'line') {
    // Story 3.6b — op=line dispatch par méthode HTTP :
    //   POST   (sans lineId)  → create ligne
    //   PATCH  (avec lineId)  → update ligne
    //   DELETE (avec lineId)  → delete ligne
    if (method === 'POST') {
      if (lineId !== null) {
        sendError(res, 'VALIDATION_FAILED', 'POST /lines ne doit pas inclure lineId', requestId)
        return
      }
      return savLineCreateHandler(savId)(req, res)
    }
    if (lineId === null) {
      sendError(res, 'VALIDATION_FAILED', 'ID ligne invalide ou manquant', requestId)
      return
    }
    if (method === 'PATCH') {
      return savLineEditHandler(savId, lineId)(req, res)
    }
    if (method === 'DELETE') {
      return savLineDeleteHandler(savId, lineId)(req, res)
    }
    res.setHeader('Allow', 'PATCH, DELETE, POST')
    sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
    return
  }

  if (op === 'tags') {
    if (method !== 'PATCH') {
      res.setHeader('Allow', 'PATCH')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return savTagsHandler(savId)(req, res)
  }

  if (op === 'comments') {
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return savCommentsPostHandler(savId)(req, res)
  }

  if (op === 'duplicate') {
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return savDuplicateHandler(savId)(req, res)
  }

  // Story 4.4 — POST /api/sav/:id/credit-notes
  if (op === 'credit-notes') {
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return emitCreditNoteHandler(savId)(req, res)
  }

  sendError(res, 'NOT_FOUND', 'Route non disponible', requestId)
}

const router: ApiHandler = withAuth({ types: ['operator'] })(dispatch)

export default router
