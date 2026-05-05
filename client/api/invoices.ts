import { z } from 'zod'
import { withRateLimit } from './_lib/middleware/with-rate-limit'
import { ensureRequestId } from './_lib/request-id'
import { sendError } from './_lib/errors'
import { logger } from './_lib/logger'
import { hashEmail } from './_lib/auth/magic-link'
import { createHash, timingSafeEqual } from 'node:crypto'
import {
  findInvoiceByNumber,
  PennylaneTimeoutError,
  PennylaneUnauthorizedError,
  PennylaneUpstreamError,
} from './_lib/clients/pennylane'
import { ensureFolderExists, createUploadSession } from './_lib/onedrive-ts'
import { sanitizeFilename, sanitizeSavDossier } from './_lib/sanitize-ts'
import { isMimeAllowed } from './_lib/mime-ts'
import fileLimits from '../shared/file-limits.json'
import { formatErrors } from './_lib/middleware/with-validation'
import type { ApiHandler, ApiRequest } from './_lib/types'

/**
 * Story 5.7 AC #1 — `/api/invoices/lookup` (remplace Make scenario 3197846).
 *
 * Multiplexing `?op=lookup` (cap Vercel Hobby = 12 functions, ce fichier
 * occupe le 12e slot — toute future story DOIT multiplexer ici ou ailleurs).
 *
 * Anonymous (pas d'auth, pas de cookie) — calque le pattern « webhook
 * anonymous » du scenario Make. Protections :
 *   - rate-limit 5 req/min/IP (volumétrie pic Fruitstock ~10 SAV/jour ;
 *     5/min largement suffisant, marge 720× sur le pic légitime)
 *   - validation Zod stricte du format `F-YYYY-NNNNN` (refuse les hashids
 *     legacy 10-chars que pourrait envoyer un bot scanner)
 *   - logs hashés (jamais le numéro/email en clair)
 *   - `Cache-Control: no-store` (interdit cache CDN — évite la fuite
 *     cross-utilisateur si même invoice cachée pour 2 IPs distinctes)
 */

const ALLOWED_OPS = new Set(['lookup', 'upload-session', 'folder-share-link'])

/**
 * V1.2 hotfix 2026-05-05 — restauration endpoints publics anonymes upload-session + folder-share-link
 * supprimés par f5cfc0e (cap Hobby 12-fn) sans propagation côté client.
 * Multiplexés ici (slot invoices) plutôt que via webhooks/capture.ts (qui a bodyParser:false).
 * Auth API-key X-API-Key (legacy contract conservé). Rate-limit par IP comme lookup.
 */

function safeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

function requireApiKey(req: ApiRequest): boolean {
  const expected = process.env['API_KEY']
  if (!expected) return false
  const headerKey = req.headers['x-api-key']
  const provided = Array.isArray(headerKey) ? headerKey[0] : headerKey
  if (typeof provided === 'string' && safeEqualStr(provided, expected)) return true
  const authHeader = req.headers['authorization']
  const auth = Array.isArray(authHeader) ? authHeader[0] : authHeader
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const tok = auth.substring(7).trim()
    if (safeEqualStr(tok, expected)) return true
  }
  return false
}

const uploadSessionBodySchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(127),
  size: z.number().int().positive(),
  savDossier: z.string().min(1).max(255),
})

const folderShareBodySchema = z.object({
  savDossier: z.string().min(1).max(255),
})

const lookupQuerySchema = z.object({
  invoiceNumber: z
    .string()
    .regex(/^F-\d{4}-\d{1,8}$/, 'Format attendu : F-YYYY-NNNNN')
    .max(32),
  email: z.string().email().max(254),
})

function parseOp(req: ApiRequest): string | null {
  const raw = (req.query as Record<string, unknown> | undefined)?.['op']
  if (typeof raw === 'string') return ALLOWED_OPS.has(raw) ? raw : null
  if (Array.isArray(raw) && typeof raw[0] === 'string')
    return ALLOWED_OPS.has(raw[0]) ? raw[0] : null
  return null
}

function readQueryString(req: ApiRequest, key: string): string | null {
  const raw = (req.query as Record<string, unknown> | undefined)?.[key]
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0]
  return null
}

/** Hash court (16 hex) pour log : ne reverse pas un numéro de facture (faible entropie). */
function hashInvoiceNumber(n: string): string {
  return createHash('sha256').update(n).digest('hex').slice(0, 16)
}

