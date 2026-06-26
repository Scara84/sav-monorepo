import { z } from 'zod'
import { withRateLimit } from '../middleware/with-rate-limit'
import { withValidation } from '../middleware/with-validation'
import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { findOperatorCredentialsByEmail, logAuthEvent, operatorToSessionUser } from './operator'
import { hashEmail, hashIp, isSafeReturnTo } from './magic-link'
import { verifyPassword } from './password'
import { issueSessionCookie, readOperatorSessionTtlSec } from './session'
import { isAllowedOrigin, readOrigin } from './origin-check'
import type { ApiHandler, ApiRequest } from '../types'

const bodySchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(1024),
})

const NEUTRAL_ERROR = 'Identifiants invalides.'

const coreHandler: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)

  if (req.method !== 'POST') {
    sendError(res, 'METHOD_NOT_ALLOWED', 'POST attendu', requestId)
    return
  }

  const appBase = process.env['APP_BASE_URL']
  const sessionSecret = process.env['SESSION_COOKIE_SECRET']
  if (!appBase || !sessionSecret) {
    logger.error('operator password login config missing', { requestId })
    sendError(res, 'SERVER_ERROR', 'Configuration manquante', requestId)
    return
  }

  if (!isAllowedOrigin(req, appBase)) {
    logger.warn('operator password login cross-origin blocked', {
      requestId,
      origin: readOrigin(req),
    })
    sendError(res, 'FORBIDDEN', 'Origine non autorisée', requestId)
    return
  }

  const body = req.body as z.infer<typeof bodySchema>
  const email = body.email.normalize('NFC').toLowerCase().trim()
  const ua = readUserAgent(req)
  const ipSrc = readIp(req)
  const ipHash = ipSrc ? hashIp(ipSrc) : undefined

  try {
    const operator = await findOperatorCredentialsByEmail(email)
    if (!operator || !operator.is_active || !operator.password_hash) {
      const failure: {
        email: string
        operatorId?: number
        reason: string
        ipHash?: string
        userAgent?: string
      } = {
        email,
        reason: !operator
          ? 'operator_not_found'
          : !operator.is_active
            ? 'operator_inactive'
            : 'password_not_set',
      }
      if (operator?.id !== undefined) failure.operatorId = operator.id
      if (ipHash) failure.ipHash = ipHash
      if (ua) failure.userAgent = ua
      await logPasswordFailure(failure)
      await sleep(250)
      sendError(res, 'UNAUTHENTICATED', NEUTRAL_ERROR, requestId)
      return
    }

    const ok = await verifyPassword(body.password, operator.password_hash)
    if (!ok) {
      const failure: {
        email: string
        operatorId?: number
        reason: string
        ipHash?: string
        userAgent?: string
      } = {
        email,
        operatorId: operator.id,
        reason: 'bad_password',
      }
      if (ipHash) failure.ipHash = ipHash
      if (ua) failure.userAgent = ua
      await logPasswordFailure(failure)
      await sleep(250)
      sendError(res, 'UNAUTHENTICATED', NEUTRAL_ERROR, requestId)
      return
    }

    const ttlSec = readOperatorSessionTtlSec()
    const sessionCookie = issueSessionCookie({
      user: operatorToSessionUser(operator),
      ttlSec,
      secret: sessionSecret,
    })

    const rawReturnTo = req.query?.['returnTo']
    const returnToCandidate = Array.isArray(rawReturnTo) ? rawReturnTo[0] : rawReturnTo
    const redirectTo = isSafeReturnTo(returnToCandidate) ? returnToCandidate : '/admin'

    await logAuthEvent({
      eventType: 'operator_password_login_succeeded',
      operatorId: operator.id,
      emailHash: hashEmail(operator.email),
      ...(ipHash ? { ipHash } : {}),
      ...(ua ? { userAgent: ua } : {}),
      metadata: {
        ttl_sec: ttlSec,
        return_to_used: redirectTo === '/admin' ? 'default' : 'custom',
      },
    }).catch(() => undefined)

    res.setHeader('Set-Cookie', sessionCookie)
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({ ok: true, redirectTo })
  } catch (err) {
    logger.error('operator password login failed', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    })
    sendError(res, 'SERVER_ERROR', 'Erreur interne', requestId)
  }
}

async function logPasswordFailure(input: {
  email: string
  operatorId?: number
  reason: string
  ipHash?: string
  userAgent?: string
}): Promise<void> {
  await logAuthEvent({
    eventType: 'operator_password_login_failed',
    ...(input.operatorId !== undefined ? { operatorId: input.operatorId } : {}),
    emailHash: hashEmail(input.email),
    ...(input.ipHash ? { ipHash: input.ipHash } : {}),
    ...(input.userAgent ? { userAgent: input.userAgent } : {}),
    metadata: { reason: input.reason },
  }).catch(() => undefined)
}

function readUserAgent(req: ApiRequest): string | undefined {
  const ua = req.headers['user-agent']
  return Array.isArray(ua) ? ua[0] : ua
}

function readIp(req: ApiRequest): string | undefined {
  if (req.ip) return req.ip
  const fwd = req.headers['x-forwarded-for']
  const firstFwd = Array.isArray(fwd) ? fwd[0] : fwd
  if (typeof firstFwd === 'string' && firstFwd.length > 0) return firstFwd.split(',')[0]?.trim()
  return undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export const operatorPasswordLoginHandler: ApiHandler = withValidation({ body: bodySchema })(
  originCheckBeforeRateLimit(
    withRateLimit({
      bucketPrefix: 'op-login:email',
      keyFrom: (req: ApiRequest) => {
        const b = req.body as { email?: unknown } | undefined
        return typeof b?.email === 'string'
          ? b.email.normalize('NFC').toLowerCase().trim()
          : undefined
      },
      max: 10,
      window: '1h',
    })(
      withRateLimit({
        bucketPrefix: 'op-login:ip',
        keyFrom: (req: ApiRequest) => readIp(req) ?? 'unknown',
        max: 20,
        window: '15m',
      })(coreHandler)
    )
  )
)

export { coreHandler as __operatorPasswordLoginCoreHandler }

function originCheckBeforeRateLimit(handler: ApiHandler): ApiHandler {
  return async (req, res) => {
    const requestId = ensureRequestId(req)
    const appBase = process.env['APP_BASE_URL']
    if (!appBase) {
      logger.error('operator password login config missing', { requestId })
      sendError(res, 'SERVER_ERROR', 'Configuration manquante', requestId)
      return
    }

    if (!isAllowedOrigin(req, appBase)) {
      logger.warn('operator password login cross-origin blocked', {
        requestId,
        origin: readOrigin(req),
      })
      sendError(res, 'FORBIDDEN', 'Origine non autorisée', requestId)
      return
    }

    return handler(req, res)
  }
}
