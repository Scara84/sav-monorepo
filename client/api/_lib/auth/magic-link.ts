import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { supabaseAdmin } from '../clients/supabase-admin'

/** TTL d'un magic link : 15 min (NFR-S5). */
export const MAGIC_LINK_TTL_SEC = 15 * 60

export type MagicLinkKind = 'member' | 'operator'

export interface MagicLinkPayload {
  sub: number
  jti: string
  iat: number
  exp: number
  /**
   * Discriminateur ajouté Story 5.8.
   * - Tokens émis avant 5.8 : champ absent → traité comme 'member' à la vérification (rétrocompat).
   * - Tokens émis après 5.8 : 'member' (issue.ts adhérent) ou 'operator' (operator/issue.ts).
   *
   * Le verify endpoint REJETTE un token dont le `kind` ne matche pas celui attendu
   * (cross-use protection : un token adhérent ne peut pas ouvrir une session opérateur
   * et inversement).
   */
  kind?: MagicLinkKind
  /**
   * Story H-04 (W43) — chemin de redirection post-login.
   * - Tokens émis avant H-04 : champ absent → fallback `/admin` côté verify (rétrocompat).
   * - Tokens émis après H-04 : présent UNIQUEMENT si `isSafeReturnTo()` a retourné true côté issue.
   * - Re-validation côté verify (defense-in-depth) : même si claim présent, si `isSafeReturnTo()`
   *   retourne false (futur bug isMagicLinkPayload ou secret leak), fallback `/admin`.
   */
  returnTo?: string
}

// -----------------------------------------------------------------------
// JWT HS256 spécifique aux magic links (clé distincte de session cookie)
// -----------------------------------------------------------------------

function base64UrlEncode(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(s: string): string {
  const pad = '='.repeat((4 - (s.length % 4)) % 4)
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(b64, 'base64').toString('utf8')
}

function signPayload(payload: MagicLinkPayload, secret: string): string {
  const header = { alg: 'HS256', typ: 'JWT' }
  const h = base64UrlEncode(JSON.stringify(header))
  const p = base64UrlEncode(JSON.stringify(payload))
  const s = base64UrlEncode(createHmac('sha256', secret).update(`${h}.${p}`).digest())
  return `${h}.${p}.${s}`
}

export function signMagicLink(
  memberId: number,
  secret: string,
  now: number = Math.floor(Date.now() / 1000)
): { token: string; jti: string; expiresAt: Date } {
  const jti = randomUUID()
  const payload: MagicLinkPayload = {
    sub: memberId,
    jti,
    iat: now,
    exp: now + MAGIC_LINK_TTL_SEC,
    kind: 'member',
  }
  return { token: signPayload(payload, secret), jti, expiresAt: new Date(payload.exp * 1000) }
}

/**
 * Story H-04 (W43) — valide qu'un returnTo candidat est un chemin interne sûr.
 *
 * Règles (DN-3 : double-validation issue + verify ; DN-4 : length cap 512 ; DN-A : rejeter `..` ; DN-B : tighten regex) :
 *   - DOIT être une string (pas array, pas undefined, pas number)
 *   - DOIT commencer par `/` unique (pas `//` ni `/\` — protocol-relative + Windows-style)
 *   - NE DOIT PAS contenir `//` n'importe où dans le path (mid-path double-slash, DN-B)
 *   - NE DOIT PAS contenir `..` (traversée de répertoire parent, DN-A Option 1)
 *   - DOIT match la char-class `[A-Za-z0-9/_\-.~?=&%]` (rejette CRLF, `\0`, `<`, `>`, `#`, espaces…)
 *   - Longueur ≤ 512 (anti-DoS JWT bloat, DN-4)
 *
 * Regex finale : `^\/(?![/\\])(?!.*\/\/)(?!.*\.\.)[A-Za-z0-9/_\-.~?=&%]{0,511}$`
 *
 * Exemples acceptés : `/admin`, `/admin/sav/123`, `/admin/sav/123?tab=lines`,
 *   `/admin/sav/.123` (point non parent), longueur exacte 512
 * Exemples rejetés :
 *   - `//evil.com`              → protocol-relative (leading //)
 *   - `/\evil.com`              → Windows-style → ambigu navigateur
 *   - `/admin//evil.com`        → mid-path // (DN-B)
 *   - `/admin/../etc/passwd`    → segment parent .. (DN-A Option 1)
 *   - `https://evil.com`        → pas un chemin
 *   - `admin/sav/123`           → relatif (pas leading `/`)
 *   - `/admin\r\nLocation: …`   → CRLF injection header splitting
 *   - `/<script>`               → caractère interdit
 *   - `/admin#section`          → `#` rejeté (DN-4 Option A : fragments inutiles côté serveur)
 *   - `${'a'.repeat(600)}`      → trop long
 */
export function isSafeReturnTo(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > 512) return false
  if (!value.startsWith('/')) return false
  if (value.startsWith('//') || value.startsWith('/\\')) return false
  return /^\/(?![/\\])(?!.*\/\/)(?!.*\.\.)[A-Za-z0-9/_\-.~?=&%]{0,511}$/.test(value)
}

/**
 * Story 5.8 — sign d'un magic link opérateur.
 * Payload identique sauf `kind: 'operator'` qui empêche le cross-use avec
 * /api/auth/magic-link/verify (endpoint adhérent).
 *
 * Story H-04 — signature migrée vers options bag pour support returnTo claim.
 * Rétrocompat : appel sans options bag fonctionne comme avant.
 */
