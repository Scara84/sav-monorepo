import { z } from 'zod'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { encodeCursor, decodeCursor } from './audit-trail-schema'
import type { ApiHandler, ApiResponse } from '../types'

/**
 * Story 7-5 AC #5 D-10 — `GET /api/admin/erp-queue`
 * (op `admin-erp-queue-list`).
 *
 * Décisions :
 *   D-10 — feature-flag : tant que la table erp_push_queue n'existe pas
 *          (Story 7-1 deferred), retourne 503 ERP_QUEUE_NOT_PROVISIONED.
 *          Sonde sans ligne sur la file, résultat mis en cache 60 s.
 *   D-2 — pagination cursor base64 `(created_at, id)` cohérent audit-trail.
 *   D-7 — defense-in-depth role==='admin' réappliqué côté handler.
 *
 * Sécurité D-10 : payload jsonb (peut contenir PII) JAMAIS retourné par
 * défaut. Endpoint dédié `?include_payload=true` réservé V2.
 *
 * Réponses :
 *   200 → { data: { items: ErpPushItem[], nextCursor: string | null } }
 *   403 ROLE_NOT_ALLOWED
 *   422 INVALID_STATUS | INVALID_CURSOR
 *   503 ERP_QUEUE_NOT_PROVISIONED
 *   500 QUERY_FAILED
 */

const statusSchema = z.enum(['pending', 'success', 'failed', 'all']).optional().default('failed')

const limitSchema = z.coerce.number().int().min(1).max(100).optional().default(50)

interface ErpPushRow {
  id: number
  sav_id: number
  status: 'pending' | 'success' | 'failed'
  attempts: number
  last_error: string | null
  last_attempt_at: string | null
  next_retry_at: string | null
  scheduled_at: string | null
  created_at: string
  updated_at: string
}

export interface ErpPushItem extends ErpPushRow {
  sav_reference: string | null
}

/**
 * D-10 cache 60s pour la disponibilité de la file. Reset au cold-start serverless.
 * Exporté pour tests d'invalidation manuelle si besoin.
 */
let _erpQueueTableCheckCache: { exists: boolean; checkedAt: number } | null = null
const ERP_QUEUE_CACHE_TTL_MS = 60_000

export function __resetErpQueueCacheForTests(): void {
  _erpQueueTableCheckCache = null
}

async function isErpQueueTableProvisioned(): Promise<boolean> {
  const now = Date.now()
  if (_erpQueueTableCheckCache && now - _erpQueueTableCheckCache.checkedAt < ERP_QUEUE_CACHE_TTL_MS) {
    return _erpQueueTableCheckCache.exists
  }
  // GET limité à zéro ligne pour conserver le code d’erreur JSON de PostgREST.
  const { error } = await supabaseAdmin().from('erp_push_queue').select('id').limit(0)
  if (error && error.code !== 'PGRST205' && error.code !== '42P01') throw error
  const exists = !error
  _erpQueueTableCheckCache = { exists, checkedAt: now }
  return exists
}

export async function requireErpQueue(res: ApiResponse, requestId: string): Promise<boolean> {
  try {
    if (await isErpQueueTableProvisioned()) return true
    sendError(
      res,
      'DEPENDENCY_DOWN',
      "La file ERP n'est pas encore provisionnée — Story 7-1 en attente du contrat ERP Fruitstock",
      requestId,
      { code: 'ERP_QUEUE_NOT_PROVISIONED' }
    )
  } catch {
    sendError(res, 'SERVER_ERROR', 'Vérification de la file ERP impossible', requestId, {
      code: 'QUERY_FAILED',
    })
  }
  return false
}

function asString(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0]
  return undefined
}

