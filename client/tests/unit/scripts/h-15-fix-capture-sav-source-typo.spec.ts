/**
 * Story H-15 — Fix RPC `capture_sav_from_webhook` : source='webhook' → 'capture'
 *
 * ATDD Strategy per AC:
 *
 * AC#1 (Migration formelle) : static-file assertion.
 *   Vérifie l'existence + contenu de la migration `20260521120000_fix_capture_sav_source_typo.sql`.
 *   Pattern : même style que h-09, h-13 static-file assertions.
 *   Test type: unit / static-file-assertion
 *
 * AC#3 (Audit transverse) : static-file assertion sur le rapport.
 *   Vérifie l'existence + structure du rapport `h-15-audit-source-values.md`.
 *   Test type: unit / static-file-assertion
 *
 * AC#4 (audit:schema beef-up) : unit tests sur la logique de parsing.
 *   Le script `audit-check-constraints.mjs` (NEW) expose des fonctions de parsing
 *   utilisées ici en self-test + regression.
 *   Test type: unit + self-test regression (PATTERN-H15-B doctrine)
 *
 * AC#5 (Trackers) : static-file assertion.
 *   Vérifie sprint-status.yaml ligne h-15 done + preuve repo du gap mémoire.
 *   Test type: unit / static-file-assertion
 *
 * GREEN-guards (invariants) :
 *   - La migration V1.9-B (`20260518120000`) reste intacte (ne contient PAS 'capture'
 *     dans sa ligne sav_files INSERT — ce serait une modification non-autorisée).
 *   - Le script audit-handler-schema.mjs existant tourne toujours en PASS.
 *
 * RED-phase : tous les tests AC#1/3/4/5 doivent FAIL avant Step 3 DEV.
 * GREEN-guards : doivent PASS dès la phase RED.
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Navigate from client/tests/unit/scripts/ → monorepo root
const MONOREPO_ROOT = resolve(__dirname, '../../../..')
const CLIENT_ROOT = resolve(MONOREPO_ROOT, 'client')
const MIGRATIONS_DIR = resolve(CLIENT_ROOT, 'supabase', 'migrations')
const ARTIFACTS_DIR = resolve(MONOREPO_ROOT, '_bmad-output', 'implementation-artifacts')

// Key file paths
const MIGRATION_FIX_PATH = resolve(MIGRATIONS_DIR, '20260521120000_fix_capture_sav_source_typo.sql')
const MIGRATION_BUGGY_PATH = resolve(MIGRATIONS_DIR, '20260518120000_v1-9-b-arbitration-motif.sql')
const AUDIT_REPORT_PATH = resolve(ARTIFACTS_DIR, 'h-15-audit-source-values.md')
const SPRINT_STATUS_PATH = resolve(ARTIFACTS_DIR, 'sprint-status.yaml')
const INTEGRATION_README_PATH = resolve(CLIENT_ROOT, 'tests', 'integration', 'README.md')
const AUDIT_CHECK_SCRIPT_PATH = resolve(CLIENT_ROOT, 'scripts', 'audit-check-constraints.mjs')
const AUDIT_SCHEMA_SCRIPT_PATH = resolve(CLIENT_ROOT, 'scripts', 'audit-handler-schema.mjs')

// ---------------------------------------------------------------------------
// GREEN GUARDS — must PASS before and after Step 3 DEV
// ---------------------------------------------------------------------------

describe('GREEN-guard — V1.9-B migration NOT amended (DN-1=A invariant immuable)', () => {
  it('GUARD — migration 20260518120000 existe toujours (pas supprimée)', () => {
    expect(existsSync(MIGRATION_BUGGY_PATH)).toBe(true)
  })

  it('GUARD — migration 20260518120000 contient bien le bug source="webhook" (non-amendent)', () => {
    const content = readFileSync(MIGRATION_BUGGY_PATH, 'utf8')
    // The buggy line must still exist — DN-1=A means we NEVER amend V1.9-B in-place
    expect(content).toContain("'webhook'")
  })

  it('GUARD — migration 20260518120000 ne contient PAS source="capture" dans le block INSERT sav_files V1.9-B', () => {
    const content = readFileSync(MIGRATION_BUGGY_PATH, 'utf8')
    // Line 564 should still say 'webhook' not 'capture' — if it says 'capture' then
    // someone violated the migration-immutable invariant (DN-1=A)
    // We find the sav_files INSERT block and check it still has 'webhook'
    const insertBlock = content.substring(
      content.indexOf('INSERT INTO sav_files'),
      content.indexOf("'webhook'") + 20
    )
    expect(insertBlock).toContain("'webhook'")
  })
})

describe('GREEN-guard — audit-handler-schema.mjs (W113) PASS baseline', () => {
  it('GUARD — W113 audit script still reports no drift', () => {
    let stdout = ''
    let exitCode = 0
    try {
      stdout = execFileSync('node', [AUDIT_SCHEMA_SCRIPT_PATH], {
        encoding: 'utf8',
        cwd: CLIENT_ROOT,
      })
    } catch (err) {
      const e = err as { status: number; stdout: string }
      exitCode = e.status ?? 1
      stdout = e.stdout ?? ''
    }
    expect(exitCode).toBe(0)
    expect(stdout).toContain('No drift detected')
  })
})

// ---------------------------------------------------------------------------
// AC#1 — Migration formelle `20260521120000_fix_capture_sav_source_typo.sql`
// ---------------------------------------------------------------------------

describe('H15-AC1 — Migration fix source typo', () => {
  it('RED — migration 20260521120000_fix_capture_sav_source_typo.sql EXISTE', () => {
    expect(existsSync(MIGRATION_FIX_PATH)).toBe(true)
  })

  it('RED — migration contient CREATE OR REPLACE FUNCTION capture_sav_from_webhook', () => {
    const content = readFileSync(MIGRATION_FIX_PATH, 'utf8')
    expect(content).toMatch(/CREATE OR REPLACE FUNCTION\s+public\.capture_sav_from_webhook/)
  })

  it("RED — migration contient source='capture' dans le bloc INSERT sav_files", () => {
    const content = readFileSync(MIGRATION_FIX_PATH, 'utf8')
    // The fix: 'webhook' replaced by 'capture' in the INSERT sav_files block
    expect(content).toContain("'capture'")
  })

  it("RED — migration NE contient PAS source='webhook' (typo corrigée)", () => {
    const content = readFileSync(MIGRATION_FIX_PATH, 'utf8')
    // The bad value must be absent from the new migration
    expect(content).not.toContain("'webhook'")
  })

  it('RED — migration contient commentaire en-tête citant le story h-15', () => {
    const content = readFileSync(MIGRATION_FIX_PATH, 'utf8')
    expect(content).toContain('h-15')
  })

  it('RED — migration contient lien vers source du bug (20260518120000)', () => {
    const content = readFileSync(MIGRATION_FIX_PATH, 'utf8')
    expect(content).toContain('20260518120000')
  })

  it('RED — migration contient lien vers CHECK constraint definition (20260421140000)', () => {
    const content = readFileSync(MIGRATION_FIX_PATH, 'utf8')
    expect(content).toContain('20260421140000')
  })

  it('RED — migration contient lien vers intention originale (20260421150000)', () => {
    const content = readFileSync(MIGRATION_FIX_PATH, 'utf8')
    expect(content).toContain('20260421150000')
  })

  it('RED — migration contient note idempotence / CREATE OR REPLACE', () => {
    const content = readFileSync(MIGRATION_FIX_PATH, 'utf8')
    // AC#1.3 requires explicit note about idempotency
    const hasIdempotentNote =
      content.toLowerCase().includes('idempotent') ||
      content.toLowerCase().includes('create or replace')
    expect(hasIdempotentNote).toBe(true)
  })

  it('RED — migration contient COMMENT ON FUNCTION mis à jour (mention h-15)', () => {
    const content = readFileSync(MIGRATION_FIX_PATH, 'utf8')
    // AC#1.4 — COMMENT ON FUNCTION must mention h-15
    expect(content).toMatch(/COMMENT ON FUNCTION[\s\S]*h-15/i)
  })

  it('RED — migration préserve la signature RETURNS TABLE(sav_id, reference, line_count, file_count)', () => {
    const content = readFileSync(MIGRATION_FIX_PATH, 'utf8')
    expect(content).toMatch(/RETURNS TABLE\s*\(/i)
    expect(content).toContain('sav_id')
    expect(content).toContain('reference')
    expect(content).toContain('line_count')
    expect(content).toContain('file_count')
  })

  it('RED — migration préserve SECURITY DEFINER', () => {
    const content = readFileSync(MIGRATION_FIX_PATH, 'utf8')
    expect(content).toContain('SECURITY DEFINER')
  })
})

// ---------------------------------------------------------------------------
// AC#3 — Rapport audit transverse source values
// ---------------------------------------------------------------------------

describe('H15-AC3 — Rapport audit source values dans sav_files', () => {
  it('RED — rapport h-15-audit-source-values.md EXISTE dans _bmad-output/implementation-artifacts/', () => {
    expect(existsSync(AUDIT_REPORT_PATH)).toBe(true)
  })

  it('RED — rapport contient la section "source" ou "sav_files"', () => {
    const content = readFileSync(AUDIT_REPORT_PATH, 'utf8')
    const hasSavFiles = content.includes('sav_files') || content.includes('source')
    expect(hasSavFiles).toBe(true)
  })

  it("RED — rapport mentionne la violation 20260518120000:564 ('webhook')", () => {
    const content = readFileSync(AUDIT_REPORT_PATH, 'utf8')
    expect(content).toContain('20260518120000')
  })

  it('RED — rapport mentionne les valeurs autorisées par le CHECK constraint', () => {
    const content = readFileSync(AUDIT_REPORT_PATH, 'utf8')
    // Must mention the allowed values from CHECK (source IN ('capture','operator-add','member-add'))
    const hasAllowedValues =
      content.includes('capture') &&
      (content.includes('operator-add') || content.includes('member-add'))
    expect(hasAllowedValues).toBe(true)
  })

  it('RED — rapport contient PASS/VIOLATION statuts pour chaque literal trouvé', () => {
    const content = readFileSync(AUDIT_REPORT_PATH, 'utf8')
    // AC#3.2 — each file+line must have a PASS or VIOLATION status
    const hasStatus =
      content.toUpperCase().includes('PASS') || content.toUpperCase().includes('VIOLATION')
    expect(hasStatus).toBe(true)
  })

  it('RED — rapport confirme 0 violation active (autre que bug fixé)', () => {
    const content = readFileSync(AUDIT_REPORT_PATH, 'utf8')
    // AC#3.3 — after AC#1 fix is applied, 0 remaining violations
    // Report must explicitly state the count (0 violations remaining or "all clear")
    const hasZeroViolation =
      content.includes('0 violation') ||
      content.includes('aucune violation') ||
      content.includes('no violation') ||
      content.includes('all PASS') ||
      content.toUpperCase().includes('0 VIOLATION ACTIVE')
    expect(hasZeroViolation).toBe(true)
  })

  it('RED — rapport ne contient PAS de clé secrète (redact pre-commit)', () => {
    const content = readFileSync(AUDIT_REPORT_PATH, 'utf8')
    // PATTERN-MEMORY-REDACT-SECRETS
    expect(content).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{20,}/)
    expect(content).not.toMatch(/sb_(secret|publishable)_/)
    expect(content).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/)
  })
})

// ---------------------------------------------------------------------------
// AC#4 — audit-check-constraints.mjs — parsing logic unit tests
// ---------------------------------------------------------------------------

describe('H15-AC4 — audit-check-constraints.mjs script existence + execution', () => {
  it('RED — script audit-check-constraints.mjs EXISTE dans client/scripts/', () => {
    expect(existsSync(AUDIT_CHECK_SCRIPT_PATH)).toBe(true)
  })

  it('RED — script sort avec exit code 0 sur un repo propre (post-fix AC#1)', () => {
    // This test will pass only AFTER migration AC#1 is in place — before, script
    // should detect 'webhook' violation and exit 1.
    // During red-phase, script doesn't exist → this test FAILS (existsSync false above).
    if (!existsSync(AUDIT_CHECK_SCRIPT_PATH)) {
      throw new Error('audit-check-constraints.mjs not found — RED phase expected')
    }
    let exitCode = 0
    let stdout = ''
    try {
      stdout = execFileSync('node', [AUDIT_CHECK_SCRIPT_PATH], {
        encoding: 'utf8',
        cwd: CLIENT_ROOT,
      })
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string }
      exitCode = e.status ?? 1
      stdout = (e.stdout ?? '') + (e.stderr ?? '')
    }
    // After AC#1 fix migration is in place: script should detect no violations
    // (The 'webhook' violation in 20260518120000 is caught but the fix migration re-CREATEs
    //  the function with 'capture' — the *live* function uses 'capture').
    // Per AC#4.3 the gate checks literal values in migrations/handlers.
    // NOTE: After DEV step, the script should EXIT 0 (or flag the V1.9-B historical
    //       migration as historical/superseded — see OPEN QUESTION #1).
    expect(exitCode).toBe(0)
    expect(stdout).not.toMatch(/\[VIOLATION\].*sav_files.*webhook/)
  })
})

describe('H15-AC4 — Self-test de régression du gate (PATTERN-H15-B)', () => {
  it('RED — script expose un mode --self-test ou test de régression interne qui prouve le gate ferme la classe', () => {
    // AC#4.7 — the script must include a self-test that simulates the bug
    // Strategy: check that the script file contains a fixture/test that injects 'webhook'
    // and asserts exit 1.
    if (!existsSync(AUDIT_CHECK_SCRIPT_PATH)) {
      throw new Error('audit-check-constraints.mjs not found — RED phase expected')
    }
    const content = readFileSync(AUDIT_CHECK_SCRIPT_PATH, 'utf8')
    // The script must contain a self-test section or --self-test flag
    const hasSelfTest =
      content.includes('self-test') ||
      content.includes('selfTest') ||
      content.includes('self_test') ||
      content.includes('SELF_TEST') ||
      content.includes('regression')
    expect(hasSelfTest).toBe(true)
  })

  it('RED — script contient une fixture synthétique avec la valeur violatrice "webhook"', () => {
    if (!existsSync(AUDIT_CHECK_SCRIPT_PATH)) {
      throw new Error('audit-check-constraints.mjs not found — RED phase expected')
    }
    const content = readFileSync(AUDIT_CHECK_SCRIPT_PATH, 'utf8')
    // The self-test must reference 'webhook' as the simulated violation value
    // (per AC#4.7 — fixture that simulates the bug 20260518120000:564)
    expect(content).toContain('webhook')
  })

  it('RED — exécution avec --self-test exit 0 (self-test interne passe)', () => {
    if (!existsSync(AUDIT_CHECK_SCRIPT_PATH)) {
      throw new Error('audit-check-constraints.mjs not found — RED phase expected')
    }
    let exitCode = 0
    let stdout = ''
    try {
      stdout = execFileSync('node', [AUDIT_CHECK_SCRIPT_PATH, '--self-test'], {
        encoding: 'utf8',
        cwd: CLIENT_ROOT,
      })
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string }
      exitCode = e.status ?? 1
      stdout = (e.stdout ?? '') + (e.stderr ?? '')
    }
    // The self-test mode must exit 0 AND report that it detected the simulated violation
    expect(exitCode).toBe(0)
    const hasSelfTestPass =
      stdout.includes('self-test') ||
      stdout.includes('PASS') ||
      stdout.includes('regression') ||
      stdout.toLowerCase().includes('ok')
    expect(hasSelfTestPass).toBe(true)
  })
})

describe('H15-AC4 — Parsing CHECK constraints IN depuis migrations (regex logic)', () => {
  it("RED — le script peut parser \"CHECK (source IN ('capture','operator-add','member-add'))\" depuis la migration schéma", () => {
    // This is a behavioral test: we verify the script's parsed output
    // includes the sav_files.source CHECK constraint.
    // If script exposes --dump-constraints, we can check the output.
    if (!existsSync(AUDIT_CHECK_SCRIPT_PATH)) {
      throw new Error('audit-check-constraints.mjs not found — RED phase expected')
    }
    let stdout = ''
    let exitCode = 0
    try {
      stdout = execFileSync('node', [AUDIT_CHECK_SCRIPT_PATH, '--dump-constraints'], {
        encoding: 'utf8',
        cwd: CLIENT_ROOT,
      })
    } catch (err) {
      const e = err as { status: number; stdout: string }
      // If --dump-constraints not supported, try plain run
      exitCode = e.status ?? 1
      stdout = e.stdout ?? ''
    }
    // The script must have detected sav_files.source constraint somewhere in its output
    // Either from --dump-constraints or from the main run mentioning sav_files
    const detectsSavFilesSource =
      stdout.includes('sav_files') || stdout.includes('source') || stdout.includes('capture')
    expect(detectsSavFilesSource).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AC#5 — Trackers : sprint-status.yaml + memory update
// ---------------------------------------------------------------------------

describe('H15-AC5 — sprint-status.yaml tracker', () => {
  it('RED — sprint-status.yaml existe', () => {
    expect(existsSync(SPRINT_STATUS_PATH)).toBe(true)
  })

  it('RED — sprint-status.yaml contient h-15-fix-capture-sav-source-typo: done', () => {
    const content = readFileSync(SPRINT_STATUS_PATH, 'utf8')
    expect(content).toMatch(/^\s*h-15-fix-capture-sav-source-typo:\s*done\b/m)
  })

  it('RED — sprint-status.yaml mention h-15 indique migration 20260521120000', () => {
    const content = readFileSync(SPRINT_STATUS_PATH, 'utf8')
    // AC#5.1 — résumé doit mentionner la migration
    // Find h-15 line and check it mentions the timestamp
    const h15LineMatch = content.match(/h-15-fix-capture-sav-source-typo.*/)
    expect(h15LineMatch).not.toBeNull()
    const h15Line = h15LineMatch![0]
    expect(h15Line).toContain('20260521120000')
  })

  it('RED — sprint-status.yaml mention h-15 note "non touché prod legacy"', () => {
    const content = readFileSync(SPRINT_STATUS_PATH, 'utf8')
    // AC#5.1 — mention explicite prod non-touché
    const h15Match = content.match(/h-15-fix-capture-sav-source-typo[^#\n]*/)?.[0] ?? ''
    const hasProdNote =
      h15Match.includes('prod') ||
      // Line may wrap into a comment; search broader context
      content
        .slice(
          content.indexOf('h-15-fix-capture-sav-source-typo'),
          content.indexOf('h-15-fix-capture-sav-source-typo') + 500
        )
        .includes('prod')
    expect(hasProdNote).toBe(true)
  })
})

