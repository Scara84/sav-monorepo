import { describe, it, expect } from 'vitest'

/**
 * Story 7-5 AC #6 — RED-PHASE tests pour `pilotage.ts` extension Story 7-5 :
 *   - Set `ALLOWED_OPS` étendu avec 3 nouvelles ops (audit-trail-list,
 *     erp-queue-list, erp-push-retry).
 *   - Set `ADMIN_ONLY_OPS` étendu avec ces 3 ops (D-7 defense-in-depth).
 *   - Dispatch route les 3 ops vers les nouveaux handlers.
 *   - vercel.json : 3 nouvelles rewrites SANS nouveau function entry
 *     (slots EXACT 12 — invariant Vercel Hobby cap, cohérent 7-4).
 *   - Ordre rewrites : `/api/admin/erp-queue/:id/retry` DOIT précéder
 *     `/api/admin/erp-queue` (sinon Vercel match `:id='retry'` perdu).
 *   - Régression D-9 : ALLOWED_OPS Stories 5.5, 7-3a/b/c, 7-4 restent intactes.
 *
 * Pattern lightweight (lecture statique du source) — pas de runtime
 * dispatch (déjà couvert par les tests unitaires handlers).
 *
 * IMPORTANT : pas de duplication des assertions Stories 7-3a/b/c/7-4 —
 * ce fichier ajoute UNIQUEMENT les assertions Story 7-5 + régressions
 * critiques.
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

describe('pilotage.ts — Story 7-5 extensions (AC #6)', () => {
  it('ALLOWED_OPS + ADMIN_ONLY_OPS contiennent les 3 nouvelles ops 7-5 (D-7)', () => {
    const src = readPilotage()
    // ALLOWED_OPS : ops listées (présence brute dans le fichier).
    expect(src).toContain("'admin-audit-trail-list'")
    expect(src).toContain("'admin-erp-queue-list'")
    expect(src).toContain("'admin-erp-push-retry'")

    // ADMIN_ONLY_OPS : les 3 ops doivent figurer dans le bloc ADMIN_ONLY_OPS
    // (defense-in-depth D-7). Multi-line regex pour matcher la déclaration.
    expect(src).toMatch(/ADMIN_ONLY_OPS[\s\S]*?'admin-audit-trail-list'/m)
    expect(src).toMatch(/ADMIN_ONLY_OPS[\s\S]*?'admin-erp-queue-list'/m)
    expect(src).toMatch(/ADMIN_ONLY_OPS[\s\S]*?'admin-erp-push-retry'/m)

    // Dispatch : le router doit référencer les 3 handlers (par nom de fichier
    // OU symbole exporté).
    expect(src).toMatch(/adminAuditTrailListHandler|audit-trail-list-handler/)
    expect(src).toMatch(/adminErpQueueListHandler|erp-queue-list-handler/)
    expect(src).toMatch(/adminErpPushRetryHandler|erp-push-retry-handler/)
  })

  it('vercel.json — 3 nouvelles rewrites Story 7-5 ajoutées + ordre :id/retry AVANT base', () => {
    const cfg = readVercelConfig()
    const sources = cfg.rewrites.map((r) => r.source)

    // Présence des 3 rewrites Story 7-5.
    expect(sources).toContain('/api/admin/audit-trail')
    expect(sources).toContain('/api/admin/erp-queue/:id/retry')
    expect(sources).toContain('/api/admin/erp-queue')

    // Ordre critique : /api/admin/erp-queue/:id/retry DOIT précéder
    // /api/admin/erp-queue (sinon Vercel match `:id='retry'` perdu).
    const idxRetry = sources.indexOf('/api/admin/erp-queue/:id/retry')
    const idxList = sources.indexOf('/api/admin/erp-queue')
    expect(idxRetry).toBeGreaterThan(-1)
    expect(idxList).toBeGreaterThan(-1)
    expect(idxRetry).toBeLessThan(idxList)

    // Les 3 rewrites pointent bien vers /api/pilotage avec le bon op.
    const auditRewrite = cfg.rewrites.find((r) => r.source === '/api/admin/audit-trail')
    expect(auditRewrite?.destination).toContain('op=admin-audit-trail-list')
    const erpListRewrite = cfg.rewrites.find((r) => r.source === '/api/admin/erp-queue')
    expect(erpListRewrite?.destination).toContain('op=admin-erp-queue-list')
    const retryRewrite = cfg.rewrites.find((r) => r.source === '/api/admin/erp-queue/:id/retry')
    expect(retryRewrite?.destination).toContain('op=admin-erp-push-retry')
    expect(retryRewrite?.destination).toContain('id=:id')
  })

  it('vercel.json — function entries reste EXACT 12 (invariant Hobby cap, héritage 7-4)', () => {
    const cfg = readVercelConfig()
    expect(Object.keys(cfg.functions)).toHaveLength(12)
  })

  it('D-9 régression : ALLOWED_OPS Stories 5.5/7-3a/b/c/7-4 restent intactes', () => {
    const src = readPilotage()
    // Story 5.5 (admin settings threshold).
    expect(src).toContain("'admin-settings-threshold-patch'")
    expect(src).toContain("'admin-settings-threshold-history'")
    // Story 7-3a (operators CRUD).
    expect(src).toMatch(/'admin-operators?-list'/)
    expect(src).toMatch(/'admin-operator-(create|update)'/)
    // Story 7-3b (catalog/products).
    expect(src).toMatch(/'admin-products?-list'/)
    // Story 7-3c (validation lists).
    expect(src).toMatch(/'admin-validation-lists?-list'/)
    // Story 7-4 (settings versionnés).
    expect(src).toContain("'admin-settings-list'")
    expect(src).toContain("'admin-setting-rotate'")
    expect(src).toContain("'admin-setting-history'")
  })
})
