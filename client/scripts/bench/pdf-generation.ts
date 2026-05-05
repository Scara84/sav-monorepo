#!/usr/bin/env tsx
/**
 * Story 4.5 AC #11 — bench rendu PDF bon SAV.
 *
 * Lance N rendus consécutifs de `buildCreditNotePdf` via
 * `@react-pdf/renderer.renderToBuffer` (upload OneDrive mocké) et affiche
 * p50 / p95 / p99.
 *
 * Usage :
 *   cd client && npx tsx scripts/bench/pdf-generation.ts [count]
 *
 * Target V1 : p95 < 2s, p99 < 10s. Le script print un `⚠` si p95 > 2s
 * mais ne fail pas (CI non-bloquant V1).
 *
 * V1.3 HARDEN-1 — lazy `await import('@react-pdf/renderer')` inside async
 * main() for spec consistency with PATTERN-V3 (defense-in-depth), even though
 * tsx runs ESM natively (no CJS cold-start risk here). Also updated call site
 * to use `buildCreditNotePdf(ReactPDF, props)` after V1.3 rename.
 */
import {
  buildCreditNotePdf,
  type CreditNotePdfProps,
  type CreditNotePdfLine,
} from '../../api/_lib/pdf/CreditNotePdf'

const COUNT = Number(process.argv[2] ?? 50)

function buildLine(n: number): CreditNotePdfLine {
  return {
    line_number: n,
    product_code_snapshot: `CODE-${n}`,
    product_name_snapshot: `Produit ${n} libellé long pour stresser le tableau`,
    qty_requested: 2 + (n % 5),
    unit_requested: 'kg',
    qty_invoiced: 2 + (n % 5),
    unit_invoiced: 'kg',
    unit_price_ht_cents: 500 + n * 10,
    credit_coefficient: 1,
    credit_coefficient_label: 'TOTAL',
    credit_amount_cents: 1000 + n * 50,
    validation_message: null,
  }
}

const props: CreditNotePdfProps = {
  creditNote: {
    id: 42,
    number: 42,
    number_formatted: 'AV-2026-00042',
    bon_type: 'AVOIR',
    total_ht_cents: 50000,
    discount_cents: 2000,
    vat_cents: 2640,
    total_ttc_cents: 50640,
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
  lines: Array.from({ length: 10 }, (_, i) => buildLine(i + 1)),
  company: {
    legal_name: 'Fruitstock SAS',
    siret: '12345678901234',
    tva_intra: 'FR12345678901',
    address_line1: '1 rue du Verger',
    postal_code: '69000',
    city: 'Lyon',
    phone: '+33 4 00 00 00 00',
    email: 'sav@fruitstock.test',
    legal_mentions_short: 'TVA acquittée sur les encaissements',
  },
  is_group_manager: true,
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)] as number
}

async function main(): Promise<void> {
  // V1.3 HARDEN-1 — lazy import for PATTERN-V3 consistency (defense-in-depth).
  // tsx runs in ESM so there is no cold-start risk here, but keeping the lazy
  // pattern ensures the bench exercises the same code path as the serverless lambda.
  const ReactPDF = await import('@react-pdf/renderer')

  console.log(`🏁 PDF bench — ${COUNT} rendus…`)
  const durations: number[] = []
  let bytes = 0
  for (let i = 0; i < COUNT; i++) {
    const t0 = Date.now()
    // V1.3 HARDEN-1 — use updated factory signature: buildCreditNotePdf(reactPdfModule, props)
    const element = buildCreditNotePdf(ReactPDF, props)
    const buffer = await (
      ReactPDF as unknown as {
        renderToBuffer: (el: unknown) => Promise<Buffer>
      }
    ).renderToBuffer(element)
    durations.push(Date.now() - t0)
    bytes = buffer.byteLength
  }
  durations.sort((a, b) => a - b)
  const p50 = percentile(durations, 50)
  const p95 = percentile(durations, 95)
  const p99 = percentile(durations, 99)
  console.log(`── stats (${COUNT} rendus, ${bytes} bytes/PDF)`)
  console.log(`  p50 = ${p50} ms`)
  console.log(`  p95 = ${p95} ms  (target < 2000)`)
  console.log(`  p99 = ${p99} ms  (target < 10000)`)
  if (p95 > 2000) console.warn(`⚠ PDF p95 = ${p95}ms > 2000 — investigate`)
  if (p99 > 10000) console.warn(`⚠ PDF p99 = ${p99}ms > 10000 — risk Vercel timeout`)
}

main().catch((err) => {
  console.error('bench failed:', err)
  process.exit(1)
})
