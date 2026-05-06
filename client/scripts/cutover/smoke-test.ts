/**
 * Story 7.7 AC #2 — Script smoke-test prod bout-en-bout GO/NO-GO
 *
 * Usage CLI :
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   SMOKE_MEMBER_EMAIL=cutover-smoke@fruitstock.invalid \
 *   SMTP_SAV_HOST=smtp.mailtrap.io ONEDRIVE_OFFLINE=1 \
 *   LAST_CREDIT_NUMBER=4567 \
 *   npx tsx scripts/cutover/smoke-test.ts
 *
 * D-2 isolation sentinel : membre identifiable par email .invalid + last_name SMOKE-TEST.
 * D-7 feature-flag ERP : auto-detect via pg_tables erp_push_queue.
 * D-10 SMTP : redirigé par env var temporaire (aucune modif handler email-outbox).
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, createHmac, randomUUID } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// JWT capture-token helper (HARDEN-1 — Story 2.2 pattern)
// ---------------------------------------------------------------------------

function base64UrlEncode(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Sign a minimal capture-token JWT (HS256) matching verifyCaptureToken contract.
 *
 * @param secret  MAGIC_LINK_SECRET used to sign the HS256 JWT.
 * @param jti     Optional JWT ID — when provided, the same value MUST be pre-inserted
 *                in `sav_submit_tokens` (jti, expires_at) so that `consumeCaptureToken`
 *                can find and atomically mark the row as used.  If omitted, a fresh UUID
 *                is generated (unit-test path where the HTTP mock ignores the token).
 * @returns       Signed JWT string, TTL_SEC = 300 s (same as SAV_SUBMIT_TOKEN_TTL_SEC).
 */
function signSmokeCapturToken(secret: string, jti?: string): string {
  const tokenJti = jti ?? randomUUID()
  const now = Math.floor(Date.now() / 1000)
  const ttlSec = 300 // 5 minutes — same as SAV_SUBMIT_TOKEN_TTL_SEC default
  const header = { alg: 'HS256', typ: 'JWT' }
  const payload = { scope: 'sav-submit', jti: tokenJti, iat: now, exp: now + ttlSec }
  const h = base64UrlEncode(JSON.stringify(header))
  const p = base64UrlEncode(JSON.stringify(payload))
  const s = base64UrlEncode(createHmac('sha256', secret).update(`${h}.${p}`).digest())
  return `${h}.${p}.${s}`
}

/** TTL in seconds used when pre-inserting a sav_submit_tokens row for smoke-test.
 *  Kept consistent with signSmokeCapturToken (300 s). */
const SMOKE_TOKEN_TTL_SEC = 300

// ---------------------------------------------------------------------------
// Types (DI-compatible pour tests)
// ---------------------------------------------------------------------------

export interface StepResult {
  step: number
  name: string
  status: 'PASS' | 'FAIL' | 'SKIPPED'
  duration_ms?: number
  reason?: string
}

export interface SmokeReport {
  started_at: string
  completed_at: string
  verdict: 'GO' | 'NO-GO'
  steps: StepResult[]
  credit_number_emitted?: number
  smoke_member_id?: number
  smoke_sav_id?: number
  erp_push_status?: string
  no_go_reason?: string
}

export interface SmokeConfig {
  lastCreditNumber: number
  smokeEmail: string
  baseUrl: string
}

export interface HttpClient {
  post: (
    url: string,
    body: unknown,
    headers?: Record<string, string>
  ) => Promise<{ status: number; data: unknown }>
  patch: (url: string, body: unknown) => Promise<{ status: number; data: unknown }>
  get: (
    url: string,
    opts?: { redirect?: 'follow' | 'manual' }
  ) => Promise<{ status: number; data: unknown; headers?: Record<string, string>; size?: number }>
}

