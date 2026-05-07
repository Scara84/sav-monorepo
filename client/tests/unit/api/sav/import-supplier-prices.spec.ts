/**
 * Story 4.8 — AC #6 : Tests handler import prix fournisseur
 *
 * Test type: UNIT (handler isolated via vi.mock — no real DB, no real xlsx parse)
 *
 * AC coverage:
 *   AC #6(a) — CSV valide 3 lignes match exact → matched.length=3, unmatched=0, errors=0
 *   AC #6(b) — XLSX valide 5 lignes dont 2 unmatched → matched=3, unmatched=2, errors=0
 *   AC #6(c) — Format invalide (colonnes manquantes) → 400 INVALID_FORMAT
 *   AC #6(d) — Fichier > 5 MB → 413 PAYLOAD_TOO_LARGE
 *   AC #6(e) — MIME pas whitelist → 415 UNSUPPORTED_MEDIA_TYPE
 *   AC #6(f) — Idempotence apply : 2e PATCH → met à jour supplier_price_imported_at sans erreur
 *   AC #6(g) — Cross-SAV protection : lineId d'un autre SAV/groupe → 403/404
 *   AC #6(h) — Formula injection guard : =cmd|'/c calc'!A1 traité comme texte (préfixe ')
 *
 * Mock strategy:
 *   - supabaseAdmin: vi.hoisted mutable db state object
 *   - xlsx library: mocked via __mocks__/xlsx.js (anti-parse) + configurable sheet data
 *   - recordAudit: vi.mock no-op to avoid DB side-effects
 *   - Rate limit: mocked as always allowed (not under test here)
 *
 * DN decisions reflected:
 *   DN-1: headers français (Code, Quantité, PU HT, Réf. fournisseur) — insensible casse
 *   DN-2: apply via RPC SECURITY DEFINER
 *   DN-3: formula injection → préfixe ' silencieux (OWASP)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

// ---------------------------------------------------------------------------
// Hoisted mocks — mutable DB state
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => ({
  // rows renvoyées par FROM sav_lines WHERE sav_id = :id
  savLines: [] as Array<{
    id: number
    product_code_snapshot: string
    unit_price_ttc_cents: number | null
  }>,
  // résultat RPC apply_supplier_prices_for_sav
  applyRpcData: null as unknown,
  applyRpcError: null as unknown,
  // résultat rate limit
  rateLimitAllowed: true as boolean,
  // état du SAV pour check groupe (groupe de l'opérateur = groupe du SAV)
  savGroupId: 1 as number,
  operatorGroupIds: [1] as number[],
  // M-6: audit trail capturedArgs (captured by recordAudit mock)
  auditCaptured: null as unknown,
  // M-8: stateful rows store — simulates in-memory DB state for idempotence test
  storedRows: {} as Record<
    number,
    { supplier_price_imported_at: string; supplier_price_source: string }
  >,
  // M-8: call counter to simulate different timestamps
  applyCallCount: 0 as number,
}))

function resetDb(): void {
  db.savLines = [
    { id: 101, product_code_snapshot: 'RUF-001', unit_price_ttc_cents: 2000 },
    { id: 102, product_code_snapshot: 'RUF-002', unit_price_ttc_cents: 3000 },
    { id: 103, product_code_snapshot: 'RUF-003', unit_price_ttc_cents: 1500 },
  ]
  db.applyRpcData = {
    updated_count: 3,
    total_supplier_amount_cents: 4500,
    new_margin_total_cents: 3000,
  }
  db.applyRpcError = null
  db.rateLimitAllowed = true
  db.savGroupId = 1
  db.operatorGroupIds = [1]
  db.auditCaptured = null
  db.storedRows = {}
  db.applyCallCount = 0
}

// ---------------------------------------------------------------------------
// vi.mock declarations (hoisted by Vitest)
// ---------------------------------------------------------------------------

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  const client = {
    from: (table: string) => {
      if (table === 'sav_lines') {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: db.savLines, error: null }),
          }),
        }
      }
      if (table === 'sav') {
        // table réelle = 'sav' (pas 'savs')
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: { group_id: db.savGroupId }, error: null }),
            }),
          }),
        }
      }
      if (table === 'operator_groups') {
        return {
          select: () => ({
            eq: () =>
              Promise.resolve({
                data: db.operatorGroupIds.map((g) => ({ group_id: g })),
                error: null,
              }),
          }),
        }
      }
      if (table === 'audit_trail') {
        return {
          insert: (row: unknown) => {
            // M-6: capture audit call for test assertions
            db.auditCaptured = row
            return Promise.resolve({ error: null })
          },
        }
      }
      return {
        select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
        insert: (_row: unknown) => Promise.resolve({ error: null }),
      }
    },
    rpc: (fn: string, args: Record<string, unknown>) => {
      if (fn === 'increment_rate_limit') {
        return Promise.resolve({
          data: [{ allowed: db.rateLimitAllowed, retry_after: 1 }],
          error: null,
        })
      }
      if (fn === 'apply_supplier_prices_for_sav') {
        // M-8: stateful tracking — store rows with a timestamp based on call count
        db.applyCallCount++
        const timestamp = new Date(Date.now() + db.applyCallCount * 1000).toISOString()
        const items = (args['p_items'] as Array<{ line_id: number }> | undefined) ?? []
        for (const item of items) {
          db.storedRows[item.line_id] = {
            supplier_price_imported_at: timestamp,
            supplier_price_source: String(args['p_filename'] ?? ''),
          }
        }
        return Promise.resolve({ data: db.applyRpcData, error: db.applyRpcError })
      }
      return Promise.resolve({ data: null, error: null })
    },
  }
  return {
    supabaseAdmin: () => client,
    __resetSupabaseAdminForTests: () => undefined,
  }
})

// ---------------------------------------------------------------------------
// xlsx mock — we'll control what sheets it returns per test via a hoisted ref
// ---------------------------------------------------------------------------

const xlsxState = vi.hoisted(() => ({
  // What parseSupplierPricingFile should return for the active test
  // Keyed by filename pattern; default = full 3-match set
  sheetRows: null as Array<Record<string, unknown>> | null,
}))

vi.mock('xlsx', async () => {
  return {
    default: {
      read: (_buf: Buffer, _opts: unknown) => ({ SheetNames: ['Sheet1'], Sheets: {} }),
      utils: {
        sheet_to_json: (_ws: unknown, _opts: unknown) => xlsxState.sheetRows ?? [],
      },
    },
    read: (_buf: Buffer, _opts: unknown) => ({ SheetNames: ['Sheet1'], Sheets: {} }),
    utils: {
      sheet_to_json: (_ws: unknown, _opts: unknown) => xlsxState.sheetRows ?? [],
    },
  }
})

// ---------------------------------------------------------------------------
// Import handler AFTER mocks
// ---------------------------------------------------------------------------

import handler from '../../../../api/sav'
import { sanitizeCsvCell } from '../../../../api/_lib/csv-injection-guard'

// ---------------------------------------------------------------------------
// Helper: build cookies
// ---------------------------------------------------------------------------

function opCookie(opts: { sub?: number; role?: SessionUser['role'] } = {}): string {
  const p: SessionUser = {
    sub: opts.sub ?? 42,
    type: 'operator',
    role: opts.role ?? 'sav-operator',
    exp: Math.floor(Date.now() / 1000) + 3600,
  }
  return `sav_session=${signJwt(p, SECRET)}`
}

// ---------------------------------------------------------------------------
// Helper: build multipart-like request for upload (we pass buffer in body)
// The actual handler reads req.body.file or a parsed buffer.
// For unit tests we simulate the parsed payload injected by the handler.
// ---------------------------------------------------------------------------

function importPreviewReq(
  savId: number,
  fileBuffer: Buffer,
  mimeType: string,
  filename = 'test.csv',
  cookie = opCookie()
) {
  return mockReq({
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'application/json',
      'x-file-size': String(fileBuffer.length),
      'x-file-mime': mimeType,
      'x-file-name': filename,
    },
    query: { op: 'import-supplier-prices', id: String(savId) },
    body: {
      fileBuffer: fileBuffer.toString('base64'),
      mimeType,
      filename,
    },
  })
}

function applyReq(
  savId: number,
  items: Array<{
    lineId: number
    supplierPriceHtCents: number
    supplierReference?: string
    supplierPriceSource: string
  }>,
  filename = 'test.csv',
  cookie = opCookie()
) {
  return mockReq({
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json' },
    query: { op: 'apply-supplier-prices', id: String(savId) },
    body: { items, filename },
  })
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubEnv('SESSION_COOKIE_SECRET', SECRET)
  vi.stubEnv('SUPABASE_URL', 'http://localhost')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test')
  resetDb()
  xlsxState.sheetRows = null
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// AC #6(a) — CSV valide 3 lignes match exact
// ---------------------------------------------------------------------------

describe('ISP-01: POST import-supplier-prices — preview parse', () => {
  it('ISP-01a: CSV valide 3 lignes match exact → matched=3, unmatched=0, errors=0', async () => {
    // DB has 3 lines: RUF-001, RUF-002, RUF-003
    // CSV has same 3 codes → full match
    xlsxState.sheetRows = [
      { Code: 'RUF-001', Quantité: 2, 'PU HT': 10.0, 'Réf. fournisseur': 'FOURN-A1' },
      { Code: 'RUF-002', Quantité: 1, 'PU HT': 20.0, 'Réf. fournisseur': 'FOURN-A2' },
      { Code: 'RUF-003', Quantité: 3, 'PU HT': 5.0, 'Réf. fournisseur': 'FOURN-A3' },
    ]

    const buf = Buffer.from('Code,Quantité,PU HT,Réf. fournisseur\nRUF-001,2,10,FOURN-A1')
    const res = mockRes()
    await handler(importPreviewReq(1, buf, 'text/csv', 'fournisseur.csv'), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      matched: unknown[]
      unmatched: unknown[]
      errors: unknown[]
      fileMeta: { filename: string; rowCount: number; parser: string }
    }
    expect(body.matched).toHaveLength(3)
    expect(body.unmatched).toHaveLength(0)
    expect(body.errors).toHaveLength(0)
    expect(body.fileMeta.parser).toBe('xlsx')
    // Verify price is converted to cents correctly (10.0 € → 1000 cents)
    const firstMatch = body.matched[0] as { newPriceCents: number; code: string }
    expect(firstMatch.code).toBe('RUF-001')
    expect(firstMatch.newPriceCents).toBe(1000)
  })

  // AC #6(b) — XLSX 5 lignes dont 2 unmatched
  it('ISP-01b: XLSX 5 lignes dont 2 unmatched → matched=3, unmatched=2, errors=0', async () => {
    xlsxState.sheetRows = [
      { Code: 'RUF-001', Quantité: 2, 'PU HT': 10.0, 'Réf. fournisseur': 'FOURN-A1' },
      { Code: 'RUF-002', Quantité: 1, 'PU HT': 20.0, 'Réf. fournisseur': 'FOURN-A2' },
      { Code: 'RUF-003', Quantité: 3, 'PU HT': 5.0, 'Réf. fournisseur': 'FOURN-A3' },
      { Code: 'FOURN-XYZ', Quantité: 4, 'PU HT': 7.5, 'Réf. fournisseur': 'FOURN-B1' }, // unmatched
      { Code: 'FOURN-ABC', Quantité: 1, 'PU HT': 12.5, 'Réf. fournisseur': 'FOURN-B2' }, // unmatched
    ]

    const buf = Buffer.alloc(100) // small XLSX buffer
    const res = mockRes()
    await handler(
      importPreviewReq(
        1,
        buf,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'fournisseur.xlsx'
      ),
      res
    )

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      matched: unknown[]
      unmatched: unknown[]
      errors: unknown[]
    }
    expect(body.matched).toHaveLength(3)
    expect(body.unmatched).toHaveLength(2)
    expect(body.errors).toHaveLength(0)
    // Unmatched entries have row + code
    const firstUnmatched = body.unmatched[0] as { code: string; row: number }
    expect(firstUnmatched.code).toBe('FOURN-XYZ')
  })

  // AC #6(c) — Format invalide (colonnes manquantes)
  it('ISP-01c: Format invalide (colonnes manquantes) → 400 INVALID_FORMAT', async () => {
    // Sheet has wrong headers — missing "Code" and "PU HT"
    xlsxState.sheetRows = [
      { Produit: 'something', Prix: 10 }, // wrong columns
    ]

    const buf = Buffer.from('Produit,Prix\nsomething,10')
    const res = mockRes()
    await handler(importPreviewReq(1, buf, 'text/csv', 'bad-headers.csv'), res)

    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { code: string; details?: unknown[] } }
    expect(body.error.code).toBe('INVALID_FORMAT')
    // details lists missing columns
    expect(body.error.details).toBeDefined()
  })

  // DN-B=B1 boundary: fichier sans "Réf. fournisseur" (optionnel) → accepté, supplierRef vide
  it('ISP-01c-boundary: fichier sans "Réf. fournisseur" (colonne optionnelle) → 200 OK', async () => {
    xlsxState.sheetRows = [
      { Code: 'RUF-001', Quantité: 1, 'PU HT': 10.0 }, // pas de Réf. fournisseur
    ]

    const buf = Buffer.from('Code,Quantité,PU HT\nRUF-001,1,10')
    const res = mockRes()
    await handler(importPreviewReq(1, buf, 'text/csv', 'no-ref.csv'), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      matched: Array<{ code: string; supplierRef: string }>
      errors: unknown[]
    }
    expect(body.matched).toHaveLength(1)
    expect(body.matched[0]?.code).toBe('RUF-001')
    // supplierRef vide car colonne absente
    expect(body.matched[0]?.supplierRef).toBe('')
    expect(body.errors).toHaveLength(0)
  })

  // AC #6(d) — Fichier > 5 MB → 413
  it('ISP-01d: Fichier > 5 MB → 413 PAYLOAD_TOO_LARGE', async () => {
    const SIX_MB = 6 * 1024 * 1024
    const buf = Buffer.alloc(SIX_MB, 0xff)
    const res = mockRes()
    await handler(importPreviewReq(1, buf, 'text/csv', 'huge.csv'), res)

    expect(res.statusCode).toBe(413)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE')
  })

  // AC #6(e) — MIME pas whitelist → 415
  it('ISP-01e: MIME application/zip → 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    const buf = Buffer.from('PK\x03\x04fake-zip')
    const res = mockRes()
    await handler(importPreviewReq(1, buf, 'application/zip', 'archive.zip'), res)

    expect(res.statusCode).toBe(415)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE')
  })

  // 401 sans cookie
  it('ISP-01f: 401 sans cookie', async () => {
    const buf = Buffer.from('test')
    const res = mockRes()
    await handler(importPreviewReq(1, buf, 'text/csv', 'test.csv', ''), res)

    expect(res.statusCode).toBe(401)
  })

  // Rate limit
  it('ISP-01g: 429 rate limit dépassé', async () => {
    db.rateLimitAllowed = false
    const buf = Buffer.from('test')
    const res = mockRes()
    await handler(importPreviewReq(1, buf, 'text/csv', 'test.csv'), res)

    expect(res.statusCode).toBe(429)
  })

  // float precision — AC #6 risque R-7
  it('ISP-01h: float precision — 12.34 € → 1234 cents (Math.round, pas parseInt)', async () => {
    xlsxState.sheetRows = [{ Code: 'RUF-001', Quantité: 1, 'PU HT': 12.34, 'Réf. fournisseur': '' }]

    const buf = Buffer.from('Code,Quantité,PU HT,Réf. fournisseur\nRUF-001,1,12.34,')
    const res = mockRes()
    await handler(importPreviewReq(1, buf, 'text/csv', 'test.csv'), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { matched: Array<{ newPriceCents: number }> }
    expect(body.matched[0]?.newPriceCents).toBe(1234)
  })

  // cellule vide vs zéro — R-8
  it('ISP-01i: PU HT = 0 (geste commercial) → accepté, stocké 0 cents', async () => {
    xlsxState.sheetRows = [{ Code: 'RUF-001', Quantité: 1, 'PU HT': 0, 'Réf. fournisseur': '' }]

    const buf = Buffer.from('Code,Quantité,PU HT,Réf. fournisseur\nRUF-001,1,0,')
    const res = mockRes()
    await handler(importPreviewReq(1, buf, 'text/csv', 'test.csv'), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { matched: Array<{ newPriceCents: number }>; errors: unknown[] }
    expect(body.matched[0]?.newPriceCents).toBe(0)
    expect(body.errors).toHaveLength(0)
  })

  // PU HT invalide → errors[]
  it('ISP-01j: PU HT non-numérique → erreur dans errors[] pour cette ligne', async () => {
    xlsxState.sheetRows = [
      { Code: 'RUF-001', Quantité: 1, 'PU HT': 'INVALID', 'Réf. fournisseur': '' },
    ]

    const buf = Buffer.from('Code,Quantité,PU HT,Réf. fournisseur\nRUF-001,1,INVALID,')
    const res = mockRes()
    await handler(importPreviewReq(1, buf, 'text/csv', 'test.csv'), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      errors: Array<{ row: number; reason: string }>
      matched: unknown[]
    }
    expect(body.errors).toHaveLength(1)
    expect(body.errors[0]?.reason).toMatch(/unit_price_ht|PU HT|NaN|invalid/i)
    expect(body.matched).toHaveLength(0)
  })

  // PU HT négatif → errors[]
  it('ISP-01k: PU HT négatif → erreur dans errors[]', async () => {
    xlsxState.sheetRows = [{ Code: 'RUF-001', Quantité: 1, 'PU HT': -5, 'Réf. fournisseur': '' }]

    const buf = Buffer.from('Code,Quantité,PU HT,Réf. fournisseur\nRUF-001,1,-5,')
    const res = mockRes()
    await handler(importPreviewReq(1, buf, 'text/csv', 'test.csv'), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { errors: Array<{ row: number; reason: string }> }
    expect(body.errors).toHaveLength(1)
    expect(body.errors[0]?.reason).toMatch(/négatif|negative|invalid/i)
  })
})

// ---------------------------------------------------------------------------
// AC #6(f) — Apply endpoint
// ---------------------------------------------------------------------------

describe('ISP-02: PATCH apply-supplier-prices', () => {
  it('ISP-02a: 200 apply 3 lignes → updatedCount=3 + totalSupplierAmountCents', async () => {
    const items = [
      {
        lineId: 101,
        supplierPriceHtCents: 1000,
        supplierReference: 'FOURN-A1',
        supplierPriceSource: 'test.csv',
      },
      {
        lineId: 102,
        supplierPriceHtCents: 2000,
        supplierReference: 'FOURN-A2',
        supplierPriceSource: 'test.csv',
      },
      {
        lineId: 103,
        supplierPriceHtCents: 500,
        supplierReference: 'FOURN-A3',
        supplierPriceSource: 'test.csv',
      },
    ]
    db.applyRpcData = {
      updated_count: 3,
      total_supplier_amount_cents: 3500,
      new_margin_total_cents: 1500,
    }

    const res = mockRes()
    await handler(applyReq(1, items), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      updatedCount: number
      totalSupplierAmountCents: number
      newMarginTotalCents: number
    }
    expect(body.updatedCount).toBe(3)
    expect(body.totalSupplierAmountCents).toBe(3500)
    expect(body.newMarginTotalCents).toBe(1500)
  })

  // AC #6(f) Idempotence : 2e PATCH → met à jour supplier_price_imported_at (M-8 — stateful mock)
  it('ISP-02b: idempotence — 2e PATCH avec mêmes items → 200 + supplier_price_imported_at mis à jour', async () => {
    const items = [{ lineId: 101, supplierPriceHtCents: 1000, supplierPriceSource: 'run1.csv' }]
    db.applyRpcData = {
      updated_count: 1,
      total_supplier_amount_cents: 1000,
      new_margin_total_cents: 500,
    }

    // First apply
    const res1 = mockRes()
    await handler(applyReq(1, items, 'run1.csv'), res1)
    expect(res1.statusCode).toBe(200)
    const afterFirstImport = db.storedRows[101]
    expect(afterFirstImport).not.toBeNull()
    const ts1 = afterFirstImport?.supplier_price_imported_at ?? ''
    expect(ts1).not.toBe('')

    // Second apply — same items but different filename (simule re-import)
    const items2 = [{ lineId: 101, supplierPriceHtCents: 1000, supplierPriceSource: 'run2.csv' }]
    const res2 = mockRes()
    await handler(applyReq(1, items2, 'run2.csv'), res2)
    expect(res2.statusCode).toBe(200)

    const afterSecondImport = db.storedRows[101]
    const ts2 = afterSecondImport?.supplier_price_imported_at ?? ''
    // supplier_price_imported_at doit avoir été mis à jour (ts2 > ts1)
    expect(ts2 > ts1).toBe(true)
    // supplier_price_source doit refléter le 2e fichier
    expect(afterSecondImport?.supplier_price_source).toBe('run2.csv')
    const body2 = res2.jsonBody as { updatedCount: number }
    expect(body2.updatedCount).toBe(1)
  })

  // 400 Zod validation — supplierPriceHtCents missing
  it('ISP-02c: 400 body invalide — supplierPriceHtCents manquant', async () => {
    const res = mockRes()
    await handler(
      applyReq(1, [
        { lineId: 101, supplierPriceHtCents: undefined as never, supplierPriceSource: 'test.csv' },
      ]),
      res
    )
    expect(res.statusCode).toBe(400)
  })

  // 400 supplierPriceHtCents négatif
  it('ISP-02d: 400 supplierPriceHtCents < 0', async () => {
    const res = mockRes()
    await handler(
      applyReq(1, [{ lineId: 101, supplierPriceHtCents: -100, supplierPriceSource: 'test.csv' }]),
      res
    )
    expect(res.statusCode).toBe(400)
  })

  // 409 CONFLICT — lines not found (race condition)
  it('ISP-02e: 409 LINES_NOT_FOUND — ligne supprimée entre preview et apply', async () => {
    db.applyRpcError = { code: 'P0001', message: 'LINES_NOT_FOUND|missingIds=101,102' }
    const items = [{ lineId: 101, supplierPriceHtCents: 1000, supplierPriceSource: 'test.csv' }]

    const res = mockRes()
    await handler(applyReq(1, items), res)

    expect(res.statusCode).toBe(409)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('LINES_NOT_FOUND')
  })

  // 401 sans cookie
  it('ISP-02f: 401 sans cookie', async () => {
    const res = mockRes()
    await handler(applyReq(1, [], 'test.csv', ''), res)
    expect(res.statusCode).toBe(401)
  })

  // supplierPriceHtCents = 0 accepté (geste commercial — distinct de NULL)
  // + M-6: vérifier que recordAudit est appelé avec le bon payload
  it('ISP-02g: supplierPriceHtCents=0 accepté + recordAudit appelé avec action sav_supplier_prices_imported', async () => {
    db.applyRpcData = {
      updated_count: 1,
      total_supplier_amount_cents: 0,
      new_margin_total_cents: 1000,
    }
    const items = [{ lineId: 101, supplierPriceHtCents: 0, supplierPriceSource: 'test.csv' }]

    const res = mockRes()
    await handler(applyReq(1, items), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { updatedCount: number }
    expect(body.updatedCount).toBe(1)

    // M-6: recordAudit doit avoir été appelé (via audit_trail insert mock)
    expect(db.auditCaptured).not.toBeNull()
    const audit = db.auditCaptured as { action: string; entity_type: string; entity_id: number }
    expect(audit.action).toBe('sav_supplier_prices_imported')
    expect(audit.entity_type).toBe('sav')
    expect(audit.entity_id).toBe(1)
  })

  // items.length > 200 → 400
  it('ISP-02h: 400 items.length > 200 → cap webhook capture', async () => {
    const items = Array.from({ length: 201 }, (_, i) => ({
      lineId: i + 1,
      supplierPriceHtCents: 100,
      supplierPriceSource: 'test.csv',
    }))

    const res = mockRes()
    await handler(applyReq(1, items), res)

    expect(res.statusCode).toBe(400)
  })

  // supplierPriceSource > 255 chars → 400
  it('ISP-02i: 400 supplierPriceSource > 255 chars', async () => {
    const items = [
      {
        lineId: 101,
        supplierPriceHtCents: 100,
        supplierPriceSource: 'x'.repeat(256),
      },
    ]

    const res = mockRes()
    await handler(applyReq(1, items), res)

    expect(res.statusCode).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// AC #6(g) — Cross-SAV protection
// ---------------------------------------------------------------------------

describe('ISP-03: Cross-SAV protection', () => {
  it('ISP-03a: lineId appartenant à un autre groupe → 403 ou 404', async () => {
    // SAV appartient au groupe 2, opérateur est dans le groupe 1
    db.savGroupId = 2
    db.operatorGroupIds = [1] // opérateur PAS dans groupe 2

    const items = [{ lineId: 999, supplierPriceHtCents: 100, supplierPriceSource: 'test.csv' }]
    const res = mockRes()
    await handler(applyReq(1, items), res)

    // Doit être 403 ou 404 (pas 200) — défense group scope
    expect([403, 404]).toContain(res.statusCode)
  })

  // M-5: Handler-level check — opérateur du groupe A forge un lineId d'un autre SAV du même groupe
  it("ISP-03c: lineId forgé d'un autre SAV (même groupe) → 422 LINE_NOT_IN_SAV", async () => {
    // savLines du SAV 1 = [101, 102, 103]
    // L'opérateur soumet lineId=999 qui appartient à SAV 2 (même groupe = bypasse group scope check)
    // Le handler-level check M-5 doit rejeter car 999 ∉ sav_lines WHERE sav_id=1
    const items = [{ lineId: 999, supplierPriceHtCents: 100, supplierPriceSource: 'test.csv' }]
    const res = mockRes()
    await handler(applyReq(1, items), res)

    // Doit être 422 LINE_NOT_IN_SAV (pas 200)
    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('LINE_NOT_IN_SAV')
  })

  it('ISP-03b: admin bypass groupe → 200 (admin voit tous les groupes)', async () => {
    db.savGroupId = 2
    db.operatorGroupIds = [] // admin ne check pas
    db.applyRpcData = {
      updated_count: 1,
      total_supplier_amount_cents: 1000,
      new_margin_total_cents: 500,
    }

    const items = [{ lineId: 101, supplierPriceHtCents: 1000, supplierPriceSource: 'test.csv' }]
    const adminCookie = (() => {
      const p: SessionUser = {
        sub: 1,
        type: 'operator',
        role: 'admin',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }
      return `sav_session=${signJwt(p, SECRET)}`
    })()

    const res = mockRes()
    await handler(applyReq(1, items, 'test.csv', adminCookie), res)

    expect(res.statusCode).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// AC #6(h) — Formula injection guard (DN-3 = A : préfixe ' silencieux)
// ---------------------------------------------------------------------------

describe('ISP-04: Formula injection guard (DN-3=A — préfixe silencieux)', () => {
  it("ISP-04a: =cmd|'c calc'!A1 dans supplier_ref → traité comme texte prefixé ' (jamais exécuté)", async () => {
    // La lib xlsx + options anti-formula (cellFormula:false) + sanitizeCsvCell
    // transforme la valeur en texte prefixé '
    // Ce test vérifie le comportement côté handler : la valeur est soit
    // préfixée ' (option A) soit rejetée, mais JAMAIS passée telle quelle.
    const injectionRef = "=cmd|'/c calc'!A1"
    xlsxState.sheetRows = [
      { Code: 'RUF-001', Quantité: 1, 'PU HT': 10.0, 'Réf. fournisseur': injectionRef },
    ]

    const buf = Buffer.from(`Code,Quantité,PU HT,Réf. fournisseur\nRUF-001,1,10,${injectionRef}`)
    const res = mockRes()
    await handler(importPreviewReq(1, buf, 'text/csv', 'formula-inj.csv'), res)

    // Doit soit passer (200) avec la valeur sanitisée, soit 400 si rejet
    if (res.statusCode === 200) {
      const body = res.jsonBody as { matched: Array<{ supplierRef: string }> }
      const ref = body.matched[0]?.supplierRef ?? ''
      // La valeur NE DOIT PAS commencer par = (formule injectable)
      expect(ref.startsWith('=')).toBe(false)
      // Option A : préfixée par '
      // Option B : rejetée (non dans ce test — test ISP-04b)
    } else {
      // Option B : rejet explicite 400
      expect(res.statusCode).toBe(400)
    }
  })

  it('ISP-04b: @SUM(1+1) dans supplier_ref → préfixé ou rejeté (jamais exécuté)', async () => {
    const atFormula = '@SUM(1+1)'
    xlsxState.sheetRows = [
      { Code: 'RUF-001', Quantité: 1, 'PU HT': 10.0, 'Réf. fournisseur': atFormula },
    ]

    const buf = Buffer.from(`Code,Quantité,PU HT,Réf. fournisseur\nRUF-001,1,10,${atFormula}`)
    const res = mockRes()
    await handler(importPreviewReq(1, buf, 'text/csv', 'formula-inj-2.csv'), res)

    if (res.statusCode === 200) {
      const body = res.jsonBody as { matched: Array<{ supplierRef: string }> }
      const ref = body.matched[0]?.supplierRef ?? ''
      // NE DOIT PAS commencer par @ (formule injectable)
      expect(ref.startsWith('@')).toBe(false)
    } else {
      expect(res.statusCode).toBe(400)
    }
  })

  it('ISP-04c: valeur normale RUF-001 dans code → aucune modification', async () => {
    // S'assure que sanitizeCsvCell ne touche pas les valeurs normales
    xlsxState.sheetRows = [
      { Code: 'RUF-001', Quantité: 1, 'PU HT': 10.0, 'Réf. fournisseur': 'NORMAL-REF' },
    ]

    const buf = Buffer.from('Code,Quantité,PU HT,Réf. fournisseur\nRUF-001,1,10,NORMAL-REF')
    const res = mockRes()
    await handler(importPreviewReq(1, buf, 'text/csv', 'normal.csv'), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { matched: Array<{ code: string; supplierRef: string }> }
    expect(body.matched[0]?.code).toBe('RUF-001')
    expect(body.matched[0]?.supplierRef).toBe('NORMAL-REF')
  })
})

// ---------------------------------------------------------------------------
// Helper : sanitizeCsvCell unit tests (PATTERN-CSV-INJECTION-GUARD)
// ---------------------------------------------------------------------------

describe('ISP-05: sanitizeCsvCell helper (PATTERN-CSV-INJECTION-GUARD)', () => {
  // M-7: fail-closed — helper importé directement (ESM), plus de require() dynamique

  it('ISP-05a: "=ALERT()" → préfixé par apostrophe', () => {
    expect(sanitizeCsvCell).not.toBeNull()
    expect(sanitizeCsvCell('=ALERT()')).toBe("'=ALERT()")
  })

  it('ISP-05b: "+ALERT()" → préfixé par apostrophe', () => {
    expect(sanitizeCsvCell('+' + 'ALERT()')).toBe("'+ALERT()")
  })

  it('ISP-05c: "-ALERT()" → préfixé par apostrophe', () => {
    expect(sanitizeCsvCell('-ALERT()')).toBe("'-ALERT()")
  })

  it('ISP-05d: "@SUM()" → préfixé', () => {
    expect(sanitizeCsvCell('@SUM()')).toBe("'@SUM()")
  })

  it('ISP-05e: "RUF-001" → inchangé (pas de préfixe dangereux)', () => {
    expect(sanitizeCsvCell('RUF-001')).toBe('RUF-001')
  })

  it('ISP-05f: chaîne vide → inchangée', () => {
    expect(sanitizeCsvCell('')).toBe('')
  })

  it('ISP-05g: tab-préfixé → préfixé par apostrophe', () => {
    expect(sanitizeCsvCell('\t=cmd')).toBe("'\t=cmd")
  })
})
