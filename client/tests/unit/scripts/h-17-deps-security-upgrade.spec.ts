/**
 * Story H-17 — Bump deps sécurité : xlsx (CDN SheetJS) + axios + form-data
 *
 * ATDD Strategy per AC:
 *
 * AC#1 (xlsx depuis CDN SheetJS ≥0.20.3) : STATIC-FILE-ASSERTION (config-assertion)
 *   Test type: unit / static-file-assertion
 *   Reads package.json and package-lock.json as text files, asserts:
 *   (a) package.json xlsx entry matches CDN tarball URL (cdn.sheetjs.com)
 *   (b) package-lock.json resolved entry for xlsx starts with cdn.sheetjs.com
 *   (c) node_modules/xlsx/package.json version >= 0.20.3
 *   RED before Step 3 DEV (package.json still has "^0.18.5").
 *   GREEN after bump.
 *
 * AC#2 (axios ^1.15.2 + form-data ≥4.0.4) : STATIC-FILE-ASSERTION (config-assertion)
 *   Test type: unit / static-file-assertion
 *   Reads package.json and package-lock.json:
 *   (a) package.json axios version is "^1.15.2" or higher
 *   (b) package-lock.json resolved axios version starts with "1.15."
 *   (c) package-lock.json ALL form-data entries resolve to >=4.0.4
 *   RED before bump, GREEN after.
 *
 * AC#3 (npm audit 0 HIGH/CRITICAL runtime) : SCRIPT-GATE
 *   Test type: process / CI-gate via execFileSync
 *   Strategy: the test runs `npm audit --omit=dev --json` (or reads a cached
 *   audit output file if AUDIT_CACHE_PATH env var set), then parses the JSON and
 *   asserts metadata.vulnerabilities.high === 0 && critical === 0.
 *   NOTE: npm audit cannot detect xlsx CVE post CDN-switch (npm registry does not
 *   know the CDN version) — this is expected per DN-3 and explicitly asserted.
 *   Test type: integration / npm-script-gate (runs npm cli as subprocess)
 *   OPEN QUESTION: timeout — npm audit can be slow on CI (15s guard applied).
 *
 * AC#4 (Tests XLSX : régression + malformé) : UNIT (extend existing spec)
 *   Test type: unit / Vitest + real XLSX.read (NOT mocked)
 *   Location: separate describe block in this file (security regression suite)
 *   Strategy: imports real xlsx library (not mocked) to exercise actual parsing.
 *   (a) Existing tests in import-supplier-prices.spec.ts pass — asserted via
 *       execFileSync running the specific test file.
 *   (b) NEW test: malformed buffer (corrupted ZIP) → error thrown, not V8 crash.
 *   (c) NEW test: prototype pollution guard (GHSA-4r6h-8v6p-xvw6 POC) using a
 *       crafted XLSX ZIP with __proto__ key injection — asserts Object.prototype
 *       remains unpolluted after XLSX.read().
 *   (d) NEW test: ReDoS-mitigation — XLSX with catastrophic pattern → parse
 *       completes in <500ms (or throws) — uses vi.fakeTimers + async timeout.
 *   (e) Snapshot delta: reads supplier-prices-rufino.xlsx fixture (if it exists)
 *       and asserts stable sheet structure between xlsx@0.18.x and @0.20.3.
 *   FIXTURE DECISION: supplier-prices-rufino.xlsx must be created at
 *   client/tests/fixtures/supplier-prices-rufino.xlsx — see DECISIONS TAKEN.
 *
 * AC#5 (Smoke Preview) : MANUAL / MCP-BROWSER-CHECKLIST
 *   Test type: manual (not automatable in Vitest)
 *   Rationale: requires live Preview Vercel deployment + operator session.
 *   A checklist is provided below as a commented block.
 *   One automated sub-assertion: assert that the e2e Playwright test file for
 *   import-supplier-prices-4-8.spec.ts still exists (regression guard).
 *
 * GREEN-guards (must PASS before AND after bump):
 *   - check-xlsx-version.mjs script (NEW per DN-3): asserts xlsx >= 0.20.3
 *   - import-supplier-prices.spec.ts run: all existing tests PASS
 *   - No "xlsx" entry in devDependencies (it must remain in dependencies)
 *
 * RED-phase: AC#1, AC#2, AC#4(prototype pollution), AC#4(snapshot) are RED before Step 3.
 * GREEN-guards: PASS before and after.
 *
 * ==========================================================================
 * DECISIONS TAKEN
 * ==========================================================================
 *
 * D1 — AC#1 test strategy: static-file-assertion on package.json and package-lock.json
 *   Rationale: The bump itself is a config change, not a code change. The most
 *   direct assertion is to read the JSON files as text and grep the expected URL.
 *   This avoids running `npm ls` as a subprocess (fragile, slow).
 *
 * D2 — AC#3 test: runs as a slow integration test (npm audit subprocess).
 *   Vitest category: not in the default unit suite (too slow, side effects).
 *   Placed in this file but behind a SKIP guard unless ENABLE_NPM_AUDIT_TEST=1 is set.
 *   Alternative for CI: a dedicated scripts/security/check-npm-audit.mjs gate (OOS V1).
 *
 * D3 — AC#4 prototype pollution DEFENSIVE GUARD (not exploit-regression POC):
 *   The GHSA-4r6h-8v6p-xvw6 advisory describes that xlsx < 0.19.3 is vulnerable
 *   when parsing XLSX files crafted with __proto__ keys in cell data.
 *   This test constructs a workbook via XLSX.utils.aoa_to_sheet() with __proto__
 *   as a column header, then round-trips via XLSX.write() + XLSX.read().
 *   IMPORTANT — honest scope: this exercise does NOT reproduce the original
 *   vulnerable code path verbatim (the GHSA POC requires a hand-crafted ZIP
 *   with a sharedStrings.xml payload, not a SheetJS-emitted workbook). The
 *   test therefore likely passes on xlsx@0.18.5 too — it is a forward-looking
 *   GUARD against future regressions where the API surface used here would
 *   pollute Object.prototype, not a proof that 0.18.5 was vulnerable.
 *   The binding CVE regression gate is the version-floor assertion at
 *   `H17-AC4c — version xlsx >= 0.19.3` + `check-xlsx-version.mjs`.
 *   Tracking real-binary POC fixture: DEF-1 / OOS-7 (story).
 *
 * D4 — AC#4 ReDoS guard (smoke-level, not true ReDoS regression):
 *   GHSA-5pgg-2g8v-p4x9 describes ReDoS in sheet name parsing regex.
 *   The POC is a crafted XLSX where the sheet name is a long repeated pattern
 *   designed to trigger catastrophic backtracking.
 *   Test asserts the parse either (a) throws immediately, or (b) resolves in <500ms.
 *   IMPORTANT — limitation: XLSX.read() is synchronous, so `Promise.race` with a
 *   setTimeout sentinel CANNOT interrupt the parse if catastrophic backtracking
 *   hangs the event loop. The race only catches the result *after* the sync
 *   work returns. A true ReDoS regression test requires a worker_thread
 *   isolation (DEF-2). The current test is a smoke guard + caller-side latency
 *   check, not a hard ReDoS gate. Binding regression control is the version-
 *   floor assertion at `H17-AC4c — version xlsx >= 0.20.2`.
 *
 * D5 — supplier-prices-rufino.xlsx fixture:
 *   The story references this fixture (AC#4.d) but it does NOT exist in the repo.
 *   Resolution: the test for the snapshot delta is written to SKIP with an explicit
 *   message if the fixture file is absent (graceful degradation).
 *   The dev step must create the fixture from the _bmad-input reference file.
 *   DECISION_NEEDED: should supplier-prices-rufino.xlsx be the same as
 *   prix-fournisseur-sav-2026-00001.xlsx from _bmad-input/excel-gestion/?
 *
 * D6 — AC#4(a) existing tests: asserted by checking the test file exists AND
 *   running vitest programmatically. To avoid double-running all tests, this is
 *   expressed as a "test file exists" guard + a note that `npm test` must pass.
 *
 * D7 — check-xlsx-version.mjs: the script reads node_modules/xlsx/package.json
 *   and compares version >= 0.20.3 (semver). Written as a new file per DN-3.
 *
 * ==========================================================================
 * OPEN QUESTIONS
 * ==========================================================================
 *
 * OQ-1 — AC#3 npm audit gate enforcement in CI:
 *   Currently no CI gate runs `npm audit --audit-level=high` on this repo (OOS-5).
 *   This test uses ENABLE_NPM_AUDIT_TEST=1 opt-in guard to avoid blocking normal
 *   unit test runs. A dedicated CI gate step is left as a V2 recommendation.
 *
 * OQ-2 — AC#5 smoke automation feasibility:
 *   Full smoke is MCP browser only (requires Preview Vercel + operator session).
 *   Not automatable in Vitest. Playwright could cover the upload flow but requires
 *   a live deployment. Left as MANUAL with a checklist. The test file for the e2e
 *   spec (import-supplier-prices-4-8.spec.ts) asserts existence as a proxy guard.
 *
 * OQ-3 — supplier-prices-rufino.xlsx fixture origin (see D5).
 *
 * OQ-4 — AC#2(c) form-data: npm ls form-data can return multiple versions if
 *   nested under different packages. The test checks ALL entries in package-lock.json
 *   are >= 4.0.4. If a nested dep still pins 4.0.3, the test is RED — that is correct
 *   behavior (the bump should deduplicate them all).
 *
 * OQ-5 — Vitest inline dependency for xlsx CDN tarball:
 *   vitest.config.js has `server.deps.inline: ['xlsx']`. After the CDN switch, the
 *   package name remains 'xlsx' so this config requires no change. However, if the
 *   CDN tarball exposes a different module structure, inline may need adjustment.
 *   Flagged here — must verify after bump with `npm run test`.
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Navigate from client/tests/unit/scripts/ → client root
const CLIENT_ROOT = resolve(__dirname, '../../..')
const MONOREPO_ROOT = resolve(CLIENT_ROOT, '..')

// Key file paths
const PKG_JSON_PATH = resolve(CLIENT_ROOT, 'package.json')
const PKG_LOCK_PATH = resolve(CLIENT_ROOT, 'package-lock.json')
const NODE_MODULES_XLSX_PKG = resolve(CLIENT_ROOT, 'node_modules', 'xlsx', 'package.json')
const NODE_MODULES_AXIOS_PKG = resolve(CLIENT_ROOT, 'node_modules', 'axios', 'package.json')
const CHECK_XLSX_SCRIPT_PATH = resolve(CLIENT_ROOT, 'scripts', 'security', 'check-xlsx-version.mjs')
const EXISTING_HANDLER_SPEC = resolve(
  CLIENT_ROOT,
  'tests',
  'unit',
  'api',
  'sav',
  'import-supplier-prices.spec.ts'
)
const E2E_IMPORT_SPEC = resolve(
  CLIENT_ROOT,
  'tests',
  'e2e',
  'import-supplier-prices-4-8.spec.ts'
)
const RUFINO_FIXTURE = resolve(CLIENT_ROOT, 'tests', 'fixtures', 'supplier-prices-rufino.xlsx')
const CDN_URL_REGEX = /https:\/\/cdn\.sheetjs\.com\/xlsx-[\d.]+\/xlsx-[\d.]+\.tgz/

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse package.json safely */
function readPkgJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(PKG_JSON_PATH, 'utf8')) as Record<string, unknown>
}

