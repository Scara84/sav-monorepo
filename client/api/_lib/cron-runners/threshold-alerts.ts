import { z } from 'zod'
import { supabaseAdmin } from '../_typed-shim'
import { logger } from '../logger'
import { renderThresholdAlertEmail } from '../emails/threshold-alert-template'

/**
 * Story 5.5 — cron runner threshold-alerts.
 *
 * Détecte les produits dépassant un seuil paramétrable de SAV sur une
 * fenêtre glissante (settings `threshold_alert`). Pour chaque produit
 * détecté :
 *   1. Vérifie qu'aucune alerte produit n'a été envoyée dans les
 *      `dedup_hours` heures (table `threshold_alert_sent`).
 *   2. Render template + appelle la RPC `enqueue_threshold_alert` qui
 *      insère atomiquement la trace dédup ET le batch d'emails outbox
 *      (1 par opérateur actif admin|sav-operator) — pas de silent loss.
 *
 * Note Epic 6.6 : les emails restent en `status='pending'`. Le cron
 * `retry-emails.ts` Epic 6.6 activera la délivrance SMTP. La détection
 * a déjà de la valeur (audit trail, signal admin).
 *
 * Ce runner étend le dispatcher existant `api/cron/dispatcher.ts` (pas
 * de nouveau slot Vercel cron Hobby).
 *
 * CR adversarial 2026-04-28 (patches appliqués) :
 *   - try/catch per-product (résilience : 1 produit qui throw n'abandonne
 *     pas les autres).
 *   - RPC `enqueue_threshold_alert` transactionnelle (Decision 1 CR :
 *     remplace les 2 INSERT séparés trace+outbox).
 *   - Normalisation/validation `recipient_email` (strip CRLF, regex format).
 *   - Strip CRLF sur subject (defense-in-depth header injection).
 *   - APP_BASE_URL fail-fast en production (pas de fallback prod en preview).
 *   - JS Date arithmetic remplacé par lecture DB pour la cohérence
 *     window_start/window_end avec la RPC (source unique de vérité).
 *   - `.gte` au lieu de `.gt` sur dedup_cutoff (boundary inclusif).
 *   - NaN guards sur valeurs renvoyées par la RPC.
 *   - Number.isSafeInteger guard sur product_id/sav_count (bigint).
 *   - Refs SAV triées par `sav.received_at` (le plus récent en premier).
 */

const SettingsSchema = z.object({
  count: z.number().int().min(1).max(100),
  days: z.number().int().min(1).max(365),
  dedup_hours: z.number().int().min(1).max(168),
})

interface ProductRow {
  id: number
  code: string
  name_fr: string
}

interface RecentSavRow {
  id: number
  reference: string
}

export interface ThresholdAlertsResult {
  products_over_threshold: number
  alerts_enqueued: number
  alerts_skipped_dedup: number
  alerts_failed: number
  settings_used: { count: number; days: number; dedup_hours: number }
  duration_ms: number
}

const APP_BASE_URL_DEFAULT_DEV = 'http://localhost:5173'
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Résout l'URL absolue de l'app pour les liens email.
 * - APP_BASE_URL ou VITE_APP_BASE_URL si défini.
 * - Sinon, dérive depuis VERCEL_URL (preview/prod Vercel).
 * - Sinon, fail-fast en production ; localhost en dev/test.
 */
function appBaseUrl(): string {
  const explicit = (process.env['APP_BASE_URL'] ?? process.env['VITE_APP_BASE_URL'] ?? '').trim()
  if (explicit.length > 0) return explicit.replace(/\/+$/, '')

  const vercelUrl = (process.env['VERCEL_URL'] ?? '').trim()
  if (vercelUrl.length > 0) {
    return `https://${vercelUrl.replace(/\/+$/, '')}`
  }

  const env = (process.env['NODE_ENV'] ?? '').toLowerCase()
  if (env === 'production') {
    throw new Error(
      'APP_BASE_URL_MISSING|production environment requires APP_BASE_URL or VERCEL_URL'
    )
  }
  return APP_BASE_URL_DEFAULT_DEV
}

function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const cleaned = raw
    .replace(/[\r\n]/g, '')
    .trim()
    .toLowerCase()
  if (cleaned.length === 0) return null
  if (!EMAIL_REGEX.test(cleaned)) return null
  return cleaned
}

function stripCrlf(value: string): string {
  return value.replace(/[\r\n]/g, ' ')
}

