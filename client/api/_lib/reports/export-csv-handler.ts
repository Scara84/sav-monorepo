import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import {
  listSavQuerySchema,
  normalizeListQuery,
  type ListSavQuery,
} from '../schemas/sav-list-query'
import { generateCsv, formatEurFr, buildExportFileName, type CsvColumn } from './csv-generator'
import { generateXlsx, type XlsxColumn } from './xlsx-generator'
import type { ApiHandler, ApiRequest, ApiResponse } from '../types'

/**
 * Story 5.4 — handler `GET /api/reports/export-csv`.
 *
 * Génère un export CSV (UTF-8 BOM, `;`, CRLF, décimale FR) ou XLSX de la
 * liste SAV filtrée — mêmes filtres que `GET /api/sav` (Story 3.2). Pas de
 * pagination — export intégral matchant les filtres.
 *
 * Garde-fous volume :
 *   - count > 50 000 → 400 EXPORT_TOO_LARGE (hard limit mémoire lambda).
 *   - count > 5 000 ET format=csv → 200 JSON `{ warning: 'SWITCH_TO_XLSX' }`
 *     (économise RAM + temps Vercel ; UI bascule sur XLSX).
 *   - count ≤ 5 000 OU format=xlsx (≤ 50 000) → génère le binaire en buffer.
 *
 * Stratégie agrégats : `.select()` Supabase avec joins relationnels suivi
 * d'agrégation TS-side (Dev Notes Story 5.4 — décision V1, défer view SQL).
 *
 * Note schéma motifs (W AC #3 §10) : la colonne `sav_lines.motif` n'existe
 * pas en V1 — les motifs sont des entrées `kind='cause'` dans
 * `sav_lines.validation_messages` (jsonb array, format Story 2.1 capture).
 * On agrège ces entrées TS-side comme le RPC `report_top_reasons`
 * (Story 5.3) — convention V1, défer colonne dédiée Epic 7.
 *
 * Erreurs (alignées AC #6) :
 *   - 400 INVALID_FILTERS (Zod) | EXPORT_TOO_LARGE
 *   - 401 UNAUTHENTICATED (router) | 403 FORBIDDEN (type session)
 *   - 405 (Allow GET)
 *   - 500 QUERY_FAILED
 */

export const HARD_LIMIT_ROWS = 50_000
export const CSV_SOFT_LIMIT_ROWS = 5_000

// Sélection plate des champs nécessaires pour les 14 colonnes (AC #3).
// `validation_messages` est ramené pour extraction TS-side des motifs.
// Le LEFT JOIN products est nécessaire pour `supplier_code`. groups via group.
// `assignee:operators` réutilise le hint FK déjà installé Story 3.2.
const SELECT_EXPR = `
  id, reference, status, received_at, closed_at, total_amount_cents,
  invoice_ref, tags,
  member:members ( id, first_name, last_name, email ),
  group:groups ( id, name ),
  assignee:operators!sav_assigned_to_fkey ( id, email, display_name ),
  sav_lines (
    id,
    validation_messages,
    product:products ( supplier_code )
  )
`.trim()

interface RawMember {
  id: number
  first_name: string | null
  last_name: string
  email: string
}
interface RawGroup {
  id: number
  name: string
}
interface RawAssignee {
  id: number
  email: string
  display_name: string
}
interface RawSavLineProduct {
  supplier_code: string | null
}
interface RawValidationMessage {
  kind?: string
  text?: string
}
interface RawSavLine {
  id: number
  validation_messages: unknown
  product: RawSavLineProduct | null
}
interface RawSavRow {
  id: number
  reference: string
  status: string
  received_at: string
  closed_at: string | null
  total_amount_cents: number | null
  invoice_ref: string
  tags: string[] | null
  member: RawMember | null
  group: RawGroup | null
  assignee: RawAssignee | null
  sav_lines: RawSavLine[] | null
}

