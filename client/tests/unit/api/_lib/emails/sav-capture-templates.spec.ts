import { describe, it, expect } from 'vitest'
import {
  renderSavInternalNotification,
  renderSavCustomerAck,
  type SavCaptureContext,
} from '../../../../../api/_lib/emails/sav-capture-templates'

const baseCtx: SavCaptureContext = {
  customer: {
    email: 'laurence@example.com',
    fullName: 'Laurence Panetta',
    firstName: 'Laurence',
    lastName: 'Panetta',
    phone: '+33 6 12 34 56 78',
    pennylaneCustomerId: '1833',
  },
  invoice: {
    ref: 'F-2025-37039',
    label: 'Facture Laurence Panetta - F-2025-37039',
    specialMention: '709_25S39_68_20',
  },
  items: [
    {
      productCode: '13501',
      productName: 'Pomme Royal Gala 1kg',
      qtyRequested: 3,
      unit: 'kg',
      cause: 'Produit pourri',
    },
    {
      productCode: '14210',
      productName: 'Carotte botte',
      qtyRequested: 2,
      unit: 'piece',
    },
  ],
  dossierSavUrl: 'https://onedrive.live.com/?id=ABC123',
  savId: 8472,
  savReference: 'SAV-2026-00342',
}

describe('renderSavInternalNotification', () => {
  it('subject inclut specialMention + label si présents', () => {
    const r = renderSavInternalNotification(baseCtx)
    expect(r.subject).toBe('Demande SAV 709_25S39_68_20 - Facture Laurence Panetta - F-2025-37039')
  })

  it('subject fallback sur "Demande SAV - <ref>" si specialMention absent', () => {
    const r = renderSavInternalNotification({
      ...baseCtx,
      invoice: { ref: 'F-2025-37039' },
    })
    expect(r.subject).toBe('Demande SAV - F-2025-37039')
  })

  it('HTML contient items rendus en table', () => {
    const r = renderSavInternalNotification(baseCtx)
    expect(r.html).toContain('Pomme Royal Gala 1kg')
    expect(r.html).toContain('13501')
    expect(r.html).toContain('Produit pourri')
    expect(r.html).toContain('SAV-2026-00342')
  })

  it('HTML escape les caractères spéciaux (XSS guard)', () => {
    const r = renderSavInternalNotification({
      ...baseCtx,
      items: [
        {
          productCode: '<script>alert(1)</script>',
          productName: 'Bad & Worse',
          qtyRequested: 1,
          unit: 'piece',
          cause: '"<img src=x>"',
        },
      ],
    })
    expect(r.html).not.toContain('<script>alert(1)</script>')
    expect(r.html).toContain('&lt;script&gt;')
    expect(r.html).toContain('Bad &amp; Worse')
  })

  it('lien dossier OneDrive présent si dossierSavUrl fourni', () => {
    const r = renderSavInternalNotification(baseCtx)
    expect(r.html).toContain('https://onedrive.live.com/?id=ABC123')
  })

  it('pas de lien dossier si dossierSavUrl absent', () => {
    const r = renderSavInternalNotification({ ...baseCtx, dossierSavUrl: null })
    expect(r.html).not.toContain('Dossier OneDrive')
  })

  it('snapshot HTML stable (parité fonctionnelle Make scenario 2 module 2)', () => {
    const r = renderSavInternalNotification(baseCtx)
    // Normalise les whitespaces pour éviter flakiness CI cross-Node-version
    const normalized = r.html.replace(/\s+/g, ' ').trim()
    expect(normalized).toMatchSnapshot()
  })
})

describe('renderSavCustomerAck', () => {
  it('subject = "Demande SAV Facture <ref>"', () => {
    const r = renderSavCustomerAck(baseCtx)
    expect(r.subject).toBe('Demande SAV Facture F-2025-37039')
  })

  it('greeting tutoiement avec prénom', () => {
    const r = renderSavCustomerAck(baseCtx)
    expect(r.html).toContain('Bonjour Laurence')
    expect(r.html).toContain('Nous te confirmons avoir bien reçu ta demande')
  })

  it('greeting fallback "Bonjour," si prénom absent', () => {
    const r = renderSavCustomerAck({
      ...baseCtx,
      customer: { email: 'x@y.z' },
    })
    expect(r.html).toContain('Bonjour,')
    expect(r.html).not.toContain('Bonjour undefined')
  })

  it('charte orange #ea7500', () => {
    const r = renderSavCustomerAck(baseCtx)
    expect(r.html).toContain('#ea7500')
  })

  it('signature équipe SAV FRUITSTOCK', () => {
    const r = renderSavCustomerAck(baseCtx)
    expect(r.html).toContain('SAV FRUITSTOCK')
  })

  it('snapshot HTML stable', () => {
    const r = renderSavCustomerAck(baseCtx)
    const normalized = r.html.replace(/\s+/g, ' ').trim()
    expect(normalized).toMatchSnapshot()
  })
})
