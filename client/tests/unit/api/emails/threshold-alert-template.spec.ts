import { describe, it, expect } from 'vitest'
import {
  renderThresholdAlertEmail,
  __testables,
} from '../../../../api/_lib/emails/threshold-alert-template'

describe('renderThresholdAlertEmail', () => {
  const baseInput = {
    productCode: 'P42',
    productNameFr: 'Pomme Golden',
    savCount: 6,
    windowDays: 7,
    recentSavRefs: [
      { id: 1, reference: 'SAV-2026-00001' },
      { id: 2, reference: 'SAV-2026-00002' },
    ],
    appBaseUrl: 'https://sav.example.com',
  }

  it('génère un subject explicite avec produit + count + window', () => {
    const out = renderThresholdAlertEmail(baseInput)
    expect(out.subject).toBe('Alerte SAV : Pomme Golden (6 SAV sur 7 jours)')
  })

  it('html contient les variables substituées (code, nom, count)', () => {
    const out = renderThresholdAlertEmail(baseInput)
    expect(out.html).toContain('P42')
    expect(out.html).toContain('Pomme Golden')
    expect(out.html).toContain('>6<')
  })

  it('html linké correctement vers les SAVs et settings', () => {
    const out = renderThresholdAlertEmail(baseInput)
    expect(out.html).toContain('https://sav.example.com/admin/sav/1')
    expect(out.html).toContain('https://sav.example.com/admin/sav/2')
    expect(out.html).toContain('https://sav.example.com/admin/settings?tab=thresholds')
  })

  it('escape HTML dangereux dans nom produit', () => {
    const out = renderThresholdAlertEmail({
      ...baseInput,
      productNameFr: '<script>alert(1)</script>',
    })
    expect(out.html).not.toContain('<script>alert(1)')
    expect(out.html).toContain('&lt;script&gt;')
  })

  it('liste vide → message italique "Aucune référence récente"', () => {
    const out = renderThresholdAlertEmail({ ...baseInput, recentSavRefs: [] })
    expect(out.html).toContain('Aucune référence récente')
  })

  it('trim trailing slash sur appBaseUrl', () => {
    expect(__testables.trimTrailingSlash('https://x/')).toBe('https://x')
    expect(__testables.trimTrailingSlash('https://x/y/')).toBe('https://x/y')
    expect(__testables.trimTrailingSlash('https://x///')).toBe('https://x')
  })

  it('escapeHtml échappe les 5 caractères critiques', () => {
    const e = __testables.escapeHtml(`<a href="x">'&"</a>`)
    expect(e).not.toContain('<a')
    expect(e).toContain('&lt;')
    expect(e).toContain('&gt;')
    expect(e).toContain('&amp;')
    expect(e).toContain('&quot;')
    expect(e).toContain('&#39;')
  })

  it('html bien formé : DOCTYPE + html + body', () => {
    const out = renderThresholdAlertEmail(baseInput)
    expect(out.html).toMatch(/^<!DOCTYPE html>/)
    expect(out.html).toContain('<html lang="fr">')
    expect(out.html).toContain('</html>')
    expect(out.html).toContain('<body')
    expect(out.html).toContain('</body>')
  })
})
