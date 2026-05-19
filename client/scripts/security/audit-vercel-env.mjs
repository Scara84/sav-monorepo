#!/usr/bin/env node
/**
 * audit-vercel-env.mjs — Script d'audit des variables d'environnement Vercel
 *
 * @description
 * Audite les env vars configurées sur un projet Vercel via l'API REST v9.
 * Compare la liste réelle Vercel avec la liste de référence issue de `client/.env.example`.
 * Produit un rapport de findings : secrets exposés en VITE_*, vars manquantes en Production,
 * vars orphelines (présentes sur Vercel mais absentes de .env.example), vars dont la date
 * de mise à jour Prod == Preview (signal de copy-paste — même valeur probable).
 *
 * @prérequis
 * Un PAT (Personal Access Token) Vercel scopé `read:env` est nécessaire.
 * Créer via : https://vercel.com/account/settings/tokens
 * - Scope : "Read" (cocher "Environment Variables")
 * - Stocker dans : ~/.vercel-token-audit (chmod 600, JAMAIS dans le repo)
 *
 * @see https://vercel.com/docs/rest-api/endpoints/projects#filter-project-environment-variables
 * @see Endpoint utilisé : GET /v9/projects/{projectId}/env?decrypt=false
 *
 * @rationale decrypt=false (DN-3)
 * L'option `?decrypt=[valeur]` accepte "true" ou "false". Avec "true", les valeurs
 * de secrets seraient retournées en clair dans la réponse API — inacceptable pour
 * un script pouvant s'exécuter en CI ou laisser des traces dans les logs.
 * Ce script utilise TOUJOURS decrypt=false : seuls les noms, scopes, types et
 * timestamps sont retournés, ce qui suffit pour détecter les anomalies structurelles
 * sans exposer les valeurs sensibles.
 *
 * @usage
 *   node client/scripts/security/audit-vercel-env.mjs \
 *     --token-file ~/.vercel-token-audit \
 *     --project-id prj_4oLSqDRj5756Ep2u72Zm5FChSi0D
 *
 *   # Ou via env var (moins sûr — préférer --token-file) :
 *   VERCEL_TOKEN=<pat> node client/scripts/security/audit-vercel-env.mjs \
 *     --project-id prj_4oLSqDRj5756Ep2u72Zm5FChSi0D
 *
 * @exit-codes
 *   0 — aucun finding critique
 *   1 — findings critiques détectés (VITE_* secret, var CRITICAL_VARS manquante en Production)
 *   2 — erreur d'usage (token manquant, project-id manquant)
 *
 * PATTERN-H18-A — Naming discipline :
 *   VITE_* = valeur publique, exposée bundle SPA → JAMAIS contenir secret/token/password
 *   *_SECRET / *_TOKEN / *_PASSWORD / *SERVICE_ROLE* = valeur privée server-only
 *
 * Story : h-18-vercel-env-vars-audit.md
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// CRITICAL_VARS — Set des 12 vars dont l'absence en Production → exit code 1
// (D2) — auditable, hardcodé, ne dépend pas de .env.example dynamiquement
// (DN-1 Option A) — CRON_SECRET ajouté comme operational must-have
// ---------------------------------------------------------------------------

export const CRITICAL_VARS = new Set([
  // Auth/crypto secrets
  'SUPABASE_SERVICE_ROLE_KEY', 'MAGIC_LINK_SECRET', 'SESSION_COOKIE_SECRET',
  'RGPD_EXPORT_HMAC_SECRET', 'MICROSOFT_CLIENT_SECRET',
  // Boot-fatal vars
  'VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'VITE_API_KEY',
  'SUPABASE_DB_URL', 'MICROSOFT_TENANT_ID', 'MICROSOFT_CLIENT_ID',
  // Operational must-have (DN-1 Option A)
  'CRON_SECRET',
])

// ---------------------------------------------------------------------------
// Whitelist AC#2.b — seule exception VITE_* autorisée à ne pas être un secret
// VITE_API_KEY = HMAC partagé front-API pour le filtrage frame, conçu pour
// être public dans le bundle SPA (pas un secret server-only).
// ---------------------------------------------------------------------------
const VITE_SECRET_WHITELIST = new Set(['VITE_API_KEY'])

// Regex des vars Vercel system injectées automatiquement — skip dans detectOrphans
const VERCEL_SYSTEM_VARS_RE = /^(NODE_ENV|VERCEL|VERCEL_.*|CI|VITEST)$/

// Pattern PATTERN-H18-A — regex de détection suffixe secret dans les noms VITE_*
const VITE_SECRET_PATTERN = /(_SECRET|_TOKEN|SERVICE_ROLE|PASSWORD)/i

// ---------------------------------------------------------------------------
// filterViteSecrets — détecte les VITE_* portant un suffixe secret (AC#2)
// ---------------------------------------------------------------------------

/**
 * Filtre les variables VITE_* dont le nom contient un suffixe secret.
 * Exclut VITE_API_KEY (whitelist AC#2.b).
 *
 * @param {Array<{key: string, target: string[], type: string, [key: string]: unknown}>} vars
 * @returns {Array} — vars VITE_* violant PATTERN-H18-A
 */
