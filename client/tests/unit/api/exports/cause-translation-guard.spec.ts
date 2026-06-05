import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * FR12 guard (H-2 du CR adversarial) — empêche la RÉ-INTRODUCTION du bug motif.
 *
 * Le bug (slug stocké `abime` vs libellé référentiel `Abîmé`) a survécu 1+ mois sur
 * reconcile + Rufino + Martinez précisément parce que le lookup direct
 * `list[causeRaw]` "marchait" en test (fixtures = libellés) mais jamais en prod.
 *
 * Ce guard statique impose : tout export config qui traduit `sav_cause` DOIT passer
 * par `resolveTranslatedCause` (clé normalisée) et NE DOIT PAS faire de lookup direct
 * indexé sur le sous-map de traduction.
 */
const EXPORTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../api/_lib/exports',
)

function configFiles(): string[] {
  return readdirSync(EXPORTS_DIR).filter((f) => /Config\.ts$/.test(f))
}

describe('FR12 guard — résolution motif via clé normalisée partagée', () => {
  it('au moins 2 configs export existent (rufino + martinez)', () => {
    const files = configFiles()
    expect(files).toContain('rufinoConfig.ts')
    expect(files).toContain('martinezConfig.ts')
  })

  it('tout config qui référence sav_cause importe resolveTranslatedCause', () => {
    for (const f of configFiles()) {
      const src = readFileSync(join(EXPORTS_DIR, f), 'utf8')
      if (src.includes("'sav_cause'")) {
        expect(
          src.includes('resolve-cause-translation'),
          `${f} traduit sav_cause sans importer resolveTranslatedCause (FR12)`,
        ).toBe(true)
      }
    }
  })

  it('aucun lookup direct indexé list[cause...] / translations[...][cause...] dans les configs (FR12)', () => {
    // Motif interdit : accès indexé par une variable de cause brute, qui contourne
    // la normalisation. Ex. `list[causeFr]`, `list[causeRaw]`, `translations['sav_cause'][causeRaw]`.
    const forbidden = /\[\s*cause[A-Za-z]*\s*\]/
    for (const f of configFiles()) {
      const src = readFileSync(join(EXPORTS_DIR, f), 'utf8')
      expect(
        forbidden.test(src),
        `${f} contient un lookup direct indexé par la cause (contourne resolveTranslatedCause / FR12)`,
      ).toBe(false)
    }
  })
})