const lookupCore: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  const start = Date.now()

  if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
    res.setHeader('Allow', 'GET')
    sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
    return
  }

  // Validation Zod query.
  const rawInvoice = readQueryString(req, 'invoiceNumber')
  const rawEmail = readQueryString(req, 'email')
  const parse = lookupQuerySchema.safeParse({
    invoiceNumber: rawInvoice ?? '',
    email: (rawEmail ?? '').toLowerCase().trim(),
  })
  if (!parse.success) {
    logger.info('invoice.lookup.validation_failed', {
      requestId,
      ms: Date.now() - start,
    })
    sendError(res, 'VALIDATION_FAILED', 'Référence facture incorrecte', requestId)
    return
  }
  const { invoiceNumber, email } = parse.data
  const invoiceNumberHash = hashInvoiceNumber(invoiceNumber)
  const emailHash = hashEmail(email)

  logger.info('invoice.lookup.received', { requestId, invoiceNumberHash, emailHash })

  res.setHeader('Cache-Control', 'no-store')

  let invoice
  try {
    invoice = await findInvoiceByNumber(invoiceNumber)
  } catch (err) {
    const ms = Date.now() - start
    if (err instanceof PennylaneTimeoutError) {
      logger.warn('invoice.lookup.failed', {
        requestId,
        reason: 'pennylane_timeout',
        invoiceNumberHash,
        ms,
      })
      res.setHeader('Retry-After', '30')
      sendError(res, 'DEPENDENCY_DOWN', 'Service Pennylane indisponible', requestId)
      return
    }
    if (err instanceof PennylaneUnauthorizedError) {
      logger.error('invoice.lookup.failed', {
        requestId,
        reason: 'pennylane_unauthorized',
        invoiceNumberHash,
        ms,
      })
      res.setHeader('Retry-After', '30')
      sendError(res, 'DEPENDENCY_DOWN', 'Service Pennylane indisponible', requestId)
      return
    }
    if (err instanceof PennylaneUpstreamError) {
      logger.error('invoice.lookup.failed', {
        requestId,
        reason: 'pennylane_upstream',
        upstreamStatus: err.status,
        invoiceNumberHash,
        ms,
      })
      res.setHeader('Retry-After', '30')
      sendError(res, 'DEPENDENCY_DOWN', 'Service Pennylane indisponible', requestId)
      return
    }
    // PENNYLANE_API_KEY manquant ou autre erreur de config.
    logger.error('invoice.lookup.failed', {
      requestId,
      reason: 'config_error',
      error: err instanceof Error ? err.message : String(err),
      invoiceNumberHash,
      ms,
    })
    sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId)
    return
  }

  if (!invoice) {
    logger.info('invoice.lookup.failed', {
      requestId,
      reason: 'invoice_not_found',
      invoiceNumberHash,
      ms: Date.now() - start,
    })
    sendError(res, 'NOT_FOUND', 'Référence facture incorrecte', requestId)
    return
  }

  // Vérifier email ∈ customer.emails (case-insensitive trim).
  const customerEmails = Array.isArray(invoice.customer?.emails)
    ? invoice.customer.emails.map((e) => (typeof e === 'string' ? e.toLowerCase().trim() : ''))
    : []
  if (!customerEmails.includes(email)) {
    logger.info('invoice.lookup.failed', {
      requestId,
      reason: 'email_mismatch',
      invoiceNumberHash,
      ms: Date.now() - start,
    })
    sendError(res, 'VALIDATION_FAILED', 'Email incorrect', requestId)
    return
  }

  logger.info('invoice.lookup.success', {
    requestId,
    invoiceNumberHash,
    ms: Date.now() - start,
  })

  res.setHeader('X-Request-Id', requestId)
  res.status(200).json({ invoice })
}

// Rate-limit : 5 req/min/IP (clé IP brute non hashée — la table buckets
// hashe en interne via SHA-256, cf. with-rate-limit.ts:55).
function ipKeyFrom(req: ApiRequest): string {
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
}

const lookupGuarded: ApiHandler = withRateLimit({
  bucketPrefix: 'invoice-lookup:ip',
  keyFrom: ipKeyFrom,
  max: 5,
  window: '1m',
})(lookupCore)

