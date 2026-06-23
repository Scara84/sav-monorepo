import type { SessionUser } from '../../api/_lib/types'

/**
 * Story 7-3a — fixtures partagées admin/sav-operator.
 * Réutilisé par 7-3b (catalog) et 7-3c (validation-lists).
 */

export function farFuture(): number {
  return Math.floor(Date.now() / 1000) + 3600
}

export const ADMIN_ID = 9
export const SAV_OPERATOR_ID = 12
export const SECOND_ADMIN_ID = 10

export function adminSession(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    sub: ADMIN_ID,
    type: 'operator',
    role: 'admin',
    email: 'admin@fruitstock.fr',
    exp: farFuture(),
    ...overrides,
  }
}

export function savOperatorSession(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    sub: SAV_OPERATOR_ID,
    type: 'operator',
    role: 'sav-operator',
    email: 'sav@fruitstock.fr',
    exp: farFuture(),
    ...overrides,
  }
}

export interface OperatorRow {
  id: number
  email: string
  display_name: string
  role: 'admin' | 'sav-operator'
  is_active: boolean
  azure_oid: string | null
  created_at: string
}

export function operatorRow(overrides: Partial<OperatorRow> = {}): OperatorRow {
  return {
    id: 100,
    email: 'jane.doe@fruitstock.fr',
    display_name: 'Jane Doe',
    role: 'sav-operator',
    is_active: true,
    azure_oid: null,
    created_at: '2026-04-30T10:00:00Z',
    ...overrides,
  }
}

/**
 * Story 7-3b — fixtures `products` (CRUD admin catalog).
 * D-2 : tier_prices min 1 entrée. D-5 : origin ISO 3166-1 alpha-2.
 */
export interface TierPrice {
  tier: number
  price_ht_cents: number
}

