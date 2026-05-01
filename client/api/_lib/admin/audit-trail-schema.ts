import { z } from 'zod'

/**
 * Story 7-5 — Schémas Zod audit_trail (D-1 + D-2 + D-3).
 *
 * D-1 (whitelist 19 valeurs `entity_type` strict) — toute autre valeur
 *     = 422 ENTITY_TYPE_NOT_WHITELISTED **avant** lecture DB. Format `actor`
 *     regex `/^(operator|member|system):[a-z0-9_-]+$/`. Cohérent D-1 7-4.
 * D-2 (pagination cursor base64 JSON `(created_at, id)`) — opaque. Cursor
 *     corrompu/mal formé → 422 INVALID_CURSOR.
 * D-3 (bornes dates) — date pure `YYYY-MM-DD` interprétée UTC midnight ;
 *     borne haute exclusive +1 jour si date pure, inclusive si datetime
 *     exact. `from > to` → 422. Cap range max 365 jours.
 */

const AUDIT_ENTITY_TYPES = [
  // Triggers PG audit_changes() (suffixe pluriel)
  'operators',
  'settings',
  'members',
  'groups',
  'validation_lists',
  'products',
  // recordAudit() handler-side (suffixe singulier)
  'operator',
  'setting',
  'member',
  'group',
  'validation_list',
  'product',
  // Audit métier épic 4 + 6
  'sav',
  'sav_line',
  'sav_file',
  'sav_comment',
  'credit_note',
  'email_outbox',
  // Audit ERP push (Story 7.5 retry + Story 7.2 cron)
  'erp_push',
  // Audit RGPD (Story 7.6 — préventif)
  'rgpd_export',
] as const

export const AUDIT_ENTITY_TYPES_WHITELIST: ReadonlyArray<(typeof AUDIT_ENTITY_TYPES)[number]> =
  AUDIT_ENTITY_TYPES

export const auditEntityTypeSchema = z.enum(AUDIT_ENTITY_TYPES)
export type AuditEntityType = z.infer<typeof auditEntityTypeSchema>

/** D-1 — actor format `operator:<id>` | `member:<id>` | `system:<name>`. */
export const ACTOR_RE = /^(operator|member|system):([a-z0-9_-]+)$/

export interface ParsedActor {
  type: 'operator' | 'member' | 'system'
  filterColumn: 'actor_operator_id' | 'actor_member_id' | 'actor_system'
  filterValue: number | string
}

export function parseActor(raw: string): ParsedActor | null {
  const m = ACTOR_RE.exec(raw)
  if (!m) return null
  const type = m[1] as 'operator' | 'member' | 'system'
  const ident = m[2]!
  if (type === 'operator' || type === 'member') {
    const n = Number(ident)
    if (!Number.isInteger(n) || n <= 0) return null
    return {
      type,
      filterColumn: type === 'operator' ? 'actor_operator_id' : 'actor_member_id',
      filterValue: n,
    }
  }
  return { type: 'system', filterColumn: 'actor_system', filterValue: ident }
}

/** D-3 — bornes dates. */
const DATE_PURE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_RANGE_MS = 365 * 24 * 60 * 60 * 1000

export interface DateRange {
  /** ISO datetime utilisé en `gte('created_at', ...)`. */
  gte: string | null
  /** ISO datetime utilisé en `lt('created_at', ...)` (toujours exclusif). */
  lt: string | null
  /** Indique si la borne haute originale était inclusive (datetime exact). */
  upperInclusive: boolean
}

/**
 * D-3 :
 * - date pure (YYYY-MM-DD) → UTC midnight ; borne haute = lendemain UTC midnight
 *   exclusif (« jusqu'au 30/04 inclus » ⇒ `< 2026-05-01T00:00:00Z`).
 * - datetime exact ISO 8601 → borne haute exacte exclusive (lt). On utilise
 *   toujours `lt` côté SQL pour la cohérence de l'interface ; le drapeau
 *   `upperInclusive` permet au handler d'ajouter +1ms si nécessaire (ici on
 *   suit la convention « datetime exact = inclusif » en ajoutant +1ms pour le
 *   `.lt`).
 *
 * `from > to` → null (le handler renvoie 422 INVALID_DATE_RANGE).
 * `to - from > 365j` → null (anti-DoS).
 */
