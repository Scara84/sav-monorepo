#!/usr/bin/env node
/**
 * Story 7-6 AC #2 D-1 — CLI standalone vérif HMAC d'un export RGPD.
 *
 * Usage :
 *   RGPD_EXPORT_HMAC_SECRET=<secret> node scripts/verify-rgpd-export.mjs <path/to/export.json>
 *
 * Exit codes :
 *   0 → signature valide ("Signature valide")
 *   1 → signature invalide / payload altéré / secret manquant / fichier KO
 *
 * Le script ré-implémente le canonical-JSON tri alphabétique récursif
 * + HMAC-SHA256 base64url + comparaison constant-time, sans dépendre du
 * module TS handler (utilisable en standalone par un auditeur RGPD avec
 * juste Node.js + le secret).
 */

import { readFileSync } from 'node:fs'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { resolve } from 'node:path'

function fail(message) {
  console.error(`ERREUR : ${message}`)
  process.exit(1)
}

function canonicalStringify(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalStringify).join(',') + ']'
  }
  const keys = Object.keys(value).sort()
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(value[k])).join(',') +
    '}'
  )
}

const argv = process.argv.slice(2)
if (argv.length === 0) {
  fail('chemin du fichier export RGPD requis (argv[1])')
}

const filePath = resolve(argv[0])
const secret = process.env.RGPD_EXPORT_HMAC_SECRET
if (!secret || secret.length < 32) {
  fail('RGPD_EXPORT_HMAC_SECRET non configuré ou < 32 bytes (env var)')
}

let raw
try {
  raw = readFileSync(filePath, 'utf8')
} catch (e) {
  fail(`lecture fichier impossible : ${e instanceof Error ? e.message : String(e)}`)
}

let full
try {
  full = JSON.parse(raw)
} catch (e) {
  fail(`JSON invalide : ${e instanceof Error ? e.message : String(e)}`)
}

if (!full || typeof full !== 'object' || !full.signature) {
  console.error('Signature invalide — payload altéré ou non signé (champ signature absent)')
  process.exit(1)
}

const sig = full.signature
if (sig.algorithm !== 'HMAC-SHA256' || sig.encoding !== 'base64url' || typeof sig.value !== 'string') {
  console.error('Signature invalide — algorithm/encoding non supportés')
  process.exit(1)
}

const { signature: _omitted, ...envelope } = full
void _omitted
const expected = createHmac('sha256', secret).update(canonicalStringify(envelope)).digest('base64url')

if (expected.length !== sig.value.length) {
  console.error('Signature invalide — payload altéré ou secret rotated')
  process.exit(1)
}

let match = false
try {
  match = timingSafeEqual(Buffer.from(expected), Buffer.from(sig.value))
} catch {
  match = false
}

if (match) {
  console.log('Signature valide')
  process.exit(0)
}
console.error('Signature invalide — payload altéré ou secret rotated')
process.exit(1)
