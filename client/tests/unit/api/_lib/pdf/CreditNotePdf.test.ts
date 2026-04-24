/**
 * Story 4.5 AC #9 — tests structure du composant `CreditNotePdf`.
 *
 * Approche : on rend le composant en arbre React (ReactElement) et on
 * walke récursivement pour collecter tous les nœuds texte (string /
 * number). Les assertions portent sur le contenu texte attendu pour
 * chaque cas PRD.
 *
 * On **ne passe pas** par `ReactPDF.renderToBuffer` côté tests :
 *   - évite l'overhead render (50-100ms/rendu → test suite lente)
 *   - évite la dépendance `pdf-parse` (pas installée V1 ; la story
 *     autorise son ajout en dev dep mais on reste minimal)
 *   - la structure de l'élément React suffit à valider la présence
 *     des chaînes attendues (la compilation PDF elle-même est testée
 *     empiriquement par AC #8.5 manuel + bench AC #11)
 */
import { describe, it, expect } from 'vitest'
import {
  CreditNotePdf,
  type CreditNotePdfProps,
  type CreditNotePdfLine,
  type CreditNotePdfCompany,
} from '../../../../../api/_lib/pdf/CreditNotePdf'

// -------------------------------------------------------
// Walker d'arbre React → collecte de strings.
// -------------------------------------------------------
type AnyEl = { props?: { children?: unknown } } & Record<string, unknown>

function collectText(node: unknown): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (typeof node === 'string') return [node]
  if (typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(collectText)
  const el = node as AnyEl
  const children = el.props?.children
  if (children === undefined) return []
  return collectText(children)
}

// -------------------------------------------------------
// Fixtures
// -------------------------------------------------------
function baseCompany(): CreditNotePdfCompany {
  return {
    legal_name: 'Fruitstock SAS',
    siret: '12345678901234',
    tva_intra: 'FR12345678901',
    address_line1: '1 rue du Verger',
    postal_code: '69000',
    city: 'Lyon',
    phone: '+33 4 00 00 00 00',
    email: 'sav@fruitstock.test',
    legal_mentions_short: 'TVA acquittée sur les encaissements',
  }
}

function baseLine(overrides: Partial<CreditNotePdfLine> = {}): CreditNotePdfLine {
  return {
    line_number: 1,
    product_code_snapshot: 'POM-BIO',
    product_name_snapshot: 'Pommes Golden bio — plateau 5 kg',
    qty_requested: 2,
    unit_requested: 'kg',
    qty_invoiced: 2,
    unit_invoiced: 'kg',
    unit_price_ht_cents: 500,
    credit_coefficient: 1,
    credit_coefficient_label: 'TOTAL 100%',
    credit_amount_cents: 1000,
    validation_message: null,
    ...overrides,
  }
}

function baseProps(overrides: Partial<CreditNotePdfProps> = {}): CreditNotePdfProps {
  return {
    creditNote: {
      id: 42,
      number: 42,
      number_formatted: 'AV-2026-00042',
      bon_type: 'AVOIR',
      total_ht_cents: 3000,
      discount_cents: 120,
      vat_cents: 158,
      total_ttc_cents: 3038,
      issued_at: '2026-04-27T10:00:00.000Z',
    },
    sav: {
      reference: 'SAV-2026-00012',
      invoice_ref: 'INV-1234',
      invoice_fdp_cents: 250,
    },
    member: {
      first_name: 'Jean',
      last_name: 'Dupont',
      email: 'jean@dupont.test',
      phone: null,
      address_line1: null,
      address_line2: null,
      postal_code: null,
      city: null,
    },
    group: { name: 'Lyon Croix-Rousse' },
    lines: [
      baseLine({ line_number: 1, product_code_snapshot: 'POM-BIO', credit_amount_cents: 1000 }),
      baseLine({ line_number: 2, product_code_snapshot: 'PEC-STD', credit_amount_cents: 1500 }),
      baseLine({ line_number: 3, product_code_snapshot: 'ABR-BIO', credit_amount_cents: 500 }),
    ],
    company: baseCompany(),
    is_group_manager: true,
    ...overrides,
  }
}

function renderText(props: CreditNotePdfProps): string {
  return collectText(CreditNotePdf(props)).join(' ')
}