export function buildDateRange(
  rawFrom: string | undefined | null,
  rawTo: string | undefined | null
): DateRange | 'INVALID' {
  let gte: string | null = null
  let lt: string | null = null
  let upperInclusive = false

  let fromMs: number | null = null
  let toMs: number | null = null

  if (typeof rawFrom === 'string' && rawFrom.length > 0) {
    if (DATE_PURE_RE.test(rawFrom)) {
      const t = Date.parse(`${rawFrom}T00:00:00Z`)
      if (Number.isNaN(t)) return 'INVALID'
      gte = new Date(t).toISOString()
      fromMs = t
    } else {
      const t = Date.parse(rawFrom)
      if (Number.isNaN(t)) return 'INVALID'
      gte = new Date(t).toISOString()
      fromMs = t
    }
  }

  if (typeof rawTo === 'string' && rawTo.length > 0) {
    if (DATE_PURE_RE.test(rawTo)) {
      const t = Date.parse(`${rawTo}T00:00:00Z`)
      if (Number.isNaN(t)) return 'INVALID'
      // Upper exclusif au lendemain UTC.
      const next = t + 24 * 60 * 60 * 1000
      lt = new Date(next).toISOString()
      toMs = next
    } else {
      const t = Date.parse(rawTo)
      if (Number.isNaN(t)) return 'INVALID'
      // Datetime exact = inclusif → on ajoute +1 ms pour `.lt`.
      lt = new Date(t + 1).toISOString()
      toMs = t + 1
      upperInclusive = true
    }
  }

  if (fromMs !== null && toMs !== null) {
    if (fromMs >= toMs) return 'INVALID'
    if (toMs - fromMs > MAX_RANGE_MS) return 'INVALID'
  }

  return { gte, lt, upperInclusive }
}

/** D-2 — pagination cursor base64 JSON `{ created_at, id }`. */
export interface AuditCursor {
  created_at: string
  id: number
}

export function encodeCursor(row: { created_at: string; id: number }): string {
  return Buffer.from(JSON.stringify({ created_at: row.created_at, id: row.id })).toString('base64')
}

/**
 * D-2 strict — `created_at` doit matcher un ISO 8601 strict (timestamptz)
 * AVANT d'être interpolé dans le filtre PostgREST `.or()`. Sinon, un attaquant
 * craftant un cursor `{created_at: "x),or=(role.eq.admin"}` pourrait injecter
 * des sous-filtres PostgREST (CR-7-5 BLOCKER F-1). Le format ISO ne contient
 * que `[0-9T:.\-Z+]` (et éventuellement `+HH:MM`/`-HH:MM`) — aucun de ces
 * caractères ne casse la grammaire `.or(col.op.value,...)`.
 */
const CURSOR_CREATED_AT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/

export function decodeCursor(b64: string): AuditCursor {
  let json: unknown
  try {
    const decoded = Buffer.from(b64, 'base64').toString('utf8')
    json = JSON.parse(decoded)
  } catch {
    throw new Error('INVALID_CURSOR')
  }
  if (
    json === null ||
    typeof json !== 'object' ||
    typeof (json as Record<string, unknown>)['created_at'] !== 'string' ||
    typeof (json as Record<string, unknown>)['id'] !== 'number'
  ) {
    throw new Error('INVALID_CURSOR')
  }
  const candidate = json as AuditCursor
  // Hardening F-1 BLOCKER + F-5 SHOULD-FIX :
  //  - created_at doit matcher un ISO 8601 strict (anti-injection PostgREST .or()).
  //  - id doit être un entier strictement positif fini (anti-NaN/Infinity/0/négatif).
  if (!CURSOR_CREATED_AT_RE.test(candidate.created_at)) {
    throw new Error('INVALID_CURSOR')
  }
  if (!Number.isInteger(candidate.id) || candidate.id <= 0) {
    throw new Error('INVALID_CURSOR')
  }
  return candidate
}

/** Limit clamp Zod (cohérent 7-3a/b/c/4). */
export const auditLimitSchema = z.coerce.number().int().min(1).max(100).optional().default(50)

/** action — string ouvert ≤ 50 chars trim. */
export const auditActionSchema = z
  .string()
  .max(50)
  .transform((s) => s.trim())
  .refine((s) => s.length > 0, 'EMPTY_AFTER_TRIM')

/** include_total — Zod accept 'true' / 'false' / true / false. */
export const includeTotalSchema = z
  .union([z.literal('true'), z.literal('false'), z.boolean()])
  .transform((v) => v === true || v === 'true')

export interface AuditTrailEntry {
  id: number
  entity_type: string
  entity_id: number
  action: string
  actor_operator_id: number | null
  actor_email_short: string | null
  actor_member_id: number | null
  actor_member_label: string | null
  actor_system: string | null
  diff: Record<string, unknown> | null
  notes: string | null
  created_at: string
}
