import { withRateLimit } from '../_lib/middleware/with-rate-limit'
import { ensureRequestId } from '../_lib/request-id'
import { sendError } from '../_lib/errors'
import { logger } from '../_lib/logger'
import { supabaseAdmin } from '../_lib/clients/supabase-admin'
import { recordAudit } from '../_lib/audit/record'
import { captureWebhookSchema, type CaptureWebhookPayload } from '../_lib/schemas/capture-webhook'
import { formatErrors } from '../_lib/middleware/with-validation'
import { verifyCaptureToken, consumeCaptureToken } from '../_lib/self-service/submit-token-handler'
import { sendMail } from '../_lib/clients/smtp'
import {
  renderSavInternalNotification,
  renderSavCustomerAck,
  type SavCaptureContext,
  type SavCaptureItem,
} from '../_lib/emails/sav-capture-templates'
import { waitUntilOrVoid } from '../_lib/pdf/wait-until'
import type { ApiHandler, ApiRequest } from '../_lib/types'

/**
 * POST /api/webhooks/capture — Story 2.2 + Story 5.7 cutover.
 *
 * Contrat post-cutover Make :
 *   - Auth UNIQUE par capture-token JWT (header `X-Capture-Token`),
 *     scope='sav-submit', single-use via `sav_submit_tokens`. Émis par
 *     `/api/self-service/submit-token` (anonyme rate-limité).
 *   - HMAC `X-Webhook-Signature` retiré (Story 5.7) — Make tué J+0,
 *     pas de fenêtre de cohabitation. Le rollback éventuel se fait côté
 *     front via réactivation `VITE_WEBHOOK_URL*` (Make redevient receiver
 *     de bout en bout sans toucher à `/webhooks/capture`).
 *   - Persistence atomique via RPC Postgres `capture_sav_from_webhook`.
 *   - webhook_inbox : INSERT AVANT vérif token (traçabilité des 401).
 */

export const config = { api: { bodyParser: false } }

const MAX_BODY_BYTES = 524288 // 512 KB hard cap (AC #1.2)

interface WebhookInboxHandle {
  id: number | null
}

