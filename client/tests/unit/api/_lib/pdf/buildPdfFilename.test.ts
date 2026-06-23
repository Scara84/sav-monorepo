import { describe, it, expect } from 'vitest'
import { buildPdfFilename } from '../../../../../api/_lib/pdf/buildPdfFilename'

describe('buildPdfFilename (Story 4.5 AC #2)', () => {
  it('happy path — nom + prénom initial', () => {
    expect(
      buildPdfFilename({
        number_formatted: 'AV-2026-00042',
        first_name: 'Jean',
        last_name: 'Dupont',
      })
    ).toBe('AV-2026-00042 Dupont J..pdf')
  })

  it('first_name absent → uniquement last_name', () => {
    expect(
      buildPdfFilename({
        number_formatted: 'AV-2026-00042',
        first_name: null,
        last_name: 'Dupont',
      })
    ).toBe('AV-2026-00042 Dupont.pdf')
  })

  it('first_name vide string → uniquement last_name', () => {
    expect(
      buildPdfFilename({
        number_formatted: 'AV-2026-00001',
        first_name: '',
        last_name: 'Martin',
      })
    ).toBe('AV-2026-00001 Martin.pdf')
  })

  it('last_name avec caractère interdit (/) → remplacé par _', () => {
    expect(
      buildPdfFilename({
        number_formatted: 'AV-2026-00042',
        first_name: 'Jean',
        last_name: 'D/upont',
      })
    ).toBe('AV-2026-00042 D_upont J..pdf')
  })

  it('caractères accentués remplacés par _ (OneDrive/Windows safe)', () => {
    expect(
      buildPdfFilename({
        number_formatted: 'AV-2026-00042',
        first_name: 'Éric',
        last_name: 'Müller',
      })
    ).toBe('AV-2026-00042 M_ller _..pdf')
  })

  it('nom très long tronqué à 80 chars (+ .pdf)', () => {
    const longName = 'A'.repeat(120)
    const result = buildPdfFilename({
      number_formatted: 'AV-2026-00042',
      first_name: null,
      last_name: longName,
    })
    expect(result.endsWith('.pdf')).toBe(true)
    expect(result.length).toBeLessThanOrEqual(80 + 4) // stem + '.pdf'
  })

  it('initial prénom en majuscule — minuscule casée', () => {
    expect(
      buildPdfFilename({
        number_formatted: 'AV-2026-00042',
        first_name: 'jean',
        last_name: 'dupont',
      })
    ).toBe('AV-2026-00042 dupont J..pdf')
  })

  it('number_formatted avec caractère interdit (rare) → sanitize', () => {
    expect(
      buildPdfFilename({
        number_formatted: 'AV-2026/00042',
        first_name: null,
        last_name: 'Dupont',
      })
    ).toBe('AV-2026_00042 Dupont.pdf')
  })
})
