import { z } from 'zod'
import { withAuth } from '../_lib/middleware/with-auth'
import { withRateLimit } from '../_lib/middleware/with-rate-limit'
import { ensureRequestId } from '../_lib/request-id'
import { sendError } from '../_lib/errors'
import { logger } from '../_lib/logger'
import { supabaseAdmin } from '../_lib/clients/supabase-admin'
import { formatErrors } from '../_lib/middleware/with-validation'
import { uploadSessionHandler } from '../_lib/self-service/upload-session-handler'
import { uploadCompleteHandler } from '../_lib/self-service/upload-complete-handler'
import type { ApiHandler, ApiRequest } from '../_lib/types'

/**
 * Router self-service — Story 2.3 (draft) + Story 2.4 (upload session/complete)
 * consolidés Story 5.2 AC #2.
 *
 * Contrainte Vercel Hobby : cap 12 Serverless Functions atteint post Epic 4.
 * Pour libérer 1 slot et permettre Epic 5 (`api/pilotage.ts`), on consolide
 * les 3 endpoints self-service sous ce fichier unique :
 *
 *   GET  /api/self-service/draft                     → op absent → draft read
 *   PUT  /api/self-service/draft                     → op absent → draft save
 *   POST /api/self-service/upload-session            → op=upload-session
 *   POST /api/self-service/upload-complete           → op=upload-complete
 *
 * Les rewrites Vercel (vercel.json) mappent les URLs REST avec le bon
 * `?op=...`. Les tests existants importent directement le handler extrait
 * (`uploadSessionHandler` / `uploadCompleteHandler`) depuis `_lib/`.
 */

const MAX_DATA_BYTES = 262144 // 256 KiB
const MAX_DATA_DEPTH = 8
const MAX_DATA_KEYS = 500
const FORBIDDEN_KEY_PREFIXES = ['__', '$']
const FORBIDDEN_KEY_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

interface SafeDataResult {
  ok: boolean
  reason?: string
}

function validateSafeData(value: unknown, depth = 0): SafeDataResult {
  if (depth > MAX_DATA_DEPTH) return { ok: false, reason: `depth exceeds ${MAX_DATA_DEPTH}` }
  if (value === null || value === undefined) return { ok: true }
  if (typeof value !== 'object') return { ok: true }
  if (Array.isArray(value)) {
    for (const v of value) {
      const r = validateSafeData(v, depth + 1)
      if (!r.ok) return r
    }
    return { ok: true }
  }
  const keys = Object.keys(value as object)
  if (keys.length > MAX_DATA_KEYS) return { ok: false, reason: `object has >${MAX_DATA_KEYS} keys` }
  for (const k of keys) {
    if (FORBIDDEN_KEY_NAMES.has(k)) return { ok: false, reason: `forbidden key: ${k}` }
    for (const prefix of FORBIDDEN_KEY_PREFIXES) {
      if (k.startsWith(prefix)) return { ok: false, reason: `forbidden key prefix: ${k}` }
    }
    const r = validateSafeData((value as Record<string, unknown>)[k], depth + 1)
    if (!r.ok) return r
  }
  return { ok: true }
}

const putBodySchema = z.object({
  data: z.record(z.string(), z.unknown()),
})

const getCore: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  const memberId = readMemberId(req)
  if (memberId === null) {
    sendError(res, 'FORBIDDEN', 'Session non membre', requestId)
    return
  }

  try {
    const { data, error } = await supabaseAdmin()
      .from('sav_drafts')
      .select('data, last_saved_at')
      .eq('member_id', memberId)
      .maybeSingle<{ data: Record<string, unknown>; last_saved_at: string }>()
    if (error) {
      logger.error('draft.get.error', { requestId, message: error.message })
      sendError(res, 'SERVER_ERROR', 'Lecture brouillon échouée', requestId)
      return
    }
    if (!data) {
      res.status(200).json({ data: null })
      return
    }
    res.status(200).json({
      data: { data: data.data, lastSavedAt: data.last_saved_at },
    })
  } catch (err) {
    logger.error('draft.get.exception', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    })
    sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId)
  }
}

