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
}

const APP_VERSION = process.env['VERCEL_GIT_COMMIT_SHA'] ?? 'local'

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  const requestId = ensureRequestId(req)
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'GET only', requestId } })
    return
  }

  const checks: HealthCheck['checks'] = {
    db: await checkDb(requestId),
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
  res.status(worst === 'down' ? 503 : 200).json(body)
}

async function checkDb(requestId: string): Promise<CheckState> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    const { error } = await supabaseAdmin()
      .from('settings')
      .select('id')
      .limit(1)
      .abortSignal(controller.signal)
    clearTimeout(timer)
    if (error) {
      const e = error as { message?: string; code?: string; details?: string; hint?: string }
      // Log en texte brut pour traverser la troncature des logs Vercel
      console.error(
        `[HEALTH-DB-DEGRADED] code=${e.code ?? 'none'} msg=${e.message ?? 'none'} details=${e.details ?? 'none'} hint=${e.hint ?? 'none'}`
      )
      return 'degraded'
    }
    return 'ok'
  } catch (err) {
    clearTimeout(timer)
    logger.error('healthcheck db down', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    })
    return 'down'
  }
}

/** Vérification statique : les env vars Graph sont renseignées. Ping réel en Story 1.7.E2E. */
function checkGraph(): CheckState {
  if (!process.env['MICROSOFT_TENANT_ID'] || !process.env['MICROSOFT_CLIENT_ID']) return 'down'
  return 'ok'
}

/** Vérification statique : les env vars SMTP sont renseignées. Ping réel en E2E. */
function checkSmtp(): CheckState {
  if (!process.env['SMTP_HOST'] || !process.env['SMTP_USER']) return 'down'
  return 'ok'
}