export interface ProductRow {
  id: number
  code: string
  name_fr: string
  name_en: string | null
  name_es: string | null
  vat_rate_bp: number
  default_unit: 'kg' | 'piece' | 'liter'
  piece_weight_grams: number | null
  tier_prices: TierPrice[]
  supplier_code: string | null
  origin: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export function productRow(overrides: Partial<ProductRow> = {}): ProductRow {
  return {
    id: 500,
    code: 'TOM-RAP-1',
    name_fr: 'Tomate Raphael',
    name_en: 'Raphael Tomato',
    name_es: 'Tomate Raphael',
    vat_rate_bp: 550,
    default_unit: 'kg',
    piece_weight_grams: null,
    tier_prices: [{ tier: 1, price_ht_cents: 250 }],
    supplier_code: 'rufino',
    origin: 'ES',
    created_at: '2026-04-30T10:00:00Z',
    updated_at: '2026-04-30T10:00:00Z',
    deleted_at: null,
    ...overrides,
  }
}

export interface ProductCreateBodyFixture {
  code: string
  name_fr: string
  name_en?: string | null
  name_es?: string | null
  vat_rate_bp?: number
  default_unit: 'kg' | 'piece' | 'liter'
  piece_weight_grams?: number | null
  tier_prices: TierPrice[]
  supplier_code?: string | null
  origin?: string | null
}

export function productCreateBody(
  overrides: Partial<ProductCreateBodyFixture> = {}
): ProductCreateBodyFixture {
  return {
    code: 'TOM-RAP-1',
    name_fr: 'Tomate Raphael',
    name_en: 'Raphael Tomato',
    name_es: 'Tomate Raphael',
    vat_rate_bp: 550,
    default_unit: 'kg',
    piece_weight_grams: null,
    tier_prices: [{ tier: 1, price_ht_cents: 250 }],
    supplier_code: 'rufino',
    origin: 'ES',
    ...overrides,
  }
}

/**
 * Story 7-3c — fixtures `validation_lists` (CRUD admin listes validation).
 * D-7 : list_code enum strict V1 (`'sav_cause' | 'bon_type' | 'unit'`).
 * D-8 : soft-delete via is_active=false ; value + list_code immutables.
 * Schema FR + ES (pas de value_en — D-6 retirée).
 */
export type ValidationListCode = 'sav_cause' | 'bon_type' | 'unit'

export interface ValidationListEntry {
  id: number
  list_code: ValidationListCode
  value: string
  value_es: string | null
  sort_order: number
  is_active: boolean
  created_at: string
  updated_at: string
}

export function validationListEntry(
  overrides: Partial<ValidationListEntry> = {}
): ValidationListEntry {
  return {
    id: 700,
    list_code: 'sav_cause',
    value: 'Abîmé',
    value_es: 'estropeado',
    sort_order: 100,
    is_active: true,
    created_at: '2026-04-30T10:00:00Z',
    updated_at: '2026-04-30T10:00:00Z',
    ...overrides,
  }
}

export interface ValidationListCreateBodyFixture {
  list_code: ValidationListCode
  value: string
  value_es?: string | null
  sort_order?: number
  is_active?: boolean
}

export function validationListCreateBody(
  overrides: Partial<ValidationListCreateBodyFixture> = {}
): ValidationListCreateBodyFixture {
  return {
    list_code: 'sav_cause',
    value: 'Périmé',
    value_es: 'caducado',
    sort_order: 100,
    is_active: true,
    ...overrides,
  }
}

/**
 * Story 7-4 — fixtures `settings` versionnés.
 *
 * D-1 whitelist V1 : 8 clés strictes (aussi exposée côté handler via Zod
 * `z.enum([...])`).
 * D-3 dispatch shape : value jsonb par-clé (object pour bp / threshold /
 * maintenance, string raw pour company.* / onedrive.*).
 *
 * Ces fixtures ne touchent pas l'infra DB existante (table `settings` +
 * trigger `trg_settings_close_previous` + UNIQUE INDEX `settings_one_active_per_key`).
 */
export type SettingKey =
  | 'vat_rate_default'
  | 'group_manager_discount'
  | 'threshold_alert'
  | 'maintenance_mode'
  | 'company.legal_name'
  | 'company.siret'
  | 'company.tva_intra'
  | 'company.legal_mentions_short'
  | 'onedrive.pdf_folder_root'

export const SETTING_KEYS_WHITELIST: readonly SettingKey[] = [
  'vat_rate_default',
  'group_manager_discount',
  'threshold_alert',
  'maintenance_mode',
  'company.legal_name',
  'company.siret',
  'company.tva_intra',
  'company.legal_mentions_short',
  'onedrive.pdf_folder_root',
] as const

export interface SettingActiveSummary {
  id: number
  key: SettingKey
  value: unknown
  valid_from: string
  valid_to: string | null
  notes: string | null
  created_at: string
  updated_by: { id: number; email_display_short: string | null } | null
  versions_count: number
}

export interface SettingHistoryItem {
  id: number
  value: unknown
  valid_from: string
  valid_to: string | null
  notes: string | null
  created_at: string
  updated_by: { id: number; email_display_short: string | null } | null
}

export function settingActive(overrides: Partial<SettingActiveSummary> = {}): SettingActiveSummary {
  return {
    id: 1001,
    key: 'vat_rate_default',
    value: { bp: 550 },
    valid_from: '2020-01-01T00:00:00Z',
    valid_to: null,
    notes: null,
    created_at: '2020-01-01T00:00:00Z',
    updated_by: { id: ADMIN_ID, email_display_short: 'admin' },
    versions_count: 1,
    ...overrides,
  }
}

export function settingHistoryItem(
  overrides: Partial<SettingHistoryItem> = {}
): SettingHistoryItem {
  return {
    id: 1001,
    value: { bp: 550 },
    valid_from: '2020-01-01T00:00:00Z',
    valid_to: null,
    notes: null,
    created_at: '2020-01-01T00:00:00Z',
    updated_by: { id: ADMIN_ID, email_display_short: 'admin' },
    ...overrides,
  }
}

export interface SettingRotateBodyFixture {
  value: unknown
  valid_from: string
  notes?: string
}

/**
 * Body PATCH /api/admin/settings/:key — par défaut shape `vat_rate_default`
 * (`{bp:int}`) avec valid_from futur (now + 1h).
 */
export function settingRotateBody(
  overrides: Partial<SettingRotateBodyFixture> = {}
): SettingRotateBodyFixture {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  return {
    value: { bp: 600 },
    valid_from: future,
    ...overrides,
  }
}

/**
 * Story 7-5 — fixtures `audit_trail` (read-only filtrable + diff JSONB)
 * et `erp_push_queue` (file ERP + retry).
 *
 * D-1 whitelist V1 : 19 valeurs `entity_type` strict (Zod enum côté handler).
 * Ces fixtures n'introduisent AUCUNE migration schema — la table audit_trail
 * existe Story 1.2, erp_push_queue est out-of-scope D-10 (Story 7-1 deferred).
 */
export const AUDIT_ENTITY_TYPES_WHITELIST = [
  // Triggers PG audit_changes() (suffixe pluriel)
  'operators',
  'settings',
  'members',
  'groups',
  'validation_lists',
  'products',
  // recordAudit() handler-side (suffixe singulier — convention 7-3a/b/c/4)
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

export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES_WHITELIST)[number]

export interface AuditTrailEntry {
  id: number
  entity_type: AuditEntityType | string
  entity_id: number
  action: string
  actor_operator_id: number | null
  actor_member_id: number | null
  actor_system: string | null
  diff: Record<string, unknown> | null
  notes: string | null
  created_at: string
  // Story 7-5 — index signature requise pour push direct dans
  // `state.auditRows: Array<Record<string, unknown>>` côté tests RED
  // (cohérent erp-queue-list spec).
  [key: string]: unknown
}

export function auditTrailEntry(overrides: Partial<AuditTrailEntry> = {}): AuditTrailEntry {
  return {
    id: 800,
    entity_type: 'sav',
    entity_id: 1,
    action: 'created',
    actor_operator_id: ADMIN_ID,
    actor_member_id: null,
    actor_system: null,
    diff: { before: null, after: { id: 1, status: 'nouveau' } },
    notes: null,
    created_at: '2026-04-15T10:00:00Z',
    ...overrides,
  }
}

/**
 * Variantes diff jsonb couvrant les patterns observés Stories 7-3a/b/c/4 +
 * Epic 4 (status_changed) + Story 7-5 (retry_manual).
 */
export const AUDIT_DIFF_VARIANTS = {
  settingRotated: {
    key: 'vat_rate_default',
    before: { value: { bp: 550 }, valid_from: '2020-01-01T00:00:00Z' },
    after: { value: { bp: 600 }, valid_from: '2026-07-01T00:00:00Z' },
  },
  operatorRoleChanged: {
    before: { role: 'sav-operator' },
    after: { role: 'admin' },
  },
  savStatusChanged: {
    before: { status: 'nouveau' },
    after: { status: 'en_cours' },
  },
  erpPushRetryManual: {
    before: { status: 'failed', attempts: 3 },
    after: { status: 'pending', attempts: 0 },
  },
} as const

export interface ErpPushEntry {
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
  // Story 7-5 — index signature requise pour push direct dans
  // `state.erpRows: Array<Record<string, unknown>>` côté tests RED.
  [key: string]: unknown
}

export function erpPushEntry(overrides: Partial<ErpPushEntry> = {}): ErpPushEntry {
  return {
    id: 900,
    sav_id: 1,
    status: 'failed',
    attempts: 3,
    last_error: 'timeout: ERP /push 504 Gateway Timeout',
    last_attempt_at: '2026-04-30T08:00:00Z',
    next_retry_at: null,
    scheduled_at: '2026-04-30T07:00:00Z',
    created_at: '2026-04-30T06:00:00Z',
    updated_at: '2026-04-30T08:00:00Z',
    ...overrides,
  }
}

/**
 * Story 7-6 — fixtures RGPD export + anonymize.
 *
 * D-1 HMAC-SHA256 base64url + canonical-JSON tri clés alphabétique récursif.
 * D-2 schéma export V1.0 — 7 collections obligatoires.
 * D-9 + D-11 RPC `admin_anonymize_member` retourne aussi (depuis D-11) :
 *   `tokens_deleted`, `drafts_deleted`, `email_pending_deleted`,
 *   `email_sent_anonymized` en plus de `member_id`/`anonymized_at`/`hash8`/
 *   `audit_purge_count`.
 *
 * Aucune migration schema introduite par ces fixtures (helpers test-only).
 */

export const RGPD_EXPORT_VERSION = '1.0' as const

export interface MemberRowRgpd {
  id: number
  email: string
  first_name: string | null
  last_name: string
  phone: string | null
  pennylane_customer_id: string | null
  notification_prefs: Record<string, unknown>
  anonymized_at: string | null
  created_at: string
  updated_at: string
  [key: string]: unknown
}

export function memberRowRgpd(overrides: Partial<MemberRowRgpd> = {}): MemberRowRgpd {
  return {
    id: 123,
    email: 'real.member@example.com',
    first_name: 'Jean',
    last_name: 'Durand',
    phone: '+33611223344',
    pennylane_customer_id: 'pn-cust-42',
    notification_prefs: { weekly_recap: true },
    anonymized_at: null,
    created_at: '2024-01-15T10:00:00Z',
    updated_at: '2026-04-30T10:00:00Z',
    ...overrides,
  }
}

/** D-3 + D-9 + D-10 : member déjà anonymisé. Hash8 = `a1b2c3d4` figé fixture. */
export function anonymizedMember(id = 123, hash8 = 'a1b2c3d4'): MemberRowRgpd {
  return {
    id,
    email: `anon+${hash8}@fruitstock.invalid`,
    first_name: null,
    last_name: `Adhérent #ANON-${hash8}`,
    phone: null,
    pennylane_customer_id: null,
    notification_prefs: {},
    anonymized_at: '2026-04-30T12:00:00Z',
    created_at: '2024-01-15T10:00:00Z',
    updated_at: '2026-04-30T12:00:00Z',
  }
}

/**
 * D-2 — payload export V1.0 minimal mais conformant : 7 collections présentes,
 * counts ajustables via overrides. Pas de signature (le handler signe).
 */
export interface RgpdExportEnvelope {
  export_version: typeof RGPD_EXPORT_VERSION
  export_id: string
  exported_at: string
  exported_by_operator_id: number
  member_id: number
  data: {
    member: MemberRowRgpd
    sav: Array<Record<string, unknown>>
    sav_lines: Array<Record<string, unknown>>
    sav_comments: Array<Record<string, unknown>>
    sav_files: Array<Record<string, unknown>>
    credit_notes: Array<Record<string, unknown>>
    auth_events: Array<Record<string, unknown>>
  }
}

export function rgpdExportPayload(
  memberOverrides: Partial<MemberRowRgpd> = {},
  collectionCounts: Partial<{
    sav: number
    sav_lines: number
    sav_comments: number
    sav_files: number
    credit_notes: number
    auth_events: number
  }> = {}
): RgpdExportEnvelope {
  const m = memberRowRgpd(memberOverrides)
  const counts = {
    sav: 2,
    sav_lines: 4,
    sav_comments: 1,
    sav_files: 1,
    credit_notes: 1,
    auth_events: 3,
    ...collectionCounts,
  }
  const sav = Array.from({ length: counts.sav }, (_, i) => ({
    id: i + 1,
    member_id: m.id,
    reference: `SAV-2026-${String(i + 1).padStart(4, '0')}`,
    status: 'closed',
    created_at: '2026-02-01T10:00:00Z',
  }))
  const sav_lines = Array.from({ length: counts.sav_lines }, (_, i) => ({
    id: 1000 + i,
    sav_id: sav[i % sav.length]?.id ?? 1,
    product_code: 'TOM-RAP-1',
    quantity: 1,
    vat_rate_bp_snapshot: 550,
  }))
  const sav_comments = Array.from({ length: counts.sav_comments }, (_, i) => ({
    id: 2000 + i,
    sav_id: sav[i % sav.length]?.id ?? 1,
    internal: true, // D-2 : comments INCLUS internal=true
    body: 'note interne ops',
    created_at: '2026-02-02T10:00:00Z',
  }))
  const sav_files = Array.from({ length: counts.sav_files }, (_, i) => ({
    id: 3000 + i,
    sav_id: sav[i % sav.length]?.id ?? 1,
    original_filename: `Bon_DURAND_2026-02-${String(i + 1).padStart(2, '0')}.pdf`,
    sanitized_filename: `bon-${i + 1}.pdf`,
    mime_type: 'application/pdf',
    size_bytes: 12345,
    web_url: `https://fruitstock.sharepoint.com/file/${3000 + i}`, // D-5
  }))
  const credit_notes = Array.from({ length: counts.credit_notes }, (_, i) => ({
    id: 4000 + i,
    member_id: m.id,
    sav_id: sav[i % sav.length]?.id ?? 1,
    number: `AV-2026-${String(i + 1).padStart(4, '0')}`,
    total_ttc_cents: 12000,
  }))
  const auth_events = Array.from({ length: counts.auth_events }, (_, i) => ({
    id: 5000 + i,
    member_id: m.id,
    event: 'login',
    email_hash: 'hash-redacted',
    ip_hash: 'iphash-redacted',
    created_at: '2026-04-30T10:00:00Z',
  }))
  return {
    export_version: RGPD_EXPORT_VERSION,
    export_id: 'rgpd-00000000-0000-4000-8000-000000000001',
    exported_at: '2026-05-01T10:30:00Z',
    exported_by_operator_id: ADMIN_ID,
    member_id: m.id,
    data: { member: m, sav, sav_lines, sav_comments, sav_files, credit_notes, auth_events },
  }
}

/**
 * Helper test : recompute HMAC-SHA256 base64url sur canonical-JSON
 * (clés triées alphabétique récursif) sans le champ `signature`. Renvoie
 * la string base64url. Utilisé par les specs canonical/roundtrip pour
 * valider l'impl handler sans dépendre du module prod (qui n'existe pas
 * encore en RED-phase).
 */
export function canonicalStringifyForTest(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalStringifyForTest).join(',') + ']'
  }
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return (
    '{' +
    keys
      .map(
        (k) =>
          JSON.stringify(k) + ':' + canonicalStringifyForTest((value as Record<string, unknown>)[k])
      )
      .join(',') +
    '}'
  )
}

