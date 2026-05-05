/**
 * Story 4.5 — pipeline asynchrone de génération PDF bon SAV.
 *
 *  1. Charger credit_note + sav + member + group + sav_lines + settings.company.*
 *  2. Résoudre is_group_manager + ensemble de props CreditNotePdf
 *  3. `ReactPDF.renderToBuffer(<CreditNotePdf …/>)`
 *  4. Construire le nom de fichier + le path OneDrive (`<root>/<YYYY>/<MM>/…`)
 *  5. `uploadCreditNotePdf(buffer, filename, { folder })` (retry ×3 exponentiel)
 *  6. `UPDATE credit_notes SET pdf_onedrive_item_id, pdf_web_url WHERE id = …`
 *
 * Idempotent : si `pdf_web_url IS NOT NULL` au (re)chargement → skip + log
 * `PDF_ALREADY_GENERATED_SKIP`. Protège contre un double-enqueue race 4.4.
 *
 * Fail-fast :
 *   - Clé `company.*` manquante ou toujours au placeholder `<à renseigner…>`
 *     → abort + log `PDF_GENERATION_FAILED|missing_company_key=…`.
 *   - Render PDF (step 3) échoue → log `PDF_RENDER_FAILED` + `throw` (bug
 *     template → pas de retry, réglage manuel requis).
 *   - Upload OneDrive échoue → retry ×3 (1s, 2s, 4s backoff) puis log
 *     `PDF_UPLOAD_FAILED` + `throw` (credit_note reste `pdf_web_url IS NULL`
 *     → endpoint `POST /regenerate-pdf` permet la relance manuelle AC #8).
 */
// V1.3 PATTERN-V3 — plus de top-level `import * as ReactPDF from '@react-pdf/renderer'`.
// Le module ESM-only est chargé en lazy via `await import()` à l'intérieur de
// `getReactPdf()` avec cache module-level (1 seul chargement par lifetime lambda).
// Cela brise la chain de transitivité qui causait ERR_REQUIRE_ESM au cold-start
// Vercel (build CJS) sans modifier les importers upstream (emit-handler.ts, etc.).
import type * as ReactPDFType from '@react-pdf/renderer'

import { supabaseAdmin } from '../clients/supabase-admin'
import { logger } from '../logger'
import { resolveSettingAt, type SettingRow } from '../business/settingsResolver'
import {
  buildCreditNotePdf,
  type CreditNotePdfCompany,
  type CreditNotePdfLine,
  type CreditNotePdfProps,
} from './CreditNotePdf'
import { buildPdfFilename } from './buildPdfFilename'
import { uploadCreditNotePdf } from '../onedrive-ts'

export interface GenerateCreditNotePdfArgs {
  credit_note_id: number
  sav_id: number
  request_id: string
}

const COMPANY_KEYS: readonly (keyof CreditNotePdfCompany)[] = [
  'legal_name',
  'siret',
  'tva_intra',
  'address_line1',
  'postal_code',
  'city',
  'phone',
  'email',
  'legal_mentions_short',
] as const

const PLACEHOLDER_PREFIX = '<à renseigner'
const COMPANY_SETTINGS_KEYS = [
  ...COMPANY_KEYS.map((k) => `company.${k}`),
  'onedrive.pdf_folder_root',
]
const DEFAULT_PDF_FOLDER_ROOT = '/SAV_PDF'

const RETRY_BACKOFFS_MS = [1000, 2000, 4000] as const

// Hook exposé pour injection en tests uniquement — surcharge le renderer.
type RenderToBuffer = (element: React.ReactElement) => Promise<Buffer>
type UploadFn = typeof uploadCreditNotePdf
type RefreshGraphTokenFn = () => Promise<unknown>

interface GenerateDeps {
  renderToBuffer?: RenderToBuffer
  upload?: UploadFn
  sleep?: (ms: number) => Promise<void>
  refreshGraphToken?: RefreshGraphTokenFn
}

