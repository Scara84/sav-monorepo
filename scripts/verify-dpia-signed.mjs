#!/usr/bin/env node
/**
 * Story 7-7 AC #5(d) — CLI vérification signature DPIA.
 *
 * Usage :
 *   node scripts/verify-dpia-signed.mjs [path/to/dpia/v1.md]
 *
 * Par défaut vérifie : docs/dpia/v1.md (relatif au répertoire d'exécution)
 *
 * Exit codes :
 *   0 → DPIA OK — signature valide (section présente, date ISO 8601, responsable + signature non vides)
 *   1 → Erreur de validation (voir message)
 *
 * Messages d'erreur :
 *   MISSING_SIGNATURE_SECTION — section ## Signature absente
 *   INVALID_DATE_FORMAT       — champ **Date** présent mais format non ISO 8601 (YYYY-MM-DD)
 *   EMPTY_RESPONSABLE         — champ **Responsable** vide ou placeholder
 *   EMPTY_SIGNATURE           — champ **Signature** vide ou placeholder
 *
 * Pattern : cohérent avec scripts/verify-rgpd-export.mjs (Story 7-6)
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function fail(code, message) {
  console.error(`${code}: ${message}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Résoudre le chemin du fichier DPIA
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)
const dpiaPath = argv.length > 0
  ? resolve(argv[0])
  : resolve(__dirname, '../docs/dpia/v1.md')

if (!existsSync(dpiaPath)) {
  fail('MISSING_SIGNATURE_SECTION', `Fichier DPIA introuvable : ${dpiaPath}`)
}

// ---------------------------------------------------------------------------
// Lire le contenu
// ---------------------------------------------------------------------------
let content
try {
  content = readFileSync(dpiaPath, 'utf8')
} catch (e) {
  fail('MISSING_SIGNATURE_SECTION', `Lecture impossible : ${e instanceof Error ? e.message : String(e)}`)
}

// ---------------------------------------------------------------------------
// Vérifier la section ## Signature
// ---------------------------------------------------------------------------
if (!content.includes('## Signature')) {
  fail('MISSING_SIGNATURE_SECTION', 'Section "## Signature" absente du DPIA')
}

// Extraire le contenu après ## Signature
const signatureSection = content.split('## Signature')[1] ?? ''

// ---------------------------------------------------------------------------
// Vérifier **Date** : format ISO 8601 (YYYY-MM-DD)
// ---------------------------------------------------------------------------
const dateMatch = signatureSection.match(/\*\*Date\*\*[ \t]*:[ \t]*(.+)/)
if (!dateMatch) {
  fail('INVALID_DATE_FORMAT', 'Champ **Date** absent de la section ## Signature')
}

const dateValue = (dateMatch[1] ?? '').trim()
// ISO 8601 strict: YYYY-MM-DD
const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/
if (!isoDateRegex.test(dateValue)) {
  fail('INVALID_DATE_FORMAT', `Format de date invalide : "${dateValue}" — attendu YYYY-MM-DD (ISO 8601)`)
}

// Validation supplémentaire : vérifier que c'est une vraie date
const parsedDate = new Date(dateValue)
if (isNaN(parsedDate.getTime())) {
  fail('INVALID_DATE_FORMAT', `Date invalide : "${dateValue}" — n'est pas une date calendaire valide`)
}

// ---------------------------------------------------------------------------
// Vérifier **Responsable** non vide
// ---------------------------------------------------------------------------
const responsableMatch = signatureSection.match(/\*\*Responsable\*\*[ \t]*:[ \t]*(.*)/)
if (!responsableMatch) {
  fail('EMPTY_RESPONSABLE', 'Champ **Responsable** absent de la section ## Signature')
}

const responsableValue = (responsableMatch[1] ?? '').trim()
if (!responsableValue || responsableValue === '' || responsableValue.startsWith('[')) {
  fail('EMPTY_RESPONSABLE', `Champ **Responsable** vide ou non rempli : "${responsableValue}"`)
}

// ---------------------------------------------------------------------------
// Vérifier **Signature** non vide
// ---------------------------------------------------------------------------
const signatureMatch = signatureSection.match(/\*\*Signature\*\*[ \t]*:[ \t]*(.*)/)
if (!signatureMatch) {
  fail('EMPTY_SIGNATURE', 'Champ **Signature** absent de la section ## Signature')
}

const signatureValue = (signatureMatch[1] ?? '').trim()
if (!signatureValue || signatureValue === '' || signatureValue.startsWith('[')) {
  fail('EMPTY_SIGNATURE', `Champ **Signature** vide ou non rempli : "${signatureValue}"`)
}

// ---------------------------------------------------------------------------
// OK
// ---------------------------------------------------------------------------
console.log(`DPIA OK — signature valide (date: ${dateValue}, responsable: ${responsableValue})`)
process.exit(0)
