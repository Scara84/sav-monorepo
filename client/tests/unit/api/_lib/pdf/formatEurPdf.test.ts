import { describe, it, expect } from 'vitest'
import { formatEurFromCents, formatDateFr } from '../../../../../api/_lib/pdf/formatEurPdf'

describe('formatEurFromCents (Story 4.5 AC #2)', () => {
  it('1 234,56 € — espace insécable milliers, virgule décimale', () => {
    const out = formatEurFromCents(123456)
    // fr-FR emits \u202f (NARROW NO-BREAK SPACE) as thousand separator in Node 20+.
    expect(out).toMatch(/1[\s\u202f\u00a0]234,56\s?€/)
  })

  it('0 cents → 0,00 € (pas "—")', () => {
    const out = formatEurFromCents(0)
    expect(out).toMatch(/^0,00\s?€$/)
  })

  it('9 cents → 0,09 €', () => {
    expect(formatEurFromCents(9)).toMatch(/^0,09\s?€$/)
  })

  it('négatif — tiret conservé', () => {
    const out = formatEurFromCents(-12345)
    expect(out).toMatch(/-123,45\s?€/)
  })

  it('gros nombre (millions)', () => {
    const out = formatEurFromCents(123456789)
    expect(out).toMatch(/1[\s\u202f\u00a0]234[\s\u202f\u00a0]567,89\s?€/)
  })
})

describe('formatDateFr (Story 4.5 AC #2)', () => {
  it('ISO UTC → DD/MM/YYYY', () => {
    expect(formatDateFr('2026-04-27T10:00:00.000Z')).toBe('27/04/2026')
  })

  it('padding jours / mois', () => {
    expect(formatDateFr('2026-01-05T00:00:00Z')).toBe('05/01/2026')
  })

  it('Date native acceptée', () => {
    expect(formatDateFr(new Date('2026-12-31T23:59:00Z'))).toBe('31/12/2026')
  })

  it('ISO invalide → chaîne vide (pas de throw)', () => {
    expect(formatDateFr('not-a-date')).toBe('')
  })
})
