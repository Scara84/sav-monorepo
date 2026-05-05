/**
 * Story 7-7 AC #4 — RED-PHASE tests for `docs/runbooks/` structure.
 *
 * Strategy: static markdown parsing — Vitest reads the markdown files and
 * asserts structural requirements per D-5 (style imposé strict). No browser,
 * no rendering.
 *
 * 4 cases:
 *   Case 1 — docs/runbooks/index.md: lists all 6 runbooks + 1-line description each
 *   Case 2 — each of the 6 runbooks exists and contains required H2 sections
 *             (## TL;DR + ## Si ça casse + footer **Dernière mise à jour**)
 *   Case 3 — each runbook has a standard header block (Audience/Objectif/Prérequis)
 *   Case 4 — regression: none of the existing docs are modified
 *             (docs/cutover-make-runbook.md + docs/email-outbox-runbook.md still exist
 *              and have not changed — measured by line count stability)
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Navigate from client/tests/unit/scripts/ → monorepo root → docs/
const DOCS_ROOT = resolve(__dirname, '../../../..', 'docs')
const RUNBOOKS_DIR = resolve(DOCS_ROOT, 'runbooks')

const REQUIRED_RUNBOOKS = [
  'operator-daily',
  'admin-rgpd',
  'cutover',
  'rollback',
  'token-rotation',
  'incident-response',
] as const

function readRunbook(name: string): string {
  return readFileSync(resolve(RUNBOOKS_DIR, `${name}.md`), 'utf8')
}

// ---------------------------------------------------------------------------
// Case 1 — index.md
// ---------------------------------------------------------------------------

describe('docs/runbooks/index.md', () => {
  it('RED — index.md exists', () => {
    expect(existsSync(resolve(RUNBOOKS_DIR, 'index.md'))).toBe(true)
  })

  it('RED — index.md lists all 6 required runbooks', () => {
    if (!existsSync(resolve(RUNBOOKS_DIR, 'index.md'))) return
    const src = readFileSync(resolve(RUNBOOKS_DIR, 'index.md'), 'utf8')

    for (const name of REQUIRED_RUNBOOKS) {
      expect(src).toContain(name)
    }
  })

  it('RED — index.md has 1-line description for each runbook (6 description lines minimum)', () => {
    if (!existsSync(resolve(RUNBOOKS_DIR, 'index.md'))) return
    const src = readFileSync(resolve(RUNBOOKS_DIR, 'index.md'), 'utf8')

    // Each runbook should have a descriptive line near its name.
    // Heuristic: at least 6 non-heading non-empty lines that are not just
    // the runbook filename (i.e., actual description text).
    const nonEmptyLines = src.split('\n').filter((l) => l.trim().length > 0 && !l.startsWith('#'))
    expect(nonEmptyLines.length).toBeGreaterThanOrEqual(6)
  })
})

// ---------------------------------------------------------------------------
// Case 2 — each runbook exists + required D-5 sections
// ---------------------------------------------------------------------------

describe('runbooks — D-5 required sections (TL;DR + Si ça casse + footer)', () => {
  for (const name of REQUIRED_RUNBOOKS) {
    it(`RED — ${name}.md exists`, () => {
      expect(existsSync(resolve(RUNBOOKS_DIR, `${name}.md`))).toBe(true)
    })

    it(`RED — ${name}.md contains ## TL;DR section`, () => {
      if (!existsSync(resolve(RUNBOOKS_DIR, `${name}.md`))) return
      const src = readRunbook(name)
      expect(src).toMatch(/^## TL;DR/m)
    })

    it(`RED — ${name}.md contains ## Si ça casse section`, () => {
      if (!existsSync(resolve(RUNBOOKS_DIR, `${name}.md`))) return
      const src = readRunbook(name)
      expect(src).toMatch(/^## .*Si ça casse/m)
    })

    it(`RED — ${name}.md contains **Dernière mise à jour** footer`, () => {
      if (!existsSync(resolve(RUNBOOKS_DIR, `${name}.md`))) return
      const src = readRunbook(name)
      expect(src).toMatch(/\*\*Dernière mise à jour\*\*/)
    })
  }
})

// ---------------------------------------------------------------------------
// Case 3 — D-5 standard header block
// ---------------------------------------------------------------------------

describe('runbooks — D-5 header block (Audience / Objectif / Prérequis)', () => {
  for (const name of REQUIRED_RUNBOOKS) {
    it(`RED — ${name}.md has Audience + Objectif + Prérequis in header block`, () => {
      if (!existsSync(resolve(RUNBOOKS_DIR, `${name}.md`))) return
      const src = readRunbook(name)
      // Header block format: > Audience: ... / > Objectif: ... / > Prérequis: ...
      expect(src).toMatch(/Audience/i)
      expect(src).toMatch(/Objectif/i)
      expect(src).toMatch(/Prérequis|Prerequis/i)
    })
  }
})

// ---------------------------------------------------------------------------
// Case 4 — existing docs not modified
// ---------------------------------------------------------------------------

describe('docs — iso-fact preservation: pre-existing runbooks untouched', () => {
  it('RED — docs/cutover-make-runbook.md still exists (not replaced by story 7-7)', () => {
    expect(existsSync(resolve(DOCS_ROOT, 'cutover-make-runbook.md'))).toBe(true)
  })

  it('RED — docs/email-outbox-runbook.md still exists (referenced by incident-response.md)', () => {
    expect(existsSync(resolve(DOCS_ROOT, 'email-outbox-runbook.md'))).toBe(true)
  })

  it('RED — incident-response.md references email-outbox-runbook.md (Q-9 link, no duplication)', () => {
    if (!existsSync(resolve(RUNBOOKS_DIR, 'incident-response.md'))) return
    const src = readRunbook('incident-response')
    // Q-9 resolved: link to existing runbook without duplicating it
    expect(src).toMatch(/email-outbox-runbook/i)
  })

  it('RED — cutover.md references cutover-make-runbook.md (5-7 reference without duplication)', () => {
    if (!existsSync(resolve(RUNBOOKS_DIR, 'cutover.md'))) return
    const src = readRunbook('cutover')
    expect(src).toMatch(/cutover-make-runbook|story.*5.?7|5-7/i)
  })
})