/**
 * Vérifie un export RGPD complet (avec champ `signature`) contre un secret
 * via canonical-JSON + HMAC-SHA256 base64url + comparaison constant-time.
 * Utilisé en roundtrip integration tests + assertion unitaire.
 */
export function verifyHmac(
  full: {
    signature: { algorithm: string; encoding: string; value: string }
    [key: string]: unknown
  },
  secret: string
): boolean {
  // Import dynamique node:crypto pour rester compat node20+ test runtime.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('node:crypto') as typeof import('node:crypto')
  if (full.signature.algorithm !== 'HMAC-SHA256') return false
  if (full.signature.encoding !== 'base64url') return false
  const { signature: _omitted, ...rest } = full as { signature: unknown } & Record<string, unknown>
  void _omitted
  const canonical = canonicalStringifyForTest(rest)
  const expected = crypto.createHmac('sha256', secret).update(canonical).digest('base64url')
  if (expected.length !== full.signature.value.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(full.signature.value))
  } catch {
    return false
  }
}

/**
 * D-9 + D-11 — payload retour RPC `admin_anonymize_member`. Inclut les 4
 * nouveaux champs ROW_COUNT D-11 (tokens_deleted/drafts_deleted/
 * email_pending_deleted/email_sent_anonymized).
 */
export interface AnonymizeRpcRow {
  member_id: number
  anonymized_at: string
  hash8: string
  audit_purge_count: number
  tokens_deleted: number
  drafts_deleted: number
  email_pending_deleted: number
  email_sent_anonymized: number
}

export function anonymizeRpcRow(overrides: Partial<AnonymizeRpcRow> = {}): AnonymizeRpcRow {
  return {
    member_id: 123,
    anonymized_at: '2026-05-01T10:35:00Z',
    hash8: 'a1b2c3d4',
    audit_purge_count: 47,
    tokens_deleted: 2,
    drafts_deleted: 1,
    email_pending_deleted: 0,
    email_sent_anonymized: 12,
    ...overrides,
  }
}
