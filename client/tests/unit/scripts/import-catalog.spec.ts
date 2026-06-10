/**
 * Tests unitaires pour `scripts/cutover/import-catalog.ts` (Story 2.1).
 *
 * Scope :
 *   - `normalizeRow` : validation déterministe de chaque cas du mapping Excel → products
 *     (AC #14). Rapide, sans dépendance externe.
 *   - `importCatalog` intégration locale : gated sur `SUPABASE_SERVICE_ROLE_KEY` +
 *     `SUPABASE_URL` (exécuté en local avec Supabase up, pas en CI).
 *
 * Le comptage effectif est **864 produits + 18 catégories-séparateurs** (pas 865/17
 * comme écrit dans l'AC #15 Story 2.1) — la ligne Excel 385 a un `code='x'` (string,
 * pas int) mais un nom contenant `CATEGORIE : KEFIRS...`. Le filtre se base sur le
 * nom, pas sur le type du code — voir Completion Notes Story 2.1 pour la déviation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import path from 'node:path'
import { existsSync } from 'node:fs'

// Mock supabase-admin pour isoler les tests de normalizeRow de l'env Supabase.
const dbState = vi.hoisted(() => ({
  upsertCalls: [] as unknown[][],
  upsertError: null as { message: string } | null,
}))

vi.mock('../../../api/_lib/clients/supabase-admin', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      upsert: (batch: unknown[]) => {
        dbState.upsertCalls.push(batch)
        return Promise.resolve({ error: dbState.upsertError })
      },
    }),
  }),
}))

// Re-imports après les mocks.
import { importCatalog } from '../../../scripts/cutover/import-catalog'

// `data.xlsx` est l'export réel de gestion, non tracké par git (_bmad-input/
// gitignoré) et rafraîchi périodiquement : absent en CI, comptage mouvant en
// local (864 au ground-truth 2026-04-21, 838 au refresh 2026-05-21). On gate
// la suite sur sa présence et on asserte des invariants dérivés du summary
// plutôt que des comptages figés.
const xlsxPath = path.resolve(__dirname, '../../../../_bmad-input/excel-gestion/data.xlsx')

describe.skipIf(!existsSync(xlsxPath))('importCatalog — fixture réelle data.xlsx', () => {
  beforeEach(() => {
    dbState.upsertCalls = []
    dbState.upsertError = null
  })

  it('parse data.xlsx BDD avec un comptage cohérent (mock DB)', async () => {
    const summary = await importCatalog(xlsxPath)

    // L'export contient ~850 produits + ~18 lignes CATEGORIE séparatrices
    // (filtrées par nom, pas par type de code — cf. Completion Notes Story 2.1).
    expect(summary.imported).toBeGreaterThan(500)
    expect(summary.skippedCategory).toBeGreaterThan(0)
    expect(summary.skippedInvalidUnit).toBe(0)
    expect(summary.errors).toHaveLength(0)

    // Tous les produits ont supplier_code='RUFINO'.
    const allRows = dbState.upsertCalls.flat() as Array<{
      supplier_code: string
      default_unit: string
      vat_rate_bp: number
      tier_prices: unknown[]
    }>
    expect(allRows).toHaveLength(summary.imported)
    expect(allRows.every((r) => r.supplier_code === 'RUFINO')).toBe(true)
    expect(allRows.every((r) => ['piece', 'kg', 'liter'].includes(r.default_unit))).toBe(true)
    expect(allRows.every((r) => r.vat_rate_bp >= 0)).toBe(true)
    expect(allRows.every((r) => Array.isArray(r.tier_prices) && r.tier_prices.length === 0)).toBe(
      true
    )
  })

  it('batch UPSERT par 100', async () => {
    const summary = await importCatalog(xlsxPath)

    const expectedBatches = Math.ceil(summary.imported / 100)
    expect(dbState.upsertCalls).toHaveLength(expectedBatches)
    expect(dbState.upsertCalls.slice(0, -1).every((b) => b.length === 100)).toBe(true)
    expect(dbState.upsertCalls[expectedBatches - 1]).toHaveLength(summary.imported % 100 || 100)
  })

  it('propage les erreurs UPSERT Supabase', async () => {
    dbState.upsertError = { message: 'mock RLS blocked' }
    await expect(importCatalog(xlsxPath)).rejects.toThrow(/mock RLS blocked/)
  })
})