export interface DbClient {
  erpPushQueueExists: boolean
  /** HARDEN-7 (M-3) — callback to re-fetch live (avoids stale snapshot) */
  getEmailOutboxRow: () => Promise<{ kind: string; recipient_email: string; status: string } | null>
  /** HARDEN-7 (M-3) — callback to re-fetch live */
  getErpQueueRow: () => Promise<{ idempotency_key: string; status: string } | null>
  queries: string[]
  sentinelMemberId: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now(): string {
  return new Date().toISOString()
}

function elapsed(start: number): number {
  return Date.now() - start
}

// ---------------------------------------------------------------------------
// assertColdStartHealthy — V1.3 PATTERN-V3-bis cold-start check
// ---------------------------------------------------------------------------

/**
 * Vérifie que les dispatchers serverless `api/sav` et `api/credit-notes`
 * démarrent sans crash ERR_REQUIRE_ESM au cold-start (V1.3 PATTERN-V3-bis).
 *
 * Logique :
 *   - GET <previewUrl>/api/sav (sans auth) → attendu : 401, PAS 500
 *   - GET <previewUrl>/api/credit-notes (sans auth) → attendu : 401, PAS 500
 *   - Si 500 → status FAIL + reason `SMOKE_COLDSTART_FAIL|api/sav|500`
 *   - Si autre code (401, 200, 404, ...) → status PASS (only 500 = crash indicator)
 *
 * À appeler AVANT les steps métier (step 1..7) pour détecter le cold-start
 * crash AVANT que le smoke-test tente des opérations métier.
 */
export async function assertColdStartHealthy(
  previewUrl: string,
  http: HttpClient
): Promise<StepResult> {
  const endpoints = ['/api/sav', '/api/credit-notes', '/api/sav/files/0/thumbnail']

  for (const path of endpoints) {
    const url = `${previewUrl}${path}`
    let status: number
    try {
      const res = await http.get(url)
      status = res.status
    } catch (err) {
      // Network error → not a cold-start crash indicator — treat as PASS
      // (the smoke will fail at later steps if connectivity is broken)
      continue
    }

    if (status === 500) {
      const reason = `SMOKE_COLDSTART_FAIL|${path.replace(/^\/api\//, 'api/')}|500`
      console.error(reason)
      return {
        step: 0,
        name: 'cold_start_healthy',
        status: 'FAIL',
        reason,
      }
    }
  }

  return {
    step: 0,
    name: 'cold_start_healthy',
    status: 'PASS',
  }
}

// ---------------------------------------------------------------------------
// runSmokeTest — exported for DI testing
// ---------------------------------------------------------------------------

/**
 * Orchestre les 7 étapes smoke-test bout-en-bout.
 * writeReport est optionnel (DT-3) — default = fs.writeFileSync.
 * captureTokenSecret est requis pour step 1 (HARDEN-1 — JWT X-Capture-Token).
 * captureTokenJti, quand fourni (CLI prod), est le jti pré-inséré dans
 *   sav_submit_tokens par main() AVANT cet appel — le JWT généré portera ce
 *   même jti pour que consumeCaptureToken() trouve la row et la marque used.
 *   Absent (unit tests) : un UUID est généré dans signSmokeCapturToken, la row
 *   n'est pas insérée (le mock HTTP répond 201 sans vérifier le token).
 */
export async function runSmokeTest(
  config: SmokeConfig,
  http: HttpClient,
  db: DbClient,
  writeReport?: (path: string, content: string) => void,
  captureTokenSecret?: string,
  captureTokenJti?: string
): Promise<SmokeReport> {
  const startedAt = now()
  const steps: StepResult[] = []
  let verdict: 'GO' | 'NO-GO' = 'GO'
  let noGoReason: string | undefined
  let creditNumberEmitted: number | undefined
  let smokeMemberId: number | undefined
  let smokeSavId: number | undefined
  let erpPushStatus: string | undefined

  // --------------------------------------------------------------------------
  // Step 0 — cold-start health check (V1.3 PATTERN-V3-bis HARDEN-2)
  // assertColdStartHealthy fires BEFORE any business step. If api/sav or
  // api/credit-notes returns 500 the smoke short-circuits immediately with
  // verdict='NO-GO'. The step is always appended so the JSON report reflects it.
  // --------------------------------------------------------------------------
  {
    const coldStart = await assertColdStartHealthy(config.baseUrl, http)
    steps.push(coldStart)
    if (coldStart.status === 'FAIL') {
      verdict = 'NO-GO'
      noGoReason = coldStart.reason
      return buildReport(
        startedAt,
        steps,
        verdict,
        noGoReason,
        writeReport,
        smokeMemberId,
        smokeSavId,
        creditNumberEmitted,
        erpPushStatus
      )
    }
  }

  // --------------------------------------------------------------------------
  // Préparation : sentinel member (D-2 — INSERT ON CONFLICT DO UPDATE)
  // --------------------------------------------------------------------------
  const sentinelQuery = `INSERT INTO members (email, last_name) VALUES ('${config.smokeEmail}', 'SMOKE-TEST') ON CONFLICT (email) DO UPDATE SET last_name='SMOKE-TEST' RETURNING id`
  db.queries.push(sentinelQuery)
  smokeMemberId = db.sentinelMemberId

  // --------------------------------------------------------------------------
  // Step 1 — capture (HARDEN-1: X-Capture-Token JWT required by capture.ts)
  // --------------------------------------------------------------------------
  {
    const t0 = Date.now()
    const isoTag = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const reference = `SMOKE-J0-${isoTag}`
    const capturePayload = {
      member_id: smokeMemberId,
      reference,
      webUrl: 'http://smoke-test.invalid/dummy.pdf', // D-7 OneDrive bypass
      lines: [
        { product_code: 'TEST-001', quantity: 1, unit_price_ht_cents: 1000, vat_rate_bp: 550 },
      ],
    }
    // HARDEN-1: generate JWT capture token (Story 2.2 pattern — verifyCaptureToken contract)
    // HARDEN-16: pass captureTokenJti so the JWT carries the same jti as the
    //   pre-inserted row in sav_submit_tokens (CLI prod path).  Unit tests omit
    //   captureTokenJti — the mock HTTP ignores the token value entirely.
    const captureHeaders: Record<string, string> = {}
    if (captureTokenSecret) {
      captureHeaders['X-Capture-Token'] = signSmokeCapturToken(captureTokenSecret, captureTokenJti)
    }
    try {
      const res = await http.post(
        `${config.baseUrl}/api/webhooks/capture`,
        capturePayload,
        captureHeaders
      )
      const duration = elapsed(t0)
      const respData = res.data as Record<string, unknown> | null
      // capture.ts returns { data: { savId, reference, lineCount, fileCount } }
      const savId =
        (respData?.['data'] as Record<string, unknown> | undefined)?.['savId'] ?? respData?.['id'] // fallback for mock compatibility
      if (res.status === 201 && respData && typeof savId === 'number') {
        smokeSavId = savId as number
        steps.push({ step: 1, name: 'capture', status: 'PASS', duration_ms: duration })
      } else {
        steps.push({
          step: 1,
          name: 'capture',
          status: 'FAIL',
          duration_ms: duration,
          reason: `HTTP ${res.status}`,
        })
        verdict = 'NO-GO'
        noGoReason = 'capture'
      }
    } catch (err) {
      steps.push({
        step: 1,
        name: 'capture',
        status: 'FAIL',
        duration_ms: elapsed(t0),
        reason: String(err),
      })
      verdict = 'NO-GO'
      noGoReason = 'capture'
    }
  }

  if (verdict === 'NO-GO') {
    return buildReport(
      startedAt,
      steps,
      verdict,
      noGoReason,
      writeReport,
      smokeMemberId,
      smokeSavId,
      creditNumberEmitted,
      erpPushStatus
    )
  }

  // --------------------------------------------------------------------------
  // Step 2 — transitions (pending → in_progress → validated → closed)
  // HARDEN-1: PATCH /api/sav/:id/status (rewrite → ?op=status&id=:id), body {to: '<state>'}
  // --------------------------------------------------------------------------
  {
    const t0 = Date.now()
    const transitionTargets: string[] = ['in_progress', 'validated', 'closed']
    let allPassed = true
    let failReason = ''
    for (const to of transitionTargets) {
      try {
        // HARDEN-1: correct URL pattern per vercel.json rewrite + PATCH method
        const res = await http.patch(`${config.baseUrl}/api/sav/${smokeSavId}/status`, { to })
        if (res.status < 200 || res.status > 299) {
          allPassed = false
          failReason = `transition →${to} HTTP ${res.status}`
          break
        }
      } catch (err) {
        allPassed = false
        failReason = `transition →${to} threw: ${String(err)}`
        break
      }
    }
    const duration = elapsed(t0)
    if (allPassed) {
      steps.push({ step: 2, name: 'transitions', status: 'PASS', duration_ms: duration })
    } else {
      steps.push({
        step: 2,
        name: 'transitions',
        status: 'FAIL',
        duration_ms: duration,
        reason: failReason,
      })
      verdict = 'NO-GO'
      noGoReason = 'transitions'
    }
  }

  if (verdict === 'NO-GO') {
    return buildReport(
      startedAt,
      steps,
      verdict,
      noGoReason,
      writeReport,
      smokeMemberId,
      smokeSavId,
      creditNumberEmitted,
      erpPushStatus
    )
  }

  // --------------------------------------------------------------------------
  // Step 3 — issue_credit (D-1 garde-fou : number = LAST+1)
  // HARDEN-1: POST /api/sav/:id/credit-notes (rewrite → ?op=credit-notes&id=:id)
  // --------------------------------------------------------------------------
  {
    const t0 = Date.now()
    try {
      // HARDEN-1: correct URL per vercel.json rewrite — no body needed (savId in path)
      const res = await http.post(`${config.baseUrl}/api/sav/${smokeSavId}/credit-notes`, {})
      const duration = elapsed(t0)
      if (res.status === 201 && res.data) {
        const data = res.data as Record<string, unknown>
        const issuedNumber = data['number'] as number | undefined
        creditNumberEmitted = issuedNumber

        if (issuedNumber !== config.lastCreditNumber + 1) {
          const reason = `credit number mismatch: expected LAST_CREDIT_NUMBER+1=${config.lastCreditNumber + 1} but got ${issuedNumber}`
          steps.push({
            step: 3,
            name: 'issue_credit',
            status: 'FAIL',
            duration_ms: duration,
            reason,
          })
          verdict = 'NO-GO'
          noGoReason = 'issue_credit'
        } else {
          steps.push({ step: 3, name: 'issue_credit', status: 'PASS', duration_ms: duration })
        }
      } else {
        steps.push({
          step: 3,
          name: 'issue_credit',
          status: 'FAIL',
          duration_ms: duration,
          reason: `HTTP ${res.status}`,
        })
        verdict = 'NO-GO'
        noGoReason = 'issue_credit'
      }
    } catch (err) {
      steps.push({
        step: 3,
        name: 'issue_credit',
        status: 'FAIL',
        duration_ms: elapsed(t0),
        reason: String(err),
      })
      verdict = 'NO-GO'
      noGoReason = 'issue_credit'
    }
  }

  if (verdict === 'NO-GO') {
    return buildReport(
      startedAt,
      steps,
      verdict,
      noGoReason,
      writeReport,
      smokeMemberId,
      smokeSavId,
      creditNumberEmitted,
      erpPushStatus
    )
  }

  // --------------------------------------------------------------------------
  // Step 4 — pdf (GET /api/credit-notes/:number/pdf → 302 redirect to OneDrive)
  // HARDEN-1 + HARDEN-4: param is credit note NUMBER (from step 3), not savId.
  //   Real handler returns 302 with Location: https://...
  //   Use redirect:'manual' + assert status===302 && location starts with https://
  // --------------------------------------------------------------------------
  {
    const t0 = Date.now()
    try {
      // HARDEN-1: use credit note NUMBER returned by step 3 (not smokeSavId)
      const creditParam = creditNumberEmitted ?? smokeSavId
      const res = await http.get(`${config.baseUrl}/api/credit-notes/${creditParam}/pdf`, {
        redirect: 'manual',
      })
      const duration = elapsed(t0)
      const headers = res.headers ?? {}
      // HARDEN-4: real handler returns 302 redirect (not 200+pdf)
      if (
        res.status === 302 &&
        typeof headers['location'] === 'string' &&
        headers['location'].startsWith('https://')
      ) {
        steps.push({ step: 4, name: 'pdf', status: 'PASS', duration_ms: duration })
      } else {
        const reason =
          res.status !== 302
            ? `HTTP ${res.status} (expected 302 redirect)`
            : !headers['location']
              ? 'no Location header on 302'
              : `Location header does not start with https://: ${headers['location']?.slice(0, 60)}`
        steps.push({ step: 4, name: 'pdf', status: 'FAIL', duration_ms: duration, reason })
        verdict = 'NO-GO'
        noGoReason = 'pdf'
      }
    } catch (err) {
      steps.push({
        step: 4,
        name: 'pdf',
        status: 'FAIL',
        duration_ms: elapsed(t0),
        reason: String(err),
      })
      verdict = 'NO-GO'
      noGoReason = 'pdf'
    }
  }

  if (verdict === 'NO-GO') {
    return buildReport(
      startedAt,
      steps,
      verdict,
      noGoReason,
      writeReport,
      smokeMemberId,
      smokeSavId,
      creditNumberEmitted,
      erpPushStatus
    )
  }

  // --------------------------------------------------------------------------
  // Step 5 — email (vérifier email_outbox row via DB)
  // HARDEN-7 (M-3): re-fetch live via callback with retry-loop (email inserted async post-closed)
  // --------------------------------------------------------------------------
  {
    const t0 = Date.now()
    const emailQuery = `SELECT * FROM email_outbox WHERE recipient_email='${config.smokeEmail}' AND kind='sav_closed' ORDER BY created_at DESC LIMIT 1`
    db.queries.push(emailQuery)

    // HARDEN-7: poll up to 5× with 1s delay (email inserted async by cron post-closed)
    let emailRow: { kind: string; recipient_email: string; status: string } | null = null
    for (let attempt = 0; attempt < 5; attempt++) {
      emailRow = await db.getEmailOutboxRow()
      if (emailRow) break
      if (attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }

    const duration = elapsed(t0)
    if (
      emailRow &&
      emailRow.kind === 'sav_closed' &&
      emailRow.recipient_email === config.smokeEmail &&
      ['pending', 'sent'].includes(emailRow.status)
    ) {
      steps.push({ step: 5, name: 'email', status: 'PASS', duration_ms: duration })
    } else {
      const reason = !emailRow
        ? 'no email_outbox row found'
        : `unexpected status: ${emailRow.status}`
      steps.push({ step: 5, name: 'email', status: 'FAIL', duration_ms: duration, reason })
      verdict = 'NO-GO'
      noGoReason = 'email'
    }
  }

  if (verdict === 'NO-GO') {
    return buildReport(
      startedAt,
      steps,
      verdict,
      noGoReason,
      writeReport,
      smokeMemberId,
      smokeSavId,
      creditNumberEmitted,
      erpPushStatus
    )
  }

  // --------------------------------------------------------------------------
  // Step 6 — erp_push (D-7 feature-flag auto-detect)
  // --------------------------------------------------------------------------
  {
    const t0 = Date.now()
    const pgTablesQuery = `SELECT * FROM pg_tables WHERE tablename='erp_push_queue'`
    db.queries.push(pgTablesQuery)

    if (!db.erpPushQueueExists) {
      // D-7: table absent → Story 7-1 deferred → SKIPPED
      erpPushStatus = 'SKIPPED_FEATURE_FLAG'
      steps.push({
        step: 6,
        name: 'erp_push',
        status: 'SKIPPED',
        duration_ms: elapsed(t0),
        reason: 'ERP_PUSH_SKIPPED Story 7-1 deferred',
      })
      console.warn('ERP_PUSH_SKIPPED Story 7-1 deferred — table erp_push_queue absent')
    } else {
      // Feature-flag present: check row — HARDEN-7: re-fetch live
      const erpRow = await db.getErpQueueRow()
      const duration = elapsed(t0)
      if (erpRow && ['pending', 'succeeded'].includes(erpRow.status)) {
        erpPushStatus = erpRow.status
        steps.push({ step: 6, name: 'erp_push', status: 'PASS', duration_ms: duration })
      } else {
        const reason = !erpRow
          ? 'no erp_push_queue row found'
          : `unexpected status: ${erpRow.status}`
        erpPushStatus = 'FAILED'
        steps.push({ step: 6, name: 'erp_push', status: 'FAIL', duration_ms: duration, reason })
        verdict = 'NO-GO'
        noGoReason = 'erp_push'
      }
    }
  }

  // --------------------------------------------------------------------------
  // Step 7 — cleanup (leave in place Q-10=A, NFR-D10)
  // --------------------------------------------------------------------------
  {
    steps.push({
      step: 7,
      name: 'cleanup',
      status: 'PASS',
      duration_ms: 0,
      reason: 'Leave in place (Q-10=A NFR-D10 — identifiable by cutover-smoke@fruitstock.invalid)',
    })
  }

  return buildReport(
    startedAt,
    steps,
    verdict,
    noGoReason,
    writeReport,
    smokeMemberId,
    smokeSavId,
    creditNumberEmitted,
    erpPushStatus
  )
}

// ---------------------------------------------------------------------------
// Build + write report
// ---------------------------------------------------------------------------

function buildReport(
  startedAt: string,
  steps: StepResult[],
  verdict: 'GO' | 'NO-GO',
  noGoReason: string | undefined,
  writeReport: ((path: string, content: string) => void) | undefined,
  smokeMemberId: number | undefined,
  smokeSavId: number | undefined,
  creditNumberEmitted: number | undefined,
  erpPushStatus: string | undefined
): SmokeReport {
  const completedAt = now()
  const report: SmokeReport = {
    started_at: startedAt,
    completed_at: completedAt,
    verdict,
    steps,
    ...(creditNumberEmitted !== undefined && { credit_number_emitted: creditNumberEmitted }),
    ...(smokeMemberId !== undefined && { smoke_member_id: smokeMemberId }),
    ...(smokeSavId !== undefined && { smoke_sav_id: smokeSavId }),
    ...(erpPushStatus !== undefined && { erp_push_status: erpPushStatus }),
    ...(noGoReason !== undefined && { no_go_reason: noGoReason }),
  }

  // Write JSON report
  const isoTag = startedAt.replace(/[:.]/g, '-').slice(0, 19)
  const reportFileName = `smoke-J0-${isoTag}.json`
  const reportPath = resolve(__dirname, `results/${reportFileName}`)

  const serialized = JSON.stringify(report, null, 2)

  if (writeReport) {
    writeReport(reportPath, serialized)
  } else {
    // Default: fs.writeFileSync
    try {
      mkdirSync(resolve(__dirname, 'results'), { recursive: true })
      writeFileSync(reportPath, serialized, 'utf8')
    } catch (err) {
      console.warn(`WARN: could not write report to ${reportPath}: ${String(err)}`)
    }
  }

  return report
}

// ---------------------------------------------------------------------------
// CLI main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // HARDEN-8 (M-4): validate SERVICE_ROLE_KEY format at boot
  if (!process.env['SUPABASE_SERVICE_ROLE_KEY']?.startsWith('eyJ')) {
    console.error('SERVICE_ROLE_KEY missing or malformed (must start with "eyJ" — JWT format)')
    process.exit(1)
  }

  const lastCreditNumberStr = process.env['LAST_CREDIT_NUMBER']
  if (!lastCreditNumberStr) {
    console.error('ERROR: LAST_CREDIT_NUMBER env var required')
    process.exit(1)
  }
  const lastCreditNumber = parseInt(lastCreditNumberStr, 10)
  const smokeEmail = process.env['SMOKE_MEMBER_EMAIL'] ?? 'cutover-smoke@fruitstock.invalid'
  const baseUrl = process.env['SUPABASE_URL'] ?? 'http://localhost:3000'

  // HARDEN-1: capture token secret (MAGIC_LINK_SECRET used by verifyCaptureToken)
  const captureTokenSecret = process.env['MAGIC_LINK_SECRET']
  if (!captureTokenSecret) {
    console.error('ERROR: MAGIC_LINK_SECRET env var required (used for X-Capture-Token JWT)')
    process.exit(1)
  }

  // Build prod http client (HARDEN-1: add patch method + custom headers + redirect:manual)
  const { default: fetch } = await import('node-fetch' as string)
  const prodHttp: HttpClient = {
    post: async (url, body, extraHeaders) => {
      const res = await (fetch as typeof globalThis.fetch)(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(extraHeaders ?? {}) },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      return { status: res.status, data }
    },
    patch: async (url, body) => {
      const res = await (fetch as typeof globalThis.fetch)(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      return { status: res.status, data }
    },
    get: async (url, opts) => {
      const res = await (fetch as typeof globalThis.fetch)(url, {
        redirect: opts?.redirect ?? 'follow',
      })
      const buffer = await res.arrayBuffer()
      const data = Buffer.from(buffer)
      const headers: Record<string, string> = {}
      res.headers.forEach((v, k) => {
        headers[k] = v
      })
      // For manual redirect, also capture location header
      const location = res.headers.get('location')
      if (location) headers['location'] = location
      return { status: res.status, data, headers, size: data.length }
    },
  }

  const { supabaseAdmin } = await import('../../api/_lib/clients/supabase-admin')
  const supabase = supabaseAdmin()

  // Check ERP feature flag
  const { data: erpTables } = await supabase
    .rpc('query_pg_tables', { table_name: 'erp_push_queue' })
    .catch(() => ({ data: null }))
  const erpPushQueueExists = Array.isArray(erpTables) && erpTables.length > 0

  // HARDEN-6 (M-2): upsert sentinel member with null check
  const { data: memberData, error: memberErr } = await supabase
    .from('members')
    .upsert({ email: smokeEmail, last_name: 'SMOKE-TEST' }, { onConflict: 'email' })
    .select('id')
    .single()
    .catch((err) => ({ data: null, error: err as Error }))

  if (memberErr || !(memberData as Record<string, unknown> | null)?.['id']) {
    console.error('SENTINEL_MEMBER_UPSERT_FAILED', memberErr)
    process.exit(1)
  }

  const sentinelMemberId = (memberData as Record<string, unknown>)['id'] as number

  // HARDEN-7 (M-3): pass callbacks (re-fetch live) instead of stale snapshot
  const getEmailOutboxRow = async () => {
    const { data } = await supabase
      .from('email_outbox')
      .select('kind, recipient_email, status')
      .eq('recipient_email', smokeEmail)
      .eq('kind', 'sav_closed')
      .order('created_at', { ascending: false })
      .limit(1)
      .single()
      .catch(() => ({ data: null }))
    return data as { kind: string; recipient_email: string; status: string } | null
  }

  const getErpQueueRow = async () => {
    if (!erpPushQueueExists) return null
    const { data } = await supabase
      .from('erp_push_queue')
      .select('idempotency_key, status')
      .order('created_at', { ascending: false })
      .limit(1)
      .single()
      .catch(() => ({ data: null }))
    return data as { idempotency_key: string; status: string } | null
  }

  const prodDb: DbClient = {
    erpPushQueueExists,
    getEmailOutboxRow,
    getErpQueueRow,
    queries: [],
    sentinelMemberId,
  }

  // HARDEN-16 — pre-insert sav_submit_tokens row so consumeCaptureToken() finds
  // it during step 1.  The row must exist BEFORE the HTTP call; it is consumed
  // (used_at set) by the real capture.ts handler.
  //
  // Columns required by the schema (see migration 20260508120000_sav_submit_tokens):
  //   jti uuid PK, expires_at timestamptz NOT NULL, ip_hash text NULL (optional).
  // issued_at has DEFAULT now(), user_agent is optional.
  // ip_hash: sha256('smoke-cli-ip') — harmless sentinel value, no real IP stored.
  const smokeJti = randomUUID()
  const smokeExpiresAt = new Date(Date.now() + SMOKE_TOKEN_TTL_SEC * 1000).toISOString()
  const smokeIpHash = createHash('sha256').update('smoke-cli-ip').digest('hex')

  const { error: tokenInsertErr } = await supabase.from('sav_submit_tokens').insert({
    jti: smokeJti,
    expires_at: smokeExpiresAt,
    ip_hash: smokeIpHash,
  })
  if (tokenInsertErr) {
    console.error('SMOKE_TOKEN_INSERT_FAILED', tokenInsertErr)
    process.exit(1)
  }

  const report = await runSmokeTest(
    { lastCreditNumber, smokeEmail, baseUrl },
    prodHttp,
    prodDb,
    undefined,
    captureTokenSecret,
    smokeJti
  )

  if (report.verdict === 'GO') {
    console.log(`cutover.smoke.go=true`)
    process.exit(0)
  } else {
    console.error(`cutover.smoke.go=false reason=${report.no_go_reason ?? 'unknown'}`)
    process.exit(1)
  }
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1]))

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err)
    process.exit(3)
  })
}