export const adminErpQueueListHandler: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  const user = req.user
  if (!user || user.type !== 'operator') {
    sendError(res, 'FORBIDDEN', 'Session opérateur requise', requestId)
    return
  }
  if (user.role !== 'admin') {
    sendError(res, 'FORBIDDEN', 'Rôle admin requis', requestId, {
      code: 'ROLE_NOT_ALLOWED',
    })
    return
  }

  // D-2 — cursor (avant feature-flag check pour fail fast).
  const queryRaw = (req.query as Record<string, unknown> | undefined) ?? {}
  const rawCursor = asString(queryRaw['cursor'])
  let cursor: ReturnType<typeof decodeCursor> | null = null
  if (rawCursor !== undefined && rawCursor.length > 0) {
    try {
      cursor = decodeCursor(rawCursor)
    } catch {
      sendError(res, 'BUSINESS_RULE', 'Cursor invalide', requestId, {
        code: 'INVALID_CURSOR',
      })
      return
    }
  }

  if (!(await requireErpQueue(res, requestId))) return

  // status filter — défaut 'failed' (D-10).
  const statusParsed = statusSchema.safeParse(queryRaw['status'])
  if (!statusParsed.success) {
    sendError(res, 'VALIDATION_FAILED', 'status invalide', requestId, {
      code: 'INVALID_STATUS',
    })
    return
  }
  const status = statusParsed.data

  const limitParsed = limitSchema.safeParse(queryRaw['limit'])
  if (!limitParsed.success) {
    sendError(res, 'VALIDATION_FAILED', 'limit invalide', requestId, {
      code: 'INVALID_PARAMS',
    })
    return
  }
  const limit = limitParsed.data

  // sav_id optionnel.
  let savIdFilter: number | null = null
  const rawSavId = asString(queryRaw['sav_id'])
  if (rawSavId !== undefined && rawSavId.length > 0) {
    const n = Number(rawSavId)
    if (Number.isInteger(n) && n > 0) savIdFilter = n
  }

  const admin = supabaseAdmin()

  // SELECT explicite SANS payload/signature/idempotency_key (D-10 privacy).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query: any = admin
    .from('erp_push_queue')
    .select(
      'id, sav_id, status, attempts, last_error, last_attempt_at, next_retry_at, scheduled_at, created_at, updated_at'
    )

  if (status !== 'all') query = query.eq('status', status)
  if (savIdFilter !== null) query = query.eq('sav_id', savIdFilter)
  if (cursor !== null) {
    const c = cursor.created_at
    const cid = cursor.id
    query = query.or(`created_at.lt.${c},and(created_at.eq.${c},id.lt.${cid})`)
  }

  query = query.order('created_at', { ascending: false })
  query = query.order('id', { ascending: false })
  const finalQuery = query.limit(limit)

  const { data: rows, error } = (await finalQuery) as {
    data: ErpPushRow[] | null
    error: { message: string } | null
  }

  if (error) {
    logger.error('admin.erp_queue.list.query_failed', {
      requestId,
      message: error.message,
    })
    sendError(res, 'SERVER_ERROR', 'Lecture impossible', requestId, {
      code: 'QUERY_FAILED',
    })
    return
  }

  const erpRows = rows ?? []

  // LEFT JOIN sav (reference) pour affichage UI.
  const savIds = Array.from(
    new Set(erpRows.map((r) => r.sav_id).filter((v) => typeof v === 'number'))
  )
  const savMap = new Map<number, string>()
  if (savIds.length > 0) {
    const { data: savRows } = (await admin
      .from('sav')
      .select('id, reference')
      .in('id', savIds)) as unknown as {
      data: Array<{ id: number; reference: string }> | null
    }
    for (const r of savRows ?? []) savMap.set(r.id, r.reference)
  }

  const items: ErpPushItem[] = erpRows.map((r) => ({
    ...r,
    sav_reference: savMap.get(r.sav_id) ?? null,
  }))

  const last = items[items.length - 1]
  const nextCursor =
    items.length < limit || last === undefined
      ? null
      : encodeCursor({ created_at: last.created_at, id: last.id })

  res.status(200).json({ data: { items, nextCursor } })
}