let __deps: GenerateDeps = {}
/** Uniquement pour les tests — reset via `__setGeneratePdfDepsForTests({})`. */
export function __setGeneratePdfDepsForTests(deps: GenerateDeps): void {
  __deps = deps
}

// V1.3 HARDEN-5 — test accessor to inspect/reset the lazy module cache.
// Used in regression tests to assert that `getReactPdf()` was NOT called when
// `__deps.renderToBuffer` injection bypasses the lazy import path.
export function __getReactPdfCacheForTests(): typeof ReactPDFType | null {
  return _reactPdfCache
}
export function __resetReactPdfCacheForTests(): void {
  _reactPdfCache = null
}

// V1.3 PATTERN-V3 — lazy module cache (module-level, 1 seul await import() par
// lifetime lambda). Le premier call déclenche le chargement ESM ; les appels
// suivants retournent le cache. Compatible CJS Node 18/20 : `import()` dynamique
// est supporté depuis CJS (retourne une Promise) contrairement à `require()` sync.
let _reactPdfCache: typeof ReactPDFType | null = null
async function getReactPdf(): Promise<typeof ReactPDFType> {
  if (_reactPdfCache === null) {
    _reactPdfCache = (await import('@react-pdf/renderer')) as typeof ReactPDFType
  }
  return _reactPdfCache
}

