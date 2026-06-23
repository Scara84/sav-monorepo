import { describe, it, expect } from 'vitest'
import {
  escapeHtml,
  formatDate,
  formatEurFr,
  stripCrlf,
  wrapHtml,
} from '../../../../../../api/_lib/emails/transactional/_layout'

/**
 * Story 6.6 AC #5 + AC #10 — helper layout transactionnel.
 */

describe('escapeHtml', () => {
  it('AC#10 escape strict : <, >, &, ", \' → entités HTML', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'
    )
    expect(escapeHtml("O'Brien & Co.")).toBe('O&#39;Brien &amp; Co.')
  })

  it('AC#10 idempotent semantique : double appel double-encode (documenté)', () => {
    // Comportement attendu : escape de `&amp;` redonne `&amp;amp;` (double encode).
    // C'est OK tant que le caller n'appelle escapeHtml qu'une fois.
    const once = escapeHtml('<a>')
    const twice = escapeHtml(once)
    expect(once).toBe('&lt;a&gt;')
    expect(twice).toBe('&amp;lt;a&amp;gt;')
  })

  it('AC#10 null/undefined → string vide (pas de "null" littéral)', () => {
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(undefined)).toBe('')
  })

  it('AC#10 nombre est convertible (toString)', () => {
    expect(escapeHtml(42)).toBe('42')
  })
})

describe('stripCrlf', () => {
  it('AC#10 supprime CR et LF (anti header-injection)', () => {
    expect(stripCrlf('hello\r\nBcc: leak@evil.tld')).toBe('hello  Bcc: leak@evil.tld')
    expect(stripCrlf('a\nb')).toBe('a b')
    expect(stripCrlf('no-newline')).toBe('no-newline')
  })

  it('HARDENING P0-5 — supprime aussi U+2028 (LINE SEPARATOR)', () => {
    expect(stripCrlf('a b')).toBe('a b')
  })

  it('HARDENING P0-5 — supprime aussi U+2029 (PARAGRAPH SEPARATOR)', () => {
    expect(stripCrlf('a b')).toBe('a b')
  })

  it('HARDENING P0-5 — supprime aussi U+0085 (NEXT LINE / NEL)', () => {
    expect(stripCrlf('ab')).toBe('a b')
  })
})

describe('wrapHtml', () => {
  it('AC#5 header contient charte orange #ea7500', () => {
    const html = wrapHtml('<p>hello</p>')
    expect(html.toLowerCase()).toContain('#ea7500')
    expect(html).toContain('Fruitstock')
  })

  it('AC#5 footer contient lien désinscription absolu si fourni', () => {
    const html = wrapHtml('<p>hello</p>', {
      unsubscribeUrl: 'https://sav.fruitstock.fr/monespace/preferences',
    })
    expect(html).toContain('https://sav.fruitstock.fr/monespace/preferences')
    expect(html).toContain('préférences')
  })

  it('AC#5 footer contient mentions légales', () => {
    const html = wrapHtml('<p>x</p>')
    expect(html.toLowerCase()).toContain('fruitstock')
    expect(html.toLowerCase()).toContain('lyon')
  })

  it('AC#5 dossierUrl rendu en bouton CTA absolu', () => {
    const html = wrapHtml('<p>x</p>', {
      dossierUrl: 'https://sav.fruitstock.fr/monespace/sav/12',
      ctaLabel: 'Voir mon dossier SAV',
    })
    expect(html).toContain('href="https://sav.fruitstock.fr/monespace/sav/12"')
    expect(html).toContain('Voir mon dossier SAV')
  })
})

describe('formatEurFr', () => {
  it('AC#5 1234 cents → "12,34 €" (séparateur virgule, espace insécable avant €)', () => {
    expect(formatEurFr(1234)).toBe('12,34 €')
  })

  it('AC#5 0 cents → "0,00 €"', () => {
    expect(formatEurFr(0)).toBe('0,00 €')
  })

  it('AC#5 NaN/null/undefined → fallback "—"', () => {
    expect(formatEurFr(null)).toBe('—')
    expect(formatEurFr(undefined)).toBe('—')
    expect(formatEurFr(NaN)).toBe('—')
  })
})

describe('formatDate', () => {
  it('AC#5 ISO → "DD/MM/YYYY" Europe/Paris', () => {
    // 2026-05-10T08:30:00Z = 10 mai 2026 à 10:30 Europe/Paris (été UTC+2)
    expect(formatDate('2026-05-10T08:30:00Z')).toBe('10/05/2026')
  })

  it('AC#5 input invalide → "—"', () => {
    expect(formatDate('not-a-date')).toBe('—')
    expect(formatDate(null)).toBe('—')
    expect(formatDate('')).toBe('—')
  })
})
