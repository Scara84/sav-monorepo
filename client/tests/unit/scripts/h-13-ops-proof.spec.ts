/**
 * Story H-13 — Checklist J+30 post-cutover Make→Pennylane (W73+W75+clôture)
 *
 * W72 découplé vers h-13c-make-scenarios-deletion (DN-7 2026-05-14). Tests W72 retirés.
 * W76 découplé vers h-13b-w76-communication-adherents (DN-6 2026-05-14). Pas de tests ici.
 *
 * ATDD Strategy per AC:
 *
 * AC#1 (W73 — suppression env vars VITE_WEBHOOK_URL*) : testable trivialement.
 *   Vérifie l'absence de VITE_WEBHOOK_URL et VITE_WEBHOOK_URL_DATA_SAV dans client/.env.example.
 *   Test type: Vitest / grep-absence. Framework: Vitest + node:fs.
 *
 * AC#2 (W75 — curl Pennylane prod read-only) : NON-testable automatiquement (appel prod, clé user-supplied).
 *   Strategy : vérifie la présence et les sections attendues du fichier de validation
 *   `_bmad-output/implementation-artifacts/h-13-w75-pennylane-shape-validation.md`.
 *   Test type: Vitest / markdown-structure. Framework: Vitest + node:fs.
 *
 * AC#3 (Clôture) : vérifie que deferred-work.md contient des strikethroughs pour W73/W75/W98
 *   (PAS W72 — découplé vers h-13c, ne doit PAS être strikethrough côté H-13)
 *   et que sprint-status.yaml marque h-13-checklist-j30 comme done.
 *   Test type: Vitest / file-content. Framework: Vitest + node:fs.
 *
 * DECISION: fichier unique regroupant les 3 ACs (tous de type "static file assertions") —
 * cohérent avec runbooks-structure.spec.ts et dpia-structure.spec.ts.
 * Emplacement : client/tests/unit/scripts/h-13-ops-proof.spec.ts
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Navigate from client/tests/unit/scripts/ → monorepo root
const MONOREPO_ROOT = resolve(__dirname, '../../../..')
const ENV_EXAMPLE_PATH = resolve(MONOREPO_ROOT, 'client', '.env.example')
const SHAPE_VALIDATION_PATH = resolve(
  MONOREPO_ROOT,
  '_bmad-output',
  'implementation-artifacts',
  'h-13-w75-pennylane-shape-validation.md'
)
const DEFERRED_WORK_PATH = resolve(
  MONOREPO_ROOT,
  '_bmad-output',
  'implementation-artifacts',
  'deferred-work.md'
)
const SPRINT_STATUS_PATH = resolve(
  MONOREPO_ROOT,
  '_bmad-output',
  'implementation-artifacts',
  'sprint-status.yaml'
)

// ---------------------------------------------------------------------------
// AC#1 — W73 : absence de VITE_WEBHOOK_URL* dans client/.env.example
// (W72 découplé vers h-13c-make-scenarios-deletion — tests retirés du présent fichier)
// ---------------------------------------------------------------------------

describe('H13-AC1 — W73 : VITE_WEBHOOK_URL* absent de client/.env.example', () => {
  it('RED — .env.example existe', () => {
    expect(existsSync(ENV_EXAMPLE_PATH)).toBe(true)
  })

  it('RED — VITE_WEBHOOK_URL absent de .env.example (commenté ou non)', () => {
    if (!existsSync(ENV_EXAMPLE_PATH)) return
    const content = readFileSync(ENV_EXAMPLE_PATH, 'utf8')
    // Must not appear as a var reference (commented or otherwise), but
    // allow this test file itself to mention it. We test the target file.
    expect(content).not.toContain('VITE_WEBHOOK_URL=')
    expect(content).not.toContain('VITE_WEBHOOK_URL_DATA_SAV=')
  })

  it('RED — le bloc commentaire DEPRECATED Story 5.7 est supprimé', () => {
    if (!existsSync(ENV_EXAMPLE_PATH)) return
    const content = readFileSync(ENV_EXAMPLE_PATH, 'utf8')
    // The 5-line deprecated comment block must be gone
    expect(content).not.toContain('Story 5.7 — DEPRECATED après cutover Make')
    // Fix OQ-2: anchor on DEPRECATED comment block mentioning the runbook (what W73 removes)
    // M-3 CR fix: widened from /^#\s*DEPRECATED/ to cover variants like "# Story 5.7 — DEPRECATED après cutover Make"
    // Bounded {0,500} to prevent ReDoS. Bidirectional: DEPRECATED near VITE_WEBHOOK_URL or vice versa.
    expect(content).not.toMatch(
      /^#.*DEPRECATED[\s\S]{0,500}?VITE_WEBHOOK_URL|^#.*VITE_WEBHOOK_URL[\s\S]{0,500}?DEPRECATED/m
    )
  })
})

// ---------------------------------------------------------------------------
// AC#2 — W75 : présence + sections requises du fichier validation shape Pennylane
// ---------------------------------------------------------------------------

// Required sections per AC#2 (c) — story DN-5(a)
const REQUIRED_W75_SECTIONS = [
  'PRIORITÉ 1', // Section P1 : encoding %3A du filtre
  'PRIORITÉ 2', // Section P2 : customer.emails
  'PRIORITÉ 3', // Section P3 : shape root items vs data (low)
] as const

// Required metadata fields per AC#2 (c)
const REQUIRED_W75_FIELDS = [
  'HTTP', // HTTP code observé
  'invoice', // Numéro de facture utilisé (contexte)
] as const

describe('H13-AC2 — W75 : fichier validation shape Pennylane existe avec sections attendues', () => {
  it('RED — h-13-w75-pennylane-shape-validation.md existe dans _bmad-output/implementation-artifacts/', () => {
    expect(existsSync(SHAPE_VALIDATION_PATH)).toBe(true)
  })

  // Fix OQ-1: no early-bail — readFileSync throws if file absent → all content tests RED
  it('RED — fichier contient la section PRIORITÉ 1 (encoding %3A)', () => {
    const content = readFileSync(SHAPE_VALIDATION_PATH, 'utf8')
    expect(content).toContain('PRIORIT')
    // Accepts "PRIORITÉ 1" or "Priorité 1" or "P1" notation
    const hasP1 =
      content.includes('PRIORITÉ 1') || content.includes('Priorité 1') || content.includes('P1')
    expect(hasP1).toBe(true)
  })

  it('RED — fichier contient la section PRIORITÉ 2 (customer.emails)', () => {
    const content = readFileSync(SHAPE_VALIDATION_PATH, 'utf8')
    const hasP2 =
      content.includes('PRIORITÉ 2') ||
      content.includes('Priorité 2') ||
      content.includes('P2') ||
      content.includes('customer.emails')
    expect(hasP2).toBe(true)
  })

  it('RED — fichier contient la section PRIORITÉ 3 (shape root items/data)', () => {
    const content = readFileSync(SHAPE_VALIDATION_PATH, 'utf8')
    const hasP3 =
      content.includes('PRIORITÉ 3') ||
      content.includes('Priorité 3') ||
      content.includes('P3') ||
      content.includes('items') ||
      content.includes('data')
    expect(hasP3).toBe(true)
  })

  it('RED — fichier contient un HTTP status code observé', () => {
    const content = readFileSync(SHAPE_VALIDATION_PATH, 'utf8')
    // Should contain HTTP code (200, 400, 401...) mentioned explicitly
    const hasHttpCode = /HTTP[:\s]+\d{3}|status[:\s]+\d{3}|\b200\b|\b400\b|\b401\b/.test(content)
    expect(hasHttpCode).toBe(true)
  })

  it('RED — fichier ne contient PAS de clé API ou Bearer token (redact pre-commit)', () => {
    const content = readFileSync(SHAPE_VALIDATION_PATH, 'utf8')
    // PATTERN-MEMORY-REDACT-SECRETS — grep obligatoire pre-commit
    expect(content).not.toMatch(/Bearer\s+[A-Za-z0-9._\-]{20,}/)
    expect(content).not.toMatch(/sb_(secret|publishable)_/)
    expect(content).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/)
    expect(content).not.toMatch(/PENNYLANE_API_KEY\s*=\s*\S+/)
  })

  it('RED — fichier contient une décision finale (exactement 1 option [x] cochée)', () => {
    const content = readFileSync(SHAPE_VALIDATION_PATH, 'utf8')
    // M-6 CR fix: surgical assertion — template avec 0 cases cochées ne doit pas passer
    // La conclusion doit cocher exactement une des 3 options [x]
    const checkedOptions = (content.match(/^- \[x\]/gm) ?? []).length
    expect(checkedOptions).toBeGreaterThanOrEqual(1)
    expect(checkedOptions).toBeLessThanOrEqual(1) // 1 option cochée, pas plus
    // Valider que c'est bien "Validation passive OK" (seul cas valide post-validation 2026-05-14)
    expect(content).toMatch(/^- \[x\].*Validation passive OK/m)
  })
})

// ---------------------------------------------------------------------------
// AC#3 — Clôture : deferred-work.md strikethrough + sprint-status.yaml done
// ---------------------------------------------------------------------------

describe('H13-AC3 — Clôture : deferred-work.md + sprint-status.yaml mis à jour', () => {
  it('RED — deferred-work.md existe', () => {
    expect(existsSync(DEFERRED_WORK_PATH)).toBe(true)
  })

  // W72 découplé → h-13c (cf. DN-7 2026-05-14) — non testé ici (pas de strikethrough attendu côté H-13)
  // W76 découplé → h-13b (cf. DN-6 2026-05-14) — non testé ici

  it('RED — deferred-work.md contient W73 en strikethrough (résolu)', () => {
    if (!existsSync(DEFERRED_WORK_PATH)) return
    const content = readFileSync(DEFERRED_WORK_PATH, 'utf8')
    expect(content).toMatch(/~~[^~]*W73[^~]*~~/)
  })

  it('RED — deferred-work.md contient W75 en strikethrough (résolu)', () => {
    if (!existsSync(DEFERRED_WORK_PATH)) return
    const content = readFileSync(DEFERRED_WORK_PATH, 'utf8')
    expect(content).toMatch(/~~[^~]*W75[^~]*~~/)
  })

  it('RED — deferred-work.md contient W98 en strikethrough (consolidé dans W75)', () => {
    if (!existsSync(DEFERRED_WORK_PATH)) return
    const content = readFileSync(DEFERRED_WORK_PATH, 'utf8')
    expect(content).toMatch(/~~[^~]*W98[^~]*~~/)
  })

  it('RED — sprint-status.yaml contient h-13-checklist-j30: done', () => {
    if (!existsSync(SPRINT_STATUS_PATH)) return
    const content = readFileSync(SPRINT_STATUS_PATH, 'utf8')
    // AC#4 (b) — sprint-status.yaml ligne 576
    // M-2 CR fix: anchored multiline + word-boundary to prevent false positive on h-13-checklist-j30-something: done
    expect(content).toMatch(/^\s*h-13-checklist-j30:\s*done\b/m)
  })

  it('RED — sprint-status.yaml existe', () => {
    expect(existsSync(SPRINT_STATUS_PATH)).toBe(true)
  })

  it('GREEN guard — W76 NON strikethrough dans deferred-work.md (découplé h-13b, AC#3(a))', () => {
    const content = readFileSync(DEFERRED_WORK_PATH, 'utf8')
    // W76 doit rester non-strikethrough côté H-13 — clôture est responsabilité h-13b
    expect(content).not.toMatch(/^-\s+\*\*~~W76[^~]*~~\*\*/m)
  })

  it('GREEN guard — W72 NON strikethrough dans deferred-work.md (découplé h-13c, AC#3(a))', () => {
    const content = readFileSync(DEFERRED_WORK_PATH, 'utf8')
    // W72 doit rester non-strikethrough côté H-13 — clôture est responsabilité h-13c
    expect(content).not.toMatch(/^-\s+\*\*~~W72[^~]*~~\*\*/m)
  })
})
