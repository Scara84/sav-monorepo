import { describe, it, expect } from 'vitest'

/**
 * Story 7-7 AC #6 — RED-PHASE tests (garde-fous Vercel slots + régression).
 *
 * Story 7-7 = pure ops + docs. AUCUN nouveau handler API, AUCUNE nouvelle op,
 * AUCUNE nouvelle rewrite Vercel. Les tests vérifient que le baseline 7-6 est
 * préservé EXACT :
 *   1. vercel.json functions count == 12 EXACT (snapshot baseline 7-6).
 *   2. pilotage.ts ALLOWED_OPS count inchangé vs baseline 7-6 (30 ops total).
 *   3. Régression complète : toutes les ops Stories 5.5/7-3a/b/c/7-4/7-5/7-6
 *      restent présentes (iso-fact preservation).
 *
 * Cohérent avec pattern pilotage-admin-rbac-7-6.spec.ts (lecture statique source).
 * Pas de nouvelles ops ni rewrites à tester — ce fichier est un "green guard"
 * vérifiant que story 7-7 n'a pas accidentellement modifié pilotage.ts / vercel.json.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PILOTAGE_PATH = resolve(__dirname, '../../../../api/pilotage.ts')
const VERCEL_PATH = resolve(__dirname, '../../../../vercel.json')

function readPilotage(): string {
  return readFileSync(PILOTAGE_PATH, 'utf8')
}

interface VercelConfig {
  functions: Record<string, unknown>
  rewrites: Array<{ source: string; destination: string }>
}

function readVercelConfig(): VercelConfig {
  return JSON.parse(readFileSync(VERCEL_PATH, 'utf8')) as VercelConfig
}

describe('pilotage.ts + vercel.json — Story 7-7 iso-fact preservation (AC #6)', () => {
  it('GREEN guard — vercel.json functions count == 12 EXACT (snapshot baseline 7-6, unchanged by 7-7)', () => {
    const cfg = readVercelConfig()
    // Story 7-7 = pure docs/scripts: 0 new function entries
    expect(Object.keys(cfg.functions)).toHaveLength(12)
  })

  it('GREEN guard — pilotage.ts ALLOWED_OPS count == 29 EXACT (baseline 7-6, unchanged by 7-7)', () => {
    const src = readPilotage()
    // Count single-quoted op strings inside ALLOWED_OPS set literal.
    // The ALLOWED_OPS Set contains exactly 29 string entries as of Story 7-6:
    //   9 core (export-supplier/history/download/config-list/cost-timeline/
    //            top-products/delay-distribution/top-reasons-suppliers/export-csv)
    // + 2 threshold (admin-settings-threshold-patch/history)
    // + 3 operators (admin-operators-list/create/update)
    // + 4 products  (admin-products-list/create/update/delete)
    // + 3 vl-crud   (admin-validation-lists-list/create/update)
    // + 3 settings  (admin-settings-list/rotate/history)
    // + 3 audit-erp (admin-audit-trail-list/erp-queue-list/erp-push-retry)
    // + 2 rgpd      (admin-rgpd-export/admin-member-anonymize)
    // = 29 total. Story 7-7 adds 0 → must stay 29.
    const allowedOpsMatch = src.match(/const ALLOWED_OPS = new Set\(\[([\s\S]*?)\]\)/)
    expect(allowedOpsMatch).not.toBeNull()

    const opsBlock = allowedOpsMatch![1]!
    // Count 'op-name' entries (single-quoted identifiers, excluding comments)
    const opEntries = opsBlock.match(/'[a-z][a-z0-9-]*'/g) ?? []
    // Baseline 7-6 = 29 ops.
    // If this count changes, story 7-7 has accidentally modified pilotage.ts
    expect(opEntries.length).toBe(29)
  })

  it('GREEN guard — all Story 7-6 ops still present (regression check)', () => {
    const src = readPilotage()
    // Story 7-6 ops (the last additions before 7-7)
    expect(src).toContain("'admin-rgpd-export'")
    expect(src).toContain("'admin-member-anonymize'")

    // Story 7-5 ops
    expect(src).toContain("'admin-audit-trail-list'")
    expect(src).toContain("'admin-erp-queue-list'")
    expect(src).toContain("'admin-erp-push-retry'")

    // Story 7-4 ops
    expect(src).toContain("'admin-settings-list'")
    expect(src).toContain("'admin-setting-rotate'")
    expect(src).toContain("'admin-setting-history'")

    // Story 7-3c ops
    expect(src).toContain("'admin-validation-lists-list'")

    // Story 7-3b ops
    expect(src).toContain("'admin-products-list'")

    // Story 7-3a ops
    expect(src).toContain("'admin-operators-list'")

    // Story 5.5 ops
    expect(src).toContain("'admin-settings-threshold-patch'")
    expect(src).toContain("'admin-settings-threshold-history'")
  })

  it('GREEN guard — vercel.json contains no new Story 7-7 rewrites (pure ops story = 0 new routes)', () => {
    // Story 7-7 touches zero API routes → the rewrite list from 7-6 baseline
    // must be preserved without additions.
    const cfg = readVercelConfig()

    // Sanity: 7-6 rewrites still present (no regression removal either)
    const sources = cfg.rewrites.map((r) => r.source)
    expect(sources).toContain('/api/admin/members/:id/rgpd-export')
    expect(sources).toContain('/api/admin/members/:id/anonymize')

    // No 7-7 specific rewrites exist (story is pure ops — this assertion
    // will fail if a future developer accidentally adds an API route in 7-7)
    const story77Rewrites = sources.filter(
      (s) => s.includes('/api/cutover') || s.includes('/api/rollback') || s.includes('/api/dpia')
    )
    expect(story77Rewrites).toHaveLength(0)
  })
})