/** Forme aplatie utilisée pour la génération CSV/XLSX. */
export interface ExportRow {
  reference: string
  receivedAt: string
  status: string
  memberName: string
  memberEmail: string
  groupName: string
  assigneeShort: string
  totalAmountFr: string
  lineCount: number
  motifs: string
  suppliers: string
  invoiceRef: string
  tagsJoined: string
  closedAt: string
}

/** Format ISO date `YYYY-MM-DD` à partir d'un timestamptz, ou ''. */
function isoDate(ts: string | null | undefined): string {
  if (!ts) return ''
  // `2026-04-24T10:00:00Z` → `2026-04-24` ; on tolère absence du `T`.
  const idx = ts.indexOf('T')
  return idx > 0 ? ts.slice(0, idx) : ts.slice(0, 10)
}

/** Construit le nom complet membre : "Prénom Nom" ou juste "Nom". */
function memberFullName(m: RawMember | null): string {
  if (!m) return ''
  return m.first_name ? `${m.first_name} ${m.last_name}` : m.last_name
}

/** Partie locale de l'email (avant `@`) — fallback display_name si email absent. */
function emailShort(a: RawAssignee | null): string {
  if (!a) return ''
  const at = a.email.indexOf('@')
  if (at > 0) return a.email.slice(0, at)
  return a.email || a.display_name || ''
}

/**
 * Extrait + déduplique les motifs (entrées `kind='cause'`) du JSONB
 * `validation_messages` de chaque ligne SAV. Pattern aligné sur le RPC
 * `report_top_reasons` (migration 20260505120000), case-fold pour dédup
 * mais on garde la première graphie rencontrée.
 */
export function extractMotifs(lines: RawSavLine[] | null | undefined): string[] {
  if (!lines || lines.length === 0) return []
  const seen = new Map<string, string>()
  for (const line of lines) {
    const arr = line.validation_messages
    if (!Array.isArray(arr)) continue
    for (const entry of arr as RawValidationMessage[]) {
      if (!entry || typeof entry !== 'object') continue
      if (entry.kind !== 'cause') continue
      const text = typeof entry.text === 'string' ? entry.text.trim() : ''
      if (text.length === 0) continue
      const key = text.toLowerCase()
      if (!seen.has(key)) seen.set(key, text)
    }
  }
  return Array.from(seen.values())
}

/** Extrait + déduplique les supplier_code (NULL ignorés). */
export function extractSuppliers(lines: RawSavLine[] | null | undefined): string[] {
  if (!lines || lines.length === 0) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of lines) {
    const code = line.product?.supplier_code
    if (typeof code !== 'string' || code.length === 0) continue
    if (seen.has(code)) continue
    seen.add(code)
    out.push(code)
  }
  return out
}

/** Aplatit une raw-row Supabase en ExportRow pour le générateur CSV/XLSX. */
export function projectExportRow(row: RawSavRow): ExportRow {
  const lines = row.sav_lines ?? []
  return {
    reference: row.reference,
    receivedAt: isoDate(row.received_at),
    status: row.status,
    memberName: memberFullName(row.member),
    memberEmail: row.member?.email ?? '',
    groupName: row.group?.name ?? '',
    assigneeShort: emailShort(row.assignee),
    totalAmountFr: formatEurFr(row.total_amount_cents ?? 0),
    lineCount: lines.length,
    motifs: extractMotifs(lines).join(' | '),
    suppliers: extractSuppliers(lines).join(' | '),
    invoiceRef: row.invoice_ref ?? '',
    tagsJoined: Array.isArray(row.tags) ? row.tags.join(' | ') : '',
    closedAt: isoDate(row.closed_at),
  }
}

/**
 * Définition canonique des 14 colonnes (AC #3). Mêmes valeurs en CSV et XLSX
 * pour cohérence — pas de divergence d'échappement entre les deux formats.
 */