describe('H15-AC5 — preuve repo feedback_test_integration_gap', () => {
  it('RED — artefact h-15 versionné existe', () => {
    expect(existsSync(AUDIT_REPORT_PATH)).toBe(true)
  })

  it('RED — preuves h-15 référencent feedback_test_integration_gap', () => {
    const integrationReadme = readFileSync(INTEGRATION_README_PATH, 'utf8')
    const migration = readFileSync(MIGRATION_FIX_PATH, 'utf8')
    const script = readFileSync(AUDIT_CHECK_SCRIPT_PATH, 'utf8')
    expect(integrationReadme).toContain('feedback_test_integration_gap')
    expect(integrationReadme).toContain('H-15')
    expect(migration).toContain('h-15')
    expect(script).toContain('CHECK IN')
  })

  it('RED — artefact h-15 mentionne la fermeture de la classe "CHECK IN violation"', () => {
    const content = readFileSync(AUDIT_REPORT_PATH, 'utf8')
    // AC#5.2 — la preuve versionnée doit documenter la fermeture de la classe de bug.
    const mentionsCheckClass =
      content.includes('CHECK IN') ||
      content.includes('audit-check-constraints') ||
      content.includes('CHECK constraint') ||
      (content.includes('CHECK') && content.includes('h-15'))
    expect(mentionsCheckClass).toBe(true)
  })

  it('RED — artefact d audit h-15 prouve le gate renforcé', () => {
    const content = readFileSync(AUDIT_REPORT_PATH, 'utf8')
    expect(content).toContain('audit:check-constraints')
    expect(content).toContain('ferme cette classe de bug')
  })
})

