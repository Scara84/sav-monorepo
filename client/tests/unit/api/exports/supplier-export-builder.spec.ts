import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest'
import * as XLSX from 'xlsx'

import {
  buildSupplierExport,
  type ExportRow,
  type SupplierExportConfig,
} from '../../../../api/_lib/exports/supplierExportBuilder'
import { rufinoConfig } from '../../../../api/_lib/exports/rufinoConfig'

// ---------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------

function makeRow(overrides: Partial<ExportRow> = {}): ExportRow {
  return {
    id: 1,
    qty_invoiced: 3,
    piece_to_kg_weight_g: 2500,
    unit_price_ht_cents: 1250,
    vat_rate_bp_snapshot: 550,
    credit_coefficient: 1,
    credit_amount_cents: 3125,
    validation_messages: [{ kind: 'cause', text: 'Abîmé' }],
    product: {
      code: 'PECHE-001',
      name_fr: 'Pêche jaune',
      supplier_code: 'RUFINO',
      default_unit: 'kg',
      vat_rate_bp: 550,
    },
    sav: {
      id: 10,
      reference: 'SAV-2026-00042',
      received_at: '2026-01-15T14:30:00Z',
      invoice_ref: 'FAC-001',
      member: {
        id: 100,
        first_name: 'Jean',
        last_name: 'Dupont',
        pennylane_customer_id: 'PN-1',
      },
    },
    ...overrides,
  }
}

const TRANSLATIONS = [
  { list_code: 'sav_cause', value: 'Abîmé', value_es: 'estropeado' },
  { list_code: 'sav_cause', value: 'Pourri', value_es: 'podrido' },
  { list_code: 'sav_cause', value: 'Manquant', value_es: null },
  { list_code: 'sav_cause', value: 'VideString', value_es: '' },
  { list_code: 'bon_type', value: 'AVOIR', value_es: 'ABONO' },
]

// Mock supabase minimal : supporte sav_lines.select(...).<filtres>.order(...)
// avec capture des args pour vérifier le SQL, et validation_lists.select().eq().
function makeSupabaseMock(
  rows: ExportRow[],
  options: { savLinesError?: { message: string } } = {}
) {
  const calls = {
    sav_lines_select: null as string | null,
    sav_lines_gte: null as { col: string; val: unknown } | null,
    sav_lines_lt: null as { col: string; val: unknown } | null,
    sav_lines_eq: null as { col: string; val: unknown } | null,
    sav_lines_in: null as { col: string; val: unknown[] } | null,
    sav_lines_orders: [] as { col: string; opts: unknown }[],
    sav_lines_range: null as { from: number; to: number } | null,
    validation_lists_eq: null as { col: string; val: unknown } | null,
  }

  function savLinesBuilder() {
    const chain: Record<string, unknown> = {
      select: (cols: string) => {
        calls.sav_lines_select = cols
        return chain
      },
      gte: (col: string, val: unknown) => {
        calls.sav_lines_gte = { col, val }
        return chain
      },
      lt: (col: string, val: unknown) => {
        calls.sav_lines_lt = { col, val }
        return chain
      },
      eq: (col: string, val: unknown) => {
        calls.sav_lines_eq = { col, val }
        return chain
      },
      in: (col: string, val: unknown[]) => {
        calls.sav_lines_in = { col, val }
        return chain
      },
      order: (col: string, opts: unknown) => {
        calls.sav_lines_orders.push({ col, opts })
        return chain
      },
      range: (from: number, to: number) => {
        calls.sav_lines_range = { from, to }
        return Promise.resolve({
          data: options.savLinesError ? null : rows,
          error: options.savLinesError ?? null,
        })
      },
    }
    return chain
  }

  function validationListsBuilder() {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        calls.validation_lists_eq = { col, val }
        return Promise.resolve({ data: TRANSLATIONS, error: null })
      },
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
  rawAoA: unknown[][]
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
  return { headers, rows, rawAoA: aoa, sheet }
}

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

