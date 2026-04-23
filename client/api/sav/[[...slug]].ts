import { withAuth } from '../_lib/middleware/with-auth'
import { ensureRequestId } from '../_lib/request-id'
import { sendError } from '../_lib/errors'
import { listSavHandler } from '../_lib/sav/list-handler'
import { savDetailHandler } from '../_lib/sav/detail-handler'
import { savStatusHandler, savAssignHandler } from '../_lib/sav/transition-handlers'
import { savLineEditHandler } from '../_lib/sav/line-edit-handler'
import {
  savTagsHandler,
  savCommentsPostHandler,
  savDuplicateHandler,
} from '../_lib/sav/productivity-handlers'
import type { ApiHandler, ApiRequest, ApiResponse } from '../_lib/types'

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
 * Normalise Vercel's `req.query.slug` (catch-all param) en tableau stable.
 * `/api/sav` → slug = undefined → []
 * `/api/sav/42` → slug = '42' → ['42']
 * `/api/sav/42/status` → slug = ['42','status'] → ['42','status']
 */
function parseSlug(req: ApiRequest): string[] {
  const raw = (req.query as Record<string, unknown> | undefined)?.['slug']
  if (raw === undefined || raw === null) return []
  if (Array.isArray(raw)) return raw.map(String)
  return [String(raw)]
}

const dispatch: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  const method = (req.method ?? 'GET').toUpperCase()
  const slug = parseSlug(req)

  // Nettoyage : le router ne doit pas polluer `req.query` des handlers.
  // On conserve slug ailleurs si besoin ; pour list.ts la query est pure.
  if (req.query && typeof req.query === 'object') {
    const q = req.query as Record<string, unknown>
    delete q['slug']
  }

  // Route dispatch
  if (slug.length === 0) {
    if (method === 'GET') {
      return listSavHandler(req, res)
    }
    res.setHeader('Allow', 'GET')
    sendError(res, 'VALIDATION_FAILED', 'Méthode non supportée', requestId)
    return
  }

  // /api/sav/:id (détail — Story 3.4)
  if (slug.length === 1) {
    const idRaw = slug[0]!
    if (!/^\d+$/.test(idRaw)) {
      sendError(res, 'VALIDATION_FAILED', 'ID SAV invalide', requestId, [
        { field: 'id', message: 'Entier positif attendu' },
      ])
      return
    }
    const savId = Number(idRaw)
    if (!Number.isInteger(savId) || savId <= 0) {
      sendError(res, 'VALIDATION_FAILED', 'ID SAV invalide', requestId)
      return
    }
    if (method === 'GET') {
      return savDetailHandler(savId)(req, res)
    }
    res.setHeader('Allow', 'GET')
    sendError(res, 'VALIDATION_FAILED', 'Méthode non supportée', requestId)
    return
  }

  // /api/sav/:id/status — Story 3.5
  if (slug.length === 2 && slug[1] === 'status') {
    const idRaw = slug[0]!
    if (!/^\d+$/.test(idRaw)) {
      sendError(res, 'VALIDATION_FAILED', 'ID SAV invalide', requestId)
      return
    }
    const savId = Number(idRaw)
    if (method !== 'PATCH') {
      res.setHeader('Allow', 'PATCH')
      sendError(res, 'VALIDATION_FAILED', 'Méthode non supportée', requestId)
      return
    }
    return savStatusHandler(savId)(req, res)
  }

  // /api/sav/:id/assign — Story 3.5
  if (slug.length === 2 && slug[1] === 'assign') {
    const idRaw = slug[0]!
    if (!/^\d+$/.test(idRaw)) {
      sendError(res, 'VALIDATION_FAILED', 'ID SAV invalide', requestId)
      return
    }
    const savId = Number(idRaw)
    if (method !== 'PATCH') {
      res.setHeader('Allow', 'PATCH')
      sendError(res, 'VALIDATION_FAILED', 'Méthode non supportée', requestId)
      return
    }
    return savAssignHandler(savId)(req, res)
  }

  // /api/sav/:id/lines/:lineId — Story 3.6
  if (slug.length === 3 && slug[1] === 'lines') {
    const idRaw = slug[0]!
    const lineIdRaw = slug[2]!
    if (!/^\d+$/.test(idRaw) || !/^\d+$/.test(lineIdRaw)) {
      sendError(res, 'VALIDATION_FAILED', 'ID SAV ou ligne invalide', requestId)
      return
    }
    const savId = Number(idRaw)
    const lineId = Number(lineIdRaw)
    if (method !== 'PATCH') {
      res.setHeader('Allow', 'PATCH')
      sendError(res, 'VALIDATION_FAILED', 'Méthode non supportée', requestId)
      return
    }
    return savLineEditHandler(savId, lineId)(req, res)
  }

  // /api/sav/:id/tags — Story 3.7
  if (slug.length === 2 && slug[1] === 'tags') {
    const idRaw = slug[0]!
    if (!/^\d+$/.test(idRaw)) {
      sendError(res, 'VALIDATION_FAILED', 'ID SAV invalide', requestId)
      return
    }
    const savId = Number(idRaw)
    if (method !== 'PATCH') {
      res.setHeader('Allow', 'PATCH')
      sendError(res, 'VALIDATION_FAILED', 'Méthode non supportée', requestId)
      return
    }
    return savTagsHandler(savId)(req, res)
  }

  // /api/sav/:id/comments — Story 3.7 (POST uniquement V1)
  if (slug.length === 2 && slug[1] === 'comments') {
    const idRaw = slug[0]!
    if (!/^\d+$/.test(idRaw)) {
      sendError(res, 'VALIDATION_FAILED', 'ID SAV invalide', requestId)
      return
    }
    const savId = Number(idRaw)
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST')
      sendError(res, 'VALIDATION_FAILED', 'Méthode non supportée', requestId)
      return
    }
    return savCommentsPostHandler(savId)(req, res)
  }

  // /api/sav/:id/duplicate — Story 3.7
  if (slug.length === 2 && slug[1] === 'duplicate') {
    const idRaw = slug[0]!
    if (!/^\d+$/.test(idRaw)) {
      sendError(res, 'VALIDATION_FAILED', 'ID SAV invalide', requestId)
      return
    }
    const sourceSavId = Number(idRaw)
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST')
      sendError(res, 'VALIDATION_FAILED', 'Méthode non supportée', requestId)
      return
    }
    return savDuplicateHandler(sourceSavId)(req, res)
  }

  sendError(res, 'NOT_FOUND', 'Route non disponible', requestId)
}

const router: ApiHandler = withAuth({ types: ['operator'] })(dispatch)

export default router