const coreHandler: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  const start = Date.now()
  logger.info('webhook.capture.received', { requestId, path: '/api/webhooks/capture' })

  // Story 5.7 AC #5 — fail-fast prod si credentials SMTP SAV absents.
  // En dev, les emails sont skippés silencieusement (cf. sendCaptureEmails).
  if (process.env['NODE_ENV'] === 'production') {
    if (!process.env['SMTP_SAV_PASSWORD'] || !process.env['SMTP_SAV_HOST']) {
      logger.error('webhook.capture.smtp_sav_not_configured', { requestId })
      sendError(res, 'SERVER_ERROR', 'Configuration manquante', requestId)
      return
    }
  }

  // --- 1. Raw body ---
  let rawBody: Buffer
  try {
    rawBody = await readRawBody(req, MAX_BODY_BYTES)
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      logger.warn('webhook.capture.payload_too_large', {
        requestId,
        size: err.size,
        ms: Date.now() - start,
      })
      sendError(res, 'VALIDATION_FAILED', 'Payload trop volumineux (> 512 KB)', requestId)
      return
    }
    logger.error('webhook.capture.body_read_failed', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
      ms: Date.now() - start,
    })
    sendError(res, 'SERVER_ERROR', 'Lecture du body échouée', requestId)
    return
  }

  // --- 2. Parse JSON (best-effort pour stocker dans webhook_inbox) ---
  let parsedBody: unknown = null
  let parseError: string | null = null
  try {
    parsedBody = JSON.parse(rawBody.toString('utf8'))
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err)
  }

  // --- 3. INSERT webhook_inbox AVANT validation auth (AC #4) ---
  const captureTokenHeader = readCaptureTokenHeader(req)
  const inboxSignature: string | null = captureTokenHeader
    ? `capture-token:${captureTokenHeader.slice(0, 8)}…`
    : null
  const inbox = await insertInbox({
    signature: inboxSignature,
    payload: parseError
      ? { raw: rawBody.toString('utf8').slice(0, 2048), parse_error: parseError }
      : parsedBody,
  }).catch((err) => {
    logger.error('webhook.capture.inbox_insert_failed', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { id: null } as WebhookInboxHandle
  })

  // --- 4. Vérif capture-token (AC #8 post-cutover) ---
  if (!captureTokenHeader) {
    logger.warn('webhook.capture.no_auth_header', { requestId, ms: Date.now() - start })
    await markInboxProcessed(inbox.id, 'NO_AUTH_HEADER')
    sendError(res, 'UNAUTHENTICATED', 'Authentication requise', requestId)
    return
  }
  const linkSecret = process.env['MAGIC_LINK_SECRET']
  if (!linkSecret || linkSecret.length === 0) {
    logger.error('webhook.capture.secret_missing', { requestId, mode: 'capture-token' })
    await markInboxProcessed(inbox.id, 'CONFIG_MISSING')
    sendError(res, 'SERVER_ERROR', 'Configuration manquante', requestId)
    return
  }
  const verify = verifyCaptureToken(captureTokenHeader, linkSecret)
  if (!verify.ok) {
    const reason = verify.reason
    logger.warn('webhook.capture.capture_token_invalid', { requestId, reason })
    await markInboxProcessed(inbox.id, `CAPTURE_TOKEN_${reason.toUpperCase()}`)
    sendError(res, 'UNAUTHENTICATED', 'Token invalide', requestId)
    return
  }
  let consumed = false
  try {
    consumed = await consumeCaptureToken(
      supabaseAdmin() as unknown as { from: (table: string) => unknown },
      verify.payload.jti
    )
  } catch (err) {
    logger.error('webhook.capture.capture_token_consume_failed', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    })
    await markInboxProcessed(inbox.id, 'CAPTURE_TOKEN_CONSUME_ERROR')
    sendError(res, 'SERVER_ERROR', 'Token persistence échouée', requestId)
    return
  }
  if (!consumed) {
    logger.warn('webhook.capture.capture_token_consumed_or_expired', {
      requestId,
      jtiPrefix: verify.payload.jti.slice(0, 8),
    })
    await markInboxProcessed(inbox.id, 'CAPTURE_TOKEN_CONSUMED')
    sendError(res, 'UNAUTHENTICATED', 'Token déjà consommé ou expiré', requestId)
    return
  }

  // --- 5. Parse JSON (obligatoire maintenant) ---
  if (parseError) {
    logger.warn('webhook.capture.body_malformed', { requestId, ms: Date.now() - start })
    await markInboxProcessed(inbox.id, `PARSE_ERROR: ${parseError.slice(0, 120)}`)
    sendError(res, 'VALIDATION_FAILED', 'JSON malformé', requestId)
    return
  }

  // --- 6. Validation Zod (AC #5) ---
  const parse = captureWebhookSchema.safeParse(parsedBody)
  if (!parse.success) {
    const details = formatErrors(parse.error)
    const firstField = details[0]?.field ?? '(root)'
    logger.warn('webhook.capture.validation_failed', {
      requestId,
      field: firstField,
      ms: Date.now() - start,
    })
    await markInboxProcessed(inbox.id, `VALIDATION_FAILED: ${firstField}`)
    sendError(res, 'VALIDATION_FAILED', 'Payload invalide', requestId, details)
    return
  }
  const payload: CaptureWebhookPayload = parse.data

  // --- 7. Appel RPC atomique (AC #7) ---
  try {
    const admin = supabaseAdmin()
    const { data, error } = await admin.rpc('capture_sav_from_webhook', {
      p_payload: payload as unknown as Record<string, unknown>,
    })
    if (error) {
      logger.error('webhook.capture.rpc_failed', {
        requestId,
        code: error.code,
        message: error.message,
        ms: Date.now() - start,
      })
      await markInboxProcessed(
        inbox.id,
        `RPC_ERROR: ${error.code ?? ''} ${error.message ?? ''}`.slice(0, 240)
      )
      sendError(res, 'SERVER_ERROR', 'Persistence échouée', requestId)
      return
    }
    const row: RpcRow | null = Array.isArray(data) ? (data[0] ?? null) : (data as RpcRow | null)
    if (!row) {
      logger.error('webhook.capture.rpc_empty', { requestId, ms: Date.now() - start })
      await markInboxProcessed(inbox.id, 'RPC_EMPTY')
      sendError(res, 'SERVER_ERROR', 'RPC retourne vide', requestId)
      return
    }

    // --- 8. Audit explicite (AC #8) ---
    await recordAudit({
      entityType: 'sav',
      entityId: row.sav_id,
      action: 'created',
      actorSystem: 'webhook-capture',
      diff: {
        after: {
          reference: row.reference,
          lineCount: row.line_count,
          fileCount: row.file_count,
        },
      },
    }).catch((err) => {
      logger.error('webhook.capture.audit_failed', {
        requestId,
        savId: row.sav_id,
        error: err instanceof Error ? err.message : String(err),
      })
    })

    await markInboxProcessed(inbox.id, null)

    // --- 9. Emails fire-and-forget (Story 5.7 AC #2) ---
    // 2 emails best-effort en parallèle (Promise.allSettled). Échec SMTP
    // ne fait PAS échouer la requête (201 déjà acquis). Vercel : on délègue
    // à `waitUntilOrVoid` pour empêcher la lambda de geler avant complétion
    // (cf. `_lib/pdf/wait-until.ts`).
    const emailPromise = sendCaptureEmails({
      payload,
      savId: row.sav_id,
      savReference: row.reference,
      requestId,
    })
    if (process.env['NODE_ENV'] === 'test') {
      await emailPromise
    } else {
      waitUntilOrVoid(emailPromise)
    }

    logger.info('webhook.capture.success', {
      requestId,
      savId: row.sav_id,
      reference: row.reference,
      lineCount: row.line_count,
      fileCount: row.file_count,
      ms: Date.now() - start,
    })

    res.setHeader('X-Request-Id', requestId)
    res.status(201).json({
      data: {
        savId: row.sav_id,
        reference: row.reference,
        lineCount: row.line_count,
        fileCount: row.file_count,
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('webhook.capture.failed', {
      requestId,
      errorMessage: msg,
      ms: Date.now() - start,
    })
    await markInboxProcessed(inbox.id, `EXCEPTION: ${msg.slice(0, 240)}`)
    sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId)
  }
}

// ----------- helpers -----------

interface RpcRow {
  sav_id: number
  reference: string
  line_count: number
  file_count: number
}

class PayloadTooLargeError extends Error {
  constructor(public size: number) {
    super(`Payload trop volumineux: ${size} > ${MAX_BODY_BYTES}`)
  }
}

interface NodeRequestLike {
  on: (event: string, listener: (...args: unknown[]) => void) => unknown
}

async function readRawBody(req: ApiRequest, maxBytes: number): Promise<Buffer> {
  const stream = req as unknown as NodeRequestLike
  if (typeof stream.on !== 'function') {
    if (req.body !== undefined && req.body !== null) {
      return Buffer.from(JSON.stringify(req.body), 'utf8')
    }
    return Buffer.alloc(0)
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    stream.on('data', (...args: unknown[]) => {
      const chunk = args[0]
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      total += buf.length
      if (total > maxBytes) {
        reject(new PayloadTooLargeError(total))
        return
      }
      chunks.push(buf)
    })
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', (...args: unknown[]) => reject(args[0] as Error))
  })
}

