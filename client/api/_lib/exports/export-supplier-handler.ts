import { z } from 'zod'
import { withAuth } from '../middleware/with-auth'
import { withRateLimit } from '../middleware/with-rate-limit'
import { ensureRequestId } from '../request-id'
import { sendError, errorEnvelope } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { resolveSettingAt, type SettingRow } from '../business/settingsResolver'
import { buildSupplierExport } from './supplierExportBuilder'
import { resolveSupplierConfig } from './supplier-configs'
import { uploadExportXlsx } from './upload-export'
import type { ApiHandler, ApiRequest, ApiResponse } from '../types'

/**
 * Story 5.2 — handler `POST /api/exports/supplier` (export fournisseur).
 *
 * Pipeline :
 *   1. Parse+validate body (Zod : supplier/period_from/period_to/format)
 *   2. Gate period (<= 1 an, period_from <= period_to)
 *   3. Résout config fournisseur (404-like 400 UNKNOWN_SUPPLIER)
 *   4. Résout settings.onedrive.exports_folder_root (fail-closed placeholder)
 *   5. Appelle buildSupplierExport (Story 5.1) → { buffer, file_name, line_count, total_amount_cents }
 *   6. Upload OneDrive via uploadExportXlsx (retry géré en amont : le module
 *      legacy ne retry pas automatiquement — l'endpoint est synchrone et
 *      l'opérateur peut retenter)
 *   7. INSERT supplier_exports
 *   8. Retour 201 avec id + metadata
 *
 * Erreurs mappées AC #5 :
 *   400 INVALID_BODY | UNKNOWN_SUPPLIER | PERIOD_INVALID
 *   401 UNAUTHENTICATED (fourni par router)
 *   403 FORBIDDEN (role non-operator)
 *   429 RATE_LIMITED (3 req/min/operator/supplier)
 *   500 EXPORTS_FOLDER_NOT_CONFIGURED | BUILD_FAILED | PERSIST_FAILED
 *   502 ONEDRIVE_UPLOAD_FAILED
 *
 * V1 soft-orphan accepté : si upload OneDrive OK mais INSERT DB KO → log
 * WARN `export.orphan.onedrive` + 500 à l'utilisateur. Cleanup batch Epic 7.
 */

const PLACEHOLDER_ROOT = '/PLACEHOLDER_EXPORTS_ROOT'
const MAX_PERIOD_DAYS = 366 // 1 an + 1 jour bissextile tolérance

// CR 5.2 P4 — `z.coerce.date()` tout seul accepte des inputs ambigus qui
// causent des dérives de fuseau horaire (`"2026-01-01T00:00:00-05:00"` →
// après getUTCFullYear() le folder finit en 2025, divergent du builder
// Story 5.1 qui normalize UTC-midnight). Pire : `"2026"` passe en date
// valide (1er janvier) et ouvre un export annuel accidentel. On impose
// donc un format YYYY-MM-DD strict AVANT coercion, normalisé UTC-midnight
// identique au builder.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const bodySchema = z.object({
  supplier: z
    .string()
    .min(1)
    .max(20)
    .regex(/^[A-Za-z_]+$/, 'supplier doit matcher [A-Za-z_]+'),
  period_from: z
    .string()
    .regex(ISO_DATE_RE, 'period_from doit être au format YYYY-MM-DD')
    .transform((s) => new Date(`${s}T00:00:00.000Z`)),
  period_to: z
    .string()
    .regex(ISO_DATE_RE, 'period_to doit être au format YYYY-MM-DD')
    .transform((s) => new Date(`${s}T00:00:00.000Z`)),
  format: z.enum(['XLSX']).optional().default('XLSX'),
})

type ExportBody = z.infer<typeof bodySchema>

export interface ExportSupplierResponse {
  id: number
  supplier_code: string
  web_url: string
  file_name: string
  line_count: number
  total_amount_cents: string // bigint serialized
  created_at: string
}

