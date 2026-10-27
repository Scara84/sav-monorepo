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
  invoice_special_mention: string | null
  member_first_name: string | null
  member_last_name: string
  member_email: string
  group_name: string | null
  assignee_display_name: string | null
  exact_count: number
}

interface SearchSavRpcArgs {
  p_status: string[] | null
  p_from: string | null
  p_to: string | null
  p_invoice_ref: string | null
  p_member_id: number | null
  p_group_id: number | null
  p_assigned_to: number | null
  p_unassigned: boolean
  p_tag: string | null
  p_q: string | null
  p_cursor_received_at: string | null
  p_cursor_id: number | null
  p_limit: number
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
  invoiceSpecialMention: string | null
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

/**
 * Regex stricte pour `cursor.rec` — double ceinture au-dessus de Zod `datetime()`.
 * L'injection de métacaractères PostgREST (`,()`) dans un `.or()` raw literal
 * est le vecteur d'attaque ; on force ici un format canonique ISO UTC sans
 * offset hors `Z`, après normalisation de l'UTC Supabase `+00:00`.
 * Review F5 (CR Epic 3 2026-04-23).
 */
const CURSOR_REC_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/

function decodeCursor(raw: string): ListSavCursor | null {
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8')
    const parsed = JSON.parse(json) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    if (!('rec' in parsed) || typeof parsed.rec !== 'string') return null
    // Ne convertir que le suffixe UTC : Date.toISOString() perdrait les microsecondes.
    parsed.rec = parsed.rec.replace(/\+00:00$/, 'Z')
    const check = listSavCursorShape.safeParse(parsed)
    if (!check.success) return null
    if (!CURSOR_REC_REGEX.test(check.data.rec)) return null
    if (!Number.isInteger(check.data.id) || check.data.id <= 0) return null
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
    invoiceSpecialMention: row.invoice_special_mention,
    totalAmountCents: row.total_amount_cents,
    tags: row.tags ?? [],
    member: {
      id: row.member_id,
      firstName: row.member_first_name,
      lastName: row.member_last_name,
      email: row.member_email,
    },
    group:
      row.group_id !== null && row.group_name !== null
        ? { id: row.group_id, name: row.group_name }
        : null,
    assignee:
      row.assigned_to !== null && row.assignee_display_name !== null
        ? { id: row.assigned_to, displayName: row.assignee_display_name }
        : null,
  }
}

function readExactCount(row: Pick<RawSavRow, 'exact_count'>): number {
  if (!Number.isSafeInteger(row.exact_count) || row.exact_count < 0) {
    throw new Error('search_sav_list returned an invalid exact_count')
  }
  return row.exact_count
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
  // F97 (CR Epic 3) : defense-in-depth — withAuth au router garantit déjà
  // `type === 'operator'`, mais on re-check ici pour fermer la porte si le
  // handler était un jour monté sur un router moins strict.
  if (user.type !== 'operator') {
    sendError(res, 'FORBIDDEN', 'Session opérateur requise', requestId)
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
    const status = q.status === undefined ? null : Array.isArray(q.status) ? q.status : [q.status]
    const rpcArgs: SearchSavRpcArgs = {
      p_status: status,
      p_from: q.from ?? null,
      p_to: q.to ?? null,
      p_invoice_ref: q.invoiceRef ?? null,
      p_member_id: q.memberId ?? null,
      p_group_id: q.groupId ?? null,
      p_assigned_to: typeof q.assignedTo === 'number' ? q.assignedTo : null,
      p_unassigned: q.assignedTo === 'unassigned',
      p_tag: q.tag ?? null,
      p_q: q.q ?? null,
      p_cursor_received_at: cursor?.rec ?? null,
      p_cursor_id: cursor?.id ?? null,
      p_limit: q.limit,
    }
    const result = (await admin.rpc('search_sav_list', rpcArgs)) as {
      data: RawSavRow[] | null
      error: { message: string } | null
    }

    if (result.error) {
      logger.error('sav.list.supabase_error', { requestId, message: result.error.message })
      sendError(res, 'SERVER_ERROR', 'Lecture SAV échouée', requestId)
      return
    }

    const rows = result.data ?? []
    let exactCount = rows.length > 0 ? readExactCount(rows[0] as RawSavRow) : 0
    if (rows.length === 0 && cursor !== null) {
      const countResult = (await admin.rpc('search_sav_list', {
        ...rpcArgs,
        p_cursor_received_at: null,
        p_cursor_id: null,
        p_limit: 1,
      })) as {
        data: RawSavRow[] | null
        error: { message: string } | null
      }
      if (countResult.error) {
        throw new Error(`search_sav_list count lookup failed: ${countResult.error.message}`)
      }
      const countRows = countResult.data ?? []
      exactCount = countRows.length > 0 ? readExactCount(countRows[0] as RawSavRow) : 0
    }
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
        count: exactCount,
        limit: q.limit,
      },
    }

    const durationMs = Date.now() - startedAt
    if (durationMs > 400) {
      logger.warn('sav.list.slow', { requestId, durationMs, filters })
    }
    logger.info('sav.list.success', {
      requestId,
      count: exactCount,
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
  coreHandler,
}
