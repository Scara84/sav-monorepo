/**
 * Story 7-7 AC #5 — RED-PHASE tests for `docs/dpia/v1.md` structure.
 *
 * Strategy: static markdown parsing — assert the 8 required H2 sections are
 * present + the ## Signature section exists with non-empty fields.
 *
 * 3 cases (structural — does not substitute for the CI gate verify-dpia-signed.mjs):
 *   Case 1 — docs/dpia/v1.md exists and has exactly 8 required H2 sections (D-4)
 *   Case 2 — ## Signature section present with **Date** / **Responsable** / **Signature** lines
 *   Case 3 — DPIA references all 8 required sub-processors (Supabase/Vercel/…)
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Navigate from client/tests/unit/scripts/ → monorepo root → docs/dpia/
const DOCS_ROOT = resolve(__dirname, '../../../..', 'docs')
const DPIA_PATH = resolve(DOCS_ROOT, 'dpia', 'v1.md')

const REQUIRED_SECTIONS = [
  'Objet',
  'Responsable',
  'Données',
  'Finalités',
  'Durée',
  'Mesures',
  'Droits',
  'Sous-traitants',
] as const

const REQUIRED_SUBPROCESSORS = [
  'Supabase',
  'Vercel',
  'Microsoft',
  'Pennylane',
  'Infomaniak',
] as const

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('docs/dpia/v1.md — existence', () => {
  it('RED — docs/dpia/v1.md exists', () => {
    expect(existsSync(DPIA_PATH)).toBe(true)
  })
})

describe('docs/dpia/v1.md — D-4 required 8 H2 sections', () => {
  it('RED — all 8 required H2 section titles are present', () => {
    if (!existsSync(DPIA_PATH)) {
      expect(existsSync(DPIA_PATH)).toBe(true)
      return
    }
    const src = readFileSync(DPIA_PATH, 'utf8')

    for (const section of REQUIRED_SECTIONS) {
      expect(src).toMatch(new RegExp(`^## .*${section}`, 'm'))
    }
  })

  it('RED — ## Signature section is present (D-6 CI gate prerequisite)', () => {
    if (!existsSync(DPIA_PATH)) return
    const src = readFileSync(DPIA_PATH, 'utf8')
    expect(src).toMatch(/^## Signature/m)
  })
})

describe('docs/dpia/v1.md — ## Signature fields', () => {
  it('RED — **Date** line is present with ISO-format value', () => {
    if (!existsSync(DPIA_PATH)) return
    const src = readFileSync(DPIA_PATH, 'utf8')
    // Matches: **Date** : 2026-05-15
    expect(src).toMatch(/\*\*Date\*\*\s*:\s*\d{4}-\d{2}-\d{2}/)
  })

  it('RED — **Responsable** line is present and non-empty', () => {
    if (!existsSync(DPIA_PATH)) return
    const src = readFileSync(DPIA_PATH, 'utf8')
    expect(src).toMatch(/\*\*Responsable\*\*\s*:\s*\S+/)
  })

  it('RED — **Signature** line is present and non-empty', () => {
    if (!existsSync(DPIA_PATH)) return
    const src = readFileSync(DPIA_PATH, 'utf8')
    expect(src).toMatch(/\*\*Signature\*\*\s*:\s*\S+/)
  })
})

describe('docs/dpia/v1.md — D-4 sub-processors (section 8)', () => {
  it('RED — all 5 required sub-processors mentioned in DPIA', () => {
    if (!existsSync(DPIA_PATH)) return
    const src = readFileSync(DPIA_PATH, 'utf8')

    for (const processor of REQUIRED_SUBPROCESSORS) {
      expect(src).toContain(processor)
    }
  })

  it('RED — retention periods documented (10 ans comptable + magic-link 15 min)', () => {
    if (!existsSync(DPIA_PATH)) return
    const src = readFileSync(DPIA_PATH, 'utf8')
    expect(src).toMatch(/10 ans/i)
    expect(src).toMatch(/15 min|15min/i)
  })
})
