import { describe, it, expect } from 'vitest'
import { renderSavValidated } from '../../../../api/_lib/emails/transactional/sav-validated'
import type { TransitionEmailData } from '../../../../api/_lib/emails/transactional/types'

/**
 * Story V1.13 AC#5 — Template `sav-validated` réécrit, 3 chemins :
 *   - nominal (pdfFallback absent/false + noCreditNote absent/false) :
 *     mention bon SAV « en pièce jointe ». La phrase « sera émis prochainement »
 *     est SUPPRIMÉE (devenue fausse — par construction du gate AC#4 le bon SAV
 *     EST émis avant qu'on arrive ici).
 *   - pdfFallback=true : mention « disponible dans votre espace » + lien dossier
 *     (Graph down au moment du send / PDF > 10 MB / member anonymisé).
 *   - noCreditNote=true : AUCUNE mention bon SAV (défensif : impossible par
 *     construction du gate, mais legacy rows / races V1).
 *
 * Précédence : noCreditNote > pdfFallback > nominal (pattern sav-closed V1.10).
 * Échappement HTML / CRLF inchangé.
 *
 * Pattern : symétrique à `sav-closed-template.spec.ts` (V1.10 AC#8).
 *
 * Statut ATDD : RED attendu avant impl Step 4 (template encore Story 6.6).
 */

interface ExtendedTransitionEmailData extends TransitionEmailData {
  pdfFallback?: boolean
  noCreditNote?: boolean
  walletCreditConfirmed?: boolean
}

const baseData: ExtendedTransitionEmailData = {
  savReference: 'SAV-2026-V113',
  savId: 12,
  memberFirstName: 'Marie',
  memberLastName: 'Dupont',
  newStatus: 'validated',
  previousStatus: 'in_progress',
  totalAmountCents: 4567,
  dossierUrl: 'https://sav.fruitstock.fr/monespace/sav/12',
  unsubscribeUrl: 'https://sav.fruitstock.fr/monespace/preferences',
}

