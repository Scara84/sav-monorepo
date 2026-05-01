import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Story 7-6 D-1 — helpers signature HMAC-SHA256 base64url + canonical-JSON
 * pour l'export RGPD (`POST /api/admin/members/:id/rgpd-export`).
 *
 * Pourquoi canonical-JSON tri alphabétique récursif :
 *   `JSON.stringify` standard préserve l'ordre d'insertion. Un SELECT
 *   PostgREST/Supabase JS peut retourner les colonnes dans un ordre non
 *   garanti par le driver → HMAC instable. Le canonical garantit que
 *   `{a:1,b:2}` et `{b:2,a:1}` produisent le même HMAC.
 *
 * Pourquoi base64url (RFC 4648 §5) :
 *   URL-safe (pas de `+`, `/`, `=`). Permet le passage en query string ou
 *   URL si V2 expose un `download_token`. V1 le HMAC est dans le body JSON,
 *   donc `+/=` aurait fonctionné — base64url choisi pour future-proofing.
 *
 * Fail-fast : `signRgpdExport` et `verifyRgpdExport` throw si secret < 32
 * bytes (D-1 garde-fou).
 */

export interface RgpdExportSignature {
  algorithm: 'HMAC-SHA256'
  encoding: 'base64url'
  value: string
}

export interface RgpdExportEnvelope {
  export_version: '1.0'
  export_id: string
  exported_at: string
  exported_by_operator_id: number
  member_id: number
  data: {
    member: Record<string, unknown>
    sav: Array<Record<string, unknown>>
    sav_lines: Array<Record<string, unknown>>
    sav_comments: Array<Record<string, unknown>>
    sav_files: Array<Record<string, unknown>>
    credit_notes: Array<Record<string, unknown>>
    auth_events: Array<Record<string, unknown>>
  }
}

export interface RgpdExport extends RgpdExportEnvelope {
  signature: RgpdExportSignature
}

const MIN_SECRET_BYTES = 32

function assertSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_BYTES) {
    throw new Error('RGPD_SECRET_NOT_CONFIGURED')
  }
}

/**
 * Sérialise `value` en JSON canonical : clés des objets triées alphabétique,
 * récursif. Les arrays préservent leur ordre (l'ordre des éléments est
 * sémantique, pas l'ordre des clés).
 */
export function canonicalStringify(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalStringify(v)).join(',') + ']'
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') + '}'
}

/**
 * Calcule la signature HMAC-SHA256 base64url sur le canonical-JSON de
 * l'enveloppe (sans le champ `signature`).
 */
export function signRgpdExport(envelope: RgpdExportEnvelope, secret: string): RgpdExportSignature {
  assertSecret(secret)
  const canonical = canonicalStringify(envelope)
  const value = createHmac('sha256', secret).update(canonical).digest('base64url')
  return { algorithm: 'HMAC-SHA256', encoding: 'base64url', value }
}

/**
 * Vérifie la signature HMAC d'un export complet via comparaison
 * constant-time (`crypto.timingSafeEqual`).
 *
 * Renvoie `false` si :
 *   - signature.algorithm n'est pas 'HMAC-SHA256'
 *   - signature.encoding n'est pas 'base64url'
 *   - longueur de la signature ne match pas la valeur recalculée
 *   - mismatch byte-à-byte
 *   - mauvais secret
 */
export function verifyRgpdExport(full: RgpdExport, secret: string): boolean {
  assertSecret(secret)
  if (!full || typeof full !== 'object') return false
  const sig = full.signature
  if (!sig || sig.algorithm !== 'HMAC-SHA256' || sig.encoding !== 'base64url') return false
  const { signature: _omitted, ...envelope } = full
  void _omitted
  const expected = createHmac('sha256', secret)
    .update(canonicalStringify(envelope))
    .digest('base64url')
  if (expected.length !== sig.value.length) return false
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(sig.value))
  } catch {
    return false
  }
}
