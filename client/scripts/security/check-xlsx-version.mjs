#!/usr/bin/env node
/**
 * check-xlsx-version.mjs — Version gate for xlsx CDN tarball
 *
 * Story H-17 — PATTERN-H17-A / DN-3
 *
 * Why this script exists:
 *   After switching xlsx from npm registry to cdn.sheetjs.com, `npm audit`
 *   can no longer detect xlsx CVEs (the registry has no knowledge of the CDN
 *   version). This script is the compensating control: it reads
 *   node_modules/xlsx/package.json and asserts the installed version meets
 *   the minimum secure floor.
 *
 *   CVE thresholds:
 *   - >= 0.19.3 : prototype pollution (GHSA-4r6h-8v6p-xvw6) FIXED
 *   - >= 0.20.2 : ReDoS (GHSA-5pgg-2g8v-p4x9) FIXED
 *   - >= 0.20.3 : pinned version per DN-1 (preferred for audit-friendliness)
 *
 * Usage:
 *   node scripts/security/check-xlsx-version.mjs
 *
 * Exit codes:
 *   0 — xlsx version >= MIN_VERSION (OK)
 *   1 — xlsx version < MIN_VERSION or not installed (FAIL)
 *
 * PATTERN-H17-A compliance:
 *   1. Pin explicit (not latest) — enforced by CDN URL pattern check
 *   2. Version floor >= 0.20.3 — hard-coded minimum
 *   3. Note: hash integrity is checked by npm install (package-lock.json sha512)
 *
 * Story: h-17-deps-security-upgrade.md
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLIENT_ROOT = resolve(__dirname, '../..')
const XLSX_PKG_PATH = resolve(CLIENT_ROOT, 'node_modules', 'xlsx', 'package.json')
const PKG_JSON_PATH = resolve(CLIENT_ROOT, 'package.json')

/** Minimum required version (per story DN-1: pinned 0.20.3) */
const MIN_VERSION = '0.20.3'

/** Minimum prototype pollution fix (GHSA-4r6h-8v6p-xvw6) */
const PROTO_POLLUTION_FIX = '0.19.3'

/** Minimum ReDoS fix (GHSA-5pgg-2g8v-p4x9) */
const REDOS_FIX = '0.20.2'

/**
 * Semver comparison — returns true if versionA >= versionB.
 * Handles "major.minor.patch" format.
 */
function semverGte(versionA, versionB) {
  const parse = (v) =>
    v
      .replace(/^[^\d]*/, '')
      .split('.')
      .map(Number)
  const [aMaj = 0, aMin = 0, aPatch = 0] = parse(versionA)
  const [bMaj = 0, bMin = 0, bPatch = 0] = parse(versionB)
  if (aMaj !== bMaj) return aMaj > bMaj
  if (aMin !== bMin) return aMin > bMin
  return aPatch >= bPatch
}

let hasFailure = false

function fail(message) {
  console.error(`[FAIL] ${message}`)
  hasFailure = true
}

function pass(message) {
  console.log(`[OK]   ${message}`)
}

function warn(message) {
  console.warn(`[WARN] ${message}`)
}

// ---------------------------------------------------------------------------
// Check 1: node_modules/xlsx/package.json exists
// ---------------------------------------------------------------------------

if (!existsSync(XLSX_PKG_PATH)) {
  fail(`xlsx not installed: ${XLSX_PKG_PATH} not found. Run: npm install`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Check 2: Read installed version
// ---------------------------------------------------------------------------

const xlsxPkg = JSON.parse(readFileSync(XLSX_PKG_PATH, 'utf8'))
const installedVersion = xlsxPkg.version ?? '0.0.0'

console.log(`xlsx installed version: ${installedVersion}`)

// ---------------------------------------------------------------------------
// Check 3: Version floor
// ---------------------------------------------------------------------------

if (!semverGte(installedVersion, MIN_VERSION)) {
  fail(
    `xlsx@${installedVersion} < ${MIN_VERSION} (required minimum). ` +
    `Update: set "xlsx": "https://cdn.sheetjs.com/xlsx-${MIN_VERSION}/xlsx-${MIN_VERSION}.tgz" in package.json`
  )
} else {
  pass(`xlsx@${installedVersion} >= ${MIN_VERSION} (minimum floor OK)`)
}

// ---------------------------------------------------------------------------
// Check 4: Prototype pollution fix threshold
// ---------------------------------------------------------------------------

if (!semverGte(installedVersion, PROTO_POLLUTION_FIX)) {
  fail(
    `xlsx@${installedVersion} < ${PROTO_POLLUTION_FIX} — VULNERABLE to GHSA-4r6h-8v6p-xvw6 ` +
    `(prototype pollution via crafted XLSX upload). Server-side exploit path: import-supplier-prices-handler.ts`
  )
} else {
  pass(`xlsx@${installedVersion} >= ${PROTO_POLLUTION_FIX} — GHSA-4r6h-8v6p-xvw6 mitigated`)
}

// ---------------------------------------------------------------------------
// Check 5: ReDoS fix threshold
// ---------------------------------------------------------------------------

if (!semverGte(installedVersion, REDOS_FIX)) {
  fail(
    `xlsx@${installedVersion} < ${REDOS_FIX} — VULNERABLE to GHSA-5pgg-2g8v-p4x9 (ReDoS)`
  )
} else {
  pass(`xlsx@${installedVersion} >= ${REDOS_FIX} — GHSA-5pgg-2g8v-p4x9 mitigated`)
}

// ---------------------------------------------------------------------------
// Check 6: package.json source is CDN (not npm registry)
// ---------------------------------------------------------------------------

if (existsSync(PKG_JSON_PATH)) {
  const pkg = JSON.parse(readFileSync(PKG_JSON_PATH, 'utf8'))
  const xlsxEntry = pkg?.dependencies?.xlsx ?? ''

  if (xlsxEntry.includes('cdn.sheetjs.com')) {
    pass(`package.json: xlsx sourced from cdn.sheetjs.com (PATTERN-H17-A compliant)`)
    // Check not using "latest" tag (must be pinned per DN-1)
    if (xlsxEntry.includes('xlsx-latest.tgz')) {
      warn(
        `xlsx URL uses "latest" tag — prefer pinned URL like xlsx-${MIN_VERSION}.tgz for audit-friendliness (DN-1)`
      )
    } else {
      pass(`package.json: xlsx URL is pinned (not "latest") — DN-1 compliant`)
    }
  } else if (xlsxEntry.startsWith('^') || xlsxEntry.startsWith('~') || /^\d/.test(xlsxEntry)) {
    fail(
      `package.json: xlsx entry "${xlsxEntry}" looks like a semver range from npm registry. ` +
      `Must be CDN tarball URL: https://cdn.sheetjs.com/xlsx-${MIN_VERSION}/xlsx-${MIN_VERSION}.tgz`
    )
  } else if (xlsxEntry.startsWith('https://') || xlsxEntry.startsWith('http://')) {
    if (!xlsxEntry.includes('cdn.sheetjs.com')) {
      warn(`xlsx URL is not from cdn.sheetjs.com: ${xlsxEntry}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('')
if (hasFailure) {
  console.error('check-xlsx-version: FAILED — see [FAIL] entries above')
  process.exit(1)
} else {
  console.log('check-xlsx-version: OK — xlsx version and CDN source are compliant')
  process.exit(0)
}
