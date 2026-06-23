import { describe, it, expect } from 'vitest'

/**
 * Story 6.7 AC #6 + AC #9 — RED-PHASE scaffold du template `weekly-recap`.
 *
 * Pattern référence : `templates.spec.ts` (Story 6.6).
 *
 * Couvre les 5 cas listés AC #9 :
 *   (a) subject sans CRLF (anti-header-injection)
 *   (b) lignes recap rendues + lien dossier (https://sav.fruitstock.fr/monespace/sav/{id})
 *   (c) escapeHtml sur firstName malveillant (XSS)
 *   (d) version text fallback contient le récap (pas de balises HTML)
 *   (e) footer désinscription présent (https://sav.fruitstock.fr/monespace/preferences)
 *
 * NOTE RED-PHASE : ce spec importe `renderEmailTemplate` avec kind='weekly_recap'
 * qui n'est pas encore branché dans `render.ts` (Story 6.7 Task 3 Sub-3).
 * Le 1er it() retournera donc null jusqu'à implémentation.
 */

import { renderEmailTemplate } from '../../../../../../api/_lib/emails/transactional/render'

interface RecapItem {
  id: number
  reference: string
  status: string
  receivedAt: string
  totalAmountCents: number
  memberFirstName: string
  memberLastName: string
}

const baseRecap: RecapItem[] = [
  {
    id: 2001,
    reference: 'SAV-2026-02001',
    status: 'in_progress',
    receivedAt: '2026-04-25T10:00:00Z',
    totalAmountCents: 4567,
    memberFirstName: 'Marie',
    memberLastName: 'Dupont',
  },
  {
    id: 2002,
    reference: 'SAV-2026-02002',
    status: 'received',
    receivedAt: '2026-04-26T14:30:00Z',
    totalAmountCents: 8900,
    memberFirstName: 'Jean',
    memberLastName: 'Martin',
  },
]

const baseData = {
  memberId: 100,
  memberFirstName: 'Alice',
  memberLastName: 'Manager',
  groupName: 'Groupe Aix',
  recap: baseRecap,
  periodStart: '2026-04-24T00:00:00Z',
  periodEnd: '2026-05-01T00:00:00Z',
  unsubscribeUrl: 'https://sav.fruitstock.fr/monespace/preferences',
}

describe('renderEmailTemplate(kind=weekly_recap) — Story 6.7 RED PHASE', () => {
  // ── (a) AC #4 + AC #10 (Story 6.6 pattern) — subject sans CRLF ──────────
  it('AC#9 (a) subject ne contient ni CR ni LF (anti-header-injection)', () => {
    const r = renderEmailTemplate('weekly_recap', {
      ...baseData,
      // Tentative d'injection via groupName (nom de groupe contrôlé admin
      // mais on défense en profondeur sur tous les champs interpolés dans le
      // subject).
      groupName: 'Groupe\r\nBcc: leak@evil.tld',
    })
    expect(r).not.toBeNull()
    expect(r!.subject).not.toMatch(/[\r\n]/)
    // Subject contient bien le préfixe attendu malgré le strip.
    expect(r!.subject).toMatch(/Récap SAV/i)
  })

  // ── (b) AC #4 — lignes recap rendues + lien dossier ────────────────────
  it('AC#9 (b) html contient les lignes recap + lien direct https://sav.fruitstock.fr/monespace/sav/{id}', () => {
    const r = renderEmailTemplate('weekly_recap', baseData)
    expect(r).not.toBeNull()
    // Chaque référence est rendue.
    expect(r!.html).toContain('SAV-2026-02001')
    expect(r!.html).toContain('SAV-2026-02002')
    // Liens directs vers chaque dossier.
    expect(r!.html).toContain('https://sav.fruitstock.fr/monespace/sav/2001')
    expect(r!.html).toContain('https://sav.fruitstock.fr/monespace/sav/2002')
    // Au moins un member visible.
    expect(r!.html).toContain('Marie')
    expect(r!.html).toContain('Dupont')
  })

  // ── (c) AC #10 — XSS / escapeHtml sur firstName malveillant ────────────
  it('AC#9 (c) firstName="<script>alert(1)</script>" → html échappé, pas d\'exécution', () => {
    const r = renderEmailTemplate('weekly_recap', {
      ...baseData,
      memberFirstName: '<script>alert(1)</script>',
      recap: [
        {
          ...baseRecap[0]!,
          memberFirstName: '<img src=x onerror="alert(1)">',
          memberLastName: '<script>steal()</script>',
        },
      ],
    })
    expect(r).not.toBeNull()
    expect(r!.html).not.toContain('<script>alert(1)</script>')
    expect(r!.html).not.toContain('onerror="alert(1)"')
    expect(r!.html).not.toContain('<script>steal()</script>')
    // Forme échappée présente (au moins l'une).
    expect(r!.html).toMatch(/&lt;script&gt;|&lt;img/i)
  })

  // ── (d) AC #4 — version text fallback contient le récap ────────────────
  it('AC#9 (d) version text fallback contient les références SAV + pas de balise HTML', () => {
    const r = renderEmailTemplate('weekly_recap', baseData)
    expect(r).not.toBeNull()
    // Pas de balises HTML résiduelles.
    expect(r!.text).not.toMatch(/<[^>]+>/)
    // Récap présent dans la version text (au moins les références).
    expect(r!.text).toContain('SAV-2026-02001')
    expect(r!.text).toContain('SAV-2026-02002')
    // GroupName visible.
    expect(r!.text).toContain('Groupe Aix')
  })

  // ── (e) AC #4 — footer désinscription /monespace/preferences ───────────
  it('AC#9 (e) footer contient lien désinscription https://sav.fruitstock.fr/monespace/preferences', () => {
    const r = renderEmailTemplate('weekly_recap', baseData)
    expect(r).not.toBeNull()
    expect(r!.html).toContain('https://sav.fruitstock.fr/monespace/preferences')
    // Le mot "désabonner"/"désinscription"/"préférences" présent (i18n FR).
    expect(r!.html).toMatch(/désinscri|désabonn|préférence/i)
  })
})