const coreHandler: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  const user = req.user
  if (!user || user.type !== 'operator') {
    sendError(res, 'FORBIDDEN', 'Session opérateur requise', requestId)
    return
  }

  const rawBody = req.body
  if (
    rawBody === undefined ||
    rawBody === null ||
    typeof rawBody !== 'object' ||
    Array.isArray(rawBody)
  ) {
    sendError(res, 'VALIDATION_FAILED', 'Body JSON requis', requestId, {
      code: 'INVALID_BODY',
    })
    return
  }

  const parsed = bodySchema.safeParse(rawBody)
  if (!parsed.success) {
    sendError(res, 'VALIDATION_FAILED', 'Body invalide', requestId, {
      code: 'INVALID_BODY',
      issues: parsed.error.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      })),
    })
    return
  }

  const body: ExportBody = parsed.data
  const supplierCode = body.supplier.toUpperCase()

  // --- Gate period ---
  if (!(body.period_from instanceof Date) || Number.isNaN(body.period_from.getTime())) {
    sendError(res, 'VALIDATION_FAILED', 'period_from invalide', requestId, {
      code: 'PERIOD_INVALID',
    })
    return
  }
  if (!(body.period_to instanceof Date) || Number.isNaN(body.period_to.getTime())) {
    sendError(res, 'VALIDATION_FAILED', 'period_to invalide', requestId, {
      code: 'PERIOD_INVALID',
    })
    return
  }
  if (body.period_from.getTime() > body.period_to.getTime()) {
    sendError(res, 'VALIDATION_FAILED', 'period_to doit être >= period_from', requestId, {
      code: 'PERIOD_INVALID',
    })
    return
  }
  const spanDays = (body.period_to.getTime() - body.period_from.getTime()) / 86_400_000
  if (spanDays > MAX_PERIOD_DAYS) {
    sendError(res, 'VALIDATION_FAILED', `Période > ${MAX_PERIOD_DAYS} jours`, requestId, {
      code: 'PERIOD_INVALID',
    })
    return
  }

  // --- Résolution config fournisseur ---
  const config = resolveSupplierConfig(supplierCode)
  if (config === null) {
    sendError(res, 'VALIDATION_FAILED', `Fournisseur inconnu : ${supplierCode}`, requestId, {
      code: 'UNKNOWN_SUPPLIER',
    })
    return
  }

  // --- Résolution settings + fail-closed placeholder ---
  const admin = supabaseAdmin()
  const nowIso = new Date().toISOString()
  const { data: settingsData, error: settingsErr } = await admin
    .from('settings')
    .select('key, value, valid_from, valid_to')
    .eq('key', 'onedrive.exports_folder_root')
    .lte('valid_from', nowIso)
    .or(`valid_to.is.null,valid_to.gt.${nowIso}`)
  if (settingsErr) {
    logger.error('export.settings.query_failed', {
      requestId,
      supplier: supplierCode,
      message: settingsErr.message,
    })
    sendError(res, 'SERVER_ERROR', 'Lecture settings échouée', requestId, {
      code: 'BUILD_FAILED',
    })
    return
  }
  const settingsRows = ((settingsData ?? []) as SettingRow[]).map((r) => ({
    key: r.key,
    value: r.value,
    valid_from: r.valid_from,
    valid_to: r.valid_to,
  }))
  const folderRootRaw = resolveSettingAt<unknown>(settingsRows, 'onedrive.exports_folder_root')
  if (typeof folderRootRaw !== 'string' || folderRootRaw.length === 0) {
    logger.error('export.folder_root.missing', { requestId, supplier: supplierCode })
    sendError(res, 'SERVER_ERROR', 'Dossier exports OneDrive non configuré', requestId, {
      code: 'EXPORTS_FOLDER_NOT_CONFIGURED',
    })
    return
  }
  // CR 5.2 P8 — strict equality. L'ancien `.startsWith(PLACEHOLDER_ROOT)`
  // rejetait par erreur un path légitime comme `/PLACEHOLDER_EXPORTS_ROOT2`
  // (admin tape mal). On n'accepte que la valeur placeholder exacte.
  if (folderRootRaw === PLACEHOLDER_ROOT) {
    logger.error('export.folder_root.placeholder', {
      requestId,
      supplier: supplierCode,
      value: folderRootRaw,
    })
    sendError(
      res,
      'SERVER_ERROR',
      'Dossier exports OneDrive non configuré (placeholder)',
      requestId,
      {
        code: 'EXPORTS_FOLDER_NOT_CONFIGURED',
      }
    )
    return
  }
  // Defense-in-depth path traversal / null bytes (pattern Story 4.5 P4).
  if (/(^|\/)\.\.(\/|$)|\0/.test(folderRootRaw)) {
    logger.error('export.folder_root.traversal', {
      requestId,
      supplier: supplierCode,
      prefix: folderRootRaw.slice(0, 32),
    })
    sendError(res, 'SERVER_ERROR', 'Dossier exports invalide', requestId, {
      code: 'EXPORTS_FOLDER_NOT_CONFIGURED',
    })
    return
  }

  // --- Build XLSX via Story 5.1 ---
  let buildResult: Awaited<ReturnType<typeof buildSupplierExport>>
  try {
    buildResult = await buildSupplierExport({
      config,
      period_from: body.period_from,
      period_to: body.period_to,
      supabase: admin,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('export.build_failed', {
      requestId,
      supplier: supplierCode,
      period_from: body.period_from.toISOString(),
      period_to: body.period_to.toISOString(),
      errorCode: 'BUILD_FAILED',
      message: msg,
    })
    sendError(res, 'SERVER_ERROR', 'Génération export échouée', requestId, {
      code: 'BUILD_FAILED',
    })
    return
  }

  // --- Upload OneDrive ---
  const year = body.period_to.getUTCFullYear()
  const folder = joinPath(folderRootRaw, supplierCode, String(year))
  let uploadResult: Awaited<ReturnType<typeof uploadExportXlsx>>
  try {
    uploadResult = await uploadExportXlsx(buildResult.buffer, buildResult.file_name, {
      folder,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // CR 5.2 P7 — `CONFIG_ERROR|...` est un préfixe signalé par le
    // wrapper upload-export quand une variable d'env critique manque.
    // On remap en 500 EXPORTS_FOLDER_NOT_CONFIGURED (fail-closed config)
    // au lieu de 502 ONEDRIVE_UPLOAD_FAILED (qui suggère retry à
    // l'opérateur — alors qu'un retry ne corrigera jamais une config).
    if (msg.startsWith('CONFIG_ERROR|')) {
      logger.error('export.config_missing', {
        requestId,
        supplier: supplierCode,
        reason: msg,
      })
      sendError(res, 'SERVER_ERROR', 'Configuration OneDrive manquante', requestId, {
        code: 'EXPORTS_FOLDER_NOT_CONFIGURED',
      })
      return
    }
    logger.error('export.onedrive_upload_failed', {
      requestId,
      supplier: supplierCode,
      period_from: body.period_from.toISOString(),
      period_to: body.period_to.toISOString(),
      folder,
      errorCode: 'ONEDRIVE_UPLOAD_FAILED',
      message: msg,
    })
    // AC #5 : 502 Bad Gateway — signale amont OneDrive indispo (pas 503
    // DEPENDENCY_DOWN par défaut du helper, cf. errors.ts). On émet
    // l'envelope d'erreur manuellement pour préserver le status 502.
    res.status(502).json(
      errorEnvelope('DEPENDENCY_DOWN', 'Upload OneDrive échoué', requestId, {
        code: 'ONEDRIVE_UPLOAD_FAILED',
      })
    )
    return
  }

  // --- INSERT supplier_exports ---
  const periodFromIso = toIsoDateUtc(body.period_from)
  const periodToIso = toIsoDateUtc(body.period_to)
  const { data: inserted, error: insertErr } = await admin
    .from('supplier_exports')
    .insert({
      supplier_code: supplierCode,
      format: body.format,
      period_from: periodFromIso,
      period_to: periodToIso,
      generated_by_operator_id: user.sub,
      onedrive_item_id: uploadResult.itemId,
      web_url: uploadResult.webUrl,
      file_name: buildResult.file_name,
      line_count: buildResult.line_count,
      total_amount_cents: buildResult.total_amount_cents.toString(),
    })
    .select('id, supplier_code, file_name, line_count, total_amount_cents, web_url, created_at')
    .single<{
      id: number
      supplier_code: string
      file_name: string
      line_count: number
      total_amount_cents: string | number
      web_url: string | null
      created_at: string
    }>()
  if (insertErr || !inserted) {
    logger.warn('export.orphan.onedrive', {
      requestId,
      supplier: supplierCode,
      itemId: uploadResult.itemId,
      webUrl: uploadResult.webUrl,
      reason: 'persist_failed',
      errorCode: 'PERSIST_FAILED',
      message: insertErr?.message ?? 'empty insert',
    })
    sendError(res, 'SERVER_ERROR', 'Persistance export échouée', requestId, {
      code: 'PERSIST_FAILED',
    })
    return
  }

  logger.info('export.generated', {
    requestId,
    supplier: supplierCode,
    exportId: inserted.id,
    lineCount: inserted.line_count,
    totalAmountCents:
      typeof inserted.total_amount_cents === 'string'
        ? inserted.total_amount_cents
        : String(inserted.total_amount_cents),
    actorOperatorId: user.sub,
  })

  const response: ExportSupplierResponse = {
    id: inserted.id,
    supplier_code: inserted.supplier_code,
    web_url: inserted.web_url ?? uploadResult.webUrl,
    file_name: inserted.file_name,
    line_count: inserted.line_count,
    total_amount_cents: String(inserted.total_amount_cents),
    created_at: inserted.created_at,
  }
  res.status(201).json({ data: response })
}

function joinPath(...parts: string[]): string {
  const joined = parts
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter((p) => p.length > 0)
    .join('/')
  return `/${joined}`
}

function toIsoDateUtc(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Handler complet (auth + rate-limit + core) — exporté vers `pilotage.ts`.
 * Pattern clé canonique Epic 4.5 : `export-supplier:{operator_id}:{supplier_code}`.
 * 3 exports max / minute / couple (operator, supplier) — empêche le clic
 * frénétique mais tolère un retry immédiate après 400/500.
 *
 * `withAuth` est appliqué ici en plus du router pour rendre le handler
 * testable directement (les tests unitaires passent un cookie sans router).
 * Le router pilotage.ts applique aussi withAuth — double vérification
 * inoffensive (cookie re-validé, user re-set, pas d'effet de bord).
 *
 * CR 5.2 P1 — la clé rate-limit est canonicalisée APRÈS validation de
 * format (`[A-Za-z_]+` + uppercase). Si le body contient un supplier au
 * format invalide (caractères non-whitelisted, array, null, absent), la
 * clé tombe sur le fallback `INVALID:<operatorId>` — bucket unique par
 * operator. Ainsi un attaquant ne peut PAS contourner le cap 3/min en
 * faisant tourner `FAKEA, FAKEB, FAKEC…` qui prennent chacun un bucket
 * distinct (l'ancienne implémentation `.trim().toUpperCase()` préservait
 * les variantes distinctes comme clés différentes).
 */
const VALID_SUPPLIER_RE = /^[A-Z_]+$/

function canonicalRateKey(req: ApiRequest): string | undefined {
  const user = req.user
  if (!user || user.type !== 'operator') return undefined
  const rawBody = req.body as { supplier?: unknown } | null | undefined
  const rawSupplier = typeof rawBody?.supplier === 'string' ? rawBody.supplier.trim() : ''
  const normalized = rawSupplier.toUpperCase()
  // Si le format pré-Zod est déjà invalide, on partage un bucket unique
  // par operator (évite l'évasion du cap via rotation de suppliers
  // invalides). Si le format est valide mais le code inconnu (UNKNOWN_SUPPLIER
  // détecté plus tard par `resolveSupplierConfig`), on bucket quand même
  // par operator seul pour la même raison.
  if (!VALID_SUPPLIER_RE.test(normalized)) {
    return `export-supplier:${user.sub}:INVALID`
  }
  return `export-supplier:${user.sub}:${normalized}`
}

export const exportSupplierHandler: ApiHandler = withAuth({ types: ['operator'] })(
  withRateLimit({
    bucketPrefix: 'export:supplier',
    keyFrom: canonicalRateKey,
    max: 3,
    window: '1m',
  })(coreHandler)
)

export { coreHandler as __exportSupplierCore }