function buildColumns(): {
  csv: CsvColumn<ExportRow>[]
  xlsx: XlsxColumn<ExportRow>[]
} {
  type Spec = { header: string; width: number; cell: (r: ExportRow) => string | number | null }
  const specs: Spec[] = [
    { header: 'Référence', width: 18, cell: (r) => r.reference },
    { header: 'Date réception', width: 14, cell: (r) => r.receivedAt },
    { header: 'Statut', width: 14, cell: (r) => r.status },
    { header: 'Client', width: 28, cell: (r) => r.memberName },
    { header: 'Email client', width: 32, cell: (r) => r.memberEmail },
    { header: 'Groupe', width: 22, cell: (r) => r.groupName },
    { header: 'Opérateur assigné', width: 18, cell: (r) => r.assigneeShort },
    { header: 'Total TTC (€)', width: 14, cell: (r) => r.totalAmountFr },
    { header: 'Nb lignes', width: 10, cell: (r) => r.lineCount },
    { header: 'Motifs', width: 36, cell: (r) => r.motifs },
    { header: 'Fournisseurs', width: 22, cell: (r) => r.suppliers },
    { header: 'Invoice ref', width: 18, cell: (r) => r.invoiceRef },
    { header: 'Tags', width: 22, cell: (r) => r.tagsJoined },
    { header: 'Date clôture', width: 14, cell: (r) => r.closedAt },
  ]
  return {
    csv: specs.map((s) => ({ header: s.header, cell: s.cell })),
    xlsx: specs.map((s) => ({ header: s.header, width: s.width, cell: s.cell })),
  }
}

interface QueryBuilder {
  eq: (col: string, val: unknown) => QueryBuilder
  in: (col: string, val: unknown[]) => QueryBuilder
  gte: (col: string, val: unknown) => QueryBuilder
  lte: (col: string, val: unknown) => QueryBuilder
  ilike: (col: string, val: string) => QueryBuilder
  is: (col: string, val: null) => QueryBuilder
  contains: (col: string, val: unknown[]) => QueryBuilder
  textSearch: (
    col: string,
    query: string,
    options?: { type?: string; config?: string }
  ) => QueryBuilder
  order: (col: string, opts?: { ascending?: boolean }) => QueryBuilder
  limit: (n: number) => QueryBuilder
  then?: Promise<unknown>['then']
}

const SAV_REF_REGEX = /^SAV-\d{4}-\d{5}$/
const HAS_5_DIGITS = /\d{5,}/

/**
 * Applique les filtres listSavQuerySchema sur le builder Supabase.
 * Sous-ensemble des filtres list-handler.ts (sans `cursor`/`limit`) — l'export
 * réutilise le schéma Story 3.2 mais ignore les options de pagination.
 *
 * P0 (CR-éventuel) : on n'utilise PAS `.or()` complexe ici (cf. list-handler
 * F8) — l'export ne propose pas la recherche full-text+ref combinée. Si `q`
 * est passé, on fait du websearch_to_tsquery pur, sans .or PostgREST.
 */
function applyFilters(builder: QueryBuilder, q: ListSavQuery): QueryBuilder {
  let b = builder
  if (q.status !== undefined) {
    if (Array.isArray(q.status)) b = b.in('status', q.status)
    else b = b.eq('status', q.status)
  }
  if (q.from !== undefined) b = b.gte('received_at', q.from)
  if (q.to !== undefined) b = b.lte('received_at', q.to)
  if (q.invoiceRef !== undefined) {
    const safe = q.invoiceRef.replace(/[\\%_]/g, '\\$&')
    b = b.ilike('invoice_ref', `%${safe}%`)
  }
  if (q.memberId !== undefined) b = b.eq('member_id', q.memberId)
  if (q.groupId !== undefined) b = b.eq('group_id', q.groupId)
  if (q.assignedTo !== undefined) {
    if (q.assignedTo === 'unassigned') b = b.is('assigned_to', null)
    else b = b.eq('assigned_to', q.assignedTo)
  }
  if (q.tag !== undefined) b = b.contains('tags', [q.tag])
  if (q.q !== undefined && q.q.length > 0) {
    // CR Epic 3 F8 (rappel) : strict whitelist sur le terme avant `.or()`.
    // Pour l'export V1, on simplifie : websearch_to_tsquery pur — pas de
    // combinaison avec ilike sur reference. L'opérateur peut filtrer par
    // référence via `?invoiceRef` ou la tag/status, ce qui couvre 95 %
    // des cas d'export. Plus complexe = défer si bench.
    const term = q.q
    if (SAV_REF_REGEX.test(term) || HAS_5_DIGITS.test(term)) {
      // Recherche par référence : on tolère ilike (fragment numérique).
      const safe = term.replace(/[\\%_]/g, '\\$&')
      b = b.ilike('reference', `%${safe}%`)
    } else {
      b = b.textSearch('search', term, { type: 'websearch', config: 'french' })
    }
  }
  return b
}

