import { describe, it, expect } from 'vitest'

/**
 * Story 7-6 AC #6 — RED-PHASE tests pour `pilotage.ts` extension Story 7-6 :
 *   - Set `ALLOWED_OPS` étendu avec 2 nouvelles ops (admin-rgpd-export,
 *     admin-member-anonymize).
 *   - Set `ADMIN_ONLY_OPS` étendu avec ces 2 ops (D-8 defense-in-depth).
 *   - Dispatch route les 2 ops vers les nouveaux handlers.
 *   - vercel.json : 2 nouvelles rewrites SANS nouveau function entry
 *     (slots EXACT 12 — invariant Vercel Hobby cap, cohérent 7-4/7-5).
 *   - Régression : ALLOWED_OPS Stories 5.5/7-3a/b/c/7-4/7-5 restent intactes.
 *
 * Pattern lightweight (lecture statique du source) — pas de runtime
 * dispatch (déjà couvert par les tests unitaires handlers).
 *
 * 3 cas (cohérent story spec Sub-4) :
 *   1. RED : ALLOWED_OPS + ADMIN_ONLY_OPS contiennent les 2 nouvelles ops 7-6
 *      + dispatch référence les 2 nouveaux handlers + vercel.json contient
 *      les 2 nouvelles rewrites avec destination canonique.
 *   2. GREEN : functions count = 12 EXACT (invariant Vercel Hobby).
 *   3. GREEN régression : ALLOWED_OPS Stories 5.5/7-3a/b/c/7-4/7-5 intactes.
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

describe('pilotage.ts — Story 7-6 extensions (AC #6)', () => {
  it('RED — ALLOWED_OPS + ADMIN_ONLY_OPS contiennent les 2 nouvelles ops 7-6 (D-8) + rewrites', () => {
    const src = readPilotage()
    // ALLOWED_OPS : ops listées (présence brute dans le fichier).
    expect(src).toContain("'admin-rgpd-export'")
    expect(src).toContain("'admin-member-anonymize'")

    // ADMIN_ONLY_OPS : les 2 ops doivent figurer dans le bloc ADMIN_ONLY_OPS
    // (defense-in-depth D-8). Multi-line regex pour matcher la déclaration.
    expect(src).toMatch(/ADMIN_ONLY_OPS[\s\S]*?'admin-rgpd-export'/m)
    expect(src).toMatch(/ADMIN_ONLY_OPS[\s\S]*?'admin-member-anonymize'/m)

    // Dispatch : le router doit référencer les 2 handlers (par nom de fichier
    // OU symbole exporté).
    expect(src).toMatch(/adminRgpdExportHandler|rgpd-export-handler/)
    expect(src).toMatch(/adminMemberAnonymizeHandler|member-anonymize-handler/)

    // vercel.json — 2 nouvelles rewrites Story 7-6.
    const cfg = readVercelConfig()
    const sources = cfg.rewrites.map((r) => r.source)
    expect(sources).toContain('/api/admin/members/:id/rgpd-export')
    expect(sources).toContain('/api/admin/members/:id/anonymize')

    // Destinations canoniques.
    const exportRewrite = cfg.rewrites.find(
      (r) => r.source === '/api/admin/members/:id/rgpd-export'
    )
    expect(exportRewrite?.destination).toContain('op=admin-rgpd-export')
    expect(exportRewrite?.destination).toContain('id=:id')
    const anonRewrite = cfg.rewrites.find((r) => r.source === '/api/admin/members/:id/anonymize')
    expect(anonRewrite?.destination).toContain('op=admin-member-anonymize')
    expect(anonRewrite?.destination).toContain('id=:id')
  })

  it('GREEN régression — vercel.json function entries reste EXACT 12 (invariant Hobby cap, héritage 7-4/7-5)', () => {
    const cfg = readVercelConfig()
    expect(Object.keys(cfg.functions)).toHaveLength(12)
  })

  it('GREEN régression — ALLOWED_OPS Stories 5.5/7-3a/b/c/7-4/7-5 restent intactes', () => {
    const src = readPilotage()
    // Story 5.5
    expect(src).toContain("'admin-settings-threshold-patch'")
    expect(src).toContain("'admin-settings-threshold-history'")
    // Story 7-3a (operators CRUD)
    expect(src).toMatch(/'admin-operators?-list'/)
    expect(src).toMatch(/'admin-operator-(create|update)'/)
    // Story 7-3b (catalog/products)
    expect(src).toMatch(/'admin-products?-list'/)
    // Story 7-3c (validation lists)
    expect(src).toMatch(/'admin-validation-lists?-list'/)
    // Story 7-4 (settings versionnés)
    expect(src).toContain("'admin-settings-list'")
    expect(src).toContain("'admin-setting-rotate'")
    expect(src).toContain("'admin-setting-history'")
    // Story 7-5 (audit-trail + erp-queue)
    expect(src).toContain("'admin-audit-trail-list'")
    expect(src).toContain("'admin-erp-queue-list'")
    expect(src).toContain("'admin-erp-push-retry'")
  })
})
