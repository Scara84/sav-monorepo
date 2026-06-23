/**
 * Story V1.11 — Harmonisation affichage HT/TTC (PDF avoir) + désignation complète.
 *
 * RED PHASE (TDD) — tous les tests sont `it(...)` jusqu'à activation
 * par l'implémenteur. Une fois activés, ils DOIVENT échouer contre le code
 * actuel (`'Prix HT'`, `truncateName(…, 40)`) — c'est INTENTIONNEL.
 *
 * Stack : mêmes stubs `@react-pdf/renderer` + walker `collectText` que
 * `CreditNotePdf.test.ts` (story 4.5). Aucun render-to-buffer.
 *
 * Discipline architecturale (cf. Dev Notes V1.11) :
 *   - le moteur (`credit_amount_cents` HT) est INTOUCHABLE
 *   - le helper `creditTtcCents(line)` doit être pur, arrondi half-up,
 *     null-safe sur `vat_rate_bp_snapshot`
 *   - les totaux (Sous-total HT / TVA / Total TTC) sont issus du moteur,
 *     pas recalculés depuis les TTC affichés (anti-W16 double-round)
 *
 * Discriminant anti-régression (AC#7) :
 *   ligne HT=1000 cents (10,00 €) + TVA 5,5% → TTC=1055 cents (10,55 €).
 *   Si le helper renvoyait HT, l'assertion `1055` échouerait → faux-vert
 *   impossible.
 */
import { describe, it, expect } from 'vitest'
import * as React from 'react'
import {
  buildCreditNotePdf,
  type CreditNotePdfProps,
  type CreditNotePdfLine,
  type CreditNotePdfCompany,
  // V1.11 — helper pur à exporter par l'implémenteur depuis CreditNotePdf.ts
  // (signature attendue : `creditTtcCents(line: CreditNotePdfLine): number | null`)
  creditTtcCents,
} from '../../../../../api/_lib/pdf/CreditNotePdf'
import type * as ReactPDFType from '@react-pdf/renderer'

// -------------------------------------------------------
// Stub @react-pdf/renderer (identique à CreditNotePdf.test.ts)
// -------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makePdfComponentStub(name: string): (props: any) => React.ReactElement {
  return ({ children }: { children?: React.ReactNode }) => React.createElement(name, {}, children)
}

const reactPdfModuleMock = {
  Document: makePdfComponentStub('Document'),
  Page: makePdfComponentStub('Page'),
  Text: makePdfComponentStub('Text'),
  View: makePdfComponentStub('View'),
  StyleSheet: {
    create: <T extends Record<string, unknown>>(styles: T): T => styles,
  },
} as unknown as typeof ReactPDFType

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

// V1.11 — fixture intégrée : `vat_rate_bp_snapshot` est maintenant un champ
// natif de `CreditNotePdfLine` (Task 1 done).
function baseLine(overrides: Partial<CreditNotePdfLine> = {}): CreditNotePdfLine {
  return {
    line_number: 1,
    product_code_snapshot: 'POM-BIO',
    product_name_snapshot: 'Pommes Golden bio — plateau 5 kg',
    qty_requested: 2,
    unit_requested: 'kg',
    qty_invoiced: 2,
    unit_invoiced: 'kg',
    qty_arbitrated: 2,
    unit_arbitrated: 'kg',
    unit_price_ttc_cents: 500,
    unit_price_ttc_arbitrated_cents: null,
    credit_coefficient: 1,
    credit_coefficient_label: 'TOTAL 100%',
    credit_amount_cents: 1000, // HT
    validation_message: null,
    vat_rate_bp_snapshot: 550, // TVA 5,5 %
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
      total_ht_cents: 3000, // moteur — non recalculé depuis lignes
      discount_cents: 0,
      vat_cents: 165, // moteur — non recalculé
      total_ttc_cents: 3165, // moteur — non recalculé
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
    is_group_manager: false,
    ...overrides,
  }
}

function renderText(props: CreditNotePdfProps): string {
  return collectText(buildCreditNotePdf(reactPdfModuleMock, props)).join(' ')
}

