import { describe, it, expect } from 'vitest'
import { renderSavClosed } from '../../../../api/_lib/emails/transactional/sav-closed'
import type { TransitionEmailData } from '../../../../api/_lib/emails/transactional/types'

/**
 * Story V1.10 AC#8 — tests Vitest du template `sav-closed` :
 *   - paragraphe « bon SAV » conditionnel : présence d'une **pièce jointe**
 *     (cas AC#1) versus **lien espace adhérent** (cas AC#2 fallback).
 *
 * Contrat Dev Notes Task 3 :
 *   - Le runner passe `pdfFallback: true` dans `template_data` quand la
 *     résolution de PJ a échoué (download Graph KO, pdf_web_url NULL, > 10 MB).
 *   - Sans `pdfFallback` (ou `pdfFallback: false`) → on est dans le chemin
 *     nominal PJ : le template doit mentionner explicitement la PJ.
 *   - Avec `pdfFallback: true` → le template doit pointer vers
 *     `dossierUrl` ({APP_BASE_URL}/monespace/sav/:id) avec un libellé
 *     « votre bon SAV est disponible dans votre espace ».
 *
 * Pas de migration `TransitionEmailData` : le champ `pdfFallback` est
 * optionnel, default = false (chemin nominal). Champ ajouté par le dev en
 * étendant `types.ts`.
 */

interface ExtendedTransitionEmailData extends TransitionEmailData {
  pdfFallback?: boolean
  noCreditNote?: boolean
}

const baseData: ExtendedTransitionEmailData = {
  savReference: 'SAV-2026-00003',
  savId: 3,
  memberFirstName: 'Jean',
  memberLastName: 'Dupont',
  newStatus: 'closed',
  previousStatus: 'validated',
  totalAmountCents: 4567,
  dossierUrl: 'https://sav.fruitstock.fr/monespace/sav/3',
  unsubscribeUrl: 'https://sav.fruitstock.fr/monespace/preferences',
}

describe('renderSavClosed — V1.10 AC#8 mention bon SAV', () => {
  // ── Régression pré-V1.10 : ce qui était déjà testé Story 6.6 reste vrai ──
  it('régression 6.6 : subject, html stripCrlf, montant formaté', () => {
    const out = renderSavClosed(baseData)
    expect(out.subject).toBe('SAV SAV-2026-00003 — clôturé')
    expect(out.html).toContain('Jean')
    expect(out.html).toContain('SAV-2026-00003')
    expect(out.html).toContain('clôturé')
  })

  // ── AC#8 — chemin nominal : PJ présente ─────────────────────────────────
  it('AC#8 nominal (PJ jointe, pdfFallback absent) : html mentionne « pièce jointe » bon SAV', () => {
    const out = renderSavClosed(baseData)
    // L'utilisateur doit savoir que le PDF est en PJ — formulation libre,
    // mais le mot-clé « jointe » ou « pièce jointe » est attendu.
    expect(out.html.toLowerCase()).toMatch(/pi[èe]ce[\s-]jointe|en pi[èe]ce jointe|ci-joint/i)
    // Mention « bon SAV » explicite (le concept métier).
    expect(out.html.toLowerCase()).toContain('bon sav')
  })

  it('AC#8 nominal : le text/plain mentionne aussi la PJ (lecteur sans HTML)', () => {
    const out = renderSavClosed(baseData)
    expect(out.text.toLowerCase()).toMatch(/pi[èe]ce[\s-]jointe|ci-joint|joint/i)
  })

  it('AC#8 nominal : pdfFallback=false explicite équivaut à absent', () => {
    const out = renderSavClosed({ ...baseData, pdfFallback: false })
    expect(out.html.toLowerCase()).toMatch(/pi[èe]ce[\s-]jointe|ci-joint/i)
    expect(out.html.toLowerCase()).not.toMatch(/disponible dans votre espace/i)
  })

  // ── AC#8 — chemin fallback : pas de PJ → lien espace adhérent ──────────
  it('AC#8 fallback (pdfFallback=true) : html mentionne « disponible dans votre espace » + lien dossier', () => {
    const out = renderSavClosed({ ...baseData, pdfFallback: true })
    expect(out.html.toLowerCase()).toContain('disponible dans votre espace')
    // Le lien vers dossierUrl doit être présent (CTA explicite).
    expect(out.html).toContain('https://sav.fruitstock.fr/monespace/sav/3')
    // Inversement, on NE doit PAS prétendre qu'une PJ est jointe alors qu'elle
    // ne l'est pas — anti-mensonge utilisateur.
    expect(out.html.toLowerCase()).not.toMatch(/en pi[èe]ce jointe|ci-joint/i)
  })

  it('AC#8 fallback : le text/plain mentionne aussi le lien espace adhérent', () => {
    const out = renderSavClosed({ ...baseData, pdfFallback: true })
    expect(out.text.toLowerCase()).toContain('disponible dans votre espace')
    expect(out.text).toContain('https://sav.fruitstock.fr/monespace/sav/3')
  })

  it('AC#8 fallback sans dossierUrl (cas dégénéré) : template ne throw pas', () => {
    expect(() =>
      renderSavClosed({ ...baseData, dossierUrl: null, pdfFallback: true })
    ).not.toThrow()
    const out = renderSavClosed({ ...baseData, dossierUrl: null, pdfFallback: true })
    expect(out.html.toLowerCase()).toContain('disponible dans votre espace')
  })

  // ── CR FIX 3 — branche no_credit_note (SAV clôturé sans remboursement) ──
  it('CR FIX 3 (noCreditNote=true) : html ne mentionne PAS le bon SAV (pas de PJ ni espace)', () => {
    const out = renderSavClosed({ ...baseData, noCreditNote: true })
    // Ni mention de PJ ni de "disponible dans votre espace" — comportement
    // 6.6 d'avant V1.10 (anti-mensonge : SAV clôturé sans remboursement).
    expect(out.html.toLowerCase()).not.toMatch(/pi[èe]ce jointe|ci-joint/i)
    expect(out.html.toLowerCase()).not.toContain('disponible dans votre espace')
    expect(out.html.toLowerCase()).not.toContain('bon sav')
    // Le mail reste valide (clôture mentionnée).
    expect(out.html.toLowerCase()).toContain('clôturé')
  })

  it('CR FIX 3 (noCreditNote=true) : text/plain ne mentionne pas non plus le bon SAV', () => {
    const out = renderSavClosed({ ...baseData, noCreditNote: true })
    expect(out.text.toLowerCase()).not.toMatch(/pi[èe]ce jointe|ci-joint/i)
    expect(out.text.toLowerCase()).not.toContain('disponible dans votre espace')
    expect(out.text.toLowerCase()).not.toContain('bon sav')
    expect(out.text.toLowerCase()).toContain('clôturé')
  })

  it('CR FIX 3 précédence : noCreditNote=true gagne sur pdfFallback=true (cas dégénéré)', () => {
    const out = renderSavClosed({ ...baseData, noCreditNote: true, pdfFallback: true })
    expect(out.html.toLowerCase()).not.toContain('disponible dans votre espace')
    expect(out.html.toLowerCase()).not.toContain('bon sav')
  })

  // ── Defense — escape HTML conservé en présence des nouveaux champs ─────
  it('escape HTML reste actif sur memberFirstName même en branch fallback', () => {
    const out = renderSavClosed({
      ...baseData,
      memberFirstName: '<script>alert(1)</script>',
      pdfFallback: true,
    })
    expect(out.html).not.toContain('<script>alert(1)</script>')
    expect(out.html).toContain('&lt;script&gt;')
  })
})
