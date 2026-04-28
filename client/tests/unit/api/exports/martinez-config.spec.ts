import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as XLSX from 'xlsx'

import {
  buildSupplierExport,
  type ExportRow,
} from '../../../../api/_lib/exports/supplierExportBuilder'
import { martinezConfig } from '../../../../api/_lib/exports/martinezConfig'
import { rufinoConfig } from '../../../../api/_lib/exports/rufinoConfig'

/**
 * Story 5.6 AC #7 — tests d'intégration MARTINEZ.
 *
 * Vérifie empiriquement que :
 *   1. `martinezConfig` produit un XLSX avec en-têtes/colonnes différentes
 *      de Rufino et la traduction `value_es` (DETERIORADO via sav_cause).
 *   2. Même dataset passé aux 2 configs → buffers/headers divergents
 *      (preuve config-driven).
 *   3. La requête SQL filtre bien sur `supplier_code='MARTINEZ'`.
 *   4. Re-vérification implicite du test guard FR36 : aucune référence
 *      MARTINEZ dans `supplierExportBuilder.ts` (assertion explicite ici
 *      en plus du fichier `supplier-export-builder.guard.spec.ts`).
 */

const TRANSLATIONS = [
  { list_code: 'sav_cause', value: 'Abîmé', value_es: 'estropeado' },
  { list_code: 'sav_cause', value: 'Pourri', value_es: 'podrido' },
  { list_code: 'sav_cause', value: 'Manquant', value_es: null },
]

function makeRow(overrides: Partial<ExportRow> = {}): ExportRow {
  return {
    id: 1,
    qty_invoiced: 4,
    piece_to_kg_weight_g: 3000,
    unit_price_ht_cents: 1500,
    vat_rate_bp_snapshot: 550,
    credit_coefficient: 1,
    credit_amount_cents: 6000,
    validation_messages: [{ kind: 'cause', text: 'Abîmé' }],
    product: {
      code: 'NEC-001',
      name_fr: 'Nectarine jaune',
      supplier_code: 'MARTINEZ',
      default_unit: 'kg',
      vat_rate_bp: 550,
    },
    sav: {
      id: 20,
      reference: 'SAV-2026-00100',
      received_at: '2026-02-10T09:00:00Z',
      invoice_ref: 'FAC-MTZ-001',
      member: {
        id: 200,
        first_name: 'Marie',
        last_name: 'Lambert',
        pennylane_customer_id: 'PN-MTZ-1',
      },
    },
    ...overrides,
  }
}

interface SupabaseCalls {
  sav_lines_select: string | null
  sav_lines_eq: { col: string; val: unknown } | null
  sav_lines_orders: { col: string; opts: unknown }[]
}

function makeSupabaseMock(rows: ExportRow[]) {
  const calls: SupabaseCalls = {
    sav_lines_select: null,
    sav_lines_eq: null,
    sav_lines_orders: [],
  }

  function savLinesBuilder() {
    const chain: Record<string, unknown> = {
      select: (cols: string) => {
        calls.sav_lines_select = cols
        return chain
      },
      gte: () => chain,
      lt: () => chain,
      eq: (col: string, val: unknown) => {
        calls.sav_lines_eq = { col, val }
        return chain
      },
      in: () => chain,
      order: (col: string, opts: unknown) => {
        calls.sav_lines_orders.push({ col, opts })
        return chain
      },
      range: () => Promise.resolve({ data: rows, error: null }),
    }
    return chain
  }

  function validationListsBuilder() {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => Promise.resolve({ data: TRANSLATIONS, error: null }),
    }
    return chain
  }

  const client = {
    from: (table: string) => {
      if (table === 'sav_lines') return savLinesBuilder()
      if (table === 'validation_lists') return validationListsBuilder()
      throw new Error(`Unexpected table: ${table}`)
    },
  }

  return { client, calls }
}

function readSheet(buffer: Buffer): {
  headers: string[]
  rows: Record<string, unknown>[]
  sheet: XLSX.WorkSheet
} {
  const wb = XLSX.read(buffer, { type: 'buffer' })
  const sheet = wb.Sheets[wb.SheetNames[0]!]!
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null }) as unknown[][]
  const headers = aoa[0] as string[]
  const rows: Record<string, unknown>[] = []
  for (let i = 1; i < aoa.length; i++) {
    const r: Record<string, unknown> = {}
    const arr = aoa[i]!
    for (let j = 0; j < headers.length; j++) {
      r[headers[j]!] = arr[j]
    }
    rows.push(r)
  }
  return { headers, rows, sheet }
}