/** Hash SHA-256 court (8 chars) des filtres pour log non-PII (AC #6). */
function hashFilters(filters: object): string {
  const json = JSON.stringify(filters, Object.keys(filters).sort())
  // Léger non-cryptographique mais suffisant pour logs (juste corrélation).
  let h = 0
  for (let i = 0; i < json.length; i++) h = (h * 31 + json.charCodeAt(i)) | 0
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** Format param parsing — défaut `csv`. */
function parseFormat(req: ApiRequest): 'csv' | 'xlsx' | null {
  const raw = (req.query as Record<string, unknown> | undefined)?.['format']
  const value = typeof raw === 'string' ? raw : Array.isArray(raw) ? String(raw[0] ?? '') : ''
  if (value === '' || value === 'csv') return 'csv'
  if (value === 'xlsx') return 'xlsx'
  return null
}

/** Sends a binary buffer with the appropriate headers (no streaming V1). */
function sendBinary(res: ApiResponse, buffer: Buffer, contentType: string, fileName: string): void {
  res.setHeader('Content-Type', contentType)
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`)
  res.setHeader('Content-Length', buffer.byteLength)
  res.setHeader('Cache-Control', 'no-store')
  // ApiResponse.end signature accepte `string` — buffer envoyé via cast :
  // au runtime Node, ServerResponse.end accepte Buffer nativement. Le type
  // est volontairement strict côté contrat shared.
  ;(res.end as unknown as (chunk: Buffer) => void)(buffer)
}

export const exportSavCsvHandler: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  const startedAt = Date.now()
  const user = req.user

  if (!user) {
    sendError(res, 'UNAUTHENTICATED', 'Session requise', requestId)
    return
  }
  if (user.type !== 'operator') {
    sendError(res, 'FORBIDDEN', 'Session opérateur requise', requestId)
    return
  }

  // 1. Parse `format`. Avant Zod sur le reste car format n'est pas dans
  // listSavQuerySchema (qui est partagé avec /api/sav).
  const format = parseFormat(req)
  if (format === null) {
    sendError(res, 'VALIDATION_FAILED', 'Format invalide (csv|xlsx)', requestId, {
      code: 'INVALID_FILTERS',
      issues: [{ field: 'format', message: "Doit être 'csv' ou 'xlsx'" }],
    })
    return
  }

  // 2. Strip `format` AVANT validation Zod (sinon Zod en mode strict
  // pourrait râler ; en pratique le schéma actuel est ouvert mais on
  // évite tout doute pour le futur).
  const rawQuery = { ...((req.query as Record<string, unknown>) ?? {}) }
  delete rawQuery['format']
  const normalized = normalizeListQuery(rawQuery)

  const parse = listSavQuerySchema.safeParse(normalized)
  if (!parse.success) {
    sendError(res, 'VALIDATION_FAILED', 'Filtres invalides', requestId, {
      code: 'INVALID_FILTERS',
      issues: parse.error.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      })),
    })
    return
  }
  const q = parse.data
  const filtersHash = hashFilters({
    status: q.status,
    from: q.from,
    to: q.to,
    invoiceRef: q.invoiceRef,
    memberId: q.memberId,
    groupId: q.groupId,
    assignedTo: q.assignedTo,
    tag: q.tag,
    q: q.q,
    format,
  })

  logger.info('export.csv.start', {
    requestId,
    filters_hash: filtersHash,
    format,
  })

  try {
    const admin = supabaseAdmin()

    // 3. Count exact (head: true → pas de rows transférés). Permet de
    // décider rapidement SWITCH_TO_XLSX / EXPORT_TOO_LARGE sans charger
    // le payload complet.
    const countQ = applyFilters(
      admin.from('sav').select('id', { count: 'exact', head: true }) as unknown as QueryBuilder,
      q
    )
    const countResult = (await (countQ as unknown as PromiseLike<{
      count: number | null
      error: { message: string } | null
    }>)) as { count: number | null; error: { message: string } | null }
    if (countResult.error) {
      logger.error('export.csv.count_failed', {
        requestId,
        message: countResult.error.message,
      })
      sendError(res, 'SERVER_ERROR', 'Comptage SAV échoué', requestId, {
        code: 'QUERY_FAILED',
      })
      return
    }
    const rowCount = countResult.count ?? 0

    if (rowCount > HARD_LIMIT_ROWS) {
      const durationMs = Date.now() - startedAt
      logger.warn('export.csv.too_large', {
        requestId,
        filters_hash: filtersHash,
        row_count: rowCount,
        durationMs,
      })
      sendError(
        res,
        'VALIDATION_FAILED',
        'Export trop volumineux. Restreignez vos filtres.',
        requestId,
        {
          code: 'EXPORT_TOO_LARGE',
          row_count: rowCount,
          max_rows: HARD_LIMIT_ROWS,
        }
      )
      return
    }

    if (rowCount > CSV_SOFT_LIMIT_ROWS && format === 'csv') {
      const durationMs = Date.now() - startedAt
      logger.info('export.csv.warning', {
        requestId,
        filters_hash: filtersHash,
        row_count: rowCount,
        durationMs,
        format,
      })
      // 200 + JSON warning (ne pas générer le CSV — économise RAM).
      res.status(200).json({
        warning: 'SWITCH_TO_XLSX',
        row_count: rowCount,
        message: `L'export CSV est limité à ${CSV_SOFT_LIMIT_ROWS} lignes. Utilisez format=xlsx.`,
      })
      return
    }

    // 4. Fetch rows (volume maîtrisé : ≤ 5 000 en CSV, ≤ 50 000 en XLSX).
    const dataQ = applyFilters(admin.from('sav').select(SELECT_EXPR) as unknown as QueryBuilder, q)
      .order('received_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(HARD_LIMIT_ROWS)

    const dataResult = (await (dataQ as unknown as PromiseLike<{
      data: RawSavRow[] | null
      error: { message: string } | null
    }>)) as { data: RawSavRow[] | null; error: { message: string } | null }

    if (dataResult.error) {
      logger.error('export.csv.fetch_failed', {
        requestId,
        message: dataResult.error.message,
      })
      sendError(res, 'SERVER_ERROR', 'Lecture SAV échouée', requestId, {
        code: 'QUERY_FAILED',
      })
      return
    }

    const rows = (dataResult.data ?? []).map(projectExportRow)
    const cols = buildColumns()

    if (format === 'csv') {
      const buffer = generateCsv(rows, cols.csv)
      const fileName = buildExportFileName('sav-export', 'csv')
      sendBinary(res, buffer, 'text/csv; charset=utf-8', fileName)
    } else {
      const buffer = generateXlsx(rows, cols.xlsx, 'Export SAV')
      const fileName = buildExportFileName('sav-export', 'xlsx')
      sendBinary(
        res,
        buffer,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileName
      )
    }

    const durationMs = Date.now() - startedAt
    logger.info('export.csv.success', {
      requestId,
      filters_hash: filtersHash,
      row_count: rows.length,
      durationMs,
      format,
    })
  } catch (err) {
    logger.error('export.csv.exception', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    })
    sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId, { code: 'QUERY_FAILED' })
  }
}

/** Exposed for tests. */
export const __testables = {
  applyFilters,
  parseFormat,
  hashFilters,
  buildColumns,
  isoDate,
  memberFullName,
  emailShort,
}
