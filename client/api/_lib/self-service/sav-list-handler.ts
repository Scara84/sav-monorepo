import { z } from 'zod'
import { withAuth } from '../middleware/with-auth'
import { withRateLimit } from '../middleware/with-rate-limit'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { requireActiveManager } from '../auth/manager-check'
import type { ApiHandler, ApiRequest } from '../types'

/**
 * Story 6.2 AC #4, #5, #6, #7, #10, #11 —
 * `GET /api/self-service/sav` (op=sav-list dans router self-service).
 *
 * Story 6.5 AC #2-#4 — extension scope group :
 *   - query param `scope: 'self' | 'group'` (défaut `'self'`)
 *   - `scope=group` autorisé uniquement si `req.user.role==='group-manager'`,
 *     `req.user.scope==='group'`, `req.user.groupId` défini, ET re-check DB
 *     `is_group_manager=true` (défense-en-profondeur Layer 2 — cf. AC #11)
 *   - filtres NEW : `q` (ilike sur members.last_name), `received_after`,
 *     `received_before`
 *   - réponse exclut `members.email` (privacy NFR)
 *
 * Réponse :
 *   { data: [{ id, reference, status, receivedAt, totalAmountCents,
 *              lineCount, hasCreditNote, member?: { firstName, lastName } }],
 *     meta: { cursor, count, limit } }
 *
 *   - `member` (firstName + lastName seul) UNIQUEMENT pour `scope=group` —
 *     l'onglet "Mes SAV" (scope=self) reste à shape Story 6.2 (pas de member).
 *
 * Aucune PII opérateur (pas d'assignee, pas d'internal_notes).
 * JAMAIS d'email côté response (interdit par AC #5 + test régression Story 6.2).
 */

const STATUS_OPEN = ['received', 'in_progress', 'validated'] as const
const STATUS_CLOSED = ['closed', 'cancelled'] as const

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50

// CR P3 (2026-04-29) — charset strict pour `q` (recherche par nom de famille) :
// lettres unicode (`\p{L}` couvre accents, ñ, etc.), chiffres, espace, tiret,
// apostrophe (noms type O'Brien). Tout autre char → 400 VALIDATION_FAILED.
// Bloque les wildcards Postgrest (`*`, `%`, `_`), les chars de contrôle et
// la séparation `,` qui pourraient désérialiser le filtre.
const Q_CHARSET = /^[\p{L}\p{N}\s\-']+$/u

const querySchema = z.object({
  status: z.enum(['open', 'closed']).optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  scope: z.enum(['self', 'group']).default('self'),
  q: z
    .string()
    .min(1)
    .max(100)
    .refine((s) => Q_CHARSET.test(s), {
      message: "caractères non autorisés (lettres / chiffres / espace / -' uniquement)",
    })
    .optional(),
  received_after: z.string().datetime().optional(),
  received_before: z.string().datetime().optional(),
})

interface RawRow {
  id: number
  reference: string
  status: string
  received_at: string
  total_amount_cents: number
  // PostgREST embed `sav_lines(count)` returns `[{count: N}]` (W110 fix).
  sav_lines?: Array<{ count: number }> | null
  credit_notes?: Array<{ count: number }> | null
  members?: {
    first_name: string | null
    last_name: string | null
  } | null
}

export interface SelfServiceSavListItem {
  id: number
  reference: string
  status: string
  receivedAt: string
  totalAmountCents: number
  lineCount: number
  hasCreditNote: boolean
  member?: { firstName: string | null; lastName: string | null }
}

export interface SelfServiceSavListResponse {
  data: SelfServiceSavListItem[]
  meta: { cursor: string | null; count: number; limit: number }
}

interface CursorTuple {
  rec: string
  id: number
}

const CURSOR_REC_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/

function decodeCursor(raw: string): CursorTuple | null {
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8')
    const parsed = JSON.parse(json) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const o = parsed as Record<string, unknown>
    if (typeof o['rec'] !== 'string' || typeof o['id'] !== 'number') return null
    if (!CURSOR_REC_REGEX.test(o['rec'])) return null
    if (!Number.isInteger(o['id']) || o['id'] <= 0) return null
    return { rec: o['rec'], id: o['id'] }
  } catch {
    return null
  }
}

function encodeCursor(row: { received_at: string; id: number }): string {
  return Buffer.from(JSON.stringify({ rec: row.received_at, id: row.id })).toString('base64url')
}