const putCore: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  const memberId = readMemberId(req)
  if (memberId === null) {
    sendError(res, 'FORBIDDEN', 'Session non membre', requestId)
    return
  }

  const parse = putBodySchema.safeParse(req.body)
  if (!parse.success) {
    sendError(res, 'VALIDATION_FAILED', 'Body invalide', requestId, formatErrors(parse.error))
    return
  }

  const safetyCheck = validateSafeData(parse.data.data)
  if (!safetyCheck.ok) {
    sendError(res, 'VALIDATION_FAILED', 'Brouillon contient des clés interdites', requestId, [
      { field: 'data', message: safetyCheck.reason ?? 'invalid' },
    ])
    return
  }

  const serialized = JSON.stringify(parse.data.data)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DATA_BYTES) {
    sendError(res, 'VALIDATION_FAILED', 'Brouillon > 256 KiB', requestId, [
      { field: 'data', message: `exceeds ${MAX_DATA_BYTES} bytes` },
    ])
    return
  }

  const nowIso = new Date().toISOString()
  try {
    const { error } = await supabaseAdmin().from('sav_drafts').upsert(
      {
        member_id: memberId,
        data: parse.data.data,
        last_saved_at: nowIso,
      },
      { onConflict: 'member_id' }
    )
    if (error) {
      logger.error('draft.put.error', { requestId, message: error.message })
      sendError(res, 'SERVER_ERROR', 'Enregistrement échoué', requestId)
      return
    }
    res.status(200).json({ data: { lastSavedAt: nowIso } })
  } catch (err) {
    logger.error('draft.put.exception', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    })
    sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId)
  }
}

function readMemberId(req: ApiRequest): number | null {
  const u = req.user
  if (!u || u.type !== 'member') return null
  if (typeof u.sub !== 'number') return null
  return u.sub
}

const authMember = withAuth({ types: ['member'] })
const getGuard = authMember(getCore)
const putGuard = authMember(
  withRateLimit({
    bucketPrefix: 'draft:save',
    keyFrom: (req: ApiRequest) =>
      req.user && req.user.type === 'member' ? `member:${req.user.sub}` : undefined,
    max: 120,
    window: '1m',
  })(putCore)
)

const ALLOWED_OPS = new Set(['draft', 'upload-session', 'upload-complete'])

function parseOp(req: ApiRequest): string | null {
  const raw = (req.query as Record<string, unknown> | undefined)?.['op']
  if (raw === undefined) return null
  if (typeof raw === 'string') return ALLOWED_OPS.has(raw) ? raw : 'invalid'
  if (Array.isArray(raw) && typeof raw[0] === 'string')
    return ALLOWED_OPS.has(raw[0]) ? raw[0] : 'invalid'
  return 'invalid'
}

const dispatch: ApiHandler = async (req, res) => {
  const op = parseOp(req)
  const method = (req.method ?? 'GET').toUpperCase()

  if (op === 'invalid') {
    const requestId = ensureRequestId(req)
    sendError(res, 'NOT_FOUND', 'Route non disponible', requestId)
    return
  }

  // op=null ou op='draft' → routage par méthode HTTP (backward-compat
  // des appels GET/PUT /api/self-service/draft sans query op).
  if (op === null || op === 'draft') {
    if (method === 'GET') return getGuard(req, res)
    if (method === 'PUT') return putGuard(req, res)
    const requestId = ensureRequestId(req)
    res.setHeader('Allow', 'GET, PUT')
    sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
    return
  }

  if (op === 'upload-session') {
    if (method !== 'POST') {
      const requestId = ensureRequestId(req)
      res.setHeader('Allow', 'POST')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return uploadSessionHandler(req, res)
  }

  if (op === 'upload-complete') {
    if (method !== 'POST') {
      const requestId = ensureRequestId(req)
      res.setHeader('Allow', 'POST')
      sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
      return
    }
    return uploadCompleteHandler(req, res)
  }

  const requestId = ensureRequestId(req)
  sendError(res, 'NOT_FOUND', 'Route non disponible', requestId)
}

// W40 (CR Story 5.2) — defense-in-depth : auth au niveau router en plus
// des sub-handlers déjà auth-wrappés. Si un refactor futur retire `withAuth`
// d'un sub-handler, l'auth reste garantie ici.
const router: ApiHandler = withAuth({ types: ['member'] })(dispatch)

export default router