describe('renderSavValidated — V1.13 AC#5 (PJ bon SAV) 3 chemins', () => {
  // ── Subject inchangé (régression Story 6.6) ─────────────────────────────
  it('subject = `SAV {ref} — validé` (régression 6.6, stripCrlf préservé)', () => {
    const out = renderSavValidated(baseData)
    expect(out.subject).toBe('SAV SAV-2026-V113 — validé')
  })

  it('subject CRLF strippé', () => {
    const out = renderSavValidated({ ...baseData, savReference: 'SAV-X\r\nBcc: leak' })
    expect(out.subject).not.toMatch(/[\r\n]/)
  })

  // ── Chemin nominal (PJ) ─────────────────────────────────────────────────
  it('nominal (pdfFallback absent + noCreditNote absent) : html mentionne « pièce jointe » bon SAV', () => {
    const out = renderSavValidated(baseData)
    expect(out.html.toLowerCase()).toMatch(/pi[èe]ce[\s-]jointe|en pi[èe]ce jointe|ci-joint/i)
    expect(out.html.toLowerCase()).toContain('bon sav')
  })

  it('nominal : la phrase « sera émis prochainement » est SUPPRIMÉE (devenue fausse post-gate)', () => {
    const out = renderSavValidated(baseData)
    expect(out.html.toLowerCase()).not.toContain('sera émis prochainement')
    expect(out.text.toLowerCase()).not.toContain('sera émis prochainement')
  })

  it('nominal : text/plain mentionne aussi la PJ', () => {
    const out = renderSavValidated(baseData)
    expect(out.text.toLowerCase()).toMatch(/pi[èe]ce[\s-]jointe|ci-joint|joint/i)
  })

  it('nominal : pdfFallback=false explicite équivaut à absent', () => {
    const out = renderSavValidated({ ...baseData, pdfFallback: false })
    expect(out.html.toLowerCase()).toMatch(/pi[èe]ce[\s-]jointe|ci-joint/i)
    expect(out.html.toLowerCase()).not.toMatch(/disponible dans votre espace/i)
  })

  it('affiche la phrase wallet à l’identique en HTML et texte uniquement si confirmée', () => {
    const phrase =
      'Le montant de cet avoir a été crédité sur votre compte et sera automatiquement déduit de votre prochaine facture.'
    const confirmedData: ExtendedTransitionEmailData = {
      ...baseData,
      walletCreditConfirmed: true,
    }
    const confirmed = renderSavValidated(confirmedData)
    expect(confirmed.html).toContain(phrase)
    expect(confirmed.text).toContain(phrase)

    for (const unconfirmedData of [
      { ...baseData, walletCreditConfirmed: false },
      { ...baseData },
    ] satisfies ExtendedTransitionEmailData[]) {
      const unconfirmed = renderSavValidated(unconfirmedData)
      expect(unconfirmed.html).not.toContain(phrase)
      expect(unconfirmed.text).not.toContain(phrase)
    }
  })

  // ── Chemin pdfFallback ─────────────────────────────────────────────────
  it('pdfFallback=true : html mentionne « disponible dans votre espace » + lien dossier', () => {
    const out = renderSavValidated({ ...baseData, pdfFallback: true })
    expect(out.html.toLowerCase()).toContain('disponible dans votre espace')
    expect(out.html).toContain('https://sav.fruitstock.fr/monespace/sav/12')
    // Anti-mensonge : on ne doit pas prétendre qu'une PJ est jointe.
    expect(out.html.toLowerCase()).not.toMatch(/en pi[èe]ce jointe|ci-joint/i)
  })

  it('pdfFallback=true : text/plain mentionne aussi le lien espace adhérent', () => {
    const out = renderSavValidated({ ...baseData, pdfFallback: true })
    expect(out.text.toLowerCase()).toContain('disponible dans votre espace')
    expect(out.text).toContain('https://sav.fruitstock.fr/monespace/sav/12')
  })

  it('pdfFallback=true + dossierUrl null (dégénéré) : ne throw pas', () => {
    expect(() =>
      renderSavValidated({ ...baseData, dossierUrl: null, pdfFallback: true })
    ).not.toThrow()
    const out = renderSavValidated({ ...baseData, dossierUrl: null, pdfFallback: true })
    expect(out.html.toLowerCase()).toContain('disponible dans votre espace')
  })

  // ── Chemin noCreditNote (défensif) ─────────────────────────────────────
  it('noCreditNote=true : html ne mentionne PAS le bon SAV (ni PJ ni espace)', () => {
    const out = renderSavValidated({ ...baseData, noCreditNote: true })
    expect(out.html.toLowerCase()).not.toMatch(/pi[èe]ce jointe|ci-joint/i)
    expect(out.html.toLowerCase()).not.toContain('disponible dans votre espace')
    expect(out.html.toLowerCase()).not.toContain('bon sav')
    // Le mail reste valide (validation mentionnée).
    expect(out.html.toLowerCase()).toContain('valid')
  })

  it('noCreditNote=true : text/plain symétrique', () => {
    const out = renderSavValidated({ ...baseData, noCreditNote: true })
    expect(out.text.toLowerCase()).not.toMatch(/pi[èe]ce jointe|ci-joint/i)
    expect(out.text.toLowerCase()).not.toContain('disponible dans votre espace')
    expect(out.text.toLowerCase()).not.toContain('bon sav')
  })

  it('précédence : noCreditNote=true gagne sur pdfFallback=true (cas dégénéré)', () => {
    const out = renderSavValidated({ ...baseData, noCreditNote: true, pdfFallback: true })
    expect(out.html.toLowerCase()).not.toContain('disponible dans votre espace')
    expect(out.html.toLowerCase()).not.toContain('bon sav')
  })

  // ── Defense — escape HTML conservé dans toutes les branches ─────────────
  it('escape HTML reste actif sur memberFirstName (nominal)', () => {
    const out = renderSavValidated({
      ...baseData,
      memberFirstName: '<script>alert(1)</script>',
    })
    expect(out.html).not.toContain('<script>alert(1)</script>')
    expect(out.html).toContain('&lt;script&gt;')
  })

  it('escape HTML reste actif en branch fallback', () => {
    const out = renderSavValidated({
      ...baseData,
      memberFirstName: '<script>alert(1)</script>',
      pdfFallback: true,
    })
    expect(out.html).not.toContain('<script>alert(1)</script>')
    expect(out.html).toContain('&lt;script&gt;')
  })
})