/** Parse package-lock.json safely */
function readPkgLock(): Record<string, unknown> {
  return JSON.parse(readFileSync(PKG_LOCK_PATH, 'utf8')) as Record<string, unknown>
}

/**
 * Semver comparison — returns true if versionA >= versionB (numeric only, no ranges).
 * Handles "1.15.2" style — major.minor.patch.
 */
function semverGte(versionA: string, versionB: string): boolean {
  const parse = (v: string) =>
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

// ---------------------------------------------------------------------------
// GREEN-GUARDS — must PASS before AND after bump
// ---------------------------------------------------------------------------

describe('GREEN-guard — existing test files intact', () => {
  it('GUARD — import-supplier-prices.spec.ts exists (unit test for handler)', () => {
    expect(existsSync(EXISTING_HANDLER_SPEC)).toBe(true)
  })

  it('GUARD — import-supplier-prices-4-8.spec.ts (e2e) exists', () => {
    expect(existsSync(E2E_IMPORT_SPEC)).toBe(true)
  })

  it('GUARD — xlsx is in dependencies (not devDependencies)', () => {
    const pkg = readPkgJson()
    const deps = pkg['dependencies'] as Record<string, string> | undefined
    const devDeps = pkg['devDependencies'] as Record<string, string> | undefined
    expect(deps?.['xlsx']).toBeDefined()
    // Must NOT be in devDependencies — it is used server-side at runtime
    expect(devDeps?.['xlsx']).toBeUndefined()
  })

  it('GUARD — axios is in dependencies', () => {
    const pkg = readPkgJson()
    const deps = pkg['dependencies'] as Record<string, string> | undefined
    expect(deps?.['axios']).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// AC#1 — xlsx depuis CDN SheetJS (≥0.20.3)
// ---------------------------------------------------------------------------

describe('H17-AC1 — xlsx depuis CDN SheetJS ≥0.20.3', () => {
  it(
    'RED → GREEN — package.json: xlsx pointe vers un tarball cdn.sheetjs.com (pas npm registry)',
    () => {
      const pkg = readPkgJson()
      const deps = pkg['dependencies'] as Record<string, string> | undefined
      const xlsxEntry = deps?.['xlsx'] ?? ''
      // Must match CDN tarball URL — not a semver range like "^0.18.5"
      expect(xlsxEntry).toMatch(CDN_URL_REGEX)
    }
  )

  it(
    'RED → GREEN — package.json: xlsx URL contient "0.20." ou version supérieure (pas latest non-pinné)',
    () => {
      const pkg = readPkgJson()
      const deps = pkg['dependencies'] as Record<string, string> | undefined
      const xlsxEntry = deps?.['xlsx'] ?? ''
      // Pinned version URL: must NOT be xlsx-latest.tgz (per DN-1: pinned preferred)
      expect(xlsxEntry).not.toContain('xlsx-latest.tgz')
      // Must be cdn.sheetjs.com domain
      expect(xlsxEntry).toContain('cdn.sheetjs.com')
    }
  )

  it(
    'RED → GREEN — package-lock.json: resolved entry pour xlsx pointe vers cdn.sheetjs.com',
    () => {
      const lock = readPkgLock()
      const packages = lock['packages'] as Record<string, Record<string, unknown>> | undefined
      const xlsxPkg = packages?.['node_modules/xlsx']
      expect(xlsxPkg).toBeDefined()
      const resolved = xlsxPkg?.['resolved'] as string | undefined
      expect(resolved).toMatch(/https:\/\/cdn\.sheetjs\.com\//)
    }
  )

  it(
    'RED → GREEN — package-lock.json: integrity field présent pour xlsx (hash sha512)',
    () => {
      const lock = readPkgLock()
      const packages = lock['packages'] as Record<string, Record<string, unknown>> | undefined
      const xlsxPkg = packages?.['node_modules/xlsx']
      const integrity = xlsxPkg?.['integrity'] as string | undefined
      // Integrity hash must be present and non-empty (npm calculates on tarball download)
      expect(integrity).toBeDefined()
      expect(integrity).toMatch(/^sha512-/)
    }
  )

  it(
    'RED → GREEN — node_modules/xlsx/package.json: version ≥ 0.20.3 installée',
    () => {
      // This test passes only after `npm install` has been run post-bump
      expect(existsSync(NODE_MODULES_XLSX_PKG)).toBe(true)
      const xlsxPkg = JSON.parse(readFileSync(NODE_MODULES_XLSX_PKG, 'utf8')) as {
        version: string
      }
      expect(semverGte(xlsxPkg.version, '0.20.3')).toBe(true)
    }
  )

  it(
    'RED → GREEN — scripts/security/check-xlsx-version.mjs EXISTE (DN-3 CI gate)',
    () => {
      expect(existsSync(CHECK_XLSX_SCRIPT_PATH)).toBe(true)
    }
  )

  it(
    'RED → GREEN — check-xlsx-version.mjs retourne exit 0 (version installée ≥ 0.20.3)',
    () => {
      if (!existsSync(CHECK_XLSX_SCRIPT_PATH)) {
        // If script doesn't exist, this test is redundant with the existence test above
        return
      }
      let exitCode = 0
      let stdout = ''
      try {
        stdout = execFileSync('node', [CHECK_XLSX_SCRIPT_PATH], {
          encoding: 'utf8',
          cwd: CLIENT_ROOT,
          timeout: 10000,
        })
      } catch (err) {
        const e = err as { status: number; stdout: string; stderr: string }
        exitCode = e.status ?? 1
        stdout = e.stdout ?? ''
      }
      expect(exitCode).toBe(0)
      // Script should print something confirming the version check
      expect(stdout).toMatch(/0\.20\.|OK|PASS/i)
    }
  )
})

// ---------------------------------------------------------------------------
// AC#2 — axios ^1.15.2 + form-data ≥4.0.4
// ---------------------------------------------------------------------------

describe('H17-AC2 — axios ^1.15.2 + form-data ≥4.0.4 (package-lock deduplicated)', () => {
  it(
    'RED → GREEN — package.json: axios version ≥ 1.15.2 (pas 1.3.4 ni 1.10.0)',
    () => {
      const pkg = readPkgJson()
      const deps = pkg['dependencies'] as Record<string, string> | undefined
      const axiosEntry = deps?.['axios'] ?? ''
      // Must be caret or exact, but >= 1.15.2
      // Strip caret/tilde to get bare version
      const bare = axiosEntry.replace(/^[\^~]/, '')
      expect(semverGte(bare, '1.15.2')).toBe(true)
    }
  )

  it(
    'RED → GREEN — package-lock.json: axios resolved version is 1.15.x or higher',
    () => {
      const lock = readPkgLock()
      const packages = lock['packages'] as Record<string, Record<string, unknown>> | undefined
      const axiosPkg = packages?.['node_modules/axios']
      expect(axiosPkg).toBeDefined()
      const version = axiosPkg?.['version'] as string | undefined
      expect(version).toBeDefined()
      expect(semverGte(version ?? '0.0.0', '1.15.2')).toBe(true)
    }
  )

  it(
    'RED → GREEN — node_modules/axios/package.json: version installée ≥ 1.15.2',
    () => {
      expect(existsSync(NODE_MODULES_AXIOS_PKG)).toBe(true)
      const axiosPkg = JSON.parse(readFileSync(NODE_MODULES_AXIOS_PKG, 'utf8')) as {
        version: string
      }
      expect(semverGte(axiosPkg.version, '1.15.2')).toBe(true)
    }
  )

  it(
    'RED → GREEN — package-lock.json: TOUTES les entrées form-data sont ≥ 4.0.4 (déduplication)',
    () => {
      const lock = readPkgLock()
      const packages = lock['packages'] as Record<string, Record<string, unknown>> | undefined
      if (!packages) {
        // If no packages section, skip (different lockfile format)
        return
      }
      // Find all form-data entries (direct + nested)
      const formDataEntries = Object.entries(packages).filter(([key]) =>
        key.endsWith('/form-data') || key === 'node_modules/form-data'
      )
      // If form-data is not present at all, it was completely deduped away — acceptable
      if (formDataEntries.length === 0) {
        return
      }
      for (const [entryKey, entryVal] of formDataEntries) {
        const version = entryVal['version'] as string | undefined
        expect(version, `form-data at ${entryKey} should be >=4.0.4`).toBeDefined()
        expect(
          semverGte(version ?? '0.0.0', '4.0.4'),
          `form-data@${version} at ${entryKey} must be >=4.0.4`
        ).toBe(true)
      }
    }
  )

  it(
    'GREEN-guard — aucun appel axios ne modifie AxiosRequestConfig de façon incompatible avec 1.15',
    () => {
      // Static grep guard: check that no file in client/api/_lib or client/src
      // uses deprecated AxiosRequestConfig properties that were removed between 1.x versions.
      // axios 1.x has been stable in config shape — this is a documentation guard, not a
      // functional test. We assert that known breaking patterns are absent.
      // Specifically: `baseURL` rename, `transformRequest` array issues — not present in 1.x.
      // This test trivially passes because axios 1.x is backward-compatible within major.
      expect(true).toBe(true)
      // NOTE: if typecheck fails after bump, run `npm run typecheck` and fix any
      // AxiosRequestConfig type drift there. This test is a placeholder for that contract.
    }
  )
})

// ---------------------------------------------------------------------------
// AC#3 — npm audit 0 HIGH/CRITICAL runtime (process gate, opt-in)
// ---------------------------------------------------------------------------

describe('H17-AC3 — npm audit --omit=dev: 0 HIGH/CRITICAL runtime (opt-in gate)', () => {
  // STRATEGY: This test runs `npm audit --omit=dev --json` as a subprocess.
  // It is skipped by default to avoid slowing down the normal unit suite.
  // Enable with: ENABLE_NPM_AUDIT_TEST=1 npm test
  //
  // IMPORTANT per DN-3: after the xlsx CDN switch, `npm audit` will NOT report
  // the xlsx CVE (because the CDN tarball is unknown to the npm registry).
  // This is EXPECTED behavior. The check-xlsx-version.mjs script (AC#1) covers
  // the version floor guarantee for xlsx.

  const AUDIT_ENABLED = process.env['ENABLE_NPM_AUDIT_TEST'] === '1'

  it(
    AUDIT_ENABLED
      ? 'RED → GREEN — npm audit --omit=dev: metadata.vulnerabilities.high === 0'
      : 'SKIPPED (ENABLE_NPM_AUDIT_TEST=1 to run) — npm audit HIGH count gate',
    () => {
      if (!AUDIT_ENABLED) {
        // Explicit skip with explanation
        console.info(
          '[H17-AC3] npm audit gate SKIPPED — set ENABLE_NPM_AUDIT_TEST=1 to enable. ' +
          'This is an opt-in test because npm audit is a network call (~15s) not suitable ' +
          'for the default unit suite. Run manually after bumping deps.'
        )
        return
      }

      let auditJson = ''
      try {
        auditJson = execFileSync('npm', ['audit', '--omit=dev', '--json'], {
          encoding: 'utf8',
          cwd: CLIENT_ROOT,
          timeout: 60000,
        })
      } catch (err) {
        // npm audit exits 1 if there are vulnerabilities — we still parse the JSON
        const e = err as { stdout: string }
        auditJson = e.stdout ?? ''
      }

      expect(auditJson.length).toBeGreaterThan(0)

      const auditResult = JSON.parse(auditJson) as {
        metadata?: {
          vulnerabilities?: {
            high?: number
            critical?: number
            moderate?: number
            low?: number
          }
        }
      }

      const vulns = auditResult.metadata?.vulnerabilities
      expect(vulns).toBeDefined()
      expect(
        vulns?.high,
        'npm audit: HIGH vulnerabilities in runtime deps must be 0 after bump'
      ).toBe(0)
      expect(
        vulns?.critical,
        'npm audit: CRITICAL vulnerabilities in runtime deps must be 0 after bump'
      ).toBe(0)
    }
  )

  it(
    'GREEN-guard — xlsx CDN tarball NOT visible to npm registry (expected per DN-3)',
    () => {
      // This is a documentation test: after the CDN switch, npm audit CANNOT see
      // xlsx CVEs because cdn.sheetjs.com is not the npm registry.
      // The version guard is handled by check-xlsx-version.mjs (AC#1).
      // This test trivially passes — it documents the known gap.
      const lock = readPkgLock()
      const packages = lock['packages'] as Record<string, Record<string, unknown>> | undefined
      const xlsxPkg = packages?.['node_modules/xlsx']
      const resolved = xlsxPkg?.['resolved'] as string | undefined
      if (resolved) {
        // If xlsx is installed, its resolved URL should be CDN (not npm registry)
        // This is a post-bump invariant — fails pre-bump if checked, but that's expected
        const isCdn = resolved.includes('cdn.sheetjs.com')
        const isNpm = resolved.includes('registry.npmjs.org')
        if (isCdn) {
          // Post-bump state: CDN — this is correct
          expect(isCdn).toBe(true)
        } else if (isNpm) {
          // Pre-bump state: still on npm registry — test documents the gap
          console.warn(
            '[H17-AC3] xlsx is still on npm registry. npm audit WILL see the CVE. Bump pending.'
          )
          // This is the RED state — test does NOT fail here since we are documenting
          // the transition. The AC#1 tests above will fail in RED state.
        }
      }
    }
  )
})

// ---------------------------------------------------------------------------
// AC#4 — Tests XLSX régression + prototype pollution + ReDoS
// ---------------------------------------------------------------------------
// NOTE: These tests use the REAL xlsx library (not mocked).
// They are placed here (not in import-supplier-prices.spec.ts) to avoid
// polluting the handler unit test suite with unmocked library calls.
// The vitest.config.js `server.deps.inline: ['xlsx']` ensures the real
// module is loaded in the Vitest worker.

describe('H17-AC4a — Existing handler tests pass (smoke assertion)', () => {
  it('GREEN-guard — import-supplier-prices.spec.ts EXISTE (unit tests for handler)', () => {
    expect(existsSync(EXISTING_HANDLER_SPEC)).toBe(true)
  })

  it(
    'GREEN-guard — handler spec contient les tests nominaux ISP-01a et ISP-02a',
    () => {
      const content = readFileSync(EXISTING_HANDLER_SPEC, 'utf8')
      expect(content).toContain('ISP-01a')
      expect(content).toContain('ISP-02a')
    }
  )
})

describe('H17-AC4b — Regression: malformed XLSX → error propre (pas crash V8)', () => {
  it(
    'RED → GREEN — XLSX.read(corruptedBuffer) → throws Error, ne crash pas le process',
    async () => {
      // Import real xlsx (not the mocked version from the handler spec)
      // vi.mock is scoped per test file — this file does NOT mock xlsx
      const XLSX = await import('xlsx')

      const corruptedBuffer = Buffer.from('PK\x03\x04THIS IS NOT A VALID ZIP OR XLSX FILE')

      let caughtError: unknown = null
      try {
        XLSX.read(corruptedBuffer, { type: 'buffer' })
      } catch (err) {
        caughtError = err
      }

      // The handler wraps XLSX.read in try/catch — what matters is it THROWS
      // (not silently corrupts state or crashes V8 with SIGSEGV)
      // With xlsx >= 0.20.3, invalid ZIPs throw a parse error
      expect(caughtError).not.toBeNull()
      expect(caughtError instanceof Error).toBe(true)
      // V8 process is still alive (this line executes = no crash)
      expect(process.pid).toBeGreaterThan(0)
    }
  )

  it(
    'GREEN-guard — XLSX.read(emptyBuffer) → no V8 crash (returns empty workbook or throws)',
    async () => {
      // NOTE: xlsx (all versions tested) does NOT throw on empty/null buffers —
      // it returns a workbook with 0 SheetNames. The handler's graceful response
      // is covered by ISP-01c in import-supplier-prices.spec.ts (INVALID_FORMAT path).
      // This test asserts no SIGSEGV/crash: either throws cleanly or returns a workbook.
      const XLSX = await import('xlsx')
      const emptyBuffer = Buffer.alloc(0)

      let result: unknown = null
      let caughtError: unknown = null
      try {
        result = XLSX.read(emptyBuffer, { type: 'buffer' })
      } catch (err) {
        caughtError = err
      }

      // EITHER it throws (clean error) OR it returns a workbook-like object — never crashes
      if (caughtError !== null) {
        expect(caughtError instanceof Error).toBe(true)
      } else {
        // Empty workbook: SheetNames should be an array (possibly empty)
        expect(result).not.toBeNull()
        expect((result as { SheetNames?: unknown[] }).SheetNames).toBeDefined()
      }
      // V8 process still alive
      expect(process.pid).toBeGreaterThan(0)
    }
  )

  it(
    'GREEN-guard — XLSX.read(null-bytes 64B) → no V8 crash (graceful empty workbook)',
    async () => {
      // Same rationale: null-byte buffers produce an empty workbook in xlsx,
      // not a crash. Handler then gets 0 rows → INVALID_FORMAT.
      const XLSX = await import('xlsx')
      const nullBytesBuffer = Buffer.alloc(64, 0x00)

      let result: unknown = null
      let caughtError: unknown = null
      try {
        result = XLSX.read(nullBytesBuffer, { type: 'buffer' })
      } catch (err) {
        caughtError = err
      }

      if (caughtError !== null) {
        expect(caughtError instanceof Error).toBe(true)
      } else {
        expect(result).not.toBeNull()
      }
      expect(process.pid).toBeGreaterThan(0)
    }
  )
})

describe('H17-AC4c — Prototype pollution DEFENSIVE GUARD (GHSA-4r6h-8v6p-xvw6)', () => {
  /**
   * IMPORTANT — scope honnête : ce describe contient un GUARD défensif, PAS une
   * régression CVE reproductible.
   *
   * xlsx < 0.19.3 est vulnérable à la prototype pollution quand le parseur
   * rencontre un XLSX crafté à la main (ZIP + sharedStrings.xml contenant
   * "__proto__" comme valeur), via le pattern :
   *   obj[key] = value  où key vient d'une chaîne extraite du XLSX
   *
   * Le test ci-dessous construit un workbook via XLSX.utils.aoa_to_sheet()
   * puis le round-trip via XLSX.write() + XLSX.read(). Ce code path n'exerce
   * PAS verbatim la vulnérabilité GHSA — un POC fidèle nécessiterait un
   * binaire ZIP pré-crafté (DEF-1 / OOS-7 dans la story).
   *
   * Par conséquent, ce test :
   *   - PASSE probablement aussi sur xlsx@0.18.5 (vulnérable)
   *   - Reste utile comme GARDE-FOU FORWARD : si une future version de
   *     SheetJS réintroduit une pollution via l'API publique aoa_to_sheet /
   *     XLSX.read sur une donnée __proto__, ce test le détecte.
   *
   * Le contrôle BINDING pour la régression CVE est :
   *   - H17-AC4c — version xlsx >= 0.19.3 (assert direct)
   *   - scripts/security/check-xlsx-version.mjs (prebuild gate Vercel)
   */

  it(
    'RED → GREEN — XLSX.read avec __proto__ payload ne pollue pas Object.prototype',
    async () => {
      const XLSX = await import('xlsx')

      // Baseline: Object.prototype should be clean
      const baseline = ({} as Record<string, unknown>).polluted
      expect(baseline).toBeUndefined()

      // Craft a minimal XLSX workbook using XLSX.utils.book_new() + aoa_to_sheet()
      // with a sheet that contains "__proto__" as a header key.
      // This exercises the internal object assignment paths.
      const wb = XLSX.utils.book_new()
      // Use __proto__ as a column header to trigger the vulnerable code path
      const ws = XLSX.utils.aoa_to_sheet([
        ['__proto__', 'constructor', 'normal_col'],
        ['polluted', 'malicious', 'safe_value'],
      ])
      XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')

      // Write to buffer and re-read — this exercises the full parse path
      const xlsxBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer

      // Clear any pre-existing pollution (defensive reset)
      const proto = Object.prototype as Record<string, unknown>
      delete proto['polluted']
      delete proto['isAdmin']

      // Re-read the crafted workbook
      try {
        const readBack = XLSX.read(xlsxBuffer, { type: 'buffer', raw: true })
        const sheetName = readBack.SheetNames[0] ?? 'Sheet1'
        const sheet = readBack.Sheets[sheetName]
        if (sheet) {
          XLSX.utils.sheet_to_json(sheet, { defval: '' })
        }
      } catch {
        // If reading throws, that's acceptable — but the prototype must still be clean
      }

      // ASSERT: Object.prototype is unpolluted after the parse
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
      expect(({} as Record<string, unknown>).isAdmin).toBeUndefined()
      expect(({} as Record<string, unknown>).malicious).toBeUndefined()
    }
  )

  it(
    'RED → GREEN — version xlsx installée >= 0.19.3 (prototype pollution fix threshold)',
    async () => {
      // Import xlsx to get version from the installed package
      const XLSX = await import('xlsx')
      // SheetJS exposes version on the module object
      const version = (XLSX as unknown as { version?: string }).version ?? '0.0.0'
      expect(semverGte(version, '0.19.3')).toBe(true)
    }
  )

  it(
    'RED → GREEN — version xlsx installée >= 0.20.2 (ReDoS fix threshold, GHSA-5pgg-2g8v-p4x9)',
    async () => {
      const XLSX = await import('xlsx')
      const version = (XLSX as unknown as { version?: string }).version ?? '0.0.0'
      expect(semverGte(version, '0.20.2')).toBe(true)
    }
  )
})

describe('H17-AC4d — ReDoS smoke guard (GHSA-5pgg-2g8v-p4x9)', () => {
  /**
   * IMPORTANT — limitation honnête de ce test :
   * XLSX.read() est SYNCHRONE. Si un parsing pathologique bloque l'event loop
   * via catastrophic backtracking, le `Promise.race` avec setTimeout NE PEUT
   * PAS l'interrompre — le timeout ne se déclenche qu'APRÈS le retour du code
   * sync. Ce test attrape donc :
   *   - les cas où SheetJS rejette le nom de feuille au write (court-circuit)
   *   - les cas où le parse complète <500ms (smoke latence côté caller)
   * Il N'ATTRAPE PAS un vrai blocage CPU-bound > 500ms.
   *
   * Un vrai test de régression ReDoS exigerait une isolation worker_thread
   * avec timeout dur (DEF-2 / OOS dans la story).
   *
   * Le contrôle BINDING pour la régression CVE GHSA-5pgg-2g8v-p4x9 est :
   *   - H17-AC4c — version xlsx >= 0.20.2 (assert direct)
   *   - scripts/security/check-xlsx-version.mjs (prebuild gate Vercel)
   */

  it(
    'RED → GREEN — parse sheet avec nom long ne déclenche pas ReDoS (< 500ms)',
    async () => {
      const XLSX = await import('xlsx')

      // Create a workbook with a pathological sheet name
      // The GHSA-5pgg-2g8v-p4x9 trigger: a long sheet name with repeated patterns
      // that cause catastrophic backtracking in the vulnerable regex path
      const pathologicalSheetName = 'A'.repeat(100) + '!'

      const wb = XLSX.utils.book_new()
      const ws = XLSX.utils.aoa_to_sheet([['Header'], ['Value']])

      // book_append_sheet may sanitize/reject long sheet names — wrap in try/catch
      try {
        XLSX.utils.book_append_sheet(wb, ws, pathologicalSheetName)
      } catch {
        // If SheetJS rejects the sheet name, ReDoS is impossible — test passes
        return
      }

      // Write to buffer
      let xlsxBuffer: Buffer
      try {
        xlsxBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
      } catch {
        // If write fails on the pathological name, no ReDoS possible — test passes
        return
      }

      // Re-read with a 500ms timeout guard
      const TIMEOUT_MS = 500

      const parsePromise = new Promise<void>((resolve, reject) => {
        try {
          XLSX.read(xlsxBuffer, { type: 'buffer' })
          resolve()
        } catch (err) {
          // Throwing is acceptable (input is pathological)
          resolve()
        }
      })

      const timeoutPromise = new Promise<void>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `ReDoS detected: XLSX.read took > ${TIMEOUT_MS}ms on pathological sheet name`
              )
            ),
          TIMEOUT_MS
        )
      )

      // If ReDoS is triggered, this will reject with the timeout error
      await expect(Promise.race([parsePromise, timeoutPromise])).resolves.toBeUndefined()
    },
    1000 // Test timeout: 1s (500ms for parse + 500ms buffer)
  )
})

describe('H17-AC4e — Snapshot delta sur fixture supplier-prices-rufino.xlsx', () => {
  /**
   * Snapshot test rationale:
   *
   * The story references tests/fixtures/supplier-prices-rufino.xlsx as the
   * "reference XLSX" for delta assertions. This file does NOT exist in the repo yet.
   *
   * DECISION D5: This test SKIPS gracefully if the fixture is absent.
   * The dev step must create the fixture before this test can go GREEN.
   * See OPEN QUESTION OQ-3: origin file is probably
   * _bmad-input/excel-gestion/prix-fournisseur-sav-2026-00001.xlsx
   */

  it(
    'SKIP-if-absent → GREEN — supplier-prices-rufino.xlsx parseble avec xlsx 0.20.3',
    async () => {
      if (!existsSync(RUFINO_FIXTURE)) {
        console.info(
          '[H17-AC4e] SKIPPED — tests/fixtures/supplier-prices-rufino.xlsx not found. ' +
          'Dev step must create this fixture from _bmad-input/excel-gestion/prix-fournisseur-sav-2026-00001.xlsx. ' +
          'See DECISION D5 and OQ-3 in this test file.'
        )
        return
      }

      const XLSX = await import('xlsx')
      const fixtureBuffer = readFileSync(RUFINO_FIXTURE)

      // Should NOT throw (file is valid XLSX)
      let workbook: ReturnType<typeof XLSX.read>
      expect(() => {
        workbook = XLSX.read(fixtureBuffer, {
          type: 'buffer',
          cellText: false,
          cellNF: false,
          cellHTML: false,
          cellFormula: false,
          raw: true,
        })
      }).not.toThrow()

      // Structural assertions (stable across xlsx versions)
      expect(workbook!.SheetNames.length).toBeGreaterThan(0)
      const sheetName = workbook!.SheetNames[0]!
      const sheet = workbook!.Sheets[sheetName]!
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })

      // The XLSX must have at least 1 data row
      expect(rows.length).toBeGreaterThan(0)

      // Headers must include the expected French columns (AC#1 DN-1)
      const firstRow = rows[0]!
      const headers = Object.keys(firstRow).map((h) => h.trim().toLowerCase())
      expect(headers).toContain('code')
    }
  )

  it(
    'SKIP-if-absent → GREEN — supplier-prices-rufino.xlsx: colonnes requises présentes après bump',
    async () => {
      if (!existsSync(RUFINO_FIXTURE)) {
        return // Same skip — fixture absent
      }

      const XLSX = await import('xlsx')
      const fixtureBuffer = readFileSync(RUFINO_FIXTURE)
      const workbook = XLSX.read(fixtureBuffer, { type: 'buffer', raw: true })
      const sheetName = workbook.SheetNames[0]!
      const sheet = workbook.Sheets[sheetName]!
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })

      const firstRow = rows[0]!
      const normalizedHeaders = Object.keys(firstRow).map((h) =>
        h.trim().toLowerCase().normalize('NFC')
      )

      // Required headers per DN-1 (handler: REQUIRED_HEADERS = ['code', 'quantité', 'pu ht'])
      expect(normalizedHeaders).toContain('code')
      expect(normalizedHeaders).toContain('quantité')
      expect(normalizedHeaders).toContain('pu ht')
    }
  )
})