export function filterViteSecrets(vars) {
  return vars.filter(
    (v) =>
      v.key.startsWith('VITE_') &&
      VITE_SECRET_PATTERN.test(v.key) &&
      !VITE_SECRET_WHITELIST.has(v.key)
  )
}

// ---------------------------------------------------------------------------
// detectMissing — vars dans expected absentes de Vercel Production (AC#5.b)
// ---------------------------------------------------------------------------

/**
 * Retourne les noms de vars attendus (issus de .env.example) qui sont absents
 * de Vercel avec un scope incluant 'production'.
 *
 * @param {Array<{key: string, target: string[], [key: string]: unknown}>} vars — vars Vercel
 * @param {string[]} expected — noms attendus (depuis .env.example)
 * @returns {string[]} — noms manquants en Production
 */
export function detectMissing(vars, expected) {
  // Construire un Set des keys présentes en Production
  const inProduction = new Set(
    vars
      .filter((v) => Array.isArray(v.target) && v.target.includes('production'))
      .map((v) => v.key)
  )
  return expected.filter((k) => !inProduction.has(k))
}

// ---------------------------------------------------------------------------
// detectOrphans — vars Vercel absentes de .env.example (AC#5.b)
// ---------------------------------------------------------------------------

/**
 * Retourne les noms de vars présents sur Vercel mais absents de la liste
 * de référence (= orphelins, probablement legacy).
 * Chaque nom est dédupliqué (une var peut avoir plusieurs entrées pour Prod/Preview).
 *
 * @param {Array<{key: string, [key: string]: unknown}>} vars — vars Vercel
 * @param {string[]} expected — noms attendus (depuis .env.example)
 * @returns {string[]} — noms orphelins (uniques)
 */
export function detectOrphans(vars, expected) {
  const expectedSet = new Set(expected)
  const seen = new Set()
  for (const v of vars) {
    if (expectedSet.has(v.key)) continue
    if (VERCEL_SYSTEM_VARS_RE.test(v.key)) continue
    seen.add(v.key)
  }
  return [...seen]
}

// ---------------------------------------------------------------------------
// detectStaleSharedUpdate — même updatedAt Prod == Preview (D1)
// Remplace detectSamePrefixProdPreview (impossible avec ?decrypt=false, D1).
// Un timestamp identique à la ms est un signal fort de copy-paste.
// ---------------------------------------------------------------------------

/**
 * Retourne les entrées Vercel dont updatedAt en Production est identique
 * à updatedAt en Preview (à la milliseconde). Signal fort de copy-paste.
 * Retourne les entrées Production correspondantes.
 *
 * @param {Array<{key: string, target: string[], updatedAt?: string, [key: string]: unknown}>} vars
 * @returns {Array} — entrées Production avec updatedAt identique à Preview
 */
export function detectStaleSharedUpdate(vars) {
  // Indexer par key + target
  const byKeyTarget = {}
  for (const v of vars) {
    if (!v.updatedAt) continue
    const targets = Array.isArray(v.target) ? v.target : [v.target]
    for (const t of targets) {
      const key = `${v.key}::${t}`
      byKeyTarget[key] = v
    }
  }

  const stale = []
  // Pour chaque var en production, vérifier si le preview a le même updatedAt
  for (const v of vars) {
    const targets = Array.isArray(v.target) ? v.target : [v.target]
    if (!targets.includes('production') || !v.updatedAt) continue

    const previewEntry = byKeyTarget[`${v.key}::preview`]
    if (previewEntry && previewEntry.updatedAt === v.updatedAt) {
      stale.push(v)
    }
  }
  return stale
}

// ---------------------------------------------------------------------------
// buildFindings — agrège toutes les catégories (AC#5.b + D2)
// ---------------------------------------------------------------------------

/**
 * Agrège tous les findings d'audit en une structure unique.
 * hasCritical = true si viteSecrets.length > 0 OU si une var de CRITICAL_VARS est manquante.
 *
 * @param {Array<{key: string, target: string[], type: string, updatedAt?: string, [key: string]: unknown}>} vars
 * @param {string[]} expected — noms attendus (depuis .env.example)
 * @returns {{viteSecrets: Array, missing: string[], orphans: string[], staleSharedUpdate: Array, hasCritical: boolean}}
 */