// ---------------------------------------------------------------------------
// AC#5 — npm run test:integration script exists + vitest.config.integration.ts
// ---------------------------------------------------------------------------

describe('H15-AC5 — test:integration infrastructure (AC#2 companion)', () => {
  it('RED — client/package.json contient script "test:integration"', () => {
    const pkgPath = resolve(CLIENT_ROOT, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    expect(pkg.scripts?.['test:integration']).toBeDefined()
  })

  it('RED — vitest.config.integration.ts (ou .js) EXISTE dans client/', () => {
    const configTs = resolve(CLIENT_ROOT, 'vitest.config.integration.ts')
    const configJs = resolve(CLIENT_ROOT, 'vitest.config.integration.js')
    const exists = existsSync(configTs) || existsSync(configJs)
    expect(exists).toBe(true)
  })

  it('RED — client/tests/integration/README.md EXISTE', () => {
    const readmePath = resolve(CLIENT_ROOT, 'tests', 'integration', 'README.md')
    expect(existsSync(readmePath)).toBe(true)
  })

  it('RED — README.md mentionne les prérequis Supabase local + commande test:integration', () => {
    const readmePath = resolve(CLIENT_ROOT, 'tests', 'integration', 'README.md')
    if (!existsSync(readmePath)) throw new Error('README not found — RED phase expected')
    const content = readFileSync(readmePath, 'utf8')
    const hasPrereq = content.includes('supabase') || content.includes('Supabase')
    const hasCommand =
      content.includes('test:integration') || content.includes('npm run test:integration')
    expect(hasPrereq).toBe(true)
    expect(hasCommand).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AC#4 PATTERN-H15-B doctrine — "would have caught V1.9-B" replay (Step 4-bis)
// ---------------------------------------------------------------------------

describe('H15-AC4 — PATTERN-H15-B fixture proof via MIGRATIONS_DIR_OVERRIDE', () => {
  it('AC#4 — audit-check-constraints.mjs would have caught V1.9-B bug in isolation (PATTERN-H15-B fixture proof)', async () => {
    // Mise en place : fixture dir contenant UNIQUEMENT la migration buggée 20260518120000
    // et le check constraint 20260421140000, sans le fix 20260521120000.
    // Le gate doit détecter la violation et exit 1.

    const tmpDir = mkdtempSync(join(tmpdir(), 'h15-fixture-'))
    try {
      // Copy the CHECK constraint migration (20260421140000) + the buggy migration (20260518120000)
      // but NOT the fix migration (20260521120000).
      cpSync(
        join(MIGRATIONS_DIR, '20260421140000_schema_sav_capture.sql'),
        join(tmpDir, '20260421140000_schema_sav_capture.sql')
      )
      cpSync(
        join(MIGRATIONS_DIR, '20260518120000_v1-9-b-arbitration-motif.sql'),
        join(tmpDir, '20260518120000_v1-9-b-arbitration-motif.sql')
      )

      // Run the script with MIGRATIONS_DIR_OVERRIDE pointing at the fixture tmpDir.
      // Without the fix migration, the script should detect source='webhook' and exit 1.
      let result: { status?: number; stdout?: string; stderr?: string } = { status: 0 }
      try {
        const stdout = execFileSync('node', [AUDIT_CHECK_SCRIPT_PATH], {
          env: { ...process.env, MIGRATIONS_DIR_OVERRIDE: tmpDir },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        result = { status: 0, stdout, stderr: '' }
      } catch (e: any) {
        result = { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
      }

      // The script must have exited with code != 0 (violation detected)
      expect(result.status ?? 1).not.toBe(0)

      // And the output must mention 'webhook' (the invalid value) and sav_files.source
      const output = (result.stdout ?? '') + (result.stderr ?? '')
      expect(output).toMatch(/webhook/i)
      expect(output).toMatch(/sav_files[.\s]source|sav_files.*source/i)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }, 15_000)
})