const uploadSessionCore: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
    res.setHeader('Allow', 'POST')
    sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
    return
  }
  if (!requireApiKey(req)) {
    sendError(res, 'FORBIDDEN', 'API key invalide ou manquante', requestId)
    return
  }
  const drivePath = process.env['MICROSOFT_DRIVE_PATH']
  if (!drivePath) {
    logger.error('upload-session.config_missing', { requestId })
    sendError(res, 'SERVER_ERROR', 'Configuration manquante', requestId)
    return
  }
  const parsed = uploadSessionBodySchema.safeParse(req.body)
  if (!parsed.success) {
    sendError(res, 'VALIDATION_FAILED', 'Body invalide', requestId, formatErrors(parsed.error))
    return
  }
  const body = parsed.data
  if (!isMimeAllowed(body.mimeType)) {
    sendError(res, 'VALIDATION_FAILED', `Type MIME non autorisé : ${body.mimeType}`, requestId)
    return
  }
  if (body.size > fileLimits.maxFileSizeBytes) {
    sendError(res, 'VALIDATION_FAILED', `Taille > ${fileLimits.maxFileSizeMb} Mo`, requestId)
    return
  }
  const sanitizedFolder = sanitizeSavDossier(body.savDossier)
  if (!sanitizedFolder) {
    sendError(res, 'VALIDATION_FAILED', 'savDossier invalide', requestId)
    return
  }
  const sanitizedFilename = sanitizeFilename(body.filename)
  if (!sanitizedFilename) {
    sendError(res, 'VALIDATION_FAILED', 'filename invalide après sanitization', requestId)
    return
  }
  const folderPath = `${drivePath}/${sanitizedFolder}`
  try {
    const parentFolderId = await ensureFolderExists(folderPath)
    const session = await createUploadSession({ parentFolderId, filename: sanitizedFilename })
    res.status(200).json({
      success: true,
      uploadUrl: session.uploadUrl,
      expiresAt: session.expirationDateTime,
      storagePath: `${folderPath}/${sanitizedFilename}`,
    })
  } catch (err) {
    logger.error('upload-session.graph_failed', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    })
    sendError(res, 'DEPENDENCY_DOWN', 'OneDrive indisponible', requestId)
  }
}

const folderShareLinkCore: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
    res.setHeader('Allow', 'POST')
    sendError(res, 'METHOD_NOT_ALLOWED', 'Méthode non supportée', requestId)
    return
  }
  if (!requireApiKey(req)) {
    sendError(res, 'FORBIDDEN', 'API key invalide ou manquante', requestId)
    return
  }
  const drivePath = process.env['MICROSOFT_DRIVE_PATH']
  if (!drivePath) {
    sendError(res, 'SERVER_ERROR', 'Configuration manquante', requestId)
    return
  }
  const parsed = folderShareBodySchema.safeParse(req.body)
  if (!parsed.success) {
    sendError(res, 'VALIDATION_FAILED', 'Body invalide', requestId, formatErrors(parsed.error))
    return
  }
  const sanitized = sanitizeSavDossier(parsed.data.savDossier)
  if (!sanitized) {
    sendError(res, 'VALIDATION_FAILED', 'savDossier invalide', requestId)
    return
  }
  const folderPath = `${drivePath}/${sanitized}`
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const legacy = require('./_lib/onedrive.js') as {
      getShareLinkForFolderPath: (path: string) => Promise<{ link?: { webUrl?: string } }>
    }
    const result = await legacy.getShareLinkForFolderPath(folderPath)
    const webUrl = result?.link?.webUrl
    if (!webUrl) {
      throw new Error('Graph API: webUrl manquant dans la réponse share-link')
    }
    res.status(200).json({ success: true, shareLink: webUrl })
  } catch (err) {
    logger.error('folder-share-link.graph_failed', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    })
    sendError(res, 'DEPENDENCY_DOWN', 'OneDrive indisponible', requestId)
  }
}

const uploadSessionGuarded: ApiHandler = withRateLimit({
  bucketPrefix: 'upload-session:ip',
  keyFrom: ipKeyFrom,
  max: 30,
  window: '1m',
})(uploadSessionCore)

const folderShareLinkGuarded: ApiHandler = withRateLimit({
  bucketPrefix: 'folder-share-link:ip',
  keyFrom: ipKeyFrom,
  max: 10,
  window: '1m',
})(folderShareLinkCore)

const dispatch: ApiHandler = async (req, res) => {
  const op = parseOp(req)
  if (op === null) {
    const requestId = ensureRequestId(req)
    sendError(res, 'NOT_FOUND', 'Route non disponible', requestId)
    return
  }
  if (op === 'lookup') return lookupGuarded(req, res)
  if (op === 'upload-session') return uploadSessionGuarded(req, res)
  if (op === 'folder-share-link') return folderShareLinkGuarded(req, res)
  const requestId = ensureRequestId(req)
  sendError(res, 'NOT_FOUND', 'Route non disponible', requestId)
}

export default dispatch
export {
  lookupCore as __lookupCore,
  uploadSessionCore as __uploadSessionCore,
  folderShareLinkCore as __folderShareLinkCore,
}