function projectRow(row: RawRow, includeMember: boolean): SelfServiceSavListItem {
  const item: SelfServiceSavListItem = {
    id: row.id,
    reference: row.reference,
    status: row.status,
    receivedAt: row.received_at,
    totalAmountCents: row.total_amount_cents,
    lineCount: row.sav_lines?.[0]?.count ?? 0,
    hasCreditNote: (row.credit_notes?.[0]?.count ?? 0) > 0,
  }
  if (includeMember) {
    // Privacy NFR Story 6.5 AC #3+#5 — uniquement first_name/last_name,
    // JAMAIS d'email, JAMAIS d'autre champ members.
    item.member = {
      firstName: row.members?.first_name ?? null,
      lastName: row.members?.last_name ?? null,
    }
  }
  return item
}

// W110 fix — `line_count` and `has_credit_note` are NOT columns on `sav`;
// they are derived via PostgREST embedded counts on the FK children
// `sav_lines.sav_id` and `credit_notes.sav_id`.
const SELECT_EXPR_SELF =
  'id, reference, status, received_at, total_amount_cents, sav_lines(count), credit_notes(count)'

// Story 6.5 — pour scope=group, on jointe `members(first_name, last_name)` — JAMAIS `email`.
// CR P2 (2026-04-29) — `!inner` hint OBLIGATOIRE : sans lui, Postgrest applique
// l'ilike `members.last_name` comme LEFT JOIN avec filtre, et retourne les SAV
// dont le member ne match pas avec `members:null` au lieu de les exclure. Le
// `!inner` force INNER JOIN → filtre effectif côté DB.
const SELECT_EXPR_GROUP = `${SELECT_EXPR_SELF}, members:members!sav_member_id_fkey!inner ( first_name, last_name )`