export function signOperatorMagicLink(
  operatorId: number,
  secret: string,
  options?: { returnTo?: string; now?: number }
): { token: string; jti: string; expiresAt: Date } {
  const now = options?.now ?? Math.floor(Date.now() / 1000)
  const jti = randomUUID()
  const payload: MagicLinkPayload = {
    sub: operatorId,
    jti,
    iat: now,
    exp: now + MAGIC_LINK_TTL_SEC,
    kind: 'operator',
  }
  // returnTo : on n'inclut le claim QUE si déjà validé safe côté caller.
  // Defense-in-depth : verify revalide aussi (cf. consumer dans verify.ts).
  if (options?.returnTo !== undefined && isSafeReturnTo(options.returnTo)) {
    payload.returnTo = options.returnTo
  }
  return { token: signPayload(payload, secret), jti, expiresAt: new Date(payload.exp * 1000) }
}

export type VerifyResult =
  | { ok: true; payload: MagicLinkPayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'bad_payload' }

export function verifyMagicLink(
  token: string,
  secret: string,
  now: number = Math.floor(Date.now() / 1000)
): VerifyResult {
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed' }
  const [h, p, s] = parts as [string, string, string]
  let header: { alg?: string }
  try {
    header = JSON.parse(base64UrlDecode(h))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (header.alg !== 'HS256') return { ok: false, reason: 'malformed' }

  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest()
  let given: Buffer
  try {
    const pad = '='.repeat((4 - (s.length % 4)) % 4)
    const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/')
    given = Buffer.from(b64, 'base64')
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'bad_signature' }
  }

  let payload: unknown
  try {
    payload = JSON.parse(base64UrlDecode(p))
  } catch {
    return { ok: false, reason: 'bad_payload' }
  }
  if (!isMagicLinkPayload(payload)) return { ok: false, reason: 'bad_payload' }
  if (payload.exp <= now) return { ok: false, reason: 'expired' }
  return { ok: true, payload }
}

function isMagicLinkPayload(v: unknown): v is MagicLinkPayload {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  if (
    typeof o['sub'] !== 'number' ||
    typeof o['jti'] !== 'string' ||
    typeof o['iat'] !== 'number' ||
    typeof o['exp'] !== 'number'
  ) {
    return false
  }
  // `kind` est optionnel pour rétrocompat (tokens émis avant Story 5.8) ;
  // si présent doit être 'member' ou 'operator'.
  if (o['kind'] !== undefined && o['kind'] !== 'member' && o['kind'] !== 'operator') {
    return false
  }
  // `returnTo` est optionnel (tokens émis avant H-04 n'ont pas ce champ) ;
  // si présent doit être une string. Re-validation via isSafeReturnTo côté consumer.
  if (o['returnTo'] !== undefined && typeof o['returnTo'] !== 'string') {
    return false
  }
  return true
}

// -----------------------------------------------------------------------
// Persistance des tokens (table magic_link_tokens — polymorphique 5.8)
// -----------------------------------------------------------------------

export interface StoreTokenArgs {
  jti: string
  memberId: number
  expiresAt: Date
  ipHash?: string
  userAgent?: string
}

export async function storeTokenIssue(args: StoreTokenArgs): Promise<void> {
  const row: Record<string, unknown> = {
    jti: args.jti,
    target_kind: 'member',
    member_id: args.memberId,
    expires_at: args.expiresAt.toISOString(),
  }
  if (args.ipHash !== undefined) row['ip_hash'] = args.ipHash
  if (args.userAgent !== undefined) row['user_agent'] = args.userAgent
  const { error } = await supabaseAdmin().from('magic_link_tokens').insert(row)
  if (error) throw error
}

export interface StoreOperatorTokenArgs {
  jti: string
  operatorId: number
  expiresAt: Date
  ipHash?: string
  userAgent?: string
}

/**
 * Story 5.8 — INSERT magic_link_tokens avec target_kind='operator'.
 * member_id reste null ; la CHECK XOR `magic_link_tokens_target_xor` est respectée.
 */
export async function storeOperatorTokenIssue(args: StoreOperatorTokenArgs): Promise<void> {
  const row: Record<string, unknown> = {
    jti: args.jti,
    target_kind: 'operator',
    operator_id: args.operatorId,
    expires_at: args.expiresAt.toISOString(),
  }
  if (args.ipHash !== undefined) row['ip_hash'] = args.ipHash
  if (args.userAgent !== undefined) row['user_agent'] = args.userAgent
  const { error } = await supabaseAdmin().from('magic_link_tokens').insert(row)
  if (error) throw error
}

export interface MagicLinkTokenRow {
  jti: string
  target_kind: 'member' | 'operator'
  member_id: number | null
  operator_id: number | null
  issued_at: string
  expires_at: string
  used_at: string | null
}

export async function findTokenByJti(jti: string): Promise<MagicLinkTokenRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('magic_link_tokens')
    .select('jti, target_kind, member_id, operator_id, issued_at, expires_at, used_at')
    .eq('jti', jti)
    .maybeSingle()
  if (error) throw error
  return (data as MagicLinkTokenRow | null) ?? null
}

/** Marque un token comme consommé (idempotent : update WHERE used_at IS NULL). */
export async function consumeToken(jti: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from('magic_link_tokens')
    .update({ used_at: new Date().toISOString() })
    .eq('jti', jti)
    .is('used_at', null)
    .select('jti')
  if (error) throw error
  return Array.isArray(data) && data.length > 0
}

export function hashEmail(email: string): string {
  return createHash('sha256').update(email.toLowerCase().trim()).digest('hex')
}

export function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex')
}
