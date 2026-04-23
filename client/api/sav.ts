import { withAuth } from './_lib/middleware/with-auth'
import { ensureRequestId } from './_lib/request-id'
import { sendError } from './_lib/errors'
import { listSavHandler } from './_lib/sav/list-handler'
import { savDetailHandler } from './_lib/sav/detail-handler'
import { savStatusHandler, savAssignHandler } from './_lib/sav/transition-handlers'
import { savLineEditHandler } from './_lib/sav/line-edit-handler'
import {
  savTagsHandler,
  savCommentsPostHandler,
  savDuplicateHandler,
} from './_lib/sav/productivity-handlers'
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
function parseSavId(req: ApiRequest): number | null {
  const raw = (req.query as Record<string, unknown> | undefined)?.['id']
  if (raw === undefined || raw === null) return null
  const str = Array.isArray(raw) ? String(raw[0]) : String(raw)
  if (!/^\d+$/.test(str)) return null
  const n = Number(str)
  return Number.isInteger(n) && n > 0 ? n : null
}

function parseLineId(req: ApiRequest): number | null {
  const raw = (req.query as Record<string, unknown> | undefined)?.['lineId']
  if (raw === undefined || raw === null) return null
  const str = Array.isArray(raw) ? String(raw[0]) : String(raw)
  if (!/^\d+$/.test(str)) return null
  const n = Number(str)
  return Number.isInteger(n) && n > 0 ? n : null
}

function parseOp(req: ApiRequest): string {
  const raw = (req.query as Record<string, unknown> | undefined)?.['op']
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0]
  return 'list' // défaut si /api/sav sans rewrite
}

const dispatch: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  const method = (req.method ?? 'GET').toUpperCase()

  // Lecture des params de routing AVANT cleanup — sinon parseSavId retourne null.
  const op = parseOp(req)
  const savId = parseSavId(req)
  const lineId = parseLineId(req)

  // Nettoyage : le router ne doit pas polluer `req.query` des handlers avec
  // nos params de routing.
  if (req.query && typeof req.query === 'object') {
    const q = req.query as Record<string, unknown>
    delete q['op']
    delete q['id']
    delete q['lineId']
  }

  // op=list → GET /api/sav
  if (op === 'list') {
    if (method !== 'GET') {
      res.setHeader('Allow', 'GET')
      sendError(res, 'VALIDATION_FAILED', 'Méthode non supportée', requestId)
      return
    }
    return listSavHandler(req, res)
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
      sendError(res, 'VALIDATION_FAILED', 'Méthode non supportée', requestId)
      return
    }
    return savDetailHandler(savId)(req, res)
  }

  if (op === 'status') {
    if (method !== 'PATCH') {
      res.setHeader('Allow', 'PATCH')
      sendError(res, 'VALIDATION_FAILED', 'Méthode non supportée', requestId)
      return
    }
    return savStatusHandler(savId)(req, res)
  }

  if (op === 'assign') {
    if (method !== 'PATCH') {
      res.setHeader('Allow', 'PATCH')
      sendError(res, 'VALIDATION_FAILED', 'Méthode non supportée', requestId)
      return
    }
    return savAssignHandler(savId)(req, res)
  }

  if (op === 'line') {
    if (lineId === null) {
      sendError(res, 'VALIDATION_FAILED', 'ID ligne invalide ou manquant', requestId)
      return
    }
    if (method !== 'PATCH') {
      res.setHeader('Allow', 'PATCH')
      sendError(res, 'VALIDATION_FAILED', 'Méthode non supportée', requestId)
      return
    }
    return savLineEditHandler(savId, lineId)(req, res)
  }

  if (op === 'tags') {
    if (method !== 'PATCH') {
      res.setHeader('Allow', 'PATCH')
      sendError(res, 'VALIDATION_FAILED', 'Méthode non supportée', requestId)
      return
    }
    return savTagsHandler(savId)(req, res)
  }

  if (op === 'comments') {
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST')
      sendError(res, 'VALIDATION_FAILED', 'Méthode non supportée', requestId)
      return
    }
    return savCommentsPostHandler(savId)(req, res)
  }

  if (op === 'duplicate') {
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST')
      sendError(res, 'VALIDATION_FAILED', 'Méthode non supportée', requestId)
      return
    }
    return savDuplicateHandler(savId)(req, res)
  }

  sendError(res, 'NOT_FOUND', 'Route non disponible', requestId)
}

const router: ApiHandler = withAuth({ types: ['operator'] })(dispatch)

export default router