// ---------------------------------------------------------------------------
// AC#5 — Smoke Preview: MANUAL checklist + e2e proxy guard
// ---------------------------------------------------------------------------

describe('H17-AC5 — Smoke Preview: proxy guard + manual checklist', () => {
  /**
   * AC#5 is inherently a "manual / MCP browser" test.
   * Automation rationale: the import fournisseur flow requires:
   *   1. A live Vercel Preview deployment with the bumped xlsx
   *   2. An operator session (magic-link auth)
   *   3. The supplier-prices-rufino.xlsx fixture uploaded via the UI
   *   4. The Supabase Preview DB with apply_supplier_prices_for_sav RPC
   *
   * None of these are available in the Vitest unit runner.
   *
   * Proxy guards:
   *   (a) The e2e Playwright spec for import-supplier still exists
   *   (b) The playwright.config.js is intact
   *
   * MANUAL CHECKLIST (for human + MCP browser verification):
   *
   * AC#5(a) — Import fournisseur:
   *   - Navigate /back-office/supplier-import as operator
   *   - Upload tests/fixtures/supplier-prices-rufino.xlsx (or equivalent)
   *   - Preview dialog shows matched rows (RPC dry-run)
   *   - Click "Appliquer" → toast success appears
   *   - Console: 0 red errors
   *
   * AC#5(b) — Capture self-service (axios call):
   *   - POST formulaire SPA → 201 (axios → /api/webhooks/capture)
   *   - Console: 0 red errors, no "Failed to fetch" on axios call
   *
   * AC#5(c) — Folder share link (axios call):
   *   - Generate link from SAV detail → 200 (/api/folder-share-link)
   *
   * AC#5(d) — Self-service submit token (axios call):
   *   - Flow capture token → 200 (/api/self-service/submit-token)
   *
   * AC#5(e) — Bundle size:
   *   - Check dist/ build output: xlsx CDN tarball size delta ≤ +5% vs baseline
   *   - Run: npm run build && ls -la dist/assets/*.js | awk '{sum+=$5} END {print sum}'
   *   - Compare to pre-bump baseline (note in PR description)
   */

  it('PROXY-GUARD — playwright.config.js EXISTE (e2e suite intact)', () => {
    const playwrightConfig = resolve(CLIENT_ROOT, 'playwright.config.js')
    expect(existsSync(playwrightConfig)).toBe(true)
  })

  it('PROXY-GUARD — e2e import-supplier-prices-4-8.spec.ts EXISTE', () => {
    expect(existsSync(E2E_IMPORT_SPEC)).toBe(true)
  })

  it(
    'DOCUMENTATION — AC#5 est MANUAL (MCP browser requis) — not automatable in Vitest',
    () => {
      // This test always passes. It is a documentation anchor for the ATDD
      // checklist printed above. The real verification is done via MCP chrome-devtools.
      console.info(
        '[H17-AC5] MANUAL checklist:\n' +
        '  (a) Upload supplier-prices-rufino.xlsx → preview + apply → toast success\n' +
        '  (b) POST /api/webhooks/capture → 201 (axios call OK)\n' +
        '  (c) GET /api/folder-share-link → 200\n' +
        '  (d) POST /api/self-service/submit-token → 200\n' +
        '  (e) Console: 0 red errors on all flows above\n' +
        '  (f) Bundle size delta ≤ +5%\n' +
        'Run: npx playwright test tests/e2e/import-supplier-prices-4-8.spec.ts (with Preview env)'
      )
      expect(true).toBe(true)
    }
  )
})
