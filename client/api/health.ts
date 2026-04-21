import { supabaseAdmin } from './_lib/_typed-shim'
import { ensureRequestId } from './_lib/request-id'
import { logger } from './_lib/logger'
import type { ApiRequest, ApiResponse } from './_lib/types'

type CheckState = 'ok' | 'degraded' | 'down'

interface HealthCheck {
  status: 'ok' | 'degraded'
  checks: {
    db: CheckState
    graph: CheckState
    smtp: CheckState
  }
  version: string
  timestamp: string
  debug?: { dbError?: unknown }
}

const APP_VERSION = process.env['VERCEL_GIT_COMMIT_SHA'] ?? 'local'

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  const requestId = ensureRequestId(req)
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'GET only', requestId } })
    return
  }

  const dbResult = await checkDb(requestId)
  const checks: HealthCheck['checks'] = {
    db: dbResult.state,
    graph: checkGraph(),
    smtp: checkSmtp(),
  }
  const worst: CheckState = Object.values(checks).includes('down')
    ? 'down'
    : Object.values(checks).includes('degraded')
      ? 'degraded'
      : 'ok'
  const body: HealthCheck = {
    status: worst === 'ok' ? 'ok' : 'degraded',
    checks,
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
  }
  // Debug détail erreur DB : uniquement hors production ET si HEALTH_DEBUG=1.
  if (
    process.env['HEALTH_DEBUG'] === '1' &&
    process.env['VERCEL_ENV'] !== 'production' &&
    dbResult.error
  ) {
    body.debug = { dbError: dbResult.error }
  }
  // 503 uniquement si la DB est down. Graph/SMTP env manquants → 200 avec status=degraded.
  res.status(checks.db === 'down' ? 503 : 200).json(body)
}

async function checkDb(requestId: string): Promise<{ state: CheckState; error?: unknown }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const { error } = await supabaseAdmin()
      .from('settings')
      .select('id')
      .limit(1)
      .abortSignal(controller.signal)
    clearTimeout(timer)
    if (error) {
      const e = error as { message?: string; code?: string; details?: string; hint?: string }
      console.error(
        `[HEALTH-DB-DEGRADED] code=${e.code ?? 'none'} msg=${e.message ?? 'none'} details=${e.details ?? 'none'} hint=${e.hint ?? 'none'}`
      )
      return {
        state: 'degraded',
        error: { code: e.code, message: e.message, details: e.details, hint: e.hint },
      }
    }
    return { state: 'ok' }
  } catch (err) {
    clearTimeout(timer)
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('healthcheck db down', { requestId, error: msg })
    return { state: 'down', error: { message: msg } }
  }
}

/** Vérification statique : les env vars Graph sont renseignées. Ping réel en Story 1.7.E2E. */
function checkGraph(): CheckState {
  if (!process.env['MICROSOFT_TENANT_ID'] || !process.env['MICROSOFT_CLIENT_ID']) return 'degraded'
  return 'ok'
}

/** Vérification statique : les env vars SMTP sont renseignées. Ping réel en E2E. */
function checkSmtp(): CheckState {
  if (!process.env['SMTP_HOST'] || !process.env['SMTP_USER']) return 'degraded'
  return 'ok'
}
