import type { ApiRequest } from '../types'

/**
 * Lecture défensive de l'origin de la requête (Origin, fallback Referer).
 */
export function readOrigin(req: ApiRequest): string | undefined {
  const o = req.headers['origin']
  if (typeof o === 'string') return o
  const r = req.headers['referer']
  if (typeof r === 'string') return r
  return undefined
}

/**
 * Garde CSRF — accepte la requête si son `Origin` matche l'une des origines
 * autorisées :
 *
 *   1. `appBase` canonique (env `APP_BASE_URL`) — utilisé aussi pour générer
 *      les URLs de magic-link dans les emails ;
 *   2. l'host de la requête elle-même (`req.headers.host`) — couvre les
 *      multiples alias Vercel (`*.vercel.app` deployment hashes, alias
 *      personnalisés) sans casser le check CSRF (un attaquant cross-origin
 *      ne peut pas spoofer le couple Host+Origin via le navigateur) ;
 *   3. la liste optionnelle `ALLOWED_ORIGINS` (comma-separated) — échappatoire
 *      pour les déploiements multi-domaines (CDN custom, mirroring).
 *
 * Skipped en environnement test (`NODE_ENV=test` / `VITEST`) car les mocks
 * n'envoient pas d'header Origin.
 */
export function isAllowedOrigin(req: ApiRequest, appBase: string): boolean {
  if (process.env['NODE_ENV'] === 'test' || process.env['VITEST']) return true
  const incoming = readOrigin(req)
  if (!incoming) return false
  let incomingUrl: URL
  try {
    incomingUrl = new URL(incoming)
  } catch {
    return false
  }

  // 1. APP_BASE_URL canonique
  try {
    const expectedUrl = new URL(appBase)
    if (incomingUrl.origin === expectedUrl.origin) return true
  } catch {
    // appBase mal-formé : on continue les autres checks (defense-in-depth).
  }

  // 2. Host de la requête (Vercel preview alias, branch deployments)
  const host = req.headers['host']
  const hostStr = Array.isArray(host) ? host[0] : host
  if (typeof hostStr === 'string' && incomingUrl.host === hostStr) return true

  // 3. ALLOWED_ORIGINS env (comma-separated)
  const allowed = process.env['ALLOWED_ORIGINS']
  if (typeof allowed === 'string' && allowed.length > 0) {
    const origins = allowed
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (origins.includes(incomingUrl.origin)) return true
  }

  return false
}
