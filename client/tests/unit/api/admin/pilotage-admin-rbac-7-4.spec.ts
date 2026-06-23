import { describe, it, expect } from 'vitest'

/**
 * Story 7-4 AC #5 + AC #6 — RED-PHASE tests pour `pilotage.ts` extension :
 *   - Set `ADMIN_ONLY_OPS` étendu avec 3 nouvelles ops Story 7-4
 *   - `ALLOWED_OPS` étendu avec ces ops
 *   - Dispatch route les 3 ops vers les nouveaux handlers
 *   - vercel.json : 2 nouvelles rewrites SANS nouveau function entry
 *     (slots EXACT 12 — invariant Vercel Hobby cap)
 *   - Régression Stories 5.5/7-3a/7-3b/7-3c : ops existantes restent listées
 *
 * Pattern lightweight (pas de runtime dispatch — couvert par tests
 * unitaires handlers + smoke E2E). Inspecte le source du router.
 *
 * IMPORTANT : pas de duplication de la spec `pilotage-admin-rbac.spec.ts`
 * (Story 7-3a) — ce fichier ajoute UNIQUEMENT les assertions Story 7-4.
 * Les régressions 5.5/7-3a/7-3b/7-3c sont déjà couvertes par le spec 7-3a
 * (et restent vertes baseline 1398).
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

describe('pilotage.ts — Story 7-4 extensions (AC #5 + AC #6)', () => {
  it('ALLOWED_OPS contient les 3 nouvelles ops admin-settings 7-4', () => {
    const src = readPilotage()
    expect(src).toContain("'admin-settings-list'")
    expect(src).toContain("'admin-setting-rotate'")
    expect(src).toContain("'admin-setting-history'")
  })

  it('ADMIN_ONLY_OPS inclut les 3 nouvelles ops 7-4 (defense-in-depth D-10)', () => {
    const src = readPilotage()
    expect(src).toMatch(/ADMIN_ONLY_OPS[\s\S]*?'admin-settings-list'/m)
    expect(src).toMatch(/ADMIN_ONLY_OPS[\s\S]*?'admin-setting-rotate'/m)
    expect(src).toMatch(/ADMIN_ONLY_OPS[\s\S]*?'admin-setting-history'/m)
  })

  it('dispatch route les 3 ops vers les handlers 7-4', () => {
    const src = readPilotage()
    expect(src).toMatch(/adminSettingsListHandler|settings-list-handler/)
    expect(src).toMatch(/adminSettingRotateHandler|setting-rotate-handler/)
    expect(src).toMatch(/adminSettingHistoryHandler|setting-history-handler/)
  })

  it('D-9 backward-compat : ops Story 5.5 admin-settings-threshold-* restent listées', () => {
    // Régression : la décision D-9 préserve les handlers Story 5.5 existants.
    // Si ce test casse, c'est qu'on a refactoré prématurément (hors scope V1).
    const src = readPilotage()
    expect(src).toContain("'admin-settings-threshold-patch'")
    expect(src).toContain("'admin-settings-threshold-history'")
  })

  it('vercel.json — 2 nouvelles rewrites Story 7-4 ajoutées', () => {
    const cfg = readVercelConfig()
    const sources = cfg.rewrites.map((r) => r.source)
    // Rewrite list générique (op admin-settings-list).
    expect(sources).toContain('/api/admin/settings')
    // Rewrite history (op admin-setting-history) — DOIT précéder /api/admin/settings/:key
    // pour que Vercel matche history en 1er sur `:key='X'/history`.
    expect(sources).toContain('/api/admin/settings/:key/history')
    // Rewrite rotate générique (op admin-setting-rotate).
    expect(sources).toContain('/api/admin/settings/:key')
  })

  it('vercel.json — function entries reste EXACT 12 (invariant Hobby cap)', () => {
    const cfg = readVercelConfig()
    expect(Object.keys(cfg.functions)).toHaveLength(12)
  })

  it('vercel.json — ordre rewrites : history AVANT :key générique (Q-2 OQ)', () => {
    // Vercel matche les rewrites séquentiellement. Si /api/admin/settings/:key
    // est listée avant /api/admin/settings/:key/history, Vercel matchera
    // `:key='threshold_alert'` avec leftover `/history` perdu. L'ordre
    // structurel doit être : history > :key > base.
    const cfg = readVercelConfig()
    const sources = cfg.rewrites.map((r) => r.source)
    const idxHistory = sources.indexOf('/api/admin/settings/:key/history')
    const idxKey = sources.indexOf('/api/admin/settings/:key')
    expect(idxHistory).toBeGreaterThan(-1)
    expect(idxKey).toBeGreaterThan(-1)
    expect(idxHistory).toBeLessThan(idxKey)
  })

  it('D-9 régression : rewrite Story 5.5 /api/admin/settings/threshold_alert reste intacte', () => {
    // L'ordre matters : la rewrite spécifique 5.5 (threshold_alert)
    // DOIT précéder la rewrite générique 7-4 (`:key`) pour préserver
    // le comportement legacy (D-9 backward-compat).
    const cfg = readVercelConfig()
    const sources = cfg.rewrites.map((r) => r.source)
    expect(sources).toContain('/api/admin/settings/threshold_alert')
    expect(sources).toContain('/api/admin/settings/threshold_alert/history')
    const idxLegacyPatch = sources.indexOf('/api/admin/settings/threshold_alert')
    const idxGenericKey = sources.indexOf('/api/admin/settings/:key')
    expect(idxLegacyPatch).toBeLessThan(idxGenericKey)
  })
})