// =============================================================================
// AC#1 — Header colonne prix
// =============================================================================
describe('V1.11 AC#1 — Header colonne prix facturé', () => {
  it('le header de colonne affiche `Prix facturé TTC` (et non les anciens libellés)', () => {
    const text = renderText(baseProps())
    expect(text).toContain('Prix facturé TTC')
    expect(text).not.toContain('PU TTC')
    expect(text).not.toContain('Prix HT')
  })
})

// =============================================================================
// AC#2 — Colonne Montant TTC + en-tête `Montant TTC`
// =============================================================================
describe('V1.11 AC#2 — Montant ligne en TTC', () => {
  it('le header de la colonne montant est `Montant TTC`', () => {
    const text = renderText(baseProps())
    expect(text).toContain('Montant TTC')
  })

  it('ligne HT=1000 cents + TVA 5,5% → cellule rendue 10,55 € (discriminant W16 anti-faux-vert)', () => {
    const text = renderText(
      baseProps({
        lines: [
          baseLine({
            credit_amount_cents: 1000,
            vat_rate_bp_snapshot: 550,
          }),
        ],
      })
    )
    // 10,55 € (espace insécable U+202F ou U+00A0 selon Intl)
    expect(text).toMatch(/10,55[\s  ]*€/)
    // Sentinel anti-faux-vert : 10,00 € (HT brut) NE DOIT PAS apparaître seul
    // (sauf bien sûr dans le bloc « Sous-total HT » au-dessous, mais notre
    // fixture met total_ht_cents=3000 → 30,00 €, donc 10,00 dans la zone
    // table = régression).
    expect(text).not.toMatch(/Montant TTC[\s\S]*?10,00[\s  ]*€[\s\S]*?Sous-total HT/)
  })

  it('vat_rate_bp_snapshot=null → cellule rendu `—` (pattern ghost line)', () => {
    const text = renderText(
      baseProps({
        lines: [
          baseLine({
            credit_amount_cents: 1000,
            vat_rate_bp_snapshot: null,
          }),
        ],
      })
    )
    // Le `—` apparaît au moins une fois (cellule Montant TTC quand bp null)
    expect(text).toContain('—')
  })

  it('vat_rate_bp_snapshot=0 → Montant TTC = Montant HT (TVA neutre)', () => {
    const text = renderText(
      baseProps({
        lines: [
          baseLine({
            credit_amount_cents: 1000,
            vat_rate_bp_snapshot: 0,
          }),
        ],
      })
    )
    expect(text).toMatch(/10,00[\s  ]*€/)
  })
})

// =============================================================================
// AC#3 — Totaux INCHANGÉS (issus du moteur, pas recalculés)
// =============================================================================
describe('V1.11 AC#3 — Totaux moteur préservés', () => {
  it('les totaux Sous-total HT / TVA / Total TTC sont strictement ceux du payload moteur (pas une somme des TTC affichés)', () => {
    // Fixture piège : le moteur dit 30,00 € HT + 1,65 € TVA = 31,65 € TTC.
    // Si une régression sommait les TTC lignes : 10,55 + 15,825 + 5,275 ≈ 31,65.
    // Pour rendre la régression détectable, on plante DES TOTAUX MOTEUR
    // DÉLIBÉRÉMENT INCOHÉRENTS avec la somme des lignes. Le test exige que
    // ce sont LES TOTAUX MOTEUR qui sortent.
    const text = renderText(
      baseProps({
        creditNote: {
          id: 42,
          number: 42,
          number_formatted: 'AV-2026-00042',
          bon_type: 'AVOIR',
          total_ht_cents: 9999, // 99,99 € — sentinelle absurde
          discount_cents: 0,
          vat_cents: 1234, // 12,34 € — sentinelle absurde
          total_ttc_cents: 11233, // 112,33 € — sentinelle absurde
          issued_at: '2026-04-27T10:00:00.000Z',
        },
      })
    )
    expect(text).toMatch(/99,99[\s  ]*€/)
    expect(text).toMatch(/12,34[\s  ]*€/)
    expect(text).toMatch(/112,33[\s  ]*€/)
  })
})

