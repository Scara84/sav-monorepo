/**
 * Story 4.5 — composant React PDF du bon SAV (charte Fruitstock).
 *
 * Pur, stateless — consommé uniquement via `ReactPDF.renderToBuffer(...)`
 * côté serverless (`generate-credit-note-pdf.ts`).
 *
 * Déviation story : fichier en `.ts` (non `.tsx`) + `React.createElement`
 * explicite plutôt que syntaxe JSX. Raison : le `tsconfig.json` du
 * monorepo hérite de `@vue/tsconfig` avec `jsx: "preserve"` +
 * `jsxImportSource: "vue"` — vue-tsc interpréterait le JSX en JSX Vue
 * et casserait le typecheck sur les composants React de @react-pdf.
 * Passer par `createElement` contourne le problème sans toucher la
 * configuration projet et reste lisible via l'alias `h`.
 *
 * Charte visuelle : orange primaire `#F57C00`, noir texte `#222222`,
 * gris ligne `#CCCCCC`, A4 portrait (210×297 mm), marges 15 mm haut/bas
 * et 12 mm gauche/droite (Story 4.5 AC #1). Fonts built-in `Helvetica`
 * (pas d'embed TTF — évite +500 Ko bundle serveur, AC #12).
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
import * as React from 'react'
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'

import { formatEurFromCents, formatDateFr } from './formatEurPdf'

const h = React.createElement

// ---------------------------------------------------------------
// Types publics
// ---------------------------------------------------------------

export type BonType = 'AVOIR' | 'VIREMENT BANCAIRE' | 'PAYPAL'
export type Unit = 'kg' | 'piece' | 'liter'

export interface CreditNotePdfCreditNote {
  id: number
  number: number
  number_formatted: string
  bon_type: BonType
  total_ht_cents: number
  discount_cents: number
  vat_cents: number
  total_ttc_cents: number
  issued_at: string
}

export interface CreditNotePdfSav {
  reference: string
  invoice_ref: string | null
  invoice_fdp_cents: number | null
}

export interface CreditNotePdfMember {
  first_name: string | null
  last_name: string
  email: string
  phone: string | null
  address_line1: string | null
  address_line2: string | null
  postal_code: string | null
  city: string | null
}

export interface CreditNotePdfGroup {
  name: string
}

export interface CreditNotePdfLine {
  line_number: number
  product_code_snapshot: string
  product_name_snapshot: string
  qty_requested: number
  unit_requested: Unit
  qty_invoiced: number | null
  unit_invoiced: Unit | null
  unit_price_ht_cents: number | null
  credit_coefficient: number
  credit_coefficient_label: string | null
  credit_amount_cents: number | null
  validation_message: string | null
}

export interface CreditNotePdfCompany {
  legal_name: string
  siret: string
  tva_intra: string
  address_line1: string
  postal_code: string
  city: string
  phone: string
  email: string
  legal_mentions_short: string
}

export interface CreditNotePdfProps {
  creditNote: CreditNotePdfCreditNote
  sav: CreditNotePdfSav
  member: CreditNotePdfMember
  group: CreditNotePdfGroup | null
  lines: readonly CreditNotePdfLine[]
  company: CreditNotePdfCompany
  is_group_manager: boolean
}

// ---------------------------------------------------------------
// Styles charte Fruitstock
// ---------------------------------------------------------------

const FRUITSTOCK_ORANGE = '#F57C00'
const TEXT_DARK = '#222222'
const ROW_BORDER = '#CCCCCC'
const ROW_ALT = '#F7F7F7'

const styles = StyleSheet.create({
  page: {
    fontFamily: 'Helvetica',
    fontSize: 9,
    color: TEXT_DARK,
    paddingTop: 42, // 15 mm
    paddingBottom: 42,
    paddingLeft: 34, // 12 mm
    paddingRight: 34,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    borderBottom: `1pt solid ${FRUITSTOCK_ORANGE}`,
    paddingBottom: 6,
    marginBottom: 10,
  },
  logo: {
    width: 40,
    height: 40,
    backgroundColor: FRUITSTOCK_ORANGE,
    justifyContent: 'center',
    alignItems: 'center',
  },
  logoText: {
    fontSize: 10,
    color: '#FFFFFF',
    fontFamily: 'Helvetica-Bold',
  },
  companyBlock: {
    textAlign: 'right',
    fontSize: 8.5,
    lineHeight: 1.35,
  },
  companyName: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 10,
    marginBottom: 2,
    color: FRUITSTOCK_ORANGE,
  },
  title: {
    textAlign: 'center',
    fontSize: 18,
    fontFamily: 'Helvetica-Bold',
    marginVertical: 10,
    color: TEXT_DARK,
  },
  refBlock: {
    flexDirection: 'row',
    marginBottom: 10,
  },
  refCol: {
    flex: 1,
    lineHeight: 1.4,
  },
  refLabel: {
    fontFamily: 'Helvetica-Bold',
  },
  // Table
  table: {
    marginTop: 6,
    borderTop: `0.5pt solid ${ROW_BORDER}`,
    borderBottom: `0.5pt solid ${ROW_BORDER}`,
  },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: FRUITSTOCK_ORANGE,
    color: '#FFFFFF',
    fontFamily: 'Helvetica-Bold',
    paddingVertical: 4,
    paddingHorizontal: 3,
  },
  tableRow: {
    flexDirection: 'row',
    borderTop: `0.25pt solid ${ROW_BORDER}`,
    paddingVertical: 3,
    paddingHorizontal: 3,
  },
  tableRowAlt: {
    backgroundColor: ROW_ALT,
  },
  colLineNo: { width: 18, textAlign: 'center' },
  colCode: { width: 50 },
  colName: { flex: 1 },
  colQtyReq: { width: 40, textAlign: 'right' },
  colUnit: { width: 28, textAlign: 'center' },
  colQtyInv: { width: 40, textAlign: 'right' },
  colPriceHt: { width: 55, textAlign: 'right' },
  colCoef: { width: 38, textAlign: 'right' },
  colAmount: { width: 60, textAlign: 'right' },
  // Totaux
  totalsWrap: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 12,
  },
  totals: {
    width: 220,
    fontSize: 9.5,
    lineHeight: 1.55,
  },
  totalsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  totalsRowStrong: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 11,
    color: FRUITSTOCK_ORANGE,
    borderTop: `0.5pt solid ${ROW_BORDER}`,
    paddingTop: 3,
    marginTop: 3,
  },
  // Footer
  footer: {
    position: 'absolute',
    bottom: 18,
    left: 34,
    right: 34,
    fontSize: 7.5,
    color: '#666666',
    textAlign: 'center',
    borderTop: `0.5pt solid ${ROW_BORDER}`,
    paddingTop: 4,
    lineHeight: 1.3,
  },
  footerLine: {},
  pageNumber: {
    marginTop: 2,
  },
  // Note "lignes non-comptabilisées"
  notesBlock: {
    marginTop: 6,
    fontSize: 8,
    color: '#8A4400',
  },
})

// ---------------------------------------------------------------
// Helpers UI
// ---------------------------------------------------------------

const UNIT_LABEL: Record<Unit, string> = {
  kg: 'kg',
  piece: 'pce',
  liter: 'L',
}

function truncateName(raw: string, max = 40): string {
  if (raw.length <= max) return raw
  return `${raw.slice(0, max - 1).trimEnd()}…`
}

function formatQty(q: number): string {
  // Décimal fr-FR, 2 décimales max sans zéros de queue.
  if (!Number.isFinite(q)) return ''
  const s = q.toLocaleString('fr-FR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  })
  return s
}

function formatCoef(coef: number, label: string | null): string {
  if (label !== null && label.length > 0) return label
  const pct = Math.round(coef * 100)
  return `${pct} %`
}

// Titre "BON SAV" pour les paiements espèces (VIREMENT/PAYPAL), "AVOIR"
// pour le bon fiscal. Cf. Story 4.5 AC #9 cas 5.
function titleForBonType(bon: BonType): string {
  return bon === 'AVOIR' ? 'AVOIR' : 'BON SAV'
}

// ---------------------------------------------------------------
// Composant principal
// ---------------------------------------------------------------

export function CreditNotePdf(props: CreditNotePdfProps): React.ReactElement {
  const { creditNote, sav, member, group, lines, company, is_group_manager } = props

  // On filtre les lignes sans montant calculé. Elles apparaissent dans le
  // tableau avec "—" mais ne contribuent pas aux totaux.
  const ghostLines = lines.filter((l) => l.credit_amount_cents === null).length

  const clientName =
    member.first_name !== null && member.first_name.length > 0
      ? `${member.first_name} ${member.last_name}`
      : member.last_name

  return h(
    Document,
    {
      title: `${titleForBonType(creditNote.bon_type)} ${creditNote.number_formatted}`,
      author: company.legal_name,
      subject: `Bon SAV ${sav.reference}`,
      creator: company.legal_name,
      producer: '@react-pdf/renderer',
    },
    h(
      Page,
      { size: 'A4', style: styles.page, wrap: true },
      renderHeader(company),
      h(Text, { style: styles.title }, titleForBonType(creditNote.bon_type)),
      renderReferences(creditNote, sav, clientName, group),
      renderTable(lines),
      ghostLines > 0 ? renderGhostWarning(ghostLines) : null,
      renderTotals(creditNote, is_group_manager),
      renderFooter(company)
    )
  )
}

function renderHeader(company: CreditNotePdfCompany): React.ReactElement {
  return h(
    View,
    { style: styles.header, fixed: true },
    h(View, { style: styles.logo }, h(Text, { style: styles.logoText }, 'F')),
    h(
      View,
      { style: styles.companyBlock },
      h(Text, { style: styles.companyName }, company.legal_name),
      h(Text, null, company.address_line1),
      h(Text, null, `${company.postal_code} ${company.city}`),
      h(Text, null, `SIRET : ${company.siret}`),
      h(Text, null, `TVA intra : ${company.tva_intra}`)
    )
  )
}

function renderReferences(
  cn: CreditNotePdfCreditNote,
  sav: CreditNotePdfSav,
  clientName: string,
  group: CreditNotePdfGroup | null
): React.ReactElement {
  const left = [
    h(
      Text,
      { key: 'num' },
      h(Text, { style: styles.refLabel }, 'N° Avoir : '),
      cn.number_formatted
    ),
    h(
      Text,
      { key: 'date' },
      h(Text, { style: styles.refLabel }, 'Date : '),
      formatDateFr(cn.issued_at)
    ),
    h(Text, { key: 'sav' }, h(Text, { style: styles.refLabel }, 'Réf. SAV : '), sav.reference),
  ]
  const right = [
    h(Text, { key: 'client' }, h(Text, { style: styles.refLabel }, 'Client : '), clientName),
  ]
  if (group !== null) {
    right.push(
      h(Text, { key: 'grp' }, h(Text, { style: styles.refLabel }, 'Groupe : '), group.name)
    )
  }
  if (sav.invoice_ref !== null && sav.invoice_ref.length > 0) {
    right.push(
      h(
        Text,
        { key: 'inv' },
        h(Text, { style: styles.refLabel }, 'Facture liée : '),
        sav.invoice_ref
      )
    )
  }
  return h(
    View,
    { style: styles.refBlock },
    h(View, { style: styles.refCol }, ...left),
    h(View, { style: styles.refCol }, ...right)
  )
}

function renderTable(lines: readonly CreditNotePdfLine[]): React.ReactElement {
  const header = h(
    View,
    { style: styles.tableHeader, fixed: true },
    h(Text, { style: styles.colLineNo }, 'N°'),
    h(Text, { style: styles.colCode }, 'Code'),
    h(Text, { style: styles.colName }, 'Produit'),
    h(Text, { style: styles.colQtyReq }, 'Qté dem.'),
    h(Text, { style: styles.colUnit }, 'Unité'),
    h(Text, { style: styles.colQtyInv }, 'Qté fact.'),
    h(Text, { style: styles.colPriceHt }, 'Prix HT'),
    h(Text, { style: styles.colCoef }, 'Coef'),
    h(Text, { style: styles.colAmount }, 'Montant')
  )

  const body = lines.map((l, idx) => {
    const rowStyle = idx % 2 === 1 ? [styles.tableRow, styles.tableRowAlt] : [styles.tableRow]
    return h(
      View,
      {
        // CR 4.5 P14 : inclure `idx` dans la key pour éviter collisions
        // si plusieurs lignes arrivent avec `line_number` identique ou null.
        key: `line-${idx}-${l.line_number}-${l.product_code_snapshot}`,
        style: rowStyle,
        wrap: false,
      },
      h(Text, { style: styles.colLineNo }, String(l.line_number)),
      h(Text, { style: styles.colCode }, l.product_code_snapshot),
      h(Text, { style: styles.colName }, truncateName(l.product_name_snapshot)),
      h(Text, { style: styles.colQtyReq }, formatQty(l.qty_requested)),
      h(Text, { style: styles.colUnit }, UNIT_LABEL[l.unit_requested] ?? ''),
      h(
        Text,
        { style: styles.colQtyInv },
        l.qty_invoiced === null ? '—' : formatQty(l.qty_invoiced)
      ),
      h(
        Text,
        { style: styles.colPriceHt },
        l.unit_price_ht_cents === null ? '—' : formatEurFromCents(l.unit_price_ht_cents)
      ),
      h(
        Text,
        { style: styles.colCoef },
        formatCoef(l.credit_coefficient, l.credit_coefficient_label)
      ),
      h(
        Text,
        { style: styles.colAmount },
        l.credit_amount_cents === null ? '—' : formatEurFromCents(l.credit_amount_cents)
      )
    )
  })

  return h(View, { style: styles.table }, header, ...body)
}

function renderGhostWarning(count: number): React.ReactElement {
  return h(
    Text,
    { style: styles.notesBlock },
    `⚠ Lignes non-comptabilisées dans les totaux : ${count}.`
  )
}

function renderTotals(cn: CreditNotePdfCreditNote, isGroupManager: boolean): React.ReactElement {
  const rows: React.ReactElement[] = [
    h(
      View,
      { key: 'ht', style: styles.totalsRow },
      h(Text, null, 'Sous-total HT'),
      h(Text, null, formatEurFromCents(cn.total_ht_cents))
    ),
  ]
  if (isGroupManager && cn.discount_cents > 0) {
    rows.push(
      h(
        View,
        { key: 'discount', style: styles.totalsRow },
        h(Text, null, 'Remise 4 % (responsable)'),
        h(Text, null, `-${formatEurFromCents(cn.discount_cents)}`)
      )
    )
  }
  rows.push(
    h(
      View,
      { key: 'vat', style: styles.totalsRow },
      h(Text, null, 'TVA'),
      h(Text, null, formatEurFromCents(cn.vat_cents))
    )
  )
  rows.push(
    h(
      View,
      { key: 'ttc', style: [styles.totalsRow, styles.totalsRowStrong] },
      h(Text, null, 'Total TTC'),
      h(Text, null, formatEurFromCents(cn.total_ttc_cents))
    )
  )
  return h(View, { style: styles.totalsWrap }, h(View, { style: styles.totals }, ...rows))
}

function renderFooter(company: CreditNotePdfCompany): React.ReactElement {
  return h(
    View,
    { style: styles.footer, fixed: true },
    h(Text, { style: styles.footerLine }, company.legal_mentions_short),
    h(
      Text,
      { style: styles.footerLine },
      `${company.legal_name} — SIRET ${company.siret} — Tél. ${company.phone} — ${company.email}`
    ),
    h(Text, {
      style: styles.pageNumber,
      render: (pg: { pageNumber: number; totalPages: number }) =>
        `Page ${pg.pageNumber} / ${pg.totalPages}`,
    })
  )
}
