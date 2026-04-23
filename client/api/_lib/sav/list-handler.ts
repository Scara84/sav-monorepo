import { withRateLimit } from '../middleware/with-rate-limit'
import { withValidation } from '../middleware/with-validation'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import {
  listSavQuerySchema,
  listSavCursorShape,
  normalizeListQuery,
  type ListSavQuery,
  type ListSavCursor,
} from '../schemas/sav-list-query'
import type { ApiHandler, ApiRequest, ApiResponse } from '../types'

/**
 * Story 3.2 — `GET /api/sav` : liste des SAV pour opérateur back-office.
 *
 * Pipeline : withRateLimit(op:<sub>, 120/min) → withValidation(query) → core.
 * `withAuth` est posé en amont par le router `api/sav/[[...slug]].ts`.
 *
 * Retour 200 : `{ data: SavListItem[], meta: { cursor, count, limit } }`.
 * Erreurs : 400 VALIDATION_FAILED (query/cursor), 429 RATE_LIMITED, 500.
 */

interface RawSavRow {
  id: number
  reference: string
  status: string
  member_id: number
  group_id: number | null
  invoice_ref: string
  total_amount_cents: number
  tags: string[]
  assigned_to: number | null
  received_at: string
  taken_at: string | null
  validated_at: string | null
  closed_at: string | null
  cancelled_at: string | null
  version: number
  member: { id: number; first_name: string | null; last_name: string; email: string } | null
  group: { id: number; name: string } | null
  assignee: { id: number; display_name: string } | null
}

export interface SavListItem {
  id: number
  reference: string
  status: string
  receivedAt: string
  takenAt: string | null
  validatedAt: string | null
  closedAt: string | null
  cancelledAt: string | null
  version: number
  invoiceRef: string
  totalAmountCents: number
  tags: string[]
  member: {
    id: number
    firstName: string | null
    lastName: string
    email: string
  } | null
  group: { id: number; name: string } | null
  assignee: { id: number; displayName: string } | null
}

export interface SavListResponse {
  data: SavListItem[]
  meta: {
    cursor: string | null
    count: number
    limit: number
  }
}

// Note : hint FK `!sav_assigned_to_fkey` explicite sur operators — le rename
// de la migration 20260422130000 garantit que ce nom existe. Sur members,
// `!inner` force un INNER JOIN (un SAV sans member est exclu — théoriquement
// impossible grâce à la FK NOT NULL, défense-en-profondeur).
const SELECT_EXPR = `
  id, reference, status, member_id, group_id, invoice_ref,
  total_amount_cents, tags, assigned_to, received_at, taken_at,
  validated_at, closed_at, cancelled_at, version,
  member:members!inner ( id, first_name, last_name, email ),
  group:groups ( id, name ),
  assignee:operators!sav_assigned_to_fkey ( id, display_name )
`.trim()

/** Regex référence SAV (format `SAV-YYYY-NNNNN`) pour fallback `.or(reference.ilike)`. */
const SAV_REF_REGEX = /^SAV-\d{4}-\d{5}$/

/** Un `q` contenant ≥5 chiffres consécutifs est probablement un fragment de référence. */
const HAS_5_DIGITS = /\d{5,}/

function decodeCursor(raw: string): ListSavCursor | null {
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8')
    const parsed = JSON.parse(json) as unknown
    const check = listSavCursorShape.safeParse(parsed)
    if (!check.success) return null
    return check.data
  } catch {
    return null
  }
}

function encodeCursor(row: { received_at: string; id: number }): string {
  return Buffer.from(JSON.stringify({ rec: row.received_at, id: row.id })).toString('base64url')
}

function projectSavRow(row: RawSavRow): SavListItem {
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    receivedAt: row.received_at,
    takenAt: row.taken_at,
    validatedAt: row.validated_at,
    closedAt: row.closed_at,
    cancelledAt: row.cancelled_at,
    version: row.version,
    invoiceRef: row.invoice_ref,
    totalAmountCents: row.total_amount_cents,
    tags: row.tags ?? [],
    member: row.member
      ? {
          id: row.member.id,
          firstName: row.member.first_name,
          lastName: row.member.last_name,
          email: row.member.email,
        }
      : null,
    group: row.group,
    assignee: row.assignee ? { id: row.assignee.id, displayName: row.assignee.display_name } : null,
  }
}

interface SavQueryBuilder {
  eq: (col: string, val: unknown) => SavQueryBuilder
  in: (col: string, val: unknown[]) => SavQueryBuilder
  gte: (col: string, val: unknown) => SavQueryBuilder
  lte: (col: string, val: unknown) => SavQueryBuilder
  ilike: (col: string, val: string) => SavQueryBuilder
  is: (col: string, val: null) => SavQueryBuilder
  contains: (col: string, val: unknown[]) => SavQueryBuilder
  textSearch: (
    col: string,
    query: string,
    options?: { type?: string; config?: string }
  ) => SavQueryBuilder
  or: (filter: string) => SavQueryBuilder
  order: (col: string, opts?: { ascending?: boolean }) => SavQueryBuilder
  limit: (n: number) => SavQueryBuilder
  then?: Promise<unknown>['then']
}