// =============================================================================
// AC#4 — Désignation complète (retrait truncateName)
// =============================================================================
describe('V1.11 AC#4 — Désignation produit complète', () => {
  it('un product_name_snapshot de 120 chars apparaît INTÉGRALEMENT (sans ellipsis `…`)', () => {
    const longName =
      'Pommes Golden bio Label Rouge — plateau bois FSC 5 kg origine France récolte 2024 lot 12345 référence interne POM-BIO-XL-2024-PLATEAU-FSC'
    expect(longName.length).toBeGreaterThan(40)
    const text = renderText(
      baseProps({
        lines: [baseLine({ product_name_snapshot: longName })],
      })
    )
    expect(text).toContain(longName)
    expect(text).not.toMatch(/…/)
  })

  it("pagination smoke — 25 lignes × nom 120 chars : l'arbre React PDF se construit sans throw", () => {
    const longName =
      'Pommes Golden bio Label Rouge — plateau bois FSC 5 kg origine France récolte 2024 lot 12345 ref POM-BIO-XL-2024-PLT'
    const lines: CreditNotePdfLine[] = Array.from({ length: 25 }, (_, i) =>
      baseLine({
        line_number: i + 1,
        product_code_snapshot: `CODE-${i + 1}`,
        product_name_snapshot: longName,
        credit_amount_cents: 100 * (i + 1),
      })
    )
    expect(() => buildCreditNotePdf(reactPdfModuleMock, baseProps({ lines }))).not.toThrow()
    const text = renderText(baseProps({ lines }))
    // Les 25 codes doivent tous apparaître (aucune ligne ne disparaît)
    for (let i = 1; i <= 25; i++) {
      expect(text).toContain(`CODE-${i}`)
    }
  })
})

// =============================================================================
// AC#6 — Helper pur `creditTtcCents` (parité moteur, no-mutation)
// =============================================================================
describe('V1.11 AC#6 — creditTtcCents (helper pur)', () => {
  it('HT=1000 + bp=550 → 1055 (arrondi half-up)', () => {
    const line = baseLine({
      credit_amount_cents: 1000,
      vat_rate_bp_snapshot: 550,
    })
    expect(creditTtcCents(line)).toBe(1055)
  })

  it('boundary half-up exact (CR M1) : HT=1900 + bp=550 → 2005 (exact .5 → +∞)', () => {
    // Discriminant formule entière vs formule flottante :
    //   `Math.round(1900 * (1 + 550/10000))` → 2004 (1900*1.055 = 2004.4999...)
    //   `Math.round((1900 * 10550) / 10000)` → 2005 (exact half-up)
    // Garantit qu'on est sur la formule entière, alignée moteur.
    const line = baseLine({
      credit_amount_cents: 1900,
      vat_rate_bp_snapshot: 550,
    })
    expect(creditTtcCents(line)).toBe(2005)
  })

  it('arrondi half-up : HT=333 + bp=550 → 351 (333 × 1.055 = 351.315 → 351)', () => {
    const line = baseLine({
      credit_amount_cents: 333,
      vat_rate_bp_snapshot: 550,
    })
    expect(creditTtcCents(line)).toBe(351)
  })

  it('arrondi half-up : HT=100 + bp=1500 (TVA 15%) → 115', () => {
    const line = baseLine({
      credit_amount_cents: 100,
      vat_rate_bp_snapshot: 1500,
    })
    expect(creditTtcCents(line)).toBe(115)
  })

  it('credit_amount_cents=null → null', () => {
    const line = baseLine({
      credit_amount_cents: null,
      vat_rate_bp_snapshot: 550,
    })
    expect(creditTtcCents(line)).toBeNull()
  })

  it('vat_rate_bp_snapshot=null → null', () => {
    const line = baseLine({
      credit_amount_cents: 1000,
      vat_rate_bp_snapshot: null,
    })
    expect(creditTtcCents(line)).toBeNull()
  })

  it('vat_rate_bp_snapshot=0 → TTC=HT (TVA neutre, pas null)', () => {
    const line = baseLine({
      credit_amount_cents: 1000,
      vat_rate_bp_snapshot: 0,
    })
    expect(creditTtcCents(line)).toBe(1000)
  })

  it('no-mutation : credit_amount_cents persisté reste HT après appel', () => {
    const line = baseLine({
      credit_amount_cents: 1000,
      vat_rate_bp_snapshot: 550,
    })
    const before = line.credit_amount_cents
    creditTtcCents(line)
    expect(line.credit_amount_cents).toBe(before)
    expect(line.credit_amount_cents).toBe(1000)
  })
})
