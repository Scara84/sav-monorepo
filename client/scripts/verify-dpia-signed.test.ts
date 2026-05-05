/**
 * Story 7-7 AC #5(d) — RED-PHASE tests for `scripts/verify-dpia-signed.mjs`
 *
 * Strategy: spawn the script as a child process with different DPIA markdown
 * inputs written to temp files. Assert exit code and output message per case.
 * Pattern mirrors `tests/integration/admin/rgpd-export-signature-roundtrip.spec.ts`
 * which uses the same spawnSync approach for `scripts/verify-rgpd-export.mjs`.
 *
 * 5 cases per AC #5(a):
 *   Case 1 — DPIA signed valide: section ## Signature + Date ISO + Responsable + Signature → exit 0
 *   Case 2 — Section ## Signature absente → exit 1 + MISSING_SIGNATURE_SECTION
 *   Case 3 — Date présente mais format invalide (15/05/2026) → exit 1 + INVALID_DATE_FORMAT
 *   Case 4 — Responsable vide → exit 1 + EMPTY_RESPONSABLE
 *   Case 5 — Signature vide → exit 1 + EMPTY_SIGNATURE
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// scripts/verify-dpia-signed.mjs lives at the repo root (same level as scripts/verify-rgpd-export.mjs)
const REPO_ROOT = resolve(__dirname, '../..') // client/scripts/ → client/ → monorepo root
const VERIFY_SCRIPT = resolve(REPO_ROOT, 'scripts/verify-dpia-signed.mjs')

// ---------------------------------------------------------------------------
// DPIA markdown templates
// ---------------------------------------------------------------------------

const VALID_DPIA = `# DPIA — Application SAV Fruitstock V1

## Objet du traitement

Application SAV Fruitstock V1, gestion réclamations adhérents coopérative.

## Responsable du traitement

Fruitstock SAS, contact PM Antho Scaravella.

## Données collectées

PII directes: nom, email, téléphone, pennylane_customer_id.

## Finalités

Traitement réclamations, émission avoirs, suivi historique adhérent.

## Durée de conservation

Données SAV/avoirs = 10 ans rétention comptable obligatoire.

## Mesures de sécurité

RLS Supabase, HMAC webhooks, magic-link anti-énumération.

## Droits adhérents

Portabilité, effacement, accès, rectification.

## Sous-traitants

Supabase, Vercel, Microsoft 365, Pennylane, Infomaniak.

---
## Signature

**Date** : 2026-05-15
**Responsable** : Antho Scaravella, Tech-Lead / DPO Fruitstock
**Signature** : Approuvé v1 release
`

const DPIA_NO_SIGNATURE_SECTION = `# DPIA — Application SAV Fruitstock V1

## Objet du traitement

Application SAV Fruitstock V1.

## Responsable du traitement

Fruitstock SAS.

## Données collectées

PII directes: nom, email.

## Finalités

Traitement réclamations.

## Durée de conservation

10 ans.

## Mesures de sécurité

RLS Supabase.

## Droits adhérents

Portabilité, effacement.

## Sous-traitants

Supabase, Vercel.
`

const DPIA_INVALID_DATE = `# DPIA — Application SAV Fruitstock V1

## Objet du traitement

Application SAV Fruitstock V1.

## Responsable du traitement

Fruitstock SAS.

## Données collectées

PII.

## Finalités

Traitement.

## Durée de conservation

10 ans.

## Mesures de sécurité

RLS.

## Droits adhérents

Portabilité.

## Sous-traitants

Supabase.

---
## Signature

**Date** : 15/05/2026
**Responsable** : Antho Scaravella, Tech-Lead / DPO Fruitstock
**Signature** : Approuvé v1 release
`

const DPIA_EMPTY_RESPONSABLE = `# DPIA — Application SAV Fruitstock V1

## Objet du traitement

Application SAV Fruitstock V1.

## Responsable du traitement

Fruitstock SAS.

## Données collectées

PII.

## Finalités

Traitement.

## Durée de conservation

10 ans.

## Mesures de sécurité

RLS.

## Droits adhérents

Portabilité.

## Sous-traitants

Supabase.

---
## Signature

**Date** : 2026-05-15
**Responsable** :
**Signature** : Approuvé v1 release
`

const DPIA_EMPTY_SIGNATURE = `# DPIA — Application SAV Fruitstock V1

## Objet du traitement

Application SAV Fruitstock V1.

## Responsable du traitement

Fruitstock SAS.

## Données collectées

PII.

## Finalités

Traitement.

## Durée de conservation

10 ans.

## Mesures de sécurité

RLS.

## Droits adhérents

Portabilité.

## Sous-traitants

Supabase.

---
## Signature

**Date** : 2026-05-15
**Responsable** : Antho Scaravella, Tech-Lead / DPO Fruitstock
**Signature** :
`

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'dpia-test-'))
})

afterAll(() => {
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

function writeDpia(name: string, content: string): string {
  const path = join(tmpDir, name)
  writeFileSync(path, content, 'utf8')
  return path
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('verify-dpia-signed.mjs — existence', () => {
  it('RED — script file exists at scripts/verify-dpia-signed.mjs', () => {
    expect(existsSync(VERIFY_SCRIPT)).toBe(true)
  })
})

describe('verify-dpia-signed.mjs — exit codes and messages', () => {
  it('Case 1 — valid DPIA signed: exit 0', () => {
    if (!existsSync(VERIFY_SCRIPT)) {
      expect(existsSync(VERIFY_SCRIPT)).toBe(true)
      return
    }
    const dpiaPath = writeDpia('valid.md', VALID_DPIA)
    const result = spawnSync('node', [VERIFY_SCRIPT, dpiaPath], {
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    const output = result.stdout + result.stderr
    // Script should confirm OK
    expect(output.toLowerCase()).toMatch(/ok|valid|signé|signed|dpia/i)
  })

  it('Case 2 — missing ## Signature section: exit 1 + MISSING_SIGNATURE_SECTION', () => {
    if (!existsSync(VERIFY_SCRIPT)) {
      expect(existsSync(VERIFY_SCRIPT)).toBe(true)
      return
    }
    const dpiaPath = writeDpia('no-sig-section.md', DPIA_NO_SIGNATURE_SECTION)
    const result = spawnSync('node', [VERIFY_SCRIPT, dpiaPath], {
      encoding: 'utf8',
    })
    expect(result.status).toBe(1)
    const output = result.stdout + result.stderr
    expect(output).toContain('MISSING_SIGNATURE_SECTION')
  })

  it('Case 3 — date present but wrong format (15/05/2026): exit 1 + INVALID_DATE_FORMAT', () => {
    if (!existsSync(VERIFY_SCRIPT)) {
      expect(existsSync(VERIFY_SCRIPT)).toBe(true)
      return
    }
    const dpiaPath = writeDpia('bad-date.md', DPIA_INVALID_DATE)
    const result = spawnSync('node', [VERIFY_SCRIPT, dpiaPath], {
      encoding: 'utf8',
    })
    expect(result.status).toBe(1)
    const output = result.stdout + result.stderr
    expect(output).toContain('INVALID_DATE_FORMAT')
  })

  it('Case 4 — Responsable empty: exit 1 + EMPTY_RESPONSABLE', () => {
    if (!existsSync(VERIFY_SCRIPT)) {
      expect(existsSync(VERIFY_SCRIPT)).toBe(true)
      return
    }
    const dpiaPath = writeDpia('empty-resp.md', DPIA_EMPTY_RESPONSABLE)
    const result = spawnSync('node', [VERIFY_SCRIPT, dpiaPath], {
      encoding: 'utf8',
    })
    expect(result.status).toBe(1)
    const output = result.stdout + result.stderr
    expect(output).toContain('EMPTY_RESPONSABLE')
  })

  it('Case 5 — Signature line empty: exit 1 + EMPTY_SIGNATURE', () => {
    if (!existsSync(VERIFY_SCRIPT)) {
      expect(existsSync(VERIFY_SCRIPT)).toBe(true)
      return
    }
    const dpiaPath = writeDpia('empty-sig.md', DPIA_EMPTY_SIGNATURE)
    const result = spawnSync('node', [VERIFY_SCRIPT, dpiaPath], {
      encoding: 'utf8',
    })
    expect(result.status).toBe(1)
    const output = result.stdout + result.stderr
    expect(output).toContain('EMPTY_SIGNATURE')
  })
})
