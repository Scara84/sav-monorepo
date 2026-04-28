import { z } from 'zod'
import { withRateLimit } from './_lib/middleware/with-rate-limit'
import { ensureRequestId } from './_lib/request-id'
import { sendError } from './_lib/errors'
import { logger } from './_lib/logger'
import { hashEmail } from './_lib/auth/magic-link'
import { createHash } from 'node:crypto'
import {
  findInvoiceByNumber,
  PennylaneTimeoutError,
  PennylaneUnauthorizedError,
  PennylaneUpstreamError,
} from './_lib/clients/pennylane'
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

const ALLOWED_OPS = new Set(['lookup'])

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
const lookupGuarded: ApiHandler = withRateLimit({
  bucketPrefix: 'invoice-lookup:ip',
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
  max: 5,
  window: '1m',
})(lookupCore)

const dispatch: ApiHandler = async (req, res) => {
  const op = parseOp(req)
  if (op === null) {
    const requestId = ensureRequestId(req)
    sendError(res, 'NOT_FOUND', 'Route non disponible', requestId)
    return
  }
  if (op === 'lookup') return lookupGuarded(req, res)
  // Future ops viennent ici.
  const requestId = ensureRequestId(req)
  sendError(res, 'NOT_FOUND', 'Route non disponible', requestId)
}

export default dispatch
export { lookupCore as __lookupCore }