describe('buildSupplierExport — martinezConfig (Story 5.6)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  it('happy path 3 lignes : en-têtes MARTINEZ, DETERIORADO traduit, TOTAL formule, file_name correct', async () => {
    const rows = [
      makeRow({ id: 1, qty_invoiced: 4, unit_price_ht_cents: 1500 }),
      makeRow({
        id: 2,
        qty_invoiced: 2,
        unit_price_ht_cents: 2000,
        validation_messages: [{ kind: 'cause', text: 'Pourri' }],
      }),
      makeRow({ id: 3, qty_invoiced: 1, unit_price_ht_cents: 900 }),
    ]
    const { client } = makeSupabaseMock(rows)

    const result = await buildSupplierExport({
      config: martinezConfig,
      period_from: new Date('2026-02-01T00:00:00Z'),
      period_to: new Date('2026-02-28T00:00:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
    })

    expect(result.line_count).toBe(3)
    expect(result.file_name).toBe('MARTINEZ_2026-02-01_2026-02-28.xlsx')

    // CR Story 5.6 P14 — Lock la divergence intentionnelle entre la
    // formule XLSX TOTAL=CANTIDAD*PRECIO_UNIT (qty * prix euros) et le
    // calcul builder `total_amount_cents = sum(round(piece_g * price_cents / 1000))`
    // (kg * prix cents). Avec qty=4|2|1, piece_g=3000, price_cents=1500|2000|900 :
    //   ligne 1: round(3000*1500/1000) = 4500 cents
    //   ligne 2: round(3000*2000/1000) = 6000 cents
    //   ligne 3: round(3000*900/1000)  = 2700 cents
    //   total = 13200 cents
    // (vs XLSX SUM(TOTAL) = 4*15+2*20+1*9 = 109€).
    expect(result.total_amount_cents).toBe(13200n)

    const { headers, rows: outRows, sheet } = readSheet(result.buffer)
    expect(headers).toEqual([
      'FECHA_RECEPCION',
      'NUM_PEDIDO',
      'ALBARÁN',
      'CLIENTE_FRUIT',
      'DESCRIPCIÓN_ES',
      'CANTIDAD',
      'PESO_KG',
      'PRECIO_UNIT',
      'TOTAL',
      'DETERIORADO',
    ])
    expect(outRows).toHaveLength(3)
    expect(outRows[0]!['DETERIORADO']).toBe('estropeado')
    expect(outRows[1]!['DETERIORADO']).toBe('podrido')

    // TOTAL est une formule (pas pré-calculée). Position colonne I = 9e
    // (1-based) → cellule I2, I3, I4 pour 3 lignes data.
    for (const [rowIdx, expected] of [
      [2, '=F2*H2'],
      [3, '=F3*H3'],
      [4, '=F4*H4'],
    ] as const) {
      const cell = sheet[`I${rowIdx}`]
      expect(cell, `cell I${rowIdx} missing`).toBeDefined()
      expect(cell!.f).toBe(expected)
    }
  })

  it('MARTINEZ vs RUFINO — même dataset, headers et nombre colonnes divergents (preuve config-driven)', async () => {
    const dataset = [
      makeRow({ id: 1 }),
      makeRow({
        id: 2,
        product: {
          code: 'NEC-002',
          name_fr: 'Nectarine blanche',
          supplier_code: 'RUFINO',
          default_unit: 'kg',
          vat_rate_bp: 550,
        },
      }),
    ]

    // Builds back-to-back avec exactement le même dataset (le builder est
    // pur fonction config + rows).
    const { client: clientMartinez } = makeSupabaseMock(dataset)
    const martinezResult = await buildSupplierExport({
      config: martinezConfig,
      period_from: new Date('2026-02-01T00:00:00Z'),
      period_to: new Date('2026-02-28T00:00:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: clientMartinez as any,
    })

    const { client: clientRufino } = makeSupabaseMock(dataset)
    const rufinoResult = await buildSupplierExport({
      config: rufinoConfig,
      period_from: new Date('2026-02-01T00:00:00Z'),
      period_to: new Date('2026-02-28T00:00:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: clientRufino as any,
    })

    const martinezHeaders = readSheet(martinezResult.buffer).headers
    const rufinoHeaders = readSheet(rufinoResult.buffer).headers

    expect(martinezHeaders).not.toEqual(rufinoHeaders)
    // En-têtes spécifiques MARTINEZ absentes de Rufino
    expect(martinezHeaders).toContain('FECHA_RECEPCION')
    expect(martinezHeaders).toContain('DETERIORADO')
    expect(rufinoHeaders).toContain('FECHA')
    expect(rufinoHeaders).toContain('CAUSA')
    expect(rufinoHeaders).not.toContain('FECHA_RECEPCION')
    expect(martinezHeaders).not.toContain('CAUSA')

    // File names divergents (templates différents)
    expect(martinezResult.file_name).toMatch(/^MARTINEZ_/)
    expect(rufinoResult.file_name).toMatch(/^RUFINO_/)
  })

  it('filtre SQL : la requête contient bien `supplier_code = MARTINEZ` (traçabilité)', async () => {
    const { client, calls } = makeSupabaseMock([makeRow()])
    await buildSupplierExport({
      config: martinezConfig,
      period_from: new Date('2026-02-01T00:00:00Z'),
      period_to: new Date('2026-02-28T00:00:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
    })
    expect(calls.sav_lines_eq).toEqual({ col: 'product.supplier_code', val: 'MARTINEZ' })
  })

  it('PESO_KG en format integer : 3000g → 3 (vs Rufino decimal qui rendrait 3.0)', async () => {
    const { client } = makeSupabaseMock([
      makeRow({ piece_to_kg_weight_g: 3500 }), // 3.5 kg → tronqué à 3
    ])
    const result = await buildSupplierExport({
      config: martinezConfig,
      period_from: new Date('2026-02-01T00:00:00Z'),
      period_to: new Date('2026-02-28T00:00:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
    })
    const { rows: outRows } = readSheet(result.buffer)
    expect(outRows[0]!['PESO_KG']).toBe(3)
  })

  it('guard FR36 — aucune référence hardcodée MARTINEZ dans supplierExportBuilder.ts (re-check)', async () => {
    // Story 5.6 sentry : on duplique l'assertion du guard pour qu'elle
    // soit également déclenchée côté tests MARTINEZ. Si un dev ajoute
    // `if (supplier === 'MARTINEZ')` dans le builder, ce test casse en
    // même temps que `supplier-export-builder.guard.spec.ts`.
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { resolve, dirname } = await import('node:path')
    const here = dirname(fileURLToPath(import.meta.url))
    const builderPath = resolve(here, '../../../../api/_lib/exports/supplierExportBuilder.ts')
    const source = readFileSync(builderPath, 'utf8')
    expect(source).not.toMatch(/\bmartinez\b/i)
    expect(source).not.toMatch(/['"]MARTINEZ['"]/)
  })
})
