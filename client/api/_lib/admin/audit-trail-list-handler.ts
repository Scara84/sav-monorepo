import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { shortEmail } from './settings-schema'
import {
  auditEntityTypeSchema,
  parseActor,
  buildDateRange,
  encodeCursor,
  decodeCursor,
  auditLimitSchema,
  auditActionSchema,
  includeTotalSchema,
  type AuditTrailEntry,
} from './audit-trail-schema'
import type { ApiHandler } from '../types'

/**
 * Story 7-5 AC #1 + #2 + #4 — `GET /api/admin/audit-trail`
 * (op `admin-audit-trail-list`).
 *
 * Décisions :
 *   D-1 — whitelist Zod entity_type (19 valeurs) + format actor regex.
 *   D-2 — pagination cursor base64 `(created_at, id)`. nextCursor=null
 *         quand items.length < limit.
 *   D-3 — bornes dates date pure → +1day exclusif ; datetime exact inclusif.
 *         Cap range max 365 jours.
 *   D-4 — RLS audit_trail = service_role only ; supabaseAdmin() bypass RLS.
 *   D-7 — defense-in-depth role==='admin' réappliqué côté handler.
 *
 * include_total opt-in (D-2 trade-off — count.exact head=true coûteux).
 *
 * Réponses :
 *   200 → { data: { items: AuditTrailEntry[], nextCursor: string | null,
 *                   total?: number } }
 *   403 ROLE_NOT_ALLOWED
 *   422 ENTITY_TYPE_NOT_WHITELISTED | INVALID_ACTOR_FORMAT
 *       | INVALID_DATE_RANGE | INVALID_CURSOR
 *   500 QUERY_FAILED
 */

interface AuditRow {
  id: number
  entity_type: string
  entity_id: number
  action: string
  actor_operator_id: number | null
  actor_member_id: number | null
  actor_system: string | null
  diff: Record<string, unknown> | null
  notes: string | null
  created_at: string
}

function asString(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0]
  return undefined
}