function readCaptureTokenHeader(req: ApiRequest): string | null {
  const raw = req.headers['x-capture-token']
  const v = Array.isArray(raw) ? raw[0] : raw
  if (typeof v !== 'string' || v.length === 0) return null
  return v
}

async function insertInbox(input: {
  signature: string | null
  payload: unknown
}): Promise<WebhookInboxHandle> {
  const row: Record<string, unknown> = {
    source: 'sav-form',
    payload: input.payload ?? null,
  }
  if (input.signature !== null) row['signature'] = input.signature
  const { data, error } = await supabaseAdmin()
    .from('webhook_inbox')
    .insert(row)
    .select('id')
    .single<{ id: number }>()
  if (error) throw error
  return { id: data?.id ?? null }
}

async function markInboxProcessed(inboxId: number | null, errorText: string | null): Promise<void> {
  if (inboxId === null) return
  const row: Record<string, unknown> = { processed_at: new Date().toISOString() }
  if (errorText !== null) row['error'] = errorText
  const { error } = await supabaseAdmin().from('webhook_inbox').update(row).eq('id', inboxId)
  if (error) {
    logger.error('webhook.capture.inbox_mark_failed', {
      inboxId,
      error: error.message ?? String(error),
    })
  }
}

// ----------- emails post-INSERT (Story 5.7 AC #2) -----------

interface SendCaptureEmailsArgs {
  payload: CaptureWebhookPayload
  savId: number
  savReference: string
  requestId: string
}

function isSafeHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

function buildCaptureContext(args: SendCaptureEmailsArgs): SavCaptureContext {
  const { payload, savId, savReference } = args
  const items: SavCaptureItem[] = payload.items.map((it) => {
    const item: SavCaptureItem = {
      productCode: it.productCode,
      productName: it.productName,
      qtyRequested: it.qtyRequested,
      unit: it.unit,
    }
    if (it.cause !== undefined) item.cause = it.cause
    return item
  })
  // Story 5.7 patch P4 — valider le scheme avant rendering pour éviter une
  // injection `javascript:` ou phishing dans l'email opérateur.
  const rawDossier = payload.metadata['dossierSavUrl']
  const dossierSavUrl = isSafeHttpUrl(rawDossier) ? rawDossier : null
  const customer: SavCaptureContext['customer'] = {
    email: payload.customer.email,
  }
  if (payload.customer.fullName !== undefined) customer.fullName = payload.customer.fullName
  if (payload.customer.firstName !== undefined) customer.firstName = payload.customer.firstName
  if (payload.customer.lastName !== undefined) customer.lastName = payload.customer.lastName
  if (payload.customer.phone !== undefined) customer.phone = payload.customer.phone
  if (payload.customer.pennylaneCustomerId !== undefined) {
    customer.pennylaneCustomerId = payload.customer.pennylaneCustomerId
  }
  const invoice: SavCaptureContext['invoice'] = {
    ref: payload.invoice?.ref ?? '(facture inconnue)',
  }
  if (payload.invoice?.label !== undefined) invoice.label = payload.invoice.label
  if (payload.invoice?.specialMention !== undefined) {
    invoice.specialMention = payload.invoice.specialMention
  }
  return {
    customer,
    invoice,
    items,
    dossierSavUrl,
    savId,
    savReference,
  }
}

async function sendCaptureEmails(args: SendCaptureEmailsArgs): Promise<void> {
  const { payload, requestId, savId } = args
  // Dégradation dev : si la conf SMTP SAV est absente, skip + warn.
  if (
    process.env['NODE_ENV'] !== 'production' &&
    (!process.env['SMTP_SAV_PASSWORD'] || !process.env['SMTP_SAV_HOST'])
  ) {
    logger.warn('webhook.capture.email_skipped_dev', { requestId, savId })
    return
  }
  const internalRecipient = process.env['SMTP_NOTIFY_INTERNAL'] ?? 'sav@fruitstock.eu'
  const ctx = buildCaptureContext(args)
  const internal = renderSavInternalNotification(ctx)
  const customer = renderSavCustomerAck(ctx)

  const tasks: Array<Promise<unknown>> = [
    sendMail({
      to: internalRecipient,
      subject: internal.subject,
      html: internal.html,
      text: internal.text,
      replyTo: payload.customer.email,
      account: 'sav',
    }).catch((err) => {
      logger.error('webhook.capture.email_failed', {
        requestId,
        savId,
        target: 'internal',
        error: err instanceof Error ? err.message : String(err),
      })
    }),
    sendMail({
      to: payload.customer.email,
      subject: customer.subject,
      html: customer.html,
      text: customer.text,
      account: 'sav',
    }).catch((err) => {
      logger.error('webhook.capture.email_failed', {
        requestId,
        savId,
        target: 'customer',
        error: err instanceof Error ? err.message : String(err),
      })
    }),
  ]
  await Promise.allSettled(tasks)
}

// Compose : rate-limit par IP (60/min). Auth = capture-token uniquement (Story 5.7).
//
// `req.ip` vient de la couche TCP Vercel (non spoofable). Fallback XFF rightmost
// pour environnements non-Vercel (tests, dev local).
export default withRateLimit({
  bucketPrefix: 'webhook:capture',
  keyFrom: (req: ApiRequest) => {
    if (req.ip && req.ip.length > 0) return req.ip
    const fwd = req.headers['x-forwarded-for']
    const joined = Array.isArray(fwd) ? fwd.join(',') : fwd
    if (typeof joined === 'string' && joined.length > 0) {
      const parts = joined
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
      const rightmost = parts[parts.length - 1]
      if (rightmost) return rightmost
    }
    return 'unknown'
  },
  max: 60,
  window: '1m',
})(coreHandler)

export { coreHandler as __coreHandler }
