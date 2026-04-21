import { z } from 'zod'
import { withAuth } from '../_lib/middleware/with-auth'
import { withRateLimit } from '../_lib/middleware/with-rate-limit'
import { ensureRequestId } from '../_lib/request-id'
import { sendError } from '../_lib/errors'
import { logger } from '../_lib/logger'
import { supabaseAdmin } from '../_lib/clients/supabase-admin'
import { formatErrors } from '../_lib/middleware/with-validation'
import type { ApiHandler, ApiRequest, ApiResponse } from '../_lib/types'

/**
 * GET/PUT /api/self-service/draft — Story 2.3
 *
 * Brouillon formulaire adhérent (1 par member_id). Auto-save côté front via
 * composable `useDraftAutoSave`. Purge à 30 j via cron dispatcher.
 *
 *   GET  → 200 { data: null } OR { data: { data: <jsonb>, lastSavedAt: iso } }
 *   PUT  { data: <obj> } → 200 { data: { lastSavedAt: iso } }
 */

const MAX_DATA_BYTES = 262144 // 256 KiB
const MAX_DATA_DEPTH = 8
const MAX_DATA_KEYS = 500
const FORBIDDEN_KEY_PREFIXES = ['__', '$']
const FORBIDDEN_KEY_NAMES = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Valide récursivement que `value` ne contient pas de clés dangereuses
 * (patch F4 review adversarial) :
 *   - prototype pollution : `__proto__`, `constructor`, `prototype`
 *   - réservées : clés commençant par `__` ou `$`
 *   - profondeur max et cardinalité
 *
 * Les strings ne sont PAS sanitized ici (contrat : le front consomme via
 * interpolation `{{}}` / `v-text`, jamais `v-html`). Le serveur stocke des
 * bytes tels quels — la responsabilité XSS est côté render.
 */
function validateSafeData(value: unknown, depth = 0): { ok: true } | { ok: false; reason: string } {
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
  // Objet libre côté front (items, customer, currentStep, …). Pas de schéma strict V1.
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
      { field: 'data', message: safetyCheck.reason },
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

// --- Composition par méthode ---

const authMember = withAuth({ types: ['member'] })
const putGuard = authMember(
  withRateLimit({
    bucketPrefix: 'draft:save',
    keyFrom: (req: ApiRequest) =>
      req.user && req.user.type === 'member' ? `member:${req.user.sub}` : undefined,
    max: 120,
    window: '1m',
  })(putCore)
)
const getGuard = authMember(getCore)

const router: ApiHandler = async (req, res) => {
  if (req.method === 'GET') return getGuard(req, res)
  if (req.method === 'PUT') return putGuard(req, res)
  const requestId = ensureRequestId(req)
  res.setHeader('Allow', 'GET, PUT')
  sendError(res, 'VALIDATION_FAILED', 'Méthode non supportée', requestId)
}

export default router