async function getRender(): Promise<RenderToBuffer> {
  if (__deps.renderToBuffer !== undefined) return __deps.renderToBuffer
  const ReactPDF = await getReactPdf()
  return ReactPDF.renderToBuffer as unknown as RenderToBuffer
}
function getUpload(): UploadFn {
  return __deps.upload ?? uploadCreditNotePdf
}
function getSleep(): (ms: number) => Promise<void> {
  return __deps.sleep ?? defaultSleep
}
function getRefreshGraphToken(): RefreshGraphTokenFn {
  if (__deps.refreshGraphToken !== undefined) return __deps.refreshGraphToken
  return defaultRefreshGraphToken
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function defaultRefreshGraphToken(): Promise<unknown> {
  const graph = require('../graph.js') as { forceRefreshAccessToken: () => Promise<unknown> }
  return graph.forceRefreshAccessToken()
}

/**
 * W34 (2026-05-04) — classifie une erreur Graph API / OneDrive comme
 * transient (retry justifié) ou non-transient (short-circuit immédiat).
 *
 * Transient (retry) :
 *   - HTTP 408 / 429 / 502 / 503 / 504 (server errors retryables)
 *   - HTTP 401 (token possiblement expiré → W35 force MSAL refresh
 *     avant le retry suivant)
 *   - Autres HTTP 5xx (défaut conservatif sur erreurs serveur)
 *   - Network codes ECONNRESET / ETIMEDOUT / ENETUNREACH / EAI_AGAIN
 *   - Erreurs sans `statusCode`/`code` parsables → transient par défaut
 *     (préserve le comportement legacy `Error("OneDrive 500")` sans status)
 *
 * Non-transient (short-circuit) :
 *   - HTTP 400 / 403 / 404 / 413 (erreurs déterministes côté client)
 *   - Autres HTTP 4xx connus
 *   - Assertions locales (`"PDF dépasse 4 MB"`, `"réponse invalide"`,
 *     `"MICROSOFT_DRIVE_ID manquante"`) — bug code, retry inutile
 *
 * Référence : Microsoft Graph error handling docs (HTTP status codes).
 * Si une erreur 400 transient apparaît en pratique (ex: quota Graph
 * temporaire renvoyé en 400 atypique), réviser cette liste.
 */
export function isTransientGraphError(err: unknown): boolean {
  if (!(err instanceof Error)) return true
  const e = err as { statusCode?: unknown; code?: unknown; message?: string }
  // Assertions locales — short-circuit
  if (typeof e.message === 'string') {
    if (e.message.includes('dépasse') && e.message.includes('octets')) return false
    if (e.message.includes('réponse invalide pour upload')) return false
    if (e.message.includes('MICROSOFT_DRIVE_ID manquante')) return false
  }
  if (typeof e.statusCode === 'number') {
    if (e.statusCode === 401) return true // W35 — refreshable
    if ([408, 429, 502, 503, 504].includes(e.statusCode)) return true
    if ([400, 403, 404, 413].includes(e.statusCode)) return false
    if (e.statusCode >= 400 && e.statusCode < 500) return false
    if (e.statusCode >= 500) return true
  }
  if (typeof e.code === 'string') {
    if (['ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EAI_AGAIN'].includes(e.code)) return true
    return false
  }
  // Erreurs sans statusCode ni code (legacy `new Error("…")`) → conserver
  // le comportement de retry pour ne pas régresser les callers existants
  // qui throw sans enrichir l'objet erreur.
  return true
}

interface CreditNoteRow {
  id: number
  number: number
  number_formatted: string
  bon_type: 'AVOIR' | 'VIREMENT BANCAIRE' | 'PAYPAL'
  sav_id: number
  member_id: number
  total_ht_cents: number
  discount_cents: number
  vat_cents: number
  total_ttc_cents: number
  issued_at: string
  pdf_web_url: string | null
}

interface SavRow {
  id: number
  reference: string
  invoice_ref: string | null
  invoice_fdp_cents: number | null
  member_id: number
  group_id: number | null
}

interface MemberRow {
  id: number
  first_name: string | null
  last_name: string
  email: string
  phone: string | null
  group_id: number | null
  is_group_manager: boolean | null
}

interface GroupRow {
  id: number
  name: string
}

interface SavLineRow {
  line_number: number | null
  position: number | null
  product_code_snapshot: string
  product_name_snapshot: string
  qty_requested: number
  unit_requested: 'kg' | 'piece' | 'liter'
  qty_invoiced: number | null
  unit_invoiced: 'kg' | 'piece' | 'liter' | null
  unit_price_ht_cents_snapshot: number | null
  credit_coefficient: number | string
  credit_coefficient_label: string | null
  credit_amount_cents: number | null
  validation_message: string | null
}

interface SettingsRawRow {
  key: string
  value: unknown
  valid_from: string
  valid_to: string | null
}

export async function generateCreditNotePdfAsync(args: GenerateCreditNotePdfArgs): Promise<void> {
  const { credit_note_id, sav_id, request_id } = args
  const startedAt = Date.now()
  const admin = supabaseAdmin()

  // ---- 1. Idempotence check -------------------------------------------
  const { data: cnData, error: cnError } = await admin
    .from('credit_notes')
    .select(
      'id, number, number_formatted, bon_type, sav_id, member_id, total_ht_cents, discount_cents, vat_cents, total_ttc_cents, issued_at, pdf_web_url'
    )
    .eq('id', credit_note_id)
    .limit(1)
    .maybeSingle()
  if (cnError) {
    logger.error('PDF_GENERATION_FAILED', {
      requestId: request_id,
      creditNoteId: credit_note_id,
      savId: sav_id,
      reason: 'credit_note_query_failed',
      message: cnError.message,
    })
    throw new Error(`PDF_GENERATION_FAILED|credit_note_query_failed|${cnError.message}`)
  }
  const cn = (cnData ?? null) as CreditNoteRow | null
  if (cn === null) {
    logger.error('PDF_GENERATION_FAILED', {
      requestId: request_id,
      creditNoteId: credit_note_id,
      savId: sav_id,
      reason: 'credit_note_not_found',
    })
    throw new Error(`PDF_GENERATION_FAILED|credit_note_not_found|id=${credit_note_id}`)
  }
  if (cn.pdf_web_url !== null) {
    logger.info('PDF_ALREADY_GENERATED_SKIP', {
      requestId: request_id,
      creditNoteId: credit_note_id,
      savId: sav_id,
    })
    return
  }

  // ---- 2. Fetch parallèle : sav + member + lines + settings ----------
  const nowIso = new Date().toISOString()
  const [savResult, memberResult, linesResult, settingsResult] = await Promise.all([
    admin
      .from('sav')
      .select('id, reference, invoice_ref, invoice_fdp_cents, member_id, group_id')
      .eq('id', sav_id)
      .limit(1)
      .maybeSingle(),
    admin
      .from('members')
      .select('id, first_name, last_name, email, phone, group_id, is_group_manager')
      .eq('id', cn.member_id)
      .limit(1)
      .maybeSingle(),
    admin
      .from('sav_lines')
      .select(
        'line_number, position, product_code_snapshot, product_name_snapshot, ' +
          'qty_requested, unit_requested, qty_invoiced, unit_invoiced, ' +
          'unit_price_ht_cents_snapshot, credit_coefficient, credit_coefficient_label, ' +
          'credit_amount_cents, validation_message'
      )
      .eq('sav_id', sav_id)
      .order('line_number', { ascending: true }),
    admin
      .from('settings')
      .select('key, value, valid_from, valid_to')
      .in('key', COMPANY_SETTINGS_KEYS)
      .lte('valid_from', nowIso)
      .or(`valid_to.is.null,valid_to.gt.${nowIso}`),
  ])

  if (savResult.error) {
    logger.error('PDF_GENERATION_FAILED', {
      requestId: request_id,
      creditNoteId: credit_note_id,
      savId: sav_id,
      reason: 'sav_query_failed',
      message: savResult.error.message,
    })
    throw new Error(`PDF_GENERATION_FAILED|sav_query_failed|${savResult.error.message}`)
  }
  const sav = (savResult.data ?? null) as SavRow | null
  if (sav === null) {
    logger.error('PDF_GENERATION_FAILED', {
      requestId: request_id,
      creditNoteId: credit_note_id,
      savId: sav_id,
      reason: 'sav_not_found',
    })
    throw new Error(`PDF_GENERATION_FAILED|sav_not_found|id=${sav_id}`)
  }

  if (memberResult.error) {
    logger.error('PDF_GENERATION_FAILED', {
      requestId: request_id,
      creditNoteId: credit_note_id,
      savId: sav_id,
      reason: 'member_query_failed',
      message: memberResult.error.message,
    })
    throw new Error(`PDF_GENERATION_FAILED|member_query_failed|${memberResult.error.message}`)
  }
  const member = (memberResult.data ?? null) as MemberRow | null
  if (member === null) {
    logger.error('PDF_GENERATION_FAILED', {
      requestId: request_id,
      creditNoteId: credit_note_id,
      savId: sav_id,
      reason: 'member_not_found',
    })
    throw new Error(`PDF_GENERATION_FAILED|member_not_found|id=${cn.member_id}`)
  }

  if (linesResult.error) {
    logger.error('PDF_GENERATION_FAILED', {
      requestId: request_id,
      creditNoteId: credit_note_id,
      savId: sav_id,
      reason: 'lines_query_failed',
      message: linesResult.error.message,
    })
    throw new Error(`PDF_GENERATION_FAILED|lines_query_failed|${linesResult.error.message}`)
  }
  const linesRaw = (linesResult.data ?? []) as unknown as SavLineRow[]

  if (settingsResult.error) {
    logger.error('PDF_GENERATION_FAILED', {
      requestId: request_id,
      creditNoteId: credit_note_id,
      savId: sav_id,
      reason: 'settings_query_failed',
      message: settingsResult.error.message,
    })
    throw new Error(`PDF_GENERATION_FAILED|settings_query_failed|${settingsResult.error.message}`)
  }

  // ---- 3. Résolution groupe (optionnel) -------------------------------
  let group: GroupRow | null = null
  if (sav.group_id !== null) {
    const { data: gData, error: gError } = await admin
      .from('groups')
      .select('id, name')
      .eq('id', sav.group_id)
      .limit(1)
      .maybeSingle()
    if (gError) {
      logger.warn('PDF_GROUP_LOOKUP_FAILED', {
        requestId: request_id,
        creditNoteId: credit_note_id,
        savId: sav_id,
        message: gError.message,
      })
      // non bloquant : on rend sans nom de groupe
    } else if (gData !== null) {
      group = gData as GroupRow
    }
  }

  // ---- 4. Company (settings) + fail-closed placeholder ----------------
  const settingsRows: SettingRow[] = ((settingsResult.data ?? []) as SettingsRawRow[]).map((r) => ({
    key: r.key,
    value: r.value,
    valid_from: r.valid_from,
    valid_to: r.valid_to,
  }))

  const company = {} as Record<string, string>
  for (const k of COMPANY_KEYS) {
    const raw = resolveSettingAt<unknown>(settingsRows, `company.${k}`)
    if (typeof raw !== 'string' || raw.length === 0) {
      logger.error('PDF_GENERATION_FAILED', {
        requestId: request_id,
        creditNoteId: credit_note_id,
        savId: sav_id,
        reason: 'missing_company_key',
        missing_company_key: k,
      })
      throw new Error(`PDF_GENERATION_FAILED|missing_company_key=${k}`)
    }
    if (raw.startsWith(PLACEHOLDER_PREFIX)) {
      logger.error('PDF_GENERATION_FAILED', {
        requestId: request_id,
        creditNoteId: credit_note_id,
        savId: sav_id,
        reason: 'placeholder_company_key',
        missing_company_key: k,
      })
      throw new Error(`PDF_GENERATION_FAILED|missing_company_key=${k}`)
    }
    company[k] = raw
  }

  // CR 4.5 P4 : defense-in-depth sur `onedrive.pdf_folder_root`.
  // Settings venus de la DB admin = trusted, mais le fail-fast sur valeur
  // non-string ou path-traversal évite un upload OneDrive silencieux vers
  // un dossier inattendu en cas d'UPDATE maladroit (ou compromis admin).
  const folderRootRaw = resolveSettingAt<unknown>(settingsRows, 'onedrive.pdf_folder_root')
  let folderRoot: string
  if (folderRootRaw === null || folderRootRaw === undefined) {
    folderRoot = DEFAULT_PDF_FOLDER_ROOT
  } else if (typeof folderRootRaw !== 'string' || folderRootRaw.length === 0) {
    logger.error('PDF_GENERATION_FAILED', {
      requestId: request_id,
      creditNoteId: credit_note_id,
      savId: sav_id,
      reason: 'invalid_folder_root_type',
    })
    throw new Error(`PDF_GENERATION_FAILED|invalid_folder_root_type`)
  } else if (/(^|\/)\.\.(\/|$)|\0/.test(folderRootRaw)) {
    // Reject `..` segments et null bytes (path traversal defense-in-depth).
    logger.error('PDF_GENERATION_FAILED', {
      requestId: request_id,
      creditNoteId: credit_note_id,
      savId: sav_id,
      reason: 'invalid_folder_root_traversal',
      folder_root_prefix: folderRootRaw.slice(0, 32),
    })
    throw new Error(`PDF_GENERATION_FAILED|invalid_folder_root_traversal`)
  } else {
    folderRoot = folderRootRaw
  }

  // ---- 5. is_group_manager dérivé du credit_note (pas du flag member live) -
  // CR 4.5 P6 : la remise est figée dans `credit_notes.discount_cents` à
  // l'émission Story 4.4. Si l'admin révoque le flag `is_group_manager`
  // entre émission et (re)génération PDF, le PDF doit rester cohérent avec
  // le row credit_note (sinon divergence visible/comptable : la colonne
  // "Remise 4 %" disparaîtrait alors que le total TTC inclut bien la
  // remise). On affiche donc le bloc remise IFF `discount_cents > 0`.
  const isGroupManager = Number(cn.discount_cents) > 0

  // ---- 6. Build props + render ----------------------------------------
  // CR 4.5 P8 : fallback `line_number` déterministe. L'ancien
  // `(position ?? 0) + 1 + idx` produisait des doublons quand seulement
  // certaines lignes avaient un `line_number` NULL. Après l'`ORDER BY
  // line_number ASC` (NULLs LAST postgres), `idx + 1` garantit des
  // line_numbers uniques dans la sortie PDF — même si la valeur diffère
  // du `position` DB (c'est acceptable : le bon SAV re-numérote
  // proprement pour l'affichage).
  const lines: CreditNotePdfLine[] = linesRaw.map((l, idx) => ({
    line_number: l.line_number !== null ? l.line_number : idx + 1,
    product_code_snapshot: l.product_code_snapshot,
    product_name_snapshot: l.product_name_snapshot,
    qty_requested: Number(l.qty_requested),
    unit_requested: l.unit_requested,
    qty_invoiced: l.qty_invoiced !== null ? Number(l.qty_invoiced) : null,
    unit_invoiced: l.unit_invoiced,
    unit_price_ht_cents:
      l.unit_price_ht_cents_snapshot !== null ? Number(l.unit_price_ht_cents_snapshot) : null,
    credit_coefficient:
      typeof l.credit_coefficient === 'string'
        ? Number(l.credit_coefficient)
        : l.credit_coefficient,
    credit_coefficient_label: l.credit_coefficient_label,
    credit_amount_cents: l.credit_amount_cents !== null ? Number(l.credit_amount_cents) : null,
    validation_message: l.validation_message,
  }))

  const props: CreditNotePdfProps = {
    creditNote: {
      id: cn.id,
      number: cn.number,
      number_formatted: cn.number_formatted,
      bon_type: cn.bon_type,
      total_ht_cents: Number(cn.total_ht_cents),
      discount_cents: Number(cn.discount_cents),
      vat_cents: Number(cn.vat_cents),
      total_ttc_cents: Number(cn.total_ttc_cents),
      issued_at: cn.issued_at,
    },
    sav: {
      reference: sav.reference,
      invoice_ref: sav.invoice_ref,
      invoice_fdp_cents: sav.invoice_fdp_cents !== null ? Number(sav.invoice_fdp_cents) : null,
    },
    member: {
      first_name: member.first_name,
      last_name: member.last_name,
      email: member.email,
      phone: member.phone,
      address_line1: null,
      address_line2: null,
      postal_code: null,
      city: null,
    },
    group: group === null ? null : { name: group.name },
    lines,
    company: company as unknown as CreditNotePdfCompany,
    is_group_manager: isGroupManager,
  }

  // CR 4.5 P10 : guard NaN sur tous les totaux avant render.
  // `Number(BIGINT)` retourne NaN sur input invalide (driver edge case).
  // Un "NaN €" sur un document fiscal est inacceptable.
  for (const [k, v] of Object.entries(props.creditNote) as Array<[string, unknown]>) {
    if (k.endsWith('_cents') && (typeof v !== 'number' || !Number.isFinite(v))) {
      logger.error('PDF_GENERATION_FAILED', {
        requestId: request_id,
        creditNoteId: credit_note_id,
        savId: sav_id,
        reason: 'invalid_totals',
        field: k,
        value: String(v),
      })
      throw new Error(`PDF_GENERATION_FAILED|invalid_totals|${k}`)
    }
  }

  let buffer: Buffer
  try {
    // V1.3 PATTERN-V3 — résoudre le module ESM-only en lazy (1 seul await
    // import() par lifetime lambda via cache module-level `_reactPdfCache`).
    // `getRender()` court-circuite vers `__deps.renderToBuffer` si injecté
    // (Story 4.5 test injection contrat — préservé ici).
    //
    // V1.3 HARDEN-5 — if `__deps.renderToBuffer` is injected, skip `getReactPdf()`
    // and `buildCreditNotePdf()` entirely. The injected mock does not read its argument
    // (vi.fn() returning Buffer.from(...) unconditionally), so passing null is safe.
    // This ensures test envs without @react-pdf/renderer installed don't fail despite
    // the injection.
    const render = await getRender()
    if (__deps.renderToBuffer !== undefined) {
      // Test injection path — skip lazy ESM import + buildCreditNotePdf entirely.
      buffer = await render(null as unknown as React.ReactElement)
    } else {
      const ReactPDF = await getReactPdf()
      const renderElement = buildCreditNotePdf(ReactPDF, props)
      buffer = await render(renderElement as unknown as React.ReactElement)
    }
  } catch (err) {
    logger.error('PDF_RENDER_FAILED', {
      requestId: request_id,
      creditNoteId: credit_note_id,
      savId: sav_id,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    })
    throw new Error(`PDF_RENDER_FAILED|${err instanceof Error ? err.message : String(err)}`)
  }

  // ---- 7. Filename + folder path --------------------------------------
  // CR 4.5 P7 : guard `issued_at` invalide. Sans ce filet, un timestamp
  // corrompu produit `/SAV_PDF/NaN/NaN/...pdf` qui serait créé réellement
  // sur OneDrive (dossier littéral "NaN").
  const issued = new Date(cn.issued_at)
  if (!Number.isFinite(issued.getTime())) {
    logger.error('PDF_GENERATION_FAILED', {
      requestId: request_id,
      creditNoteId: credit_note_id,
      savId: sav_id,
      reason: 'invalid_issued_at',
      issued_at_raw: String(cn.issued_at).slice(0, 40),
    })
    throw new Error(`PDF_GENERATION_FAILED|invalid_issued_at`)
  }
  const year = String(issued.getUTCFullYear())
  const month = String(issued.getUTCMonth() + 1).padStart(2, '0')
  const folder = joinPath(folderRoot, year, month)
  const filename = buildPdfFilename({
    number_formatted: cn.number_formatted,
    first_name: member.first_name,
    last_name: member.last_name,
  })

  // ---- 8. Upload OneDrive avec retry ×3 exponentiel + classification --
  // W34 : `isTransientGraphError` short-circuit sur erreurs déterministes
  //       (400/403/404/413, assertions locales) → 1 seule tentative au lieu
  //       de gaspiller le budget lambda sur 3 retry sans espoir.
  // W35 : sur 401, force MSAL `forceRefreshAccessToken` AVANT le retry
  //       suivant (cas token expiré côté Microsoft alors que MSAL local
  //       le cache encore comme valide).
  let uploadResult: Awaited<ReturnType<UploadFn>> | null = null
  let lastError: Error | null = null
  let attempts_used = 0
  for (let attempt = 0; attempt < RETRY_BACKOFFS_MS.length; attempt++) {
    attempts_used = attempt + 1
    try {
      uploadResult = await getUpload()(buffer, filename, { folder })
      lastError = null
      break
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      const transient = isTransientGraphError(lastError)
      const statusCode = (lastError as { statusCode?: unknown }).statusCode
      logger.warn('PDF_UPLOAD_RETRY', {
        requestId: request_id,
        creditNoteId: credit_note_id,
        savId: sav_id,
        attempt: attempt + 1,
        maxAttempts: RETRY_BACKOFFS_MS.length,
        transient,
        statusCode: typeof statusCode === 'number' ? statusCode : null,
        message: lastError.message,
      })

      if (!transient) {
        // W34 short-circuit : erreur déterministe, raise immédiatement
        // sans consommer les retry restants (gain ~7s lambda budget).
        logger.error('PDF_UPLOAD_FAILED', {
          requestId: request_id,
          creditNoteId: credit_note_id,
          savId: sav_id,
          attempts: attempts_used,
          lastError: lastError.message,
          reason: 'non_transient_short_circuit',
        })
        throw new Error(`PDF_UPLOAD_FAILED|${lastError.message}`)
      }

      // W35 : 401 → force refresh token MSAL avant le retry suivant.
      if (statusCode === 401 && attempt < RETRY_BACKOFFS_MS.length - 1) {
        try {
          await getRefreshGraphToken()()
          logger.warn('PDF_UPLOAD_TOKEN_REFRESHED', {
            requestId: request_id,
            creditNoteId: credit_note_id,
            savId: sav_id,
            attempt: attempt + 1,
          })
        } catch (refreshErr) {
          // Refresh échoué : on continue le retry standard (ne masque pas
          // l'erreur 401 originale, le prochain attempt remontera la même).
          logger.warn('PDF_UPLOAD_TOKEN_REFRESH_FAILED', {
            requestId: request_id,
            creditNoteId: credit_note_id,
            savId: sav_id,
            attempt: attempt + 1,
            message: refreshErr instanceof Error ? refreshErr.message : String(refreshErr),
          })
        }
      }

      if (attempt < RETRY_BACKOFFS_MS.length - 1) {
        await getSleep()(RETRY_BACKOFFS_MS[attempt] as number)
      }
    }
  }
  if (uploadResult === null) {
    logger.error('PDF_UPLOAD_FAILED', {
      requestId: request_id,
      creditNoteId: credit_note_id,
      savId: sav_id,
      attempts: attempts_used,
      lastError: lastError === null ? 'unknown' : lastError.message,
    })
    throw new Error(`PDF_UPLOAD_FAILED|${lastError === null ? 'unknown' : lastError.message}`)
  }

  // ---- 9. UPDATE credit_notes -----------------------------------------
  // CR 4.5 P3 : UPDATE conditionnel sur `pdf_web_url IS NULL` pour éviter
  // d'écraser un PDF déjà généré par une Lambda concurrente (race emit +
  // regenerate ou 2 regenerate simultanés). Si 0 row affectée, on vient
  // de créer un orphelin OneDrive → log `PDF_UPLOAD_ORPHANED` pour qu'un
  // job de cleanup Epic 7 puisse le détecter (l'itemId est dans le log).
  const { data: updData, error: updError } = await admin
    .from('credit_notes')
    .update({
      pdf_onedrive_item_id: uploadResult.itemId,
      pdf_web_url: uploadResult.webUrl,
    })
    .eq('id', credit_note_id)
    .is('pdf_web_url', null)
    .select('id')
  if (!updError && Array.isArray(updData) && updData.length === 0) {
    logger.warn('PDF_UPLOAD_ORPHANED', {
      requestId: request_id,
      creditNoteId: credit_note_id,
      savId: sav_id,
      itemId: uploadResult.itemId,
      webUrl: uploadResult.webUrl,
      reason: 'concurrent_generation_won_race',
    })
    // Pas d'erreur retournée à l'appelant : la génération "gagne" via
    // la première Lambda qui a fini. Le caller (regenerate handler) va
    // re-SELECT et voir le webUrl de la Lambda gagnante — comportement
    // correct vis-à-vis de l'opérateur.
    return
  }
  if (updError) {
    logger.error('PDF_UPDATE_FAILED', {
      requestId: request_id,
      creditNoteId: credit_note_id,
      savId: sav_id,
      message: updError.message,
    })
    throw new Error(`PDF_UPDATE_FAILED|${updError.message}`)
  }

  const durationMs = Date.now() - startedAt
  logger.info('PDF_GENERATED', {
    requestId: request_id,
    creditNoteId: credit_note_id,
    savId: sav_id,
    numberFormatted: cn.number_formatted,
    filename,
    folder,
    itemId: uploadResult.itemId,
    durationMs,
    bytes: buffer.byteLength,
  })
}

function joinPath(...parts: string[]): string {
  // Normalise `/` en début, strip trailing, collapse `//`.
  const joined = parts
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter((p) => p.length > 0)
    .join('/')
  return `/${joined}`
}
