import { describe, it, expect } from 'vitest'

/**
 * Story 7-3a AC #4 — RED-PHASE tests pour `pilotage.ts` extension :
 *   - Set `ADMIN_ONLY_OPS` listant les ops admin (Story 5.5 + 7-3a)
 *   - Helper inline `requireAdminRole(req, res, requestId): boolean`
 *   - Dispatch routes les 3 nouvelles ops `admin-operators-*` vers handlers
 *
 * Ces tests inspectent le source `client/api/pilotage.ts` pour vérifier
 * la présence des symboles attendus AVANT que les handlers ne soient
 * importés. Pattern lightweight (pas de runtime dispatch — couvert par
 * tests unitaires handlers + smoke E2E).
 *
 * Régression Story 5.5 : les 2 ops `admin-settings-threshold-*` doivent
 * rester listées dans ADMIN_ONLY_OPS (refacto cohérente, cf. Sub-2 Task 1).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PILOTAGE_PATH = resolve(__dirname, '../../../../api/pilotage.ts')

function readPilotage(): string {
  return readFileSync(PILOTAGE_PATH, 'utf8')
}

describe('pilotage.ts — Story 7-3a extensions (AC #4)', () => {
  it('ALLOWED_OPS contient les 3 nouvelles ops admin-operators-*', () => {
    const src = readPilotage()
    expect(src).toMatch(/ALLOWED_OPS\s*=\s*new Set\(\[[\s\S]*?'admin-operators-list'/m)
    expect(src).toContain("'admin-operator-create'")
    expect(src).toContain("'admin-operator-update'")
  })

  it('Set ADMIN_ONLY_OPS déclaré et inclut Story 5.5 + Story 7-3a', () => {
    const src = readPilotage()
    expect(src).toMatch(/ADMIN_ONLY_OPS\s*=\s*new Set\(/)
    // Story 5.5 (régression)
    expect(src).toMatch(/ADMIN_ONLY_OPS[\s\S]*?'admin-settings-threshold-patch'/m)
    expect(src).toMatch(/ADMIN_ONLY_OPS[\s\S]*?'admin-settings-threshold-history'/m)
    // Story 7-3a
    expect(src).toMatch(/ADMIN_ONLY_OPS[\s\S]*?'admin-operators-list'/m)
    expect(src).toMatch(/ADMIN_ONLY_OPS[\s\S]*?'admin-operator-create'/m)
    expect(src).toMatch(/ADMIN_ONLY_OPS[\s\S]*?'admin-operator-update'/m)
  })

  it('helper requireAdminRole déclaré dans pilotage.ts', () => {
    const src = readPilotage()
    expect(src).toMatch(/function\s+requireAdminRole\s*\(/)
    // Le helper doit retourner `false` et envoyer FORBIDDEN/ROLE_NOT_ALLOWED
    expect(src).toContain('ROLE_NOT_ALLOWED')
  })

  it('dispatch appelle requireAdminRole pour les ADMIN_ONLY_OPS avant délégation', () => {
    const src = readPilotage()
    // Pattern attendu : `if (ADMIN_ONLY_OPS.has(op) && !requireAdminRole(...)) return`
    expect(src).toMatch(/ADMIN_ONLY_OPS\.has\(op\)[\s\S]{0,80}requireAdminRole/m)
  })

  it('dispatch route les 3 ops vers les handlers admin operators', () => {
    const src = readPilotage()
    expect(src).toMatch(/adminOperatorsListHandler|operators-list-handler/)
    expect(src).toMatch(/adminOperatorCreateHandler|operator-create-handler/)
    expect(src).toMatch(/adminOperatorUpdateHandler|operator-update-handler/)
  })

  it('vercel.json — 3 rewrites ajoutés et functions count reste = 12', () => {
    const vercelPath = resolve(__dirname, '../../../../vercel.json')
    const cfg = JSON.parse(readFileSync(vercelPath, 'utf8')) as {
      functions: Record<string, unknown>
      rewrites: Array<{ source: string; destination: string }>
    }
    expect(Object.keys(cfg.functions)).toHaveLength(12)
    const sources = cfg.rewrites.map((r) => r.source)
    expect(sources).toContain('/api/admin/operators')
    // PATCH /:id rewrite
    expect(sources).toContain('/api/admin/operators/:id')
  })
})