// -------------------------------------------------------
// Tests
// -------------------------------------------------------
describe('CreditNotePdf (Story 4.5 AC #9)', () => {
  it('T01 structure complète happy path — 3 lignes, responsable', () => {
    const text = renderText(baseProps())
    expect(text).toContain('AV-2026-00042')
    expect(text).toContain('Dupont')
    expect(text).toContain('Fruitstock SAS')
    expect(text).toContain('Total TTC')
    expect(text).toContain('TVA')
    expect(text).toContain('SIRET')
    expect(text).toContain('12345678901234')
  })

  it('T02 is_group_manager=true + discount>0 → mention « Remise 4 % » visible', () => {
    const text = renderText(baseProps({ is_group_manager: true }))
    expect(text).toContain('Remise 4 %')
  })

  it('T03 is_group_manager=false → aucune mention « Remise »', () => {
    const text = renderText(
      baseProps({
        is_group_manager: false,
        creditNote: {
          ...baseProps().creditNote,
          discount_cents: 0,
        },
      })
    )
    expect(text).not.toMatch(/Remise/)
  })

  it('T04 bon_type AVOIR → titre « AVOIR »', () => {
    const text = renderText(
      baseProps({
        creditNote: { ...baseProps().creditNote, bon_type: 'AVOIR' },
      })
    )
    // Le titre apparaît deux fois (title Document + titre Page visible)
    expect(text.match(/AVOIR/g)?.length).toBeGreaterThanOrEqual(1)
  })

  it('T05 bon_type VIREMENT BANCAIRE → titre « BON SAV »', () => {
    const text = renderText(
      baseProps({
        creditNote: { ...baseProps().creditNote, bon_type: 'VIREMENT BANCAIRE' },
      })
    )
    expect(text).toContain('BON SAV')
  })

  it('T06 bon_type PAYPAL → titre « BON SAV »', () => {
    const text = renderText(
      baseProps({
        creditNote: { ...baseProps().creditNote, bon_type: 'PAYPAL' },
      })
    )
    expect(text).toContain('BON SAV')
  })

  it('T07 montants fr-FR — espace insécable + virgule décimale', () => {
    const text = renderText(
      baseProps({
        creditNote: {
          ...baseProps().creditNote,
          total_ttc_cents: 123456,
        },
      })
    )
    // 1 234,56 € (avec U+202F ou U+00A0 ou espace simple)
    expect(text).toMatch(/1[\s\u202f\u00a0]234,56/)
  })

  it('T08 credit_amount_cents NULL → cellule rendu « — » + note ghost line', () => {
    const text = renderText(
      baseProps({
        lines: [
          baseLine({ line_number: 1, credit_amount_cents: null, validation_message: 'Non ok' }),
          baseLine({ line_number: 2, credit_amount_cents: 2000 }),
        ],
      })
    )
    expect(text).toContain('—')
    expect(text).toContain('Lignes non-comptabilisées')
  })

  it('T09 facture liée rendue si invoice_ref présent', () => {
    const text = renderText(baseProps())
    expect(text).toContain('Facture liée')
    expect(text).toContain('INV-1234')
  })

  it('T10 facture liée masquée si invoice_ref null', () => {
    const text = renderText(
      baseProps({
        sav: { reference: 'SAV-2026-00012', invoice_ref: null, invoice_fdp_cents: null },
      })
    )
    expect(text).not.toContain('Facture liée')
  })

  it('T11 group absent → pas de ligne « Groupe »', () => {
    const text = renderText(baseProps({ group: null }))
    expect(text).not.toContain('Groupe :')
  })

  it('T12 long product_name_snapshot tronqué avec …', () => {
    const longName = 'Pommes Golden bio — plateau 5 kg caisse bois FSC label rouge 2024'
    const text = renderText(
      baseProps({
        lines: [baseLine({ product_name_snapshot: longName })],
      })
    )
    // Tronqué à 40 chars max + …
    expect(text).toMatch(/…/)
    expect(text).not.toContain(longName)
  })

  it('T13 mention légale footer visible', () => {
    const text = renderText(baseProps())
    expect(text).toContain('TVA acquittée sur les encaissements')
  })

  it('T14 colonnes tableau : 5 lignes métier rendues', () => {
    const lines: CreditNotePdfLine[] = [1, 2, 3, 4, 5].map((n) =>
      baseLine({
        line_number: n,
        product_code_snapshot: `CODE-${n}`,
        credit_amount_cents: n * 100,
      })
    )
    const text = renderText(baseProps({ lines }))
    expect(text).toContain('CODE-1')
    expect(text).toContain('CODE-2')
    expect(text).toContain('CODE-3')
    expect(text).toContain('CODE-4')
    expect(text).toContain('CODE-5')
  })
})
