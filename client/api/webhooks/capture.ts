import { createHmac, timingSafeEqual } from 'node:crypto'
import { withRateLimit } from '../_lib/middleware/with-rate-limit'
import { ensureRequestId } from '../_lib/request-id'
import { sendError } from '../_lib/errors'
import { logger } from '../_lib/logger'
import { supabaseAdmin } from '../_lib/clients/supabase-admin'
import { recordAudit } from '../_lib/audit/record'
import { captureWebhookSchema, type CaptureWebhookPayload } from '../_lib/schemas/capture-webhook'
import { formatErrors } from '../_lib/middleware/with-validation'
import type { ApiHandler, ApiRequest, ApiResponse } from '../_lib/types'

/**
 * POST /api/webhooks/capture — Story 2.2
 *
 * Contrat :
 *   - Signé HMAC-SHA256 via header `X-Webhook-Signature: sha256=<hex>` sur le
 *     raw body (attention : JSON.stringify ≠ octets émis par Make.com).
 *   - Idempotence amont : Make.com dédupe sur (email + invoice.ref + items hash).
 *     Ce endpoint ne dédupe PAS (AC #9) — 2 POST identiques → 2 SAV distincts.
 *   - Persistence atomique via RPC Postgres `capture_sav_from_webhook`.
 *   - webhook_inbox : INSERT AVANT vérif signature (traçabilité des 401).
 */

// Vercel : désactive le body-parser natif pour lire le raw body (AC #3).
export const config = { api: { bodyParser: false } }

const MAX_BODY_BYTES = 524288 // 512 KB hard cap (AC #1.2)

interface WebhookInboxHandle {
  id: number | null
}

const coreHandler: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  const start = Date.now()
  logger.info('webhook.capture.received', { requestId, path: '/api/webhooks/capture' })

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

  // --- 3. INSERT webhook_inbox AVANT validation signature (AC #4) ---
  const signatureHeader = readSignatureHeader(req)
  const inbox = await insertInbox({
    signature: signatureHeader,
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

  // --- 4. Vérif signature HMAC ---
  const secret = process.env['MAKE_WEBHOOK_HMAC_SECRET']
  if (!secret || secret.length === 0) {
    logger.error('webhook.capture.secret_missing', { requestId })
    await markInboxProcessed(inbox.id, 'CONFIG_MISSING')
    sendError(res, 'SERVER_ERROR', 'Configuration manquante', requestId)
    return
  }
  if (!verifyHmac(rawBody, signatureHeader, secret)) {
    logger.warn('webhook.capture.signature_invalid', { requestId, ms: Date.now() - start })
    await markInboxProcessed(inbox.id, 'SIGNATURE_INVALID')
    sendError(res, 'UNAUTHENTICATED', 'Signature invalide', requestId)
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
      // Ne pas échouer la requête pour un audit KO (le trigger audit_changes
      // a déjà écrit une ligne via l'INSERT sav).
    })

    await markInboxProcessed(inbox.id, null)

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
    // En tests : body déjà parsé est passé via req.body. On le re-sérialise
    // pour que les assertions HMAC fonctionnent. Le test doit signer le même
    // JSON.stringify(req.body).
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

function readSignatureHeader(req: ApiRequest): string | null {
  const raw = req.headers['x-webhook-signature']
  const v = Array.isArray(raw) ? raw[0] : raw
  if (typeof v !== 'string' || v.length === 0) return null
  return v
}

function verifyHmac(rawBody: Buffer, headerValue: string | null, secret: string): boolean {
  if (!headerValue) return false
  const m = /^sha256=([0-9a-f]{64})$/.exec(headerValue)
  if (!m || m[1] === undefined) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest()
  let given: Buffer
  try {
    given = Buffer.from(m[1], 'hex')
  } catch {
    return false
  }
  if (expected.length !== given.length) return false
  return timingSafeEqual(expected, given)
}

async function insertInbox(input: {
  signature: string | null
  payload: unknown
}): Promise<WebhookInboxHandle> {
  const row: Record<string, unknown> = {
    source: 'make.com',
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

// Compose : rate-limit par IP (60/min). Pas de withAuth (HMAC inline).
//
// NOTE sécurité : `req.ip` est posé par Vercel depuis l'IP de la connexion TCP — source
// fiable car non spoofable par l'attaquant (seul le reverse-proxy Vercel peut l'établir).
// On utilise aussi le **segment le plus à droite** de `X-Forwarded-For` en fallback : en
// chaîne de proxies trustés, le rightmost est l'IP vue par le dernier hop trusté (pas le
// leftmost qui est le client auto-déclaré, trivialement spoofable — cf. blind review
// finding F2 Epic 2).
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