function applyFilters(builder: SavQueryBuilder, q: ListSavQuery): SavQueryBuilder {
  let b = builder
  if (q.status !== undefined) {
    if (Array.isArray(q.status)) b = b.in('status', q.status)
    else b = b.eq('status', q.status)
  }
  if (q.from !== undefined) b = b.gte('received_at', q.from)
  if (q.to !== undefined) b = b.lte('received_at', q.to)
  if (q.invoiceRef !== undefined) {
    b = b.ilike('invoice_ref', `%${q.invoiceRef}%`)
  }
  if (q.memberId !== undefined) b = b.eq('member_id', q.memberId)
  if (q.groupId !== undefined) b = b.eq('group_id', q.groupId)
  if (q.assignedTo !== undefined) {
    if (q.assignedTo === 'unassigned') b = b.is('assigned_to', null)
    else b = b.eq('assigned_to', q.assignedTo)
  }
  if (q.tag !== undefined) b = b.contains('tags', [q.tag])
  if (q.q !== undefined && q.q.length > 0) {
    const term = q.q // Zod a déjà trim() et vérifié min(1)
    if (SAV_REF_REGEX.test(term) || HAS_5_DIGITS.test(term)) {
      // `q` ressemble à une référence SAV → combine full-text ET fragment reference
      // dans un **unique** OR group PostgREST (`(wfts OU ilike) AND autres filtres`).
      // Un .textSearch() séparé + .or(reference.ilike) donnerait un AND au lieu
      // d'un OR — semantic bug corrigé CR #2.
      // Échappement conservateur pour le séparateur `,()` de PostgREST.
      const safe = term.replace(/[,()]/g, ' ').replace(/\s+/g, ' ').trim()
      b = b.or(`search.wfts(french).${encodeURIComponent(safe)},reference.ilike.%${safe}%`)
    } else {
      b = b.textSearch('search', term, { type: 'websearch', config: 'french' })
    }
  }
  return b
}

const coreHandler: ApiHandler = async (req: ApiRequest, res: ApiResponse) => {
  const requestId = ensureRequestId(req)
  const startedAt = Date.now()
  const q = req.query as unknown as ListSavQuery
  const user = req.user
  if (!user) {
    sendError(res, 'UNAUTHENTICATED', 'Session requise', requestId)
    return
  }

  // Décodage cursor (si fourni, doit être valide).
  let cursor: ListSavCursor | null = null
  if (q.cursor !== undefined) {
    cursor = decodeCursor(q.cursor)
    if (cursor === null) {
      sendError(res, 'VALIDATION_FAILED', 'Cursor invalide', requestId, [
        { field: 'cursor', message: 'Format cursor illisible' },
      ])
      return
    }
  }

  const filters = {
    status: q.status,
    from: q.from,
    to: q.to,
    invoiceRef: q.invoiceRef,
    memberId: q.memberId,
    groupId: q.groupId,
    assignedTo: q.assignedTo,
    tag: q.tag,
    q: q.q,
  }
  logger.info('sav.list.start', {
    requestId,
    filters,
    limit: q.limit,
    hasCursor: cursor !== null,
  })

  try {
    const admin = supabaseAdmin()
    const base = admin.from('sav').select(SELECT_EXPR, { count: 'exact' })
    let query = applyFilters(base as unknown as SavQueryBuilder, q)

    // Cursor tuple-compare : rows strictement après le cursor (received_at DESC, id DESC).
    if (cursor !== null) {
      query = query.or(
        `received_at.lt.${cursor.rec},and(received_at.eq.${cursor.rec},id.lt.${cursor.id})`
      )
    }

    query = query
      .order('received_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(q.limit + 1)

    const result = (await (query as unknown as PromiseLike<{
      data: RawSavRow[] | null
      error: { message: string } | null
      count: number | null
    }>)) as {
      data: RawSavRow[] | null
      error: { message: string } | null
      count: number | null
    }

    if (result.error) {
      logger.error('sav.list.supabase_error', { requestId, message: result.error.message })
      sendError(res, 'SERVER_ERROR', 'Lecture SAV échouée', requestId)
      return
    }

    const rows = result.data ?? []
    const hasMore = rows.length > q.limit
    const trimmed = hasMore ? rows.slice(0, q.limit) : rows
    const nextCursor =
      hasMore && trimmed.length > 0
        ? encodeCursor({
            received_at: (trimmed[trimmed.length - 1] as RawSavRow).received_at,
            id: (trimmed[trimmed.length - 1] as RawSavRow).id,
          })
        : null

    const payload: SavListResponse = {
      data: trimmed.map(projectSavRow),
      meta: {
        cursor: nextCursor,
        count: result.count ?? 0,
        limit: q.limit,
      },
    }

    const durationMs = Date.now() - startedAt
    if (durationMs > 400) {
      logger.warn('sav.list.slow', { requestId, durationMs, filters })
    }
    logger.info('sav.list.success', {
      requestId,
      count: result.count ?? 0,
      rows: trimmed.length,
      durationMs,
    })

    res.status(200).json(payload)
  } catch (err) {
    logger.error('sav.list.exception', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    })
    sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId)
  }
}

/**
 * Composition middleware (sans `withAuth` — posé par le router).
 * Rate limit : 120/min/opérateur, clé `op:<sub>` (SessionUser.sub, non-spoofable).
 */
export const listSavHandler: ApiHandler = async (req, res) => {
  // Normalise la query-string avant validation Zod.
  const normalized = normalizeListQuery((req.query ?? {}) as Record<string, unknown>)
  req.query = normalized as Record<string, string | string[] | undefined>

  const composed = withRateLimit({
    bucketPrefix: 'sav:list',
    keyFrom: (r: ApiRequest) =>
      r.user && r.user.type === 'operator' ? `op:${r.user.sub}` : undefined,
    max: 120,
    window: '1m',
  })(withValidation({ query: listSavQuerySchema })(coreHandler))

  return composed(req, res)
}

// Exports pour tests unitaires.
export const __testables = {
  decodeCursor,
  encodeCursor,
  projectSavRow,
  applyFilters,
  coreHandler,
}
