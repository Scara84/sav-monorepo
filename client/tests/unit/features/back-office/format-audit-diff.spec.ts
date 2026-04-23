import { describe, it, expect } from 'vitest'
import { formatDiff } from '../../../../src/features/back-office/utils/format-audit-diff'

describe('formatDiff', () => {
  it("action 'created' → phrase 'Création'", () => {
    expect(formatDiff('created', null)).toEqual(['Création'])
  })

  it("action 'deleted' → phrase 'Suppression'", () => {
    expect(formatDiff('deleted', null)).toEqual(['Suppression'])
  })

  it('update status → phrase formatée', () => {
    const out = formatDiff('updated', {
      before: { status: 'received' },
      after: { status: 'in_progress' },
    })
    expect(out).toEqual(['Statut : received → in_progress'])
  })

  it('update multi-champ → une phrase par champ', () => {
    const out = formatDiff('updated', {
      before: { status: 'received', total_amount_cents: 0 },
      after: { status: 'validated', total_amount_cents: 1500 },
    })
    expect(out).toHaveLength(2)
    expect(out[0]).toMatch(/Statut/)
    expect(out[1]).toMatch(/Montant avoir/)
  })

  it('diff vide → "Modification mineure"', () => {
    expect(formatDiff('updated', { before: { x: 1 }, after: { x: 1 } })).toEqual([
      'Modification mineure',
    ])
  })

  it("action inconnue sans diff → retourne l'action brute", () => {
    expect(formatDiff('locked', null)).toEqual(['locked'])
  })

  it('tags array → rendu lisible', () => {
    const out = formatDiff('updated', {
      before: { tags: [] },
      after: { tags: ['urgent'] },
    })
    expect(out[0]).toMatch(/Tags/)
    expect(out[0]).toMatch(/urgent/)
  })
})