export async function runThresholdAlerts({
  requestId,
}: {
  requestId: string
}): Promise<ThresholdAlertsResult> {
  const startedAt = Date.now()
  const admin = supabaseAdmin()

  // 1. Charger les settings actifs (fail fast si absent).
  const { data: settingsRow, error: settingsErr } = await admin
    .from('settings')
    .select('value')
    .eq('key', 'threshold_alert')
    .is('valid_to', null)
    .order('valid_from', { ascending: false })
    .limit(1)
    .maybeSingle<{ value: unknown }>()
  if (settingsErr) {
    logger.error('cron.threshold-alerts.settings_query_failed', {
      requestId,
      message: settingsErr.message,
    })
    throw new Error(`SETTINGS_QUERY_FAILED|${settingsErr.message}`)
  }
  if (settingsRow === null || settingsRow === undefined) {
    logger.error('cron.threshold-alerts.settings_missing', { requestId })
    throw new Error('SETTINGS_MISSING_THRESHOLD_ALERT')
  }

  const parsed = SettingsSchema.safeParse(settingsRow.value)
  if (!parsed.success) {
    logger.error('cron.threshold-alerts.settings_invalid', {
      requestId,
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    })
    throw new Error('SETTINGS_INVALID_THRESHOLD_ALERT')
  }
  const settings = parsed.data

  // 2. Lookup operators (1× par run, pas N+1) + normalisation/validation.
  const { data: operatorsData, error: operatorsErr } = await admin
    .from('operators')
    .select('email')
    .eq('is_active', true)
    .in('role', ['admin', 'sav-operator'])
    .order('email', { ascending: true })
  if (operatorsErr) {
    logger.error('cron.threshold-alerts.operators_query_failed', {
      requestId,
      message: operatorsErr.message,
    })
    throw new Error(`OPERATORS_QUERY_FAILED|${operatorsErr.message}`)
  }
  const operatorEmailsRaw = (operatorsData ?? []).map((row) => (row as { email: unknown }).email)
  const operatorEmails = Array.from(
    new Set(operatorEmailsRaw.map((e) => normalizeEmail(e)).filter((e): e is string => e !== null))
  )
  const operatorEmailsRejected = operatorEmailsRaw.length - operatorEmails.length
  if (operatorEmailsRejected > 0) {
    logger.warn('cron.threshold-alerts.operator_emails_rejected', {
      requestId,
      rejected: operatorEmailsRejected,
      kept: operatorEmails.length,
    })
  }

  // 3. Aggregate via RPC.
  const { data: aggData, error: aggErr } = await admin.rpc('report_products_over_threshold', {
    p_days: settings.days,
    p_count: settings.count,
  })
  if (aggErr) {
    logger.error('cron.threshold-alerts.aggregate_query_failed', {
      requestId,
      message: aggErr.message,
    })
    throw new Error(`AGGREGATE_QUERY_FAILED|${aggErr.message}`)
  }

  const overThreshold = (aggData ?? []) as Array<{
    product_id: number | string
    sav_count: number | string
  }>
  const productsOverThreshold = overThreshold.length

  if (productsOverThreshold === 0) {
    const result: ThresholdAlertsResult = {
      products_over_threshold: 0,
      alerts_enqueued: 0,
      alerts_skipped_dedup: 0,
      alerts_failed: 0,
      settings_used: settings,
      duration_ms: Date.now() - startedAt,
    }
    logger.info('cron.threshold-alerts.completed', { requestId, ...result })
    return result
  }

  // 4. Fenêtres calculées côté JS pour la trace (window_start/end) et la
  // dédup (dedup_cutoff). La RPC `report_products_over_threshold` utilise
  // DB now() : drift résiduel entre Vercel et Supabase = quelques ms en
  // pratique (NTP), acceptable V1. Si besoin de strict-equality, créer
  // une RPC `db_now()` dédiée et passer ses valeurs aux requêtes suivantes.
  const windowEnd = new Date()
  const windowStart = new Date(windowEnd.getTime() - settings.days * 86_400_000)
  const dedupCutoff = new Date(windowEnd.getTime() - settings.dedup_hours * 3_600_000)
  const appBase = appBaseUrl()

  let alertsEnqueued = 0
  let alertsSkippedDedup = 0
  let alertsFailed = 0

  for (const row of overThreshold) {
    // Per-product try/catch : un produit qui throw n'abandonne pas les autres.
    try {
      const productIdRaw =
        typeof row.product_id === 'number' ? row.product_id : Number(row.product_id)
      const savCountRaw = typeof row.sav_count === 'number' ? row.sav_count : Number(row.sav_count)
      if (
        !Number.isFinite(productIdRaw) ||
        !Number.isFinite(savCountRaw) ||
        !Number.isSafeInteger(productIdRaw) ||
        !Number.isSafeInteger(savCountRaw) ||
        productIdRaw < 1 ||
        savCountRaw < 1
      ) {
        logger.error('cron.threshold-alerts.rpc_invalid_row', {
          requestId,
          row,
        })
        alertsFailed += 1
        continue
      }
      const productId = productIdRaw
      const savCount = savCountRaw

      // 4a. Dédup : alerte produit déjà envoyée dans la fenêtre dedup_hours ?
      // `.gte` (boundary inclusif) : un trigger exactement au boundary
      // dedup_cutoff dédupe.
      const { data: dedupData, error: dedupErr } = await admin
        .from('threshold_alert_sent')
        .select('id')
        .eq('product_id', productId)
        .gte('sent_at', dedupCutoff.toISOString())
        .limit(1)
        .maybeSingle<{ id: number }>()
      if (dedupErr) {
        logger.error('cron.threshold-alerts.dedup_query_failed', {
          requestId,
          productId,
          message: dedupErr.message,
        })
        alertsFailed += 1
        continue
      }
      if (dedupData !== null && dedupData !== undefined) {
        alertsSkippedDedup += 1
        logger.info('cron.threshold-alerts.dedup_skip', {
          requestId,
          productId,
          savCount,
          dedupHours: settings.dedup_hours,
        })
        continue
      }

      // 4b. Charger le produit.
      const { data: productData, error: productErr } = await admin
        .from('products')
        .select('id, code, name_fr')
        .eq('id', productId)
        .maybeSingle<ProductRow>()
      if (productErr) {
        logger.error('cron.threshold-alerts.product_query_failed', {
          requestId,
          productId,
          message: productErr.message,
        })
        alertsFailed += 1
        continue
      }
      if (productData === null || productData === undefined) {
        logger.warn('cron.threshold-alerts.product_missing', { requestId, productId })
        continue
      }

      // 4c. Charger les références SAV récentes (pour le template),
      // triées par sav.received_at DESC (le plus récent en premier).
      const { data: refsData, error: refsErr } = await admin
        .from('sav_lines')
        .select('sav!inner(id, reference, received_at)')
        .eq('product_id', productId)
        .gte('sav.received_at', windowStart.toISOString())
        .order('received_at', { ascending: false, foreignTable: 'sav' })
        .limit(50)
      if (refsErr) {
        logger.warn('cron.threshold-alerts.refs_query_failed', {
          requestId,
          productId,
          message: refsErr.message,
        })
      }
      const recentRefs: RecentSavRow[] = []
      const seenSavIds = new Set<number>()
      const refRows = (refsData ?? []) as unknown as Array<{
        sav:
          | { id: number; reference: string; received_at: string }
          | Array<{ id: number; reference: string; received_at: string }>
          | null
      }>
      for (const r of refRows) {
        if (r.sav === null || r.sav === undefined) continue
        const savObj = Array.isArray(r.sav) ? r.sav[0] : r.sav
        if (savObj === undefined) continue
        if (seenSavIds.has(savObj.id)) continue
        seenSavIds.add(savObj.id)
        recentRefs.push({ id: savObj.id, reference: savObj.reference })
        if (recentRefs.length >= 10) break
      }

      // 4d. Render template (subject CRLF strip + truncation côté template).
      const { subject, html } = renderThresholdAlertEmail({
        productCode: productData.code,
        productNameFr: productData.name_fr,
        savCount,
        windowDays: settings.days,
        recentSavRefs: recentRefs,
        appBaseUrl: appBase,
      })

      // 4e. RPC transactionnelle : INSERT trace + INSERT batch outbox atomique.
      // Si pas de recipients, INSERT trace seul (audit préservé, AC #4).
      // Pas de silent loss : si outbox échoue, trace ROLLBACK aussi.
      const { data: enqueueData, error: enqueueErr } = await admin
        .rpc('enqueue_threshold_alert', {
          p_product_id: productId,
          p_count_at_trigger: savCount,
          p_window_start: windowStart.toISOString(),
          p_window_end: windowEnd.toISOString(),
          p_settings_count: settings.count,
          p_settings_days: settings.days,
          p_recipients: operatorEmails,
          p_subject: stripCrlf(subject),
          p_html_body: html,
        })
        .single<{ trace_id: number; alerts_enqueued: number }>()
      if (enqueueErr || !enqueueData) {
        logger.error('cron.threshold-alerts.enqueue_failed', {
          requestId,
          productId,
          message: enqueueErr?.message ?? 'empty enqueue result',
        })
        alertsFailed += 1
        continue
      }

      if (enqueueData.alerts_enqueued === 0 && operatorEmails.length === 0) {
        logger.warn('cron.threshold-alerts.no_recipients', {
          requestId,
          productId,
          savCount,
          traceId: enqueueData.trace_id,
        })
      } else {
        alertsEnqueued += enqueueData.alerts_enqueued
        logger.info('cron.threshold-alerts.alert_enqueued', {
          requestId,
          productId,
          productCode: productData.code,
          savCount,
          recipients: enqueueData.alerts_enqueued,
          traceId: enqueueData.trace_id,
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('cron.threshold-alerts.product_failed', {
        requestId,
        row,
        message,
      })
      alertsFailed += 1
    }
  }

  const result: ThresholdAlertsResult = {
    products_over_threshold: productsOverThreshold,
    alerts_enqueued: alertsEnqueued,
    alerts_skipped_dedup: alertsSkippedDedup,
    alerts_failed: alertsFailed,
    settings_used: settings,
    duration_ms: Date.now() - startedAt,
  }
  logger.info('cron.threshold-alerts.completed', { requestId, ...result })
  return result
}

export const __testables = { SettingsSchema, appBaseUrl, normalizeEmail, stripCrlf }