describe('buildSupplierExport — rufinoConfig', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let warnSpy: MockInstance<any[], any>

  beforeEach(() => {
    // Le logger interne émet warn/error via `console.error` (cf.
    // api/_lib/logger.ts:18). On spy sur console.error pour capter les
    // `logger.warn(...)`, et sur console.warn pour capter les
    // `console.warn(...)` directs (aucun après CR 5.1 — uniformisé logger).
    warnSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined) as unknown as MockInstance<unknown[], unknown>
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  it('happy path 3 lignes : 10 colonnes, CAUSA en ES, IMPORTE formule, totaux corrects', async () => {
    const rows = [
      makeRow({ id: 1 }),
      makeRow({
        id: 2,
        piece_to_kg_weight_g: 5000,
        unit_price_ht_cents: 2000,
        validation_messages: [{ kind: 'cause', text: 'Pourri' }],
      }),
      makeRow({
        id: 3,
        piece_to_kg_weight_g: 1500,
        unit_price_ht_cents: 900,
      }),
    ]
    const { client } = makeSupabaseMock(rows)

    const result = await buildSupplierExport({
      config: rufinoConfig,
      period_from: new Date('2026-01-01T00:00:00Z'),
      period_to: new Date('2026-01-31T00:00:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
    })

    expect(result.line_count).toBe(3)
    // Total = Σ pieceKg × price_cents (cents). 2.5*1250 + 5*2000 + 1.5*900 = 3125 + 10000 + 1350 = 14475.
    expect(result.total_amount_cents).toBe(14475n)

    const { headers, rows: outRows, sheet } = readSheet(result.buffer)
    expect(headers).toEqual([
      'FECHA',
      'REFERENCE',
      'ALBARAN',
      'CLIENTE',
      'DESCRIPCIÓN',
      'UNIDADES',
      'PESO',
      'PRECIO',
      'IMPORTE',
      'CAUSA',
    ])
    expect(outRows).toHaveLength(3)
    expect(outRows[0]!['CAUSA']).toBe('estropeado')
    expect(outRows[1]!['CAUSA']).toBe('podrido')

    // IMPORTE doit être une formule Excel (pas une valeur pré-calculée).
    // CR 5.1 LOW : vérifier toutes les lignes (I2, I3, I4) — protège contre
    // un off-by-one dans la boucle de patching.
    for (const [rowIdx, expected] of [
      [2, '=G2*H2'],
      [3, '=G3*H3'],
      [4, '=G4*H4'],
    ] as const) {
      const cellRef = `I${rowIdx}`
      const cell = sheet[cellRef]
      expect(cell, `cell ${cellRef} missing`).toBeDefined()
      expect(cell!.f).toBe(expected)
    }
  })

  it('traduction manquante (value_es NULL) → fallback FR + warning loggé', async () => {
    const rows = [
      makeRow({
        id: 1,
        validation_messages: [{ kind: 'cause', text: 'Manquant' }],
      }),
    ]
    const { client } = makeSupabaseMock(rows)

    const result = await buildSupplierExport({
      config: rufinoConfig,
      period_from: new Date('2026-01-01T00:00:00Z'),
      period_to: new Date('2026-01-31T00:00:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
    })
    const { rows: outRows } = readSheet(result.buffer)
    expect(outRows[0]!['CAUSA']).toBe('Manquant')
    const warnedOnTranslationMiss = warnSpy.mock.calls.some((args) => {
      const msg = args[0]
      return typeof msg === 'string' && msg.includes('export.translation.missing')
    })
    expect(warnedOnTranslationMiss).toBe(true)
  })

  it('value_es = empty string traité comme manquant', async () => {
    const rows = [
      makeRow({
        id: 1,
        validation_messages: [{ kind: 'cause', text: 'VideString' }],
      }),
    ]
    const { client } = makeSupabaseMock(rows)

    const result = await buildSupplierExport({
      config: rufinoConfig,
      period_from: new Date('2026-01-01T00:00:00Z'),
      period_to: new Date('2026-01-31T00:00:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
    })
    const { rows: outRows } = readSheet(result.buffer)
    expect(outRows[0]!['CAUSA']).toBe('VideString')
  })

  it('ordre des colonnes déterministe (header row)', async () => {
    const { client } = makeSupabaseMock([makeRow()])
    const result = await buildSupplierExport({
      config: rufinoConfig,
      period_from: new Date('2026-01-01T00:00:00Z'),
      period_to: new Date('2026-01-31T00:00:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
    })
    const { headers } = readSheet(result.buffer)
    expect(headers).toEqual(rufinoConfig.columns.map((c) => c.header))
  })

  it('row_filter exclut les lignes ciblées (line_count reflète après filtre)', async () => {
    const filteredConfig: SupplierExportConfig = {
      ...rufinoConfig,
      row_filter: (ctx) => (ctx.row.qty_invoiced ?? 0) > 0,
    }
    const rows = [
      makeRow({ id: 1, qty_invoiced: 3 }),
      makeRow({ id: 2, qty_invoiced: 0 }),
      makeRow({ id: 3, qty_invoiced: 2 }),
    ]
    const { client } = makeSupabaseMock(rows)
    const result = await buildSupplierExport({
      config: filteredConfig,
      period_from: new Date('2026-01-01T00:00:00Z'),
      period_to: new Date('2026-01-31T00:00:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
    })
    expect(result.line_count).toBe(2)
    const { rows: outRows } = readSheet(result.buffer)
    expect(outRows).toHaveLength(2)
  })

  it('format cents-to-euros : PRECIO en cents=1250 → cellule XLSX = 12.50', async () => {
    const { client } = makeSupabaseMock([makeRow({ unit_price_ht_cents: 1250 })])
    const result = await buildSupplierExport({
      config: rufinoConfig,
      period_from: new Date('2026-01-01T00:00:00Z'),
      period_to: new Date('2026-01-31T00:00:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
    })
    const { rows: outRows } = readSheet(result.buffer)
    expect(outRows[0]!['PRECIO']).toBe(12.5)
  })

  it('format date-iso : received_at 2026-01-15T14:30:00Z → FECHA = "2026-01-15"', async () => {
    const { client } = makeSupabaseMock([makeRow()])
    const result = await buildSupplierExport({
      config: rufinoConfig,
      period_from: new Date('2026-01-01T00:00:00Z'),
      period_to: new Date('2026-01-31T00:00:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
    })
    const { rows: outRows } = readSheet(result.buffer)
    expect(outRows[0]!['FECHA']).toBe('2026-01-15')
  })

  it('format integer : qty_invoiced=3 → UNIDADES = 3 (type number)', async () => {
    const { client } = makeSupabaseMock([makeRow({ qty_invoiced: 3 })])
    const result = await buildSupplierExport({
      config: rufinoConfig,
      period_from: new Date('2026-01-01T00:00:00Z'),
      period_to: new Date('2026-01-31T00:00:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
    })
    const { rows: outRows } = readSheet(result.buffer)
    expect(outRows[0]!['UNIDADES']).toBe(3)
    expect(typeof outRows[0]!['UNIDADES']).toBe('number')
  })

  it('PESO : piece_to_kg_weight_g=null → cellule PESO = 0 (pas NULL)', async () => {
    const { client } = makeSupabaseMock([makeRow({ piece_to_kg_weight_g: null })])
    const result = await buildSupplierExport({
      config: rufinoConfig,
      period_from: new Date('2026-01-01T00:00:00Z'),
      period_to: new Date('2026-01-31T00:00:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
    })
    const { rows: outRows } = readSheet(result.buffer)
    expect(outRows[0]!['PESO']).toBe(0)
  })

  it('file_name_template résolu avec period_from / period_to', async () => {
    const { client } = makeSupabaseMock([])
    const result = await buildSupplierExport({
      config: rufinoConfig,
      period_from: new Date('2026-01-01T00:00:00Z'),
      period_to: new Date('2026-01-31T00:00:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
    })
    expect(result.file_name).toBe('RUFINO_2026-01-01_2026-01-31.xlsx')
  })

  it('aucune donnée : buffer contient header-only, line_count=0, total=0', async () => {
    const { client } = makeSupabaseMock([])
    const result = await buildSupplierExport({
      config: rufinoConfig,
      period_from: new Date('2026-01-01T00:00:00Z'),
      period_to: new Date('2026-01-31T00:00:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
    })
    expect(result.line_count).toBe(0)
    expect(result.total_amount_cents).toBe(0n)
    const { headers, rows: outRows } = readSheet(result.buffer)
    expect(headers).toHaveLength(10)
    expect(outRows).toHaveLength(0)
  })

  it('supabase query : filtre supplier_code, status, received_at bornes + range cap + order multi', async () => {
    const { client, calls } = makeSupabaseMock([makeRow()])
    await buildSupplierExport({
      config: rufinoConfig,
      period_from: new Date('2026-01-01T00:00:00Z'),
      period_to: new Date('2026-01-31T00:00:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
    })
    expect(calls.sav_lines_eq).toEqual({ col: 'product.supplier_code', val: 'RUFINO' })
    expect(calls.sav_lines_in).toEqual({
      col: 'sav.status',
      val: ['validated', 'closed'],
    })
    expect(calls.sav_lines_gte).toEqual({
      col: 'sav.received_at',
      val: '2026-01-01T00:00:00.000Z',
    })
    // period_to exclusif (+1 jour).
    expect(calls.sav_lines_lt).toEqual({
      col: 'sav.received_at',
      val: '2026-02-01T00:00:00.000Z',
    })
    expect(calls.sav_lines_select).toContain('supplier_code')
    expect(calls.sav_lines_select).toContain('validation_messages')
    expect(calls.validation_lists_eq).toEqual({ col: 'is_active', val: true })
    // CR 5.1 LOW : `.order('id')` en secondaire pour byte-hash stable.
    expect(calls.sav_lines_orders).toHaveLength(2)
    expect(calls.sav_lines_orders[1]).toEqual({
      col: 'id',
      opts: { ascending: true },
    })
    // CR 5.1 HIGH + v2 fix off-by-one : `.range(0, MAX)` (inclusive) pour
    // demander MAX+1 rows max. Dataset légitime à MAX rows exactement ne
    // throw plus ; seul l'overflow (> MAX) déclenche EXPORT_VOLUME_CAP_EXCEEDED.
    expect(calls.sav_lines_range).toEqual({ from: 0, to: 50_000 })
  })

  it('DB error translations → throw avec message explicite', async () => {
    const badClient = {
      from: (table: string) => {
        if (table === 'validation_lists') {
          return {
            select: () => ({
              eq: () => Promise.resolve({ data: null, error: { message: 'boom' } }),
            }),
          }
        }
        throw new Error(`Unexpected table: ${table}`)
      },
    }
    await expect(
      buildSupplierExport({
        config: rufinoConfig,
        period_from: new Date('2026-01-01T00:00:00Z'),
        period_to: new Date('2026-01-31T00:00:00Z'),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        supabase: badClient as any,
      })
    ).rejects.toThrow(/Translations load failed/)
  })

  it('DB error sav_lines → throw Export query failed', async () => {
    const { client } = makeSupabaseMock([], { savLinesError: { message: 'pg-down' } })
    await expect(
      buildSupplierExport({
        config: rufinoConfig,
        period_from: new Date('2026-01-01T00:00:00Z'),
        period_to: new Date('2026-01-31T00:00:00Z'),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        supabase: client as any,
      })
    ).rejects.toThrow(/Export query failed: pg-down/)
  })

  // ──────────────────────────────────────────────────────────────
  // CR 5.1 — tests de régression post-code-review
  // ──────────────────────────────────────────────────────────────

  it('CR HIGH — cellule texte commençant par "=" est préfixée "\'" (anti formula injection)', async () => {
    const rows = [
      makeRow({
        sav: {
          id: 10,
          reference: 'SAV-2026-00042',
          received_at: '2026-01-15T14:30:00Z',
          invoice_ref: '@SUM(A1:A10)',
          member: {
            id: 100,
            first_name: 'Jean',
            last_name: '=cmd|"/c calc"!A1',
            pennylane_customer_id: 'PN-1',
          },
        },
      }),
    ]
    const { client } = makeSupabaseMock(rows)
    const result = await buildSupplierExport({
      config: rufinoConfig,
      period_from: new Date('2026-01-01T00:00:00Z'),
      period_to: new Date('2026-01-31T00:00:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
    })
    const { rows: outRows } = readSheet(result.buffer)
    expect(outRows[0]!['CLIENTE']).toMatch(/^'=cmd/)
    expect(outRows[0]!['ALBARAN']).toBe("'@SUM(A1:A10)")
  })

  it('CR HIGH — volume cap dépassé (> MAX) → throw EXPORT_VOLUME_CAP_EXCEEDED', async () => {
    // Post-fix off-by-one (CR v2 HIGH) : MAX rows exactement = pass ;
    // MAX+1 (ou plus) = throw. `.range(0, MAX)` inclusive request donc le
    // serveur peut renvoyer jusqu'à MAX+1 rows → on throw si on atteint
    // ce seuil (signal d'overflow).
    const { buildSupplierExport: buildReal, MAX_ROWS_PER_EXPORT } = await import(
      '../../../../api/_lib/exports/supplierExportBuilder'
    )
    const tooMany = Array.from({ length: MAX_ROWS_PER_EXPORT + 1 }, (_, i) =>
      makeRow({ id: i + 1 })
    )
    const { client } = makeSupabaseMock(tooMany)
    await expect(
      buildReal({
        config: rufinoConfig,
        period_from: new Date('2026-01-01T00:00:00Z'),
        period_to: new Date('2026-01-31T00:00:00Z'),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        supabase: client as any,
      })
    ).rejects.toThrow(/EXPORT_VOLUME_CAP_EXCEEDED/)
  }, 60_000)

  it('CR MED — period_to non-midnight UTC est normalisé à minuit UTC', async () => {
    const { client, calls } = makeSupabaseMock([])
    await buildSupplierExport({
      config: rufinoConfig,
      period_from: new Date('2026-01-01T15:37:22.123Z'),
      period_to: new Date('2026-01-31T23:30:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
    })
    // period_from normalisé → 2026-01-01T00:00:00.000Z.
    expect(calls.sav_lines_gte!.val).toBe('2026-01-01T00:00:00.000Z')
    // period_to normalisé puis +1j → 2026-02-01T00:00:00.000Z.
    expect(calls.sav_lines_lt!.val).toBe('2026-02-01T00:00:00.000Z')
  })

  it('CR MED — row_filter exception → skip ligne + continue (pas de rejet global)', async () => {
    const rows = [makeRow({ id: 1 }), makeRow({ id: 2 }), makeRow({ id: 3 })]
    const configBoom: SupplierExportConfig = {
      ...rufinoConfig,
      row_filter: (ctx) => {
        if (ctx.row.id === 2) throw new Error('boom')
        return true
      },
    }
    const { client } = makeSupabaseMock(rows)
    const result = await buildSupplierExport({
      config: configBoom,
      period_from: new Date('2026-01-01T00:00:00Z'),
      period_to: new Date('2026-01-31T00:00:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
    })
    expect(result.line_count).toBe(2) // row 1 et 3 passent, row 2 skipped.
  })

  it('CR MED — total_amount_cents en arithmétique entière (pas de divergence float)', async () => {
    // piece_g=333, price_cents=777 → expected 333*777/1000 = 258.741 → round 259.
    const rows = [makeRow({ piece_to_kg_weight_g: 333, unit_price_ht_cents: 777 })]
    const { client } = makeSupabaseMock(rows)
    const result = await buildSupplierExport({
      config: rufinoConfig,
      period_from: new Date('2026-01-01T00:00:00Z'),
      period_to: new Date('2026-01-31T00:00:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
    })
    expect(result.total_amount_cents).toBe(259n)
  })

  it('CR MED — sanitize file_name : caractères non-whitelist → "_", ".." écrasé + warn émis', async () => {
    const maliciousConfig: SupplierExportConfig = {
      ...rufinoConfig,
      file_name_template: '../etc/passwd_{period_from}.xlsx',
    }
    const { client } = makeSupabaseMock([])
    const result = await buildSupplierExport({
      config: maliciousConfig,
      period_from: new Date('2026-01-01T00:00:00Z'),
      period_to: new Date('2026-01-31T00:00:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
    })
    expect(result.file_name).not.toMatch(/\.\./) // pas de ..
    expect(result.file_name).not.toMatch(/\//) // pas de /
    expect(result.file_name).toMatch(/^_+etc_passwd_2026-01-01\.xlsx$/)
    // CR v2 — vérifier qu'on a bien logué le sanitize (protection refactor).
    const warnedOnFilename = warnSpy.mock.calls.some((args) => {
      const msg = args[0]
      return typeof msg === 'string' && msg.includes('export.filename.sanitized')
    })
    expect(warnedOnFilename).toBe(true)
  })

  it('CR MED — proto-pollution translations : list_code="__proto__" ne pollue pas Object.prototype', async () => {
    const polluted = [
      { list_code: '__proto__', value: 'isAdmin', value_es: 'yes' },
      { list_code: 'sav_cause', value: 'Abîmé', value_es: 'estropeado' },
    ]
    const client = {
      from: (table: string) => {
        if (table === 'validation_lists') {
          return {
            select: () => ({
              eq: () => Promise.resolve({ data: polluted, error: null }),
            }),
          }
        }
        if (table === 'sav_lines') {
          const chain: Record<string, unknown> = {
            select: () => chain,
            gte: () => chain,
            lt: () => chain,
            eq: () => chain,
            in: () => chain,
            order: () => chain,
            range: () => Promise.resolve({ data: [makeRow()], error: null }),
          }
          return chain
        }
        throw new Error(`Unexpected table: ${table}`)
      },
    }
    await buildSupplierExport({
      config: rufinoConfig,
      period_from: new Date('2026-01-01T00:00:00Z'),
      period_to: new Date('2026-01-31T00:00:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
    })
    // Object.prototype ne doit PAS avoir reçu de clé 'isAdmin'.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(({} as any).isAdmin).toBeUndefined()
    // CR v2 — preuve plus forte : un objet neuf ne doit pas hériter de la
    // pollution (si `map = {}` au lieu de `Object.create(null)`, cette check
    // casserait aussi via Object.prototype).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(Object.prototype.hasOwnProperty.call({}, 'isAdmin')).toBe(false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((Object.prototype as any).isAdmin).toBeUndefined()
  })

  it('CR v2 LOW — formula statique (sans "{row}") accepté + warn (ex. =NOW())', async () => {
    const staticConfig: SupplierExportConfig = {
      ...rufinoConfig,
      formulas: { IMPORTE: '=NOW()' }, // pas de {row} — formule statique légitime
    }
    const { client } = makeSupabaseMock([makeRow()])
    const result = await buildSupplierExport({
      config: staticConfig,
      period_from: new Date('2026-01-01T00:00:00Z'),
      period_to: new Date('2026-01-31T00:00:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
    })
    expect(result.line_count).toBe(1)
    const warnedOnStatic = warnSpy.mock.calls.some((args) => {
      const msg = args[0]
      return typeof msg === 'string' && msg.includes('export.formula.static')
    })
    expect(warnedOnStatic).toBe(true)
  })

  it('CR LOW — formula absente (key non résolue dans config.formulas) → throw EXPORT_FORMULA_INVALID', async () => {
    const badConfig: SupplierExportConfig = {
      ...rufinoConfig,
      formulas: {}, // IMPORTE manquant
    }
    const { client } = makeSupabaseMock([makeRow()])
    await expect(
      buildSupplierExport({
        config: badConfig,
        period_from: new Date('2026-01-01T00:00:00Z'),
        period_to: new Date('2026-01-31T00:00:00Z'),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        supabase: client as any,
      })
    ).rejects.toThrow(/EXPORT_FORMULA_INVALID/)
  })

  // ──────────────────────────────────────────────────────────────
  // CR 5.1 PASSE 2 — tests de régression
  // ──────────────────────────────────────────────────────────────

  it('CR v2 HIGH — sanitize bypass : whitespace/BOM/fullwidth/ZWSP préfixés', async () => {
    const cases: { last_name: string; mustStartWith: string }[] = [
      { last_name: ' =HYPERLINK(...)', mustStartWith: "' =" }, // espace-prefix
      { last_name: '\u200B=DDEAUTO(...)', mustStartWith: "'\u200B=" }, // ZWSP
      { last_name: '\uFEFF=WEBSERVICE(...)', mustStartWith: "'\uFEFF=" }, // BOM
      { last_name: '＝HYPERLINK(...)', mustStartWith: "'＝" }, // fullwidth
    ]
    for (const c of cases) {
      const rows = [
        makeRow({
          sav: {
            id: 10,
            reference: 'SAV-2026-00042',
            received_at: '2026-01-15T14:30:00Z',
            invoice_ref: 'FAC-001',
            member: {
              id: 100,
              first_name: null,
              last_name: c.last_name,
              pennylane_customer_id: 'PN-1',
            },
          },
        }),
      ]
      const { client } = makeSupabaseMock(rows)
      const result = await buildSupplierExport({
        config: rufinoConfig,
        period_from: new Date('2026-01-01T00:00:00Z'),
        period_to: new Date('2026-01-31T00:00:00Z'),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        supabase: client as any,
      })
      const { rows: outRows } = readSheet(result.buffer)
      const cliente = outRows[0]!['CLIENTE'] as string
      expect(
        cliente.startsWith(c.mustStartWith),
        `bypass on ${JSON.stringify(c.last_name)} → ${JSON.stringify(cliente)}`
      ).toBe(true)
    }
  })

  it('CR v2 HIGH — volume cap exact MAX_ROWS_PER_EXPORT : pas de throw (fix off-by-one)', async () => {
    const { MAX_ROWS_PER_EXPORT, buildSupplierExport: buildReal } = await import(
      '../../../../api/_lib/exports/supplierExportBuilder'
    )
    const exactCap = Array.from({ length: MAX_ROWS_PER_EXPORT }, (_, i) => makeRow({ id: i + 1 }))
    const { client } = makeSupabaseMock(exactCap)
    const result = await buildReal({
      config: rufinoConfig,
      period_from: new Date('2026-01-01T00:00:00Z'),
      period_to: new Date('2026-01-31T00:00:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
    })
    expect(result.line_count).toBe(MAX_ROWS_PER_EXPORT)
  }, 60_000)

  it('CR v2 MED — validation_list sanitize protège admin-seeded "=HYPERLINK(...)" en value_es', async () => {
    const polluted = [
      { list_code: 'sav_cause', value: 'Piège', value_es: '=HYPERLINK("http://evil.com","click")' },
    ]
    const client = {
      from: (table: string) => {
        if (table === 'validation_lists') {
          return {
            select: () => ({
              eq: () => Promise.resolve({ data: polluted, error: null }),
            }),
          }
        }
        if (table === 'sav_lines') {
          const row = makeRow({
            validation_messages: [{ kind: 'cause', text: 'Piège' }],
          })
          const chain: Record<string, unknown> = {
            select: () => chain,
            gte: () => chain,
            lt: () => chain,
            eq: () => chain,
            in: () => chain,
            order: () => chain,
            range: () => Promise.resolve({ data: [row], error: null }),
          }
          return chain
        }
        throw new Error(`Unexpected table: ${table}`)
      },
    }
    const result = await buildSupplierExport({
      config: rufinoConfig,
      period_from: new Date('2026-01-01T00:00:00Z'),
      period_to: new Date('2026-01-31T00:00:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
    })
    const { rows: outRows } = readSheet(result.buffer)
    // Le computed CAUSA de rufinoConfig applique le lookup direct (pas le
    // resolver validation_list de M1) — c'est donc ici le sanitize final
    // `formatValue(text)` qui protège la cellule.
    const causa = outRows[0]!['CAUSA'] as string
    expect(causa.startsWith("'=")).toBe(true)
  })

  it('CR v2 MED — BigInt(NaN)/Infinity sur contribCents : skip + warn, pas de throw', async () => {
    const rows = [
      // Infinity via produit qui overflow — on force un pieceG monstrueux.
      makeRow({ piece_to_kg_weight_g: Number.POSITIVE_INFINITY, unit_price_ht_cents: 1000 }),
      makeRow({ piece_to_kg_weight_g: 2500, unit_price_ht_cents: 1250 }), // ligne OK
    ]
    const { client } = makeSupabaseMock(rows)
    const result = await buildSupplierExport({
      config: rufinoConfig,
      period_from: new Date('2026-01-01T00:00:00Z'),
      period_to: new Date('2026-01-31T00:00:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
    })
    // 2 lignes data (pas de rejet global), total agrège uniquement la 2ᵉ.
    expect(result.line_count).toBe(2)
    expect(result.total_amount_cents).toBe(3125n) // 2.5 * 1250
    const warnedOnNonFinite = warnSpy.mock.calls.some((args) => {
      const msg = args[0]
      return typeof msg === 'string' && msg.includes('export.total.nonfinite')
    })
    expect(warnedOnNonFinite).toBe(true)
  })

  it('CR v2 MED — row_filter 100% failures → throw EXPORT_ROW_FILTER_ALL_FAILED', async () => {
    const allFail: SupplierExportConfig = {
      ...rufinoConfig,
      row_filter: () => {
        throw new Error('config buguée')
      },
    }
    const { client } = makeSupabaseMock([makeRow({ id: 1 }), makeRow({ id: 2 })])
    await expect(
      buildSupplierExport({
        config: allFail,
        period_from: new Date('2026-01-01T00:00:00Z'),
        period_to: new Date('2026-01-31T00:00:00Z'),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        supabase: client as any,
      })
    ).rejects.toThrow(/EXPORT_ROW_FILTER_ALL_FAILED/)
  })

  it('CR v2 LOW — projection SQL contient `status` (cohérence filtre↔select)', async () => {
    const { client, calls } = makeSupabaseMock([])
    await buildSupplierExport({
      config: rufinoConfig,
      period_from: new Date('2026-01-01T00:00:00Z'),
      period_to: new Date('2026-01-31T00:00:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
    })
    expect(calls.sav_lines_select).toContain('status')
  })

  it('CR MED (Option C) — getPath warn sur traversée cassée, pas sur terminal null', async () => {
    // Cas 1 : terminal null (first_name null) → pas de warn.
    const rows = [
      makeRow({
        sav: {
          id: 10,
          reference: 'SAV-2026-00042',
          received_at: '2026-01-15T14:30:00Z',
          invoice_ref: 'FAC-001',
          member: {
            id: 100,
            first_name: null, // null terminal légitime
            last_name: 'Dupont',
            pennylane_customer_id: null,
          },
        },
      }),
    ]
    const { client } = makeSupabaseMock(rows)
    await buildSupplierExport({
      config: rufinoConfig,
      period_from: new Date('2026-01-01T00:00:00Z'),
      period_to: new Date('2026-01-31T00:00:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
    })
    const warnedOnPathBroken = warnSpy.mock.calls.some((args) => {
      const msg = args[0]
      return typeof msg === 'string' && msg.includes('export.path.broken')
    })
    expect(warnedOnPathBroken).toBe(false)
  })
})