export function buildFindings(vars, expected) {
  const viteSecrets = filterViteSecrets(vars)
  const missing = detectMissing(vars, expected)
  const orphans = detectOrphans(vars, expected)
  const staleSharedUpdate = detectStaleSharedUpdate(vars)

  // D2 : hasCritical = VITE_* secret trouvé OU var de CRITICAL_VARS manquante en Production
  const hasCritical =
    viteSecrets.length > 0 || missing.some((k) => CRITICAL_VARS.has(k))

  return { viteSecrets, missing, orphans, staleSharedUpdate, hasCritical }
}

// ---------------------------------------------------------------------------
// fetchAllEnvVars — fetch paginé de l'API Vercel (D3)
// ---------------------------------------------------------------------------

/**
 * Récupère toutes les env vars d'un projet Vercel via l'API REST v9.
 * Gère la pagination via body.pagination.next (URL absolue — D3).
 * Utilise decrypt=false (DN-3) — aucune valeur en clair dans la réponse.
 *
 * @param {string} projectId — ID du projet Vercel (ex: prj_4oLSqDRj...)
 * @param {string} token — PAT Vercel scopé read:env
 * @returns {Promise<Array>} — liste agrégée de toutes les env vars
 * @throws {Error} — si la réponse API n'est pas ok (ex: 401, 403, 404)
 */
export async function fetchAllEnvVars(projectId, token) {
  const MAX_PAGES = 20
  const seenUrls = new Set()
  let pageCount = 0
  let url = `https://api.vercel.com/v9/projects/${projectId}/env?decrypt=false`
  const all = []
  const headers = { Authorization: `Bearer ${token}` }

  while (url) {
    if (pageCount++ >= MAX_PAGES) {
      throw new Error(`Pagination exceeded ${MAX_PAGES} pages — possible loop`)
    }
    if (seenUrls.has(url)) {
      throw new Error(`Pagination loop detected at URL: ${url}`)
    }
    seenUrls.add(url)

    // FIX M-2 — force decrypt=false on every URL (even pagination.next URLs)
    const u = new URL(url)
    u.searchParams.set('decrypt', 'false')
    const fetchUrl = u.toString()

    const res = await fetch(fetchUrl, { headers })
    if (!res.ok) throw new Error(`Vercel API ${res.status} ${res.statusText}`)
    const body = await res.json()
    all.push(...(body.envs ?? []))
    url = body.pagination?.next ?? null
  }
  return all
}

// ---------------------------------------------------------------------------
// parseEnvExample — parse client/.env.example pour extraire les noms de vars
// ---------------------------------------------------------------------------

function parseEnvExample(envExamplePath) {
  if (!existsSync(envExamplePath)) {
    console.warn(`[audit-vercel-env] .env.example not found at: ${envExamplePath}`)
    return []
  }
  const content = readFileSync(envExamplePath, 'utf8')
  const vars = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#') || !trimmed.includes('=')) continue
    const name = trimmed.split('=')[0].trim()
    if (name && /^[A-Z_][A-Z0-9_]*$/.test(name)) vars.push(name)
  }
  return vars
}

// ---------------------------------------------------------------------------
// formatTable — affichage tableau console (AC#5.b)
// ---------------------------------------------------------------------------

function formatTable(vars) {
  const COL_KEY = 40
  const COL_TARGET = 20
  const COL_TYPE = 12
  const COL_ID = 26

  const header =
    'Variable'.padEnd(COL_KEY) +
    ' | ' +
    'Target'.padEnd(COL_TARGET) +
    ' | ' +
    'Type'.padEnd(COL_TYPE) +
    ' | ' +
    'ID'
  const separator = '-'.repeat(COL_KEY + 3 + COL_TARGET + 3 + COL_TYPE + 3 + COL_ID)

  const rows = vars.map((v) => {
    const key = String(v.key ?? '').padEnd(COL_KEY)
    const target = String(Array.isArray(v.target) ? v.target.join(',') : v.target ?? '').padEnd(COL_TARGET)
    const type = String(v.type ?? '').padEnd(COL_TYPE)
    const id = String(v.id ?? v.configurationId ?? '').substring(0, COL_ID)
    return `${key} | ${target} | ${type} | ${id}`
  })

  return [header, separator, ...rows].join('\n')
}

