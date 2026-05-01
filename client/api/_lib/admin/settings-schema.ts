import { z } from 'zod'

/**
 * Story 7-4 — Schémas Zod settings versionnés (D-1 + D-3 + D-4).
 *
 * D-1 (whitelist V1 stricte 8 clés) — toute autre clé = 422 KEY_NOT_WHITELISTED
 *     **avant** lecture/écriture DB (defense-in-depth, cohérent D-7 7-3c).
 * D-3 (Zod par-clé via `settingValueSchemaByKey`) — chaque clé a son propre
 *     schema (object pour `bp` / `threshold_alert` / `maintenance_mode`,
 *     string raw pour `company.*` / `onedrive.*`).
 * D-4 (`valid_from` futur strict) — tolérance drift -5min, cap +1 an.
 *     Snapshots historiques (`vat_rate_bp_snapshot`) jamais recalculés
 *     (architecture.md:155). Cas cutover rétroactif → raw SQL hors UI.
 *
 * Cohérent storage `settings.value` jsonb : `to_jsonb(text)` pour les
 * strings raw (cf. migration 20260428120000_settings_company_keys.sql:35-36).
 */

const SETTING_KEYS = [
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

export const SETTING_KEYS_WHITELIST: ReadonlyArray<(typeof SETTING_KEYS)[number]> = SETTING_KEYS

export const settingKeySchema = z.enum(SETTING_KEYS)
export type SettingKey = z.infer<typeof settingKeySchema>

const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/

const bpValueSchema = z
  .object({
    bp: z.number().int().min(0).max(10000),
  })
  .strict()

const thresholdAlertSchema = z
  .object({
    count: z.number().int().min(1).max(100),
    days: z.number().int().min(1).max(365),
    dedup_hours: z.number().int().min(1).max(168),
  })
  .strict()

const maintenanceModeSchema = z
  .object({
    enabled: z.boolean(),
    message: z.string().max(500).optional(),
  })
  .strict()

const stringValueSchema = z
  .string()
  .min(1)
  .max(500)
  .transform((s) => s.trim())
  .refine((s) => s.length > 0, 'EMPTY_AFTER_TRIM')
  .refine((s) => !CONTROL_CHARS_RE.test(s), 'CONTROL_CHARS')

const siretSchema = stringValueSchema.refine((s) => /^\d{14}$/.test(s), 'SIRET 14 chiffres')
const tvaIntraSchema = stringValueSchema.refine(
  (s) => /^FR\d{11}$/.test(s),
  'TVA intra FR + 11 chiffres'
)
const onedrivePathSchema = stringValueSchema.refine(
  (s) => s.startsWith('/'),
  'doit commencer par /'
)

export const settingValueSchemaByKey: Record<SettingKey, z.ZodTypeAny> = {
  vat_rate_default: bpValueSchema,
  group_manager_discount: bpValueSchema,
  threshold_alert: thresholdAlertSchema,
  maintenance_mode: maintenanceModeSchema,
  'company.legal_name': stringValueSchema,
  'company.siret': siretSchema,
  'company.tva_intra': tvaIntraSchema,
  'company.legal_mentions_short': stringValueSchema,
  'onedrive.pdf_folder_root': onedrivePathSchema,
}

const VALID_FROM_PAST_TOLERANCE_MS = 5 * 60 * 1000 // 5 min drift admin/Vercel/Supabase
const VALID_FROM_FUTURE_CAP_MS = 365 * 24 * 60 * 60 * 1000 // 1 an

/**
 * D-4 strict : valid_from ISO 8601 timestamptz, ≥ now() - 5min, ≤ now() + 1 an.
 * Returns true si valide, false sinon (le handler renvoie 422 INVALID_VALID_FROM).
 */
export function isValidFromInRange(iso: string, nowMs = Date.now()): boolean {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return false
  return t >= nowMs - VALID_FROM_PAST_TOLERANCE_MS && t <= nowMs + VALID_FROM_FUTURE_CAP_MS
}

export const settingRotateBodySchema = z
  .object({
    value: z.unknown(),
    valid_from: z.string().datetime({ offset: true }),
    notes: z
      .string()
      .max(500)
      .optional()
      .transform((s) => (typeof s === 'string' ? s.trim() : s))
      .refine((s) => s === undefined || s.length === 0 || !CONTROL_CHARS_RE.test(s), {
        message: 'CONTROL_CHARS',
      }),
  })
  .strict()

export type SettingRotateBody = z.infer<typeof settingRotateBodySchema>

export const settingHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional().default(10),
})

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

export interface SettingPersistedRow {
  id: number
  key: string
  value: unknown
  valid_from: string
  valid_to: string | null
  updated_by: number | null
  notes: string | null
  created_at: string
}

export function shortEmail(email: string | null): string | null {
  if (email === null || email.length === 0) return null
  const at = email.indexOf('@')
  if (at <= 0) return null
  return email.slice(0, at)
}
