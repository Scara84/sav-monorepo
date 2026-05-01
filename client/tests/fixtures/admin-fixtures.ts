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
