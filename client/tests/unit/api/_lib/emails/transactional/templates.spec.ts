import { describe, it, expect } from 'vitest'
import { renderEmailTemplate } from '../../../../../../api/_lib/emails/transactional/render'

/**
 * Story 6.6 AC #5 + AC #10 — 6 templates transactionnels paramétrés.
 *
 * DECISION DS Q1 : 6 templates (sav-in-progress, sav-validated, sav-closed,
 * sav-cancelled, sav-received-operator, sav-comment-added). AC #11 mentionne
 * "8 spec files" — imprécis (AC #5 fait foi). Single-file paramétré
 * describe.each × 6 OK.
 */

const TEMPLATE_KINDS = [
  'sav_in_progress',
  'sav_validated',
  'sav_closed',
  'sav_cancelled',
  'sav_received_operator',
  'sav_comment_added',
] as const

const baseAdherentData = {
  savReference: 'SAV-2026-00012',
  savId: 12,
  memberFirstName: 'Marie',
  memberLastName: 'Dupont',
  newStatus: 'in_progress',
  previousStatus: 'received',
  totalAmountCents: 4567,
  dossierUrl: 'https://sav.fruitstock.fr/monespace/sav/12',
  unsubscribeUrl: 'https://sav.fruitstock.fr/monespace/preferences',
  commentBody: 'Hello, votre dossier avance bien.',
  recipientKind: 'member' as const,
}

describe.each(TEMPLATE_KINDS)('renderEmailTemplate(kind=%s)', (kind) => {
  it(`AC#5 retourne { subject, html, text } non vides pour kind=${kind}`, () => {
    const r = renderEmailTemplate(kind, baseAdherentData)
    expect(r).not.toBeNull()
    expect(r!.subject.length).toBeGreaterThan(0)
    expect(r!.html.length).toBeGreaterThan(0)
    expect(r!.text.length).toBeGreaterThan(0)
  })

  it(`AC#5 subject inclut savReference pour kind=${kind}`, () => {
    const r = renderEmailTemplate(kind, baseAdherentData)
    expect(r!.subject).toContain('SAV-2026-00012')
  })

  it(`AC#5 html contient dossierUrl absolu pour kind=${kind}`, () => {
    const r = renderEmailTemplate(kind, baseAdherentData)
    expect(r!.html).toContain('https://sav.fruitstock.fr/monespace/sav/12')
  })

  it(`AC#5 text version sans balises HTML pour kind=${kind}`, () => {
    const r = renderEmailTemplate(kind, baseAdherentData)
    // Pas de balise HTML dans le fallback texte.
    expect(r!.text).not.toMatch(/<[^>]+>/)
  })

  // ── AC #10 — XSS / escape ─────────────────────────────────────────────
  it(`AC#10 firstName="<script>alert(1)</script>" → html escape kind=${kind}`, () => {
    const r = renderEmailTemplate(kind, {
      ...baseAdherentData,
      memberFirstName: '<script>alert(1)</script>',
    })
    expect(r!.html).not.toContain('<script>alert(1)</script>')
    expect(r!.html).toContain('&lt;script&gt;')
  })

  it(`AC#10 body commentaire malveillant échappé kind=${kind}`, () => {
    const r = renderEmailTemplate(kind, {
      ...baseAdherentData,
      commentBody: '<img src=x onerror="alert(1)">',
      memberLastName: '<img src=x onerror="alert(1)">',
    })
    expect(r!.html).not.toContain('onerror="alert(1)"')
  })

  it(`AC#10 subject strip CRLF (anti-header-injection) kind=${kind}`, () => {
    const r = renderEmailTemplate(kind, {
      ...baseAdherentData,
      savReference: 'X\r\nBcc: leak@evil.tld',
    })
    expect(r!.subject).not.toMatch(/[\r\n]/)
  })
})

describe('sav_in_progress / sav_validated / sav_closed (kinds adhérent)', () => {
  it.each(['sav_in_progress', 'sav_validated', 'sav_closed'])(
    'AC#5 footer contient lien désinscription /monespace/preferences pour kind=%s',
    (kind) => {
      const r = renderEmailTemplate(kind, baseAdherentData)
      expect(r!.html).toContain('https://sav.fruitstock.fr/monespace/preferences')
    }
  )
})

describe('sav_received_operator (notif opérateur)', () => {
  it('AC#2 inclut totalAmountCents formaté + memberFirstName/memberLastName', () => {
    const r = renderEmailTemplate('sav_received_operator', baseAdherentData)
    expect(r!.html).toContain('45,67')
    expect(r!.html).toContain('Marie')
    expect(r!.html).toContain('Dupont')
  })

  it('AC#2 PAS de lien désinscription (DS Q4 — kind opérateur)', () => {
    const r = renderEmailTemplate('sav_received_operator', baseAdherentData)
    expect(r!.html).not.toContain('/monespace/preferences')
    expect(r!.text).not.toContain('/monespace/preferences')
  })
})

describe('sav_comment_added (dual recipient)', () => {
  it('Story 6.3 — recipientKind=member → mention "commentaire de notre équipe"', () => {
    const r = renderEmailTemplate('sav_comment_added', {
      ...baseAdherentData,
      recipientKind: 'member',
    })
    expect(r!.html.toLowerCase()).toContain('commentaire')
    expect(r!.html).toContain('Marie')
  })

  it('Story 6.3 — recipientKind=operator → ton opérateur (pas de "Bonjour Marie")', () => {
    const r = renderEmailTemplate('sav_comment_added', {
      ...baseAdherentData,
      recipientKind: 'operator',
    })
    expect(r!.html).not.toContain('Bonjour Marie')
    expect(r!.html.toLowerCase()).toContain('adhérent')
  })

  it('Story 6.3 — recipientKind=operator → pas de lien désinscription', () => {
    const r = renderEmailTemplate('sav_comment_added', {
      ...baseAdherentData,
      recipientKind: 'operator',
    })
    expect(r!.html).not.toContain('/monespace/preferences')
  })
})

describe('renderEmailTemplate dispatcher', () => {
  it('kind inconnu → null (caller doit failed définitif)', () => {
    expect(renderEmailTemplate('not_a_kind', baseAdherentData)).toBeNull()
  })
})
