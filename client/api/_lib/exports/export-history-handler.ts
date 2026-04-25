import { z } from 'zod'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import type { ApiHandler } from '../types'

/**
 * Story 5.2 AC #7 — `GET /api/exports/supplier/history`.
 *
 * Liste cursor-based (pattern Epic 3 Story 3.2) des exports générés.
 * Filtrage optionnel par supplier. Tri `created_at DESC, id DESC`.
 *
 * PII : l'opérateur générateur est exposé via son `email_display_short`
 * (local-part de l'email) — cohérent Epic 3 F36/F37.
 */

const MAX_LIMIT = 100
const DEFAULT_LIMIT = 20

// W48 (CR Story 5.2) — un bookmark URL avec `?supplier=` édité à la main
// est interprété comme « tous fournisseurs » plutôt que rejeté 400. Le
// regex ne s'applique qu'aux strings non vides.
const querySchema = z.object({
  supplier: z
    .string()
    .optional()
    .transform((s) => (s && s.length > 0 ? s : undefined))
    .pipe(
      z
        .string()
        .regex(/^[A-Za-z_]+$/)
        .optional()
    ),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional(),
  cursor: z.string().optional(),
})

interface Cursor {
  createdAt: string
  id: number
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url')
}

// CR 5.2 P2 — cursor.createdAt interpolé tel quel dans un filtre PostgREST
// `.or()`, DSL sensible au `,` et aux parenthèses. `new Date('2026,01,01')`
// passe `!Number.isNaN(getTime())` (le Date parser normalise les virgules)
// → injection potentielle. On exige un format ISO 8601 strict (date-only
// OU datetime UTC avec suffixe `Z`).
const STRICT_ISO_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z)?$/

function decodeCursor(raw: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const obj = parsed as { createdAt?: unknown; id?: unknown }
    if (typeof obj.createdAt !== 'string' || typeof obj.id !== 'number') return null
    if (!STRICT_ISO_RE.test(obj.createdAt)) return null
    if (Number.isNaN(new Date(obj.createdAt).getTime())) return null
    // CR 5.2 P2 — garde id : entier > 0 (protège aussi contre des
    // interpolations farfelues dans `.or()` de type `-1e308`).
    if (!Number.isInteger(obj.id) || obj.id <= 0) return null
    return { createdAt: obj.createdAt, id: obj.id }
  } catch {
    return null
  }
}

interface SupplierExportRow {
  id: number
  supplier_code: string
  period_from: string
  period_to: string
  file_name: string
  line_count: number
  total_amount_cents: string | number
  web_url: string | null
  created_at: string
  generated_by_operator_id: number | null
}

interface OperatorRow {
  id: number
  email: string | null
}

export interface ExportHistoryItem {
  id: number
  supplier_code: string
  period_from: string
  period_to: string
  file_name: string
  line_count: number
  total_amount_cents: string
  web_url: string | null
  generated_by_operator: { id: number; email_display_short: string | null } | null
  created_at: string
}

export const exportHistoryHandler: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  const user = req.user
  if (!user || user.type !== 'operator') {
    sendError(res, 'FORBIDDEN', 'Session opérateur requise', requestId)
    return
  }

  const parse = querySchema.safeParse(req.query ?? {})
  if (!parse.success) {
    sendError(res, 'VALIDATION_FAILED', 'Query invalide', requestId, {
      code: 'INVALID_QUERY',
      issues: parse.error.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      })),
    })
    return
  }
  const q = parse.data
  const limit = q.limit ?? DEFAULT_LIMIT

  let cursor: Cursor | null = null
  if (typeof q.cursor === 'string' && q.cursor.length > 0) {
    cursor = decodeCursor(q.cursor)
    if (cursor === null) {
      sendError(res, 'VALIDATION_FAILED', 'Cursor invalide', requestId, {
        code: 'INVALID_CURSOR',
      })
      return
    }
  }

  const admin = supabaseAdmin()
  // `limit + 1` pour détecter s'il reste une page suivante.
  let query = admin
    .from('supplier_exports')
    .select(
      'id, supplier_code, period_from, period_to, file_name, line_count, total_amount_cents, web_url, created_at, generated_by_operator_id'
    )
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1)

  if (q.supplier) {
    query = query.eq('supplier_code', q.supplier.toUpperCase())
  }
  if (cursor !== null) {
    // Keyset pagination : (created_at, id) tuple < (cursor.createdAt, cursor.id).
    // On simule via : created_at < cursor.createdAt OR (created_at = cursor.createdAt AND id < cursor.id).
    query = query.or(
      `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`
    )
  }

  const { data, error } = await query
  if (error) {
    logger.error('export.history.query_failed', { requestId, message: error.message })
    sendError(res, 'SERVER_ERROR', 'Lecture historique échouée', requestId, {
      code: 'HISTORY_QUERY_FAILED',
    })
    return
  }

  const rows = (data ?? []) as SupplierExportRow[]
  const hasNext = rows.length > limit
  const pageRows = hasNext ? rows.slice(0, limit) : rows

  // Lookup operators en 1 requête (IN liste dédupliquée).
  const operatorIds = Array.from(
    new Set(pageRows.map((r) => r.generated_by_operator_id).filter((v): v is number => v !== null))
  )
  let operatorsMap: Map<number, string | null> = new Map()
  if (operatorIds.length > 0) {
    const { data: opsData, error: opsErr } = await admin
      .from('operators')
      .select('id, email')
      .in('id', operatorIds)
    if (opsErr) {
      logger.warn('export.history.operators_lookup_failed', {
        requestId,
        message: opsErr.message,
      })
      // Non bloquant : operator enrichment best-effort
    } else {
      for (const op of (opsData ?? []) as OperatorRow[]) {
        operatorsMap.set(op.id, op.email ?? null)
      }
    }
  }

  const items: ExportHistoryItem[] = pageRows.map((r) => ({
    id: r.id,
    supplier_code: r.supplier_code,
    period_from: r.period_from,
    period_to: r.period_to,
    file_name: r.file_name,
    line_count: r.line_count,
    total_amount_cents: String(r.total_amount_cents),
    web_url: r.web_url,
    generated_by_operator:
      r.generated_by_operator_id !== null
        ? {
            id: r.generated_by_operator_id,
            email_display_short: shortEmail(operatorsMap.get(r.generated_by_operator_id) ?? null),
          }
        : null,
    created_at: r.created_at,
  }))

  let nextCursor: string | null = null
  if (hasNext && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1]!
    nextCursor = encodeCursor({ createdAt: last.created_at, id: last.id })
  }

  res.status(200).json({
    data: {
      items,
      next_cursor: nextCursor,
    },
  })
}

// CR 5.2 P3 — ancien retour `return email` si `@` absent ou en position 0
// leakait l'email complet (PII). Cohérent Epic 3 F36/F37 : on renvoie null
// quand le format est inattendu, l'UI affichera « — ».
function shortEmail(email: string | null): string | null {
  if (email === null || email.length === 0) return null
  const at = email.indexOf('@')
  if (at <= 0) return null
  return email.slice(0, at)
}
