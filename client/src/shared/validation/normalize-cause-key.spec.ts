import { describe, it, expect } from 'vitest'
import { normalizeCauseKey } from './normalize-cause-key'

/**
 * FR12 fix (Sprint Change Proposal 2026-06-05) — helper de clé motif normalisée.
 * Le bug : capture stocke un SLUG (`abime`), validation_lists keyé sur LIBELLÉ (`Abîmé`).
 * Garantie testée : normalizeCauseKey(slug) === normalizeCauseKey(libellé) pour les
 * motifs réels, et aucune collision sur les 10 motifs sav_cause.
 */
describe('normalizeCauseKey (FR12)', () => {
  it('NCK-01: libellé accentué → slug (Abîmé → abime)', () => {
    expect(normalizeCauseKey('Abîmé')).toBe('abime')
  })

  it('NCK-02: slug déjà normalisé → inchangé (idempotent)', () => {
    expect(normalizeCauseKey('abime')).toBe('abime')
    expect(normalizeCauseKey(normalizeCauseKey('Abîmé'))).toBe('abime')
  })

  it('NCK-03: symétrie slug ↔ libellé pour les 3 motifs du form capture', () => {
    expect(normalizeCauseKey('Abîmé')).toBe(normalizeCauseKey('abime'))
    expect(normalizeCauseKey('Manquant')).toBe(normalizeCauseKey('manquant'))
    expect(normalizeCauseKey('Autre')).toBe(normalizeCauseKey('autre'))
  })

  it('NCK-04: casse + espaces de bord normalisés', () => {
    expect(normalizeCauseKey('  ABÎMÉ  ')).toBe('abime')
    expect(normalizeCauseKey('Trop mûr')).toBe('trop mur')
    expect(normalizeCauseKey('Trop  mûr')).toBe('trop mur') // espaces internes collapsés
  })

  it('NCK-05: aucune collision sur les 10 motifs sav_cause (libellés réels)', () => {
    const labels = [
      'Abîmé', 'Pourri', 'Sec', 'Vert', 'Trop mûr',
      'Petit calibre', 'Gros calibre', 'Manquant', 'Erreur variété', 'Autre',
    ]
    const keys = labels.map(normalizeCauseKey)
    expect(new Set(keys).size).toBe(labels.length) // 10 clés distinctes
  })

  it('NCK-06: les 3 slugs réels matchent leur libellé sav_cause attendu', () => {
    // Reproduit le contrat de jointure du fix : slug stocké ↔ libellé référentiel.
    const pairs: Array<[string, string]> = [
      ['abime', 'Abîmé'],
      ['manquant', 'Manquant'],
      ['autre', 'Autre'],
    ]
    for (const [slug, label] of pairs) {
      expect(normalizeCauseKey(slug)).toBe(normalizeCauseKey(label))
    }
  })
})
