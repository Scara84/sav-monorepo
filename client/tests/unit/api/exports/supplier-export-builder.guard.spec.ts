import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

/**
 * Story 5.1 AC #11 — Genericity enforcement (FR36).
 *
 * Le builder générique doit rester agnostique : zéro référence hardcodée
 * à un fournisseur spécifique. Ce test verrouille le principe FR36 en CI.
 * Si un dev ajoute `if (supplier === 'RUFINO')` ou équivalent dans le
 * builder, la CI casse immédiatement (Story 5.6 valide empiriquement
 * que l'ajout MARTINEZ ne passe QUE par un nouveau `<supplier>Config.ts`).
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const BUILDER_PATH = resolve(__dirname, '../../../../api/_lib/exports/supplierExportBuilder.ts')

describe('supplierExportBuilder.ts — genericity guard (FR36)', () => {
  const source = readFileSync(BUILDER_PATH, 'utf8')

  it('contient zéro référence hardcodée à un fournisseur', () => {
    // Case-insensitive : attrape RUFINO, rufino, Rufino, MARTINEZ, etc.
    // Word boundary pour éviter les faux-positifs ("surufino" etc.).
    expect(source).not.toMatch(/\brufino\b/i)
    expect(source).not.toMatch(/\bmartinez\b/i)
  })

  it("ne contient pas d'enum fournisseur hardcodé", () => {
    // Pas de type union qui fige la liste des fournisseurs V1.
    // Un mot clé `SupplierCode = 'RUFINO' | 'MARTINEZ'` casserait FR36.
    expect(source).not.toMatch(/['"](RUFINO|MARTINEZ)['"]/)
  })

  it("n'importe jamais rufinoConfig / martinezConfig", () => {
    expect(source).not.toMatch(/import[^\n]*rufinoConfig/i)
    expect(source).not.toMatch(/import[^\n]*martinezConfig/i)
  })
})