// ---------------------------------------------------------------------------
// main — CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2)

  // Parse --token-file et --project-id
  let tokenFile = null
  let projectId = null

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--token-file' && args[i + 1]) {
      tokenFile = args[i + 1]
      i++
    } else if (args[i] === '--project-id' && args[i + 1]) {
      projectId = args[i + 1]
      i++
    }
  }

  // Lecture du token : priorité CLI flag, fallback VERCEL_TOKEN env var
  let token = null
  if (tokenFile) {
    const tokenFilePath = resolve(tokenFile.replace(/^~(?=$|\/|\\)/, homedir()))
    if (!existsSync(tokenFilePath)) {
      console.error(`[audit-vercel-env] Token file not found: ${tokenFile}`)
      process.exit(2)
    }
    token = readFileSync(tokenFilePath, 'utf8').trim()
  } else if (process.env.VERCEL_TOKEN) {
    token = process.env.VERCEL_TOKEN.trim()
  }

  if (!token) {
    console.error('[audit-vercel-env] Missing token. Use --token-file <path> or set VERCEL_TOKEN env var.')
    process.exit(2)
  }

  if (!projectId) {
    console.error('[audit-vercel-env] Missing --project-id <id>.')
    process.exit(2)
  }

  // Chemin vers .env.example (relatif à client/ — le script est dans client/scripts/security/)
  const clientRoot = resolve(__dirname, '../..')
  const envExamplePath = resolve(clientRoot, '.env.example')
  const expected = parseEnvExample(envExamplePath)

  console.log(`\n[audit-vercel-env] Fetching env vars for project: ${projectId}`)
  console.log('[audit-vercel-env] Using decrypt=false (DN-3 — no secret values in output)\n')

  let allEnvs
  try {
    allEnvs = await fetchAllEnvVars(projectId, token)
  } catch (err) {
    console.error(`[audit-vercel-env] API error: ${err.message}`)
    process.exit(1)
  }

  // Defense-in-depth: never print value field (DN-3)
  const safeEnvs = allEnvs.map(({ value, ...rest }) => rest)

  // Affichage du tableau
  console.log('=== Vercel Environment Variables ===\n')
  console.log(formatTable(safeEnvs))
  console.log(`\nTotal: ${safeEnvs.length} entries\n`)

  // Calcul des findings
  const findings = buildFindings(safeEnvs, expected)

  console.log('=== Findings ===\n')

  if (findings.viteSecrets.length > 0) {
    console.log('CRITICAL — VITE_* variables exposing secrets (PATTERN-H18-A violation):')
    for (const v of findings.viteSecrets) {
      console.log(`  !! ${v.key} (target: ${v.target?.join(',')})`)
    }
    console.log()
  } else {
    console.log('OK — No VITE_* secret exposure detected\n')
  }

  if (findings.missing.length > 0) {
    console.log('MISSING — vars in .env.example not found in Production:')
    for (const k of findings.missing) {
      const isCritical = CRITICAL_VARS.has(k)
      console.log(`  ${isCritical ? '!!' : '--'} ${k}${isCritical ? ' [CRITICAL]' : ''}`)
    }
    console.log()
  } else {
    console.log('OK — All .env.example vars present in Production\n')
  }

  if (findings.orphans.length > 0) {
    console.log('ORPHAN — vars on Vercel not in .env.example (legacy / undocumented):')
    for (const k of findings.orphans) {
      console.log(`  ?? ${k}`)
    }
    console.log()
  } else {
    console.log('OK — No orphan vars detected\n')
  }

  if (findings.staleSharedUpdate.length > 0) {
    console.log('STALE_SHARED_UPDATE — vars with identical updatedAt Prod==Preview (copy-paste signal):')
    for (const v of findings.staleSharedUpdate) {
      console.log(`  ~~ ${v.key} (updatedAt: ${v.updatedAt})`)
    }
    console.log()
  } else {
    console.log('OK — No stale shared update detected\n')
  }

  console.log(`hasCritical: ${findings.hasCritical}`)

  if (findings.hasCritical) {
    console.error('\n[audit-vercel-env] CRITICAL findings detected — exit 1')
    process.exit(1)
  } else {
    console.log('\n[audit-vercel-env] Audit clean — exit 0')
    process.exit(0)
  }
}

// Exécuter main() seulement si lancé directement (pas importé comme module)
// Detection ESM : comparer import.meta.url avec process.argv[1]
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (isMain) {
  main().catch((err) => {
    const msg = String(err?.message ?? err).replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]')
    const stack = String(err?.stack ?? '').replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]')
    console.error('[audit-vercel-env] Unexpected error:', msg)
    if (process.env.AUDIT_DEBUG) console.error(stack)
    process.exit(1)
  })
}