export const adminAuditTrailListHandler: ApiHandler = async (req, res) => {
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

  const queryRaw = (req.query as Record<string, unknown> | undefined) ?? {}

  // D-1 — entity_type whitelist (avant tout SELECT).
  const rawEntityType = asString(queryRaw['entity_type'])
  let entityType: string | undefined
  if (rawEntityType !== undefined && rawEntityType.length > 0) {
    const parsed = auditEntityTypeSchema.safeParse(rawEntityType)
    if (!parsed.success) {
      sendError(res, 'BUSINESS_RULE', 'entity_type non whitelistée', requestId, {
        code: 'ENTITY_TYPE_NOT_WHITELISTED',
      })
      return
    }
    entityType = parsed.data
  }

  // D-1 — actor regex (avant tout SELECT).
  const rawActor = asString(queryRaw['actor'])
  let actor: ReturnType<typeof parseActor> = null
  if (rawActor !== undefined && rawActor.length > 0) {
    actor = parseActor(rawActor)
    if (actor === null) {
      sendError(res, 'BUSINESS_RULE', 'Format actor invalide', requestId, {
        code: 'INVALID_ACTOR_FORMAT',
      })
      return
    }
  }

  // D-3 — bornes dates (avant tout SELECT).
  const rawFrom = asString(queryRaw['from'])
  const rawTo = asString(queryRaw['to'])
  const dateRangeResult = buildDateRange(rawFrom, rawTo)
  if (dateRangeResult === 'INVALID') {
    sendError(res, 'BUSINESS_RULE', 'Plage de dates invalide', requestId, {
      code: 'INVALID_DATE_RANGE',
    })
    return
  }
  const dateRange = dateRangeResult

  // action — open enum, ≤ 50 chars trim.
  const rawAction = asString(queryRaw['action'])
  let action: string | undefined
  if (rawAction !== undefined && rawAction.length > 0) {
    const parsed = auditActionSchema.safeParse(rawAction)
    if (!parsed.success) {
      sendError(res, 'VALIDATION_FAILED', 'action invalide', requestId, {
        code: 'INVALID_PARAMS',
      })
      return
    }
    action = parsed.data
  }

  // D-2 — cursor (avant tout SELECT).
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

  const limitParsed = auditLimitSchema.safeParse(queryRaw['limit'])
  if (!limitParsed.success) {
    sendError(res, 'VALIDATION_FAILED', 'limit invalide', requestId, {
      code: 'INVALID_PARAMS',
    })
    return
  }
  const limit = limitParsed.data

  let includeTotal = false
  if (queryRaw['include_total'] !== undefined) {
    const parsed = includeTotalSchema.safeParse(queryRaw['include_total'])
    if (parsed.success) includeTotal = parsed.data
  }

  const admin = supabaseAdmin()

  /**
   * Helper pour appliquer les filtres communs (utilisé pour list + count).
   * Type le builder comme `any` localement — Supabase JS PostgREST builder
   * a un type chainé complexe, et la cast unique ici reste lisible.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function applyFilters(q: any): any {
    let out = q
    if (entityType !== undefined) out = out.eq('entity_type', entityType)
    if (actor !== null) out = out.eq(actor.filterColumn, actor.filterValue)
    if (dateRange.gte !== null) out = out.gte('created_at', dateRange.gte)
    if (dateRange.lt !== null) out = out.lt('created_at', dateRange.lt)
    if (action !== undefined) out = out.ilike('action', action)
    return out
  }

  // Construction du SELECT principal.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query: any = admin
    .from('audit_trail')
    .select(
      'id, entity_type, entity_id, action, actor_operator_id, actor_member_id, actor_system, diff, notes, created_at'
    )
  query = applyFilters(query)

  // D-2 — application du cursor pour pages > 1.
  if (cursor !== null) {
    // Tuple comparison `(created_at, id) < (cursor.created_at, cursor.id)`.
    // PostgREST n'a pas de tuple comparison native — on utilise .or() :
    //   created_at < c.created_at  OR  (created_at = c.created_at AND id < c.id)
    const c = cursor.created_at
    const cid = cursor.id
    query = query.or(`created_at.lt.${c},and(created_at.eq.${c},id.lt.${cid})`)
  }

  query = query.order('created_at', { ascending: false })
  query = query.order('id', { ascending: false })
  const finalQuery = query.limit(limit)

  const { data: rows, error } = (await finalQuery) as {
    data: AuditRow[] | null
    error: { code?: string; message: string } | null
  }

  if (error) {
    logger.error('admin.audit_trail.list.query_failed', {
      requestId,
      message: error.message,
    })
    sendError(res, 'SERVER_ERROR', 'Lecture impossible', requestId, {
      code: 'QUERY_FAILED',
    })
    return
  }

  const auditRows = rows ?? []

  // LEFT JOIN operators (PII-mask via shortEmail()).
  const operatorIds = Array.from(
    new Set(
      auditRows.map((r) => r.actor_operator_id).filter((v): v is number => typeof v === 'number')
    )
  )
  const operatorsMap = new Map<number, string>()
  if (operatorIds.length > 0) {
    const { data: opRows } = (await admin
      .from('operators')
      .select('id, email')
      .in('id', operatorIds)) as unknown as {
      data: Array<{ id: number; email: string }> | null
    }
    for (const r of opRows ?? []) operatorsMap.set(r.id, r.email)
  }

  // LEFT JOIN members (label = "nom #id" — PII-light, pas d'email).
  const memberIds = Array.from(
    new Set(
      auditRows.map((r) => r.actor_member_id).filter((v): v is number => typeof v === 'number')
    )
  )
  const membersMap = new Map<number, string>()
  if (memberIds.length > 0) {
    const { data: memRows } = (await admin
      .from('members')
      .select('id, first_name, last_name')
      .in('id', memberIds)) as unknown as {
      data: Array<{ id: number; first_name: string | null; last_name: string | null }> | null
    }
    for (const r of memRows ?? []) {
      const fn = r.first_name ?? ''
      const ln = r.last_name ?? ''
      const fullName = `${fn} ${ln}`.trim()
      membersMap.set(r.id, fullName.length > 0 ? `${fullName} #${r.id}` : `#${r.id}`)
    }
  }

  // D-5 garde-fou PII leak (CR-7-5 SHOULD-FIX F-3) — détection régression
  // masking trigger `__audit_mask_pii`. Si une valeur dans `diff` ressemble
  // à un email raw (`<text>@<text>.<text>`), on log warn (ne bloque pas
  // l'affichage admin — admin a déjà le droit de voir, mais signale dérive).
  const RAW_EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
  function diffContainsRawEmail(d: unknown): boolean {
    if (d === null || d === undefined) return false
    if (typeof d === 'string') return RAW_EMAIL_RE.test(d)
    if (typeof d !== 'object') return false
    for (const v of Object.values(d as Record<string, unknown>)) {
      if (diffContainsRawEmail(v)) return true
    }
    return false
  }

  const items: AuditTrailEntry[] = auditRows.map((r) => {
    if (r.diff !== null && diffContainsRawEmail(r.diff)) {
      logger.warn('admin.audit_trail.pii_leak_suspected', {
        requestId,
        entryId: r.id,
        entityType: r.entity_type,
        entityId: r.entity_id,
      })
    }
    return {
      id: r.id,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      action: r.action,
      actor_operator_id: r.actor_operator_id,
      actor_email_short:
        r.actor_operator_id !== null
          ? shortEmail(operatorsMap.get(r.actor_operator_id) ?? null)
          : null,
      actor_member_id: r.actor_member_id,
      actor_member_label:
        r.actor_member_id !== null ? (membersMap.get(r.actor_member_id) ?? null) : null,
      actor_system: r.actor_system,
      diff: r.diff,
      notes: r.notes,
      created_at: r.created_at,
    }
  })

  // D-2 — nextCursor=null si page finale (items < limit).
  const last = items[items.length - 1]
  const nextCursor =
    items.length < limit || last === undefined
      ? null
      : encodeCursor({ created_at: last.created_at, id: last.id })

  const responseData: {
    items: AuditTrailEntry[]
    nextCursor: string | null
    total?: number
  } = {
    items,
    nextCursor,
  }

  // Q-T2 : include_total via Supabase select count:'exact', head:true.
  if (includeTotal) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let countQuery: any = admin.from('audit_trail').select('id', { count: 'exact', head: true })
    countQuery = applyFilters(countQuery)
    const countResult = (await countQuery.limit(1)) as {
      count: number | null
      error: { message: string } | null
    }
    if (!countResult.error && typeof countResult.count === 'number') {
      responseData.total = countResult.count
    }
  }

  res.status(200).json({ data: responseData })
}