const coreHandler: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  const startedAt = Date.now()

  const user = req.user
  if (!user || user.type !== 'member' || typeof user.sub !== 'number') {
    // Defense-in-depth — withAuth({ types:['member'] }) doit déjà avoir gardé.
    sendError(res, 'FORBIDDEN', 'Session adhérent requise', requestId)
    return
  }

  const memberId = user.sub

  const parsed = querySchema.safeParse(req.query ?? {})
  if (!parsed.success) {
    sendError(res, 'VALIDATION_FAILED', 'Paramètres invalides', requestId, [
      { field: 'query', message: parsed.error.message },
    ])
    return
  }
  const q = parsed.data
  const limit = q.limit ?? DEFAULT_LIMIT
  const scope = q.scope

  // Story 6.5 AC #2 — gating scope=group côté JWT (Layer 1).
  if (scope === 'group') {
    if (
      user.role !== 'group-manager' ||
      user.scope !== 'group' ||
      typeof user.groupId !== 'number'
    ) {
      logger.warn('self-service.sav-list.scope_not_authorized', {
        requestId,
        memberId,
        role: user.role ?? 'unset',
        scopeClaim: user.scope ?? 'unset',
        hasGroupId: typeof user.groupId === 'number',
      })
      sendError(res, 'SCOPE_NOT_AUTHORIZED', 'Scope groupe non autorisé pour ce compte', requestId)
      return
    }
    // Layer 2 — re-check DB (AC #11). Bloque les managers révoqués.
    // CR P1 (2026-04-29) — re-check ÉGALEMENT que `groupId` DB matche le claim
    // JWT, pour bloquer un manager transféré entre groupes (JWT figé sur l'ancien).
    const check = await requireActiveManager(memberId)
    if (!check.active || check.groupId !== user.groupId) {
      logger.warn('self-service.sav-list.scope_revoked', {
        requestId,
        memberId,
        reason: !check.active ? 'inactive' : 'group_mismatch',
      })
      sendError(res, 'SCOPE_REVOKED', 'Scope groupe révoqué', requestId)
      return
    }
  }

  let cursor: CursorTuple | null = null
  if (q.cursor !== undefined) {
    cursor = decodeCursor(q.cursor)
    if (cursor === null) {
      sendError(res, 'VALIDATION_FAILED', 'Cursor invalide', requestId, [
        { field: 'cursor', message: 'Format cursor illisible' },
      ])
      return
    }
  }

  interface SelfServiceSavBuilder {
    eq: (c: string, v: unknown) => SelfServiceSavBuilder
    neq: (c: string, v: unknown) => SelfServiceSavBuilder
    in: (c: string, v: unknown[]) => SelfServiceSavBuilder
    or: (f: string) => SelfServiceSavBuilder
    ilike: (c: string, v: string) => SelfServiceSavBuilder
    gte: (c: string, v: unknown) => SelfServiceSavBuilder
    lte: (c: string, v: unknown) => SelfServiceSavBuilder
    order: (c: string, o?: { ascending?: boolean }) => SelfServiceSavBuilder
    limit: (n: number) => SelfServiceSavBuilder
  }

  try {
    const admin = supabaseAdmin()
    const selectExpr = scope === 'group' ? SELECT_EXPR_GROUP : SELECT_EXPR_SELF
    const base = admin.from('sav').select(selectExpr, { count: 'exact' })
    let query: SelfServiceSavBuilder

    if (scope === 'group') {
      // Story 6.5 AC #2 — `group_id = req.user.groupId AND member_id != req.user.sub`.
      // groupId est garanti number ici (check ci-dessus).
      query = (base as unknown as SelfServiceSavBuilder)
        .eq('group_id', user.groupId as number)
        .neq('member_id', memberId)
    } else {
      query = (base as unknown as SelfServiceSavBuilder).eq('member_id', memberId)
    }

    if (q.status === 'open') query = query.in('status', STATUS_OPEN as unknown as string[])
    else if (q.status === 'closed') query = query.in('status', STATUS_CLOSED as unknown as string[])

    // Story 6.5 AC #4 — filtres NEW (uniquement scope=group sémantiquement, mais
    // on les applique aussi en self pour cohérence — un member peut filtrer ses
    // propres SAV par date également ; le filtre `q` (last_name) sur self ne
    // ramène que ses propres SAV donc le filtre matchera son propre nom ou rien).
    if (q.received_after !== undefined) query = query.gte('received_at', q.received_after)
    if (q.received_before !== undefined) query = query.lte('received_at', q.received_before)
    if (scope === 'group' && q.q !== undefined) {
      // ilike sur la jointure `members.last_name`. Postgrest accepte
      // `members.last_name` comme path. On échappe les wildcards (`%`, `_`,
      // `*`) ET le backslash pour que le `q` soit traité littéralement.
      // CR P3 (2026-04-29) — la Zod refine `Q_CHARSET` rejette déjà les
      // wildcards en amont (defense-in-depth) ; cet escape reste comme
      // ceinture+bretelles si le charset venait à être assoupli.
      const escaped = q.q.replace(/[\\%_*]/g, (c) => `\\${c}`)
      query = query.ilike('members.last_name', `%${escaped}%`)
    }

    if (cursor !== null) {
      query = query.or(
        `received_at.lt.${cursor.rec},and(received_at.eq.${cursor.rec},id.lt.${cursor.id})`
      )
    }

    query = query
      .order('received_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1)

    const result = (await (query as unknown as PromiseLike<{
      data: RawRow[] | null
      error: { message: string } | null
      count: number | null
    }>)) as {
      data: RawRow[] | null
      error: { message: string } | null
      count: number | null
    }

    if (result.error) {
      // CR P6 (2026-04-29) — log error.code (stable, sans PII) plutôt que
      // error.message (peut contenir valeurs de colonnes, ex. email, lors de
      // violations de contraintes).
      logger.error('self-service.sav-list.supabase_error', {
        requestId,
        memberId,
        scope,
        errorCode: (result.error as { code?: string }).code ?? 'unknown',
      })
      sendError(res, 'SERVER_ERROR', 'Lecture SAV échouée', requestId)
      return
    }

    const rows = result.data ?? []
    const hasMore = rows.length > limit
    const trimmed = hasMore ? rows.slice(0, limit) : rows
    const last = trimmed[trimmed.length - 1]
    const nextCursor =
      hasMore && last !== undefined
        ? encodeCursor({ received_at: last.received_at, id: last.id })
        : null

    const includeMember = scope === 'group'
    const payload: SelfServiceSavListResponse = {
      data: trimmed.map((row) => projectRow(row, includeMember)),
      meta: {
        cursor: nextCursor,
        count: result.count ?? trimmed.length,
        limit,
      },
    }

    const durationMs = Date.now() - startedAt
    logger.info('self-service.sav-list.success', {
      requestId,
      memberId,
      scope,
      count: result.count ?? trimmed.length,
      durationMs,
    })

    res.setHeader('Cache-Control', 'private, no-store')
    res.status(200).json(payload)
  } catch (err) {
    logger.error('self-service.sav-list.exception', {
      requestId,
      memberId,
      scope,
      error: err instanceof Error ? err.message : String(err),
    })
    sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId)
  }
}

/**
 * Pipeline complet : withAuth(member) → withRateLimit(60/min/member) → core.
 */
export const savListHandler: ApiHandler = withAuth({ types: ['member'] })(
  withRateLimit({
    bucketPrefix: 'self-service-sav-list',
    keyFrom: (req: ApiRequest) =>
      req.user && req.user.type === 'member' ? `member:${req.user.sub}` : undefined,
    max: 60,
    window: '1m',
  })(coreHandler)
)

export { coreHandler as __savListCore, decodeCursor, encodeCursor }
