/**
 * Story 8.1 — AC #11 : Tests handler parse-supplier-file
 *
 * Test type: UNIT (handler isolated via vi.mock — no real DB, real XLSX fixtures for parse path)
 *
 * Decisions applied (all DNs arbitrated):
 *   DN-1 = Route dédiée (not relevant to server tests — SupplierClaimView.spec.ts)
 *   DN-2 = Cap 10 MB
 *   DN-3 = sav.status === 'validated' (not relevant server-side)
 *   DN-5 = ISO YYYY-MM-DD normalisation, fallback raw + warning
 *   DN-6 = fixture client/tests/fixtures/supplier-claim-data.xlsx
 *
 * AC coverage:
 *   AC #11(a) — XLSX SOL Y FRUTA fixture valide → 200, factureGroupe.rows.length > 0, bdd.rows > 0, metadata.reference != null
 *   AC #11(b) — Fichier > 10 MB → 413 PAYLOAD_TOO_LARGE
 *   AC #11(c) — MIME invalide / magic bytes non-XLSX (PDF) → 415 UNSUPPORTED_MEDIA_TYPE
 *   AC #11(d) — Archive ZIP valide mais hors-OOXML (.zip renommé .xlsx) → 422 UNPROCESSABLE_ENTITY
 *   AC #11(e) — Classeur XLSX sans onglet FACTURE_GROUPE → 400 INVALID_FORMAT
 *   AC #11(f) — Tolérance #N/A (fixture réelle avec #N/A dans precio, lignes vides) → 200, warnings > 0, skippedRows > 0
 *   AC #11(g) — Cross-SAV / group scope : opérateur groupe A → SAV groupe B → 403 FORBIDDEN
 *   AC #11(h) — Formula injection guard : designationFr avec =cmd... → jamais évalué (cellFormula:false)
 *   AC #3    — 401 rôle non op/admin (self_service user) ; 404 savId inexistant
 *   AC #4    — GET → 405 METHOD_NOT_ALLOWED
 *   AC #9    — Forme réponse JSON : metadata, factureGroupe.rows, bdd.rows, fileMeta
 *
 * Mock strategy:
 *   - supabaseAdmin: vi.hoisted mutable db state (sav group_id, operator_groups, rate limit)
 *   - XLSX library: NOT mocked for parse tests (real XLSX read from fixtures) — mocked for
 *     scenario (d) where we want SheetJS to throw on a corrupt file
 *   - withAuth: uses real JWT (signJwt helper from middleware) — no mock needed
 *   - recordAudit: not called in 8.1 (parse = no side effect) — no mock needed
 *
 * NOTE: The handler `parse-supplier-file-handler.ts` does not exist yet (story not implemented).
 * These tests are written ATDD-first: they define the contract and will fail RED until Task 1/2
 * of story 8.1 are implemented. This is intentional per BMAD ATDD methodology.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as XLSX from 'xlsx'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------

const FIXTURES_DIR = resolve(__dirname, '../../../fixtures')
const FIXTURE_VALID = resolve(FIXTURES_DIR, 'supplier-claim-data.xlsx')
const FIXTURE_MISSING_FG = resolve(FIXTURES_DIR, 'supplier-claim-missing-facture-groupe.xlsx')
const FIXTURE_MISSING_BOTH = resolve(FIXTURES_DIR, 'supplier-claim-missing-sheets.xlsx')
const FIXTURE_FORMULA_INJ = resolve(FIXTURES_DIR, 'supplier-claim-formula-injection.xlsx')
const FIXTURE_NOT_XLSX = resolve(FIXTURES_DIR, 'supplier-claim-not-xlsx.pdf')
const FIXTURE_ZIP_RENAMED = resolve(FIXTURES_DIR, 'supplier-claim-zip-renamed.xlsx')

// ---------------------------------------------------------------------------
// Hoisted mocks — mutable DB state (mirrors import-supplier-prices.spec.ts pattern)
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => ({
  /** group_id du SAV requis */
  savGroupId: 1 as number,
  /** groupes de l'opérateur */
  operatorGroupIds: [1] as number[],
  /** rate limit: true = allowed */
  rateLimitAllowed: true as boolean,
  /** savRow: null simule un SAV inexistant */
  savNotFound: false as boolean,
}))

function resetDb(): void {
  db.savGroupId = 1
  db.operatorGroupIds = [1]
  db.rateLimitAllowed = true
  db.savNotFound = false
}

// ---------------------------------------------------------------------------
// vi.mock declarations
// ---------------------------------------------------------------------------

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  const client = {
    from: (table: string) => {
      if (table === 'sav') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => {
                if (db.savNotFound) {
                  return Promise.resolve({ data: null, error: null })
                }
                return Promise.resolve({ data: { group_id: db.savGroupId }, error: null })
              },
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
      return {
        select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
        insert: (_row: unknown) => Promise.resolve({ error: null }),
      }
    },
    rpc: (fn: string) => {
      if (fn === 'increment_rate_limit') {
        return Promise.resolve({
          data: [{ allowed: db.rateLimitAllowed, retry_after: 1 }],
          error: null,
        })
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
// Import handler AFTER mocks
// ---------------------------------------------------------------------------

// NOTE: This import will fail RED until parse-supplier-file-handler is implemented.
// The router is imported via api/sav which dispatches to the handler.
import handler from '../../../../api/sav'

// ---------------------------------------------------------------------------
// Helpers
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

function selfServiceCookie(): string {
  // type='member' — doit retourner 401 (withAuth types:['operator','admin'])
  const p = {
    sub: 99,
    type: 'member' as const,
    exp: Math.floor(Date.now() / 1000) + 3600,
  }
  // Build a minimal JWT manually — signJwt expects SessionUser type
  // We use the same secret but a member payload (withAuth will reject type)
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(p)).toString('base64url')
  const { createHmac } = require('node:crypto')
  const sig = createHmac('sha256', SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url')
  return `sav_session=${header}.${payload}.${sig}`
}

/**
 * Build a multipart-like POST request for op=parse-supplier-file.
 * Following Story 4.8 pattern: body carries fileBuffer (base64) + metadata.
 * The handler is expected to read req.body.fileBuffer (base64), mimeType, filename.
 */
function parseReq(
  savId: number,
  fileBuffer: Buffer,
  opts: {
    mimeType?: string
    filename?: string
    cookie?: string
    method?: string
  } = {}
) {
  const mimeType =
    opts.mimeType ??
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  const filename = opts.filename ?? 'data.xlsx'
  const cookie = opts.cookie ?? opCookie()
  const method = opts.method ?? 'POST'

  return mockReq({
    method,
    headers: {
      cookie,
      'content-type': 'application/json',
    },
    query: { op: 'parse-supplier-file', id: String(savId) },
    body: {
      fileBuffer: fileBuffer.toString('base64'),
      mimeType,
      filename,
    },
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
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

// ===========================================================================
// AC #11(a) — XLSX SOL Y FRUTA fixture valide → 200
// ===========================================================================

describe('PSF-01: POST parse-supplier-file — XLSX valide', () => {
  it('PSF-01a: fixture valide → 200, factureGroupe.rows.length > 0, bdd.rows.length > 0, metadata.reference != null', async () => {
    const fileBuffer = readFileSync(FIXTURE_VALID)
    const res = mockRes()
    await handler(parseReq(1, fileBuffer), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      metadata: {
        reference: string | null
        albaran: number | string | null
        fechaAlbaran: string | null
        warnings: string[]
      }
      factureGroupe: {
        rows: Array<{
          codeFr: string
          designationFr: string
          prixVenteClientHt: number | null
          unite: string | null
          qteCmd: number | null
          qteFact: number | null
          codigoEs: string | null
          descripcionEs: string | null
          kilosPiezas: string | null
          kilosNetos: number | null
          precio: number | null
          importe: number | null
          cmd: string | number | null
        }>
        skippedRows: number
        warnings: Array<{ row: number; sheet: string; fields: string[] }>
      }
      bdd: {
        rows: Array<{
          code: string
          designationEs: string | null
          origen: string | null
        }>
        skippedRows: number
        warnings: Array<{ row: number; sheet: string; fields: string[] }>
      }
      fileMeta: {
        filename: string
        sizeBytes: number
        sheetsDetected: string[]
        parser: string
      }
    }

    // AC #11(a): required fields non-null
    expect(body.metadata.reference).not.toBeNull()
    expect(body.factureGroupe.rows.length).toBeGreaterThan(0)
    expect(body.bdd.rows.length).toBeGreaterThan(0)

    // AC #9 — forme réponse complète
    expect(body.fileMeta).toBeDefined()
    expect(body.fileMeta.sheetsDetected).toContain('FACTURE_GROUPE')
    expect(body.fileMeta.sheetsDetected).toContain('BDD')
    expect(body.fileMeta.parser).toBe('xlsx-cdn-0.20.3')
    expect(body.fileMeta.sizeBytes).toBeGreaterThan(0)
    // No disk path leak
    expect(JSON.stringify(body)).not.toMatch(/\/tmp\/|\/var\/task\/|process\.cwd/)
    // No buffer leak
    expect(JSON.stringify(body)).not.toMatch(/fileBuffer|base64/)
  })

  it('PSF-01b: fixture valide → metadata.reference = "278_26S21_11", albaran = 3127, fechaAlbaran = "2026-05-20"', async () => {
    const fileBuffer = readFileSync(FIXTURE_VALID)
    const res = mockRes()
    await handler(parseReq(1, fileBuffer), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      metadata: {
        reference: string | null
        albaran: string | number | null
        fechaAlbaran: string | null
        warnings: string[]
      }
    }

    // AC #7 — métadonnées G-2 confirmées
    expect(body.metadata.reference).toBe('278_26S21_11')
    expect(String(body.metadata.albaran)).toBe('3127')
    // DN-5: ISO YYYY-MM-DD
    expect(body.metadata.fechaAlbaran).toBe('2026-05-20')
    expect(body.metadata.warnings).toEqual([])
  })

  it('PSF-01c: fixture valide → factureGroupe.rows[0] a codeFr = "1022-5K" (trim + casse préservée)', async () => {
    const fileBuffer = readFileSync(FIXTURE_VALID)
    const res = mockRes()
    await handler(parseReq(1, fileBuffer), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      factureGroupe: {
        rows: Array<{ codeFr: string; codigoEs: string | null; qteFact: number | null }>
      }
    }

    const firstRow = body.factureGroupe.rows[0]
    expect(firstRow).toBeDefined()
    expect(firstRow!.codeFr).toBe('1022-5K')
    // AC #6: codigoEs extrait par header name
    expect(firstRow!.codigoEs).toBe('1022')
    // qteFact est extrait (exposé dès 8.1, utilisé en 8.3)
    expect(typeof firstRow!.qteFact).toBe('number')
  })

  it('PSF-01d: fixture valide → bdd.rows[0] a code = "1022-5K", designationEs, origen', async () => {
    const fileBuffer = readFileSync(FIXTURE_VALID)
    const res = mockRes()
    await handler(parseReq(1, fileBuffer), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      bdd: { rows: Array<{ code: string; designationEs: string | null; origen: string | null }> }
    }

    const firstBddRow = body.bdd.rows[0]
    expect(firstBddRow).toBeDefined()
    expect(firstBddRow!.code).toBe('1022-5K')
    expect(firstBddRow!.designationEs).toBeTruthy()
    expect(firstBddRow!.origen).toBeTruthy()
  })
})

// ===========================================================================
// AC #11(b) — Fichier > 4 MB → 413 PAYLOAD_TOO_LARGE (M-2 fix: 10 MB → 4 MB)
// ===========================================================================

describe('PSF-02: Validation taille fichier (M-2 = 4 MB cap, aligné Vercel)', () => {
  it('PSF-02a: buffer > 4 MB → 413 PAYLOAD_TOO_LARGE', async () => {
    const FOUR_MB_PLUS = 4 * 1024 * 1024 + 1
    const buf = Buffer.alloc(FOUR_MB_PLUS, 0xff)
    const res = mockRes()
    await handler(parseReq(1, buf), res)

    expect(res.statusCode).toBe(413)
    const body = res.jsonBody as { error: { code: string; message: string } }
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE')
    expect(body.error.message).toMatch(/4 MB|4MB/i)
  })

  it('PSF-02b: buffer exactement 4 MB → accepté par le garde taille (autre erreur possible — pas 413)', async () => {
    // NOTE: Le handler peut rejeter pour MIME/magic bytes mais PAS pour la taille.
    // Ce test vérifie que le garde taille passe (toute erreur doit être !== 413).
    const FOUR_MB = 4 * 1024 * 1024
    const buf = Buffer.alloc(FOUR_MB, 0x50) // ASCII 'P', pas magic bytes PK → rejeté MIME
    const res = mockRes()
    await handler(parseReq(1, buf, { mimeType: 'application/octet-stream' }), res)

    // Must NOT be 413 (size check passed)
    expect(res.statusCode).not.toBe(413)
  })

  it('PSF-02c: string base64 trop longue (pré-décodage) → 413 (M-3 garde double-allocation)', async () => {
    // Simule un payload base64 dont la longueur dépasse MAX_FILE_SIZE * 1.4
    // sans décoder (évite la double-allocation mémoire)
    const FOUR_MB = 4 * 1024 * 1024
    const bigBuf = Buffer.alloc(FOUR_MB + 1000, 0xff)
    const bigB64 = bigBuf.toString('base64') // ~5,5 MB de string base64

    const res = mockRes()
    const req = mockReq({
      method: 'POST',
      headers: { cookie: opCookie(), 'content-type': 'application/json' },
      query: { op: 'parse-supplier-file', id: '1' },
      body: { fileBuffer: bigB64, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: 'data.xlsx' },
    })
    await handler(req, res)

    expect(res.statusCode).toBe(413)
  })
})

// ===========================================================================
// AC #11(c) — MIME invalide / magic bytes non-XLSX → 415
// ===========================================================================

describe('PSF-03: Validation MIME + magic bytes (AC #5)', () => {
  it('PSF-03a: PDF (magic bytes %PDF) avec .xlsx extension → 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    const fileBuffer = readFileSync(FIXTURE_NOT_XLSX)
    const res = mockRes()
    await handler(
      parseReq(1, fileBuffer, {
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        filename: 'data.xlsx',
      }),
      res
    )

    expect(res.statusCode).toBe(415)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE')
  })

  it('PSF-03b: MIME application/pdf (pas dans whitelist) → 415', async () => {
    const buf = Buffer.from('%PDF-1.4 test')
    const res = mockRes()
    await handler(
      parseReq(1, buf, {
        mimeType: 'application/pdf',
        filename: 'document.pdf',
      }),
      res
    )

    expect(res.statusCode).toBe(415)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE')
  })

  it('PSF-03c: extension .csv (le CSV n\'est PAS accepté) → 415', async () => {
    const buf = Buffer.from('CODE,DESIGNATON\n1022-5K,Test')
    const res = mockRes()
    await handler(
      parseReq(1, buf, {
        mimeType: 'text/csv',
        filename: 'data.csv',
      }),
      res
    )

    expect(res.statusCode).toBe(415)
  })

  it('PSF-03d: MIME application/octet-stream MAIS magic bytes PK (XLSX valide) → accepté (sniffing)', async () => {
    // application/octet-stream est dans la whitelist MIME + magic bytes XLSX = OK
    const fileBuffer = readFileSync(FIXTURE_VALID)
    const res = mockRes()
    await handler(
      parseReq(1, fileBuffer, {
        mimeType: 'application/octet-stream',
        filename: 'data.xlsx',
      }),
      res
    )

    // doit passer le check MIME (octet-stream + magic PK = XLSX accepté)
    expect(res.statusCode).toBe(200)
  })
})

// ===========================================================================
// AC #11(d) — Archive ZIP valide mais hors-OOXML → 422 UNPROCESSABLE_ENTITY
// ===========================================================================

describe('PSF-04: Archive ZIP non-OOXML (AC #5)', () => {
  it('PSF-04a: ZIP magic bytes (PK) mais pas OOXML → 422 UNPROCESSABLE_ENTITY', async () => {
    const fileBuffer = readFileSync(FIXTURE_ZIP_RENAMED)
    const res = mockRes()
    await handler(
      parseReq(1, fileBuffer, {
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        filename: 'data.xlsx',
      }),
      res
    )

    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as { error: { code: string; message: string } }
    expect(body.error.code).toBe('UNPROCESSABLE_ENTITY')
    expect(body.error.message).toMatch(/fichier non lisible|non parseable|xlsx valide/i)
  })
})

// ===========================================================================
// AC #11(e) — Classeur XLSX sans onglet FACTURE_GROUPE → 400 INVALID_FORMAT
// ===========================================================================

describe('PSF-05: Classeur XLSX avec onglets manquants (AC #5)', () => {
  it('PSF-05a: XLSX sans FACTURE_GROUPE (avec BDD seulement) → 400 INVALID_FORMAT', async () => {
    const fileBuffer = readFileSync(FIXTURE_MISSING_FG)
    const res = mockRes()
    await handler(parseReq(1, fileBuffer), res)

    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { code: string; message: string } }
    expect(body.error.code).toBe('INVALID_FORMAT')
    expect(body.error.message).toMatch(/FACTURE_GROUPE/i)
  })

  it('PSF-05b: XLSX sans FACTURE_GROUPE ni BDD → 400 INVALID_FORMAT', async () => {
    const fileBuffer = readFileSync(FIXTURE_MISSING_BOTH)
    const res = mockRes()
    await handler(parseReq(1, fileBuffer), res)

    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_FORMAT')
  })
})

// ===========================================================================
// AC #11(f) — Tolérance #N/A : warnings > 0, skippedRows > 0
// ===========================================================================

describe('PSF-06: Tolérance #N/A et lignes vides (AC #8)', () => {
  it('PSF-06a: fixture avec #N/A dans precio et ligne vide → 200, factureGroupe.warnings.length > 0, skippedRows > 0', async () => {
    // supplier-claim-data.xlsx contient:
    //   - rowProd2 avec #N/A dans precio (col L) → warning annotée
    //   - rowEmpty (ligne sans codeFr) → skippedRows++
    const fileBuffer = readFileSync(FIXTURE_VALID)
    const res = mockRes()
    await handler(parseReq(1, fileBuffer), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      factureGroupe: {
        rows: Array<{ codeFr: string; precio: number | null }>
        skippedRows: number
        warnings: Array<{ row: number; sheet: string; fields: string[] }>
      }
    }

    // La ligne avec #N/A dans precio est conservée (code présent) mais precio = null + warning
    const rowWithNa = body.factureGroupe.rows.find((r) => r.codeFr === '2045-2K')
    expect(rowWithNa).toBeDefined()
    expect(rowWithNa!.precio).toBeNull()

    // Warning annoté pour la ligne avec #N/A
    expect(body.factureGroupe.warnings.length).toBeGreaterThan(0)
    const warningForNa = body.factureGroupe.warnings.find(
      (w) => w.sheet === 'FACTURE_GROUPE' && w.fields.includes('precio')
    )
    expect(warningForNa).toBeDefined()

    // Ligne vide ignorée → skippedRows > 0
    expect(body.factureGroupe.skippedRows).toBeGreaterThan(0)
  })

  it('PSF-06b: #N/A normalisé à null (pas de string "#N/A" dans la réponse JSON)', async () => {
    const fileBuffer = readFileSync(FIXTURE_VALID)
    const res = mockRes()
    await handler(parseReq(1, fileBuffer), res)

    expect(res.statusCode).toBe(200)
    const json = JSON.stringify(res.jsonBody)
    // Aucune valeur '#N/A' ne doit subsister dans les champs de données produits
    // (les warnings peuvent mentionner le champ en string, mais pas la valeur)
    const rows = (res.jsonBody as { factureGroupe: { rows: unknown[] } }).factureGroupe.rows
    for (const row of rows) {
      const r = row as Record<string, unknown>
      for (const [, v] of Object.entries(r)) {
        expect(v).not.toBe('#N/A')
      }
    }
    void json // used for debugging
  })

  it('PSF-06c: parsing ne lève jamais d\'exception sur lignes #N/A — réponse toujours 200', async () => {
    // Ce test est couvert par PSF-06a mais l'assertion explicite en vaut la peine
    const fileBuffer = readFileSync(FIXTURE_VALID)
    const res = mockRes()
    await expect(handler(parseReq(1, fileBuffer), res)).resolves.not.toThrow()
    expect(res.statusCode).toBe(200)
  })
})

// ===========================================================================
// AC #11(g) — Cross-SAV / group scope → 403 FORBIDDEN
// ===========================================================================

describe('PSF-07: RBAC group scope (AC #3)', () => {
  it('PSF-07a: opérateur groupe A, SAV dans groupe B → 403 FORBIDDEN', async () => {
    db.savGroupId = 2
    db.operatorGroupIds = [1] // opérateur PAS dans groupe 2

    const fileBuffer = readFileSync(FIXTURE_VALID)
    const res = mockRes()
    await handler(parseReq(1, fileBuffer), res)

    expect(res.statusCode).toBe(403)
    const body = res.jsonBody as { error: { code: string; message: string } }
    expect(body.error.code).toBe('FORBIDDEN')
    expect(body.error.message).toMatch(/scope|groupe/i)
  })

  it('PSF-07b: admin bypass → 200 même si SAV dans groupe différent', async () => {
    db.savGroupId = 2
    db.operatorGroupIds = [] // admin ne check pas les groupes

    const fileBuffer = readFileSync(FIXTURE_VALID)
    const res = mockRes()
    await handler(parseReq(1, fileBuffer, { cookie: opCookie({ role: 'admin' }) }), res)

    expect(res.statusCode).toBe(200)
  })

  it('PSF-07c: 401 sans cookie (utilisateur non authentifié)', async () => {
    const fileBuffer = Buffer.from('test')
    const res = mockRes()
    await handler(parseReq(1, fileBuffer, { cookie: '' }), res)

    expect(res.statusCode).toBe(401)
  })

  it('PSF-07d: 401 rôle hors {operator,admin} — type session "member" → rejeté par withAuth', async () => {
    const fileBuffer = Buffer.from('test')
    const res = mockRes()
    await handler(parseReq(1, fileBuffer, { cookie: selfServiceCookie() }), res)

    expect([401, 403]).toContain(res.statusCode)
  })

  it('PSF-07e: savId inexistant (DB retourne null) → 404 NOT_FOUND', async () => {
    db.savNotFound = true

    const fileBuffer = readFileSync(FIXTURE_VALID)
    const res = mockRes()
    await handler(parseReq(99999, fileBuffer), res)

    expect(res.statusCode).toBe(404)
  })
})

// ===========================================================================
// AC #4 — GET → 405 METHOD_NOT_ALLOWED
// ===========================================================================

describe('PSF-08: Méthode HTTP (AC #4)', () => {
  it('PSF-08a: GET op=parse-supplier-file → 405 METHOD_NOT_ALLOWED', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'GET',
        headers: { cookie: opCookie() },
        query: { op: 'parse-supplier-file', id: '1' },
        body: {},
      }),
      res
    )

    expect(res.statusCode).toBe(405)
  })

  it('PSF-08b: PATCH op=parse-supplier-file → 405 METHOD_NOT_ALLOWED', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'PATCH',
        headers: { cookie: opCookie() },
        query: { op: 'parse-supplier-file', id: '1' },
        body: {},
      }),
      res
    )

    expect(res.statusCode).toBe(405)
  })
})

// ===========================================================================
// AC #11(h) — Formula injection guard : cellFormula:false
// ===========================================================================

describe('PSF-09: Formula injection guard (AC #11h)', () => {
  // H-3-bis : sanity check — la fixture DOIT contenir de vraies cellules .f avec .v non-null.
  // Sans ça, le test PSF-09a/b serait trivial (cellule absente → null sans scrubber).
  it('PSF-09-sanity: la fixture contient de vraies cellules .f avec .v non-null (guard anti-fixture-dégénérée)', () => {
    const fileBuffer = readFileSync(FIXTURE_FORMULA_INJ)
    // Lire avec cellFormula:true pour exposer .f
    const wb = XLSX.read(fileBuffer, { type: 'buffer', cellFormula: true })
    const fg = wb.Sheets['FACTURE_GROUPE']
    expect(fg).toBeDefined()

    // B6 = designationFr injection row : doit avoir .f ET .v non-null
    const b6 = fg!['B6'] as XLSX.CellObject | undefined
    expect(b6).toBeDefined()
    expect(b6!.f).toBeDefined() // formule présente
    expect(b6!.v).not.toBeNull()
    expect(b6!.v).not.toBeUndefined()
    expect(b6!.v).toBe('INJECTED_LABEL') // valeur cached forgée non-null

    // L6 = precio injection row : doit avoir .f ET .v = 2 (valeur cachée de =1+1)
    const l6 = fg!['L6'] as XLSX.CellObject | undefined
    expect(l6).toBeDefined()
    expect(l6!.f).toBeDefined() // formule présente
    expect(l6!.v).toBe(2) // valeur cached forgée = 2 (non null)
  })

  it('PSF-09a: XLSX avec formule HYPERLINK dans designationFr (cellule .f + .v = "INJECTED_LABEL") → designationFr = null (scrubber neutralise la valeur cached)', async () => {
    // Fixture B6 : { t:'s', v:'INJECTED_LABEL', f:'HYPERLINK("http://evil.com","x")' }
    // SANS scrubber : cellFormula:false conserve .v → sheet_to_json retourne 'INJECTED_LABEL'
    // AVEC scrubber : .v supprimé AVANT sheet_to_json → sheet_to_json retourne null
    const fileBuffer = readFileSync(FIXTURE_FORMULA_INJ)
    const res = mockRes()
    await handler(parseReq(1, fileBuffer), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      factureGroupe: {
        rows: Array<{ codeFr: string; designationFr: string | null }>
        warnings: Array<{ row: number; sheet: string; fields: string[] }>
      }
    }

    // (b) La valeur cached forgée est neutralisée : designationFr doit être null
    // PAS 'INJECTED_LABEL' (preuve que le scrubber a supprimé .v)
    const injectionRow = body.factureGroupe.rows.find((r) => r.codeFr === '9999-INJECT')
    expect(injectionRow).toBeDefined()
    expect(injectionRow!.designationFr).toBeNull() // scrubber a supprimé la valeur forgée
    expect(injectionRow!.designationFr).not.toBe('INJECTED_LABEL') // preuve négative explicite

    // (c) Un warning formule_neutralisee est présent dans factureGroupe.warnings
    const formulaWarning = body.factureGroupe.warnings.find((w) =>
      w.fields.some((f) => f.includes('formule_neutralisee'))
    )
    expect(formulaWarning).toBeDefined()
    expect(formulaWarning!.fields[0]).toMatch(/formule_neutralisee.*B6|formule_neutralisee.*FACTURE_GROUPE/i)
  })

  it('PSF-09b: formule =1+1 dans precio (cellule .f + .v = 2) → precio = null (JAMAIS le nombre 2 — scrubber actif)', async () => {
    // Fixture L6 : { t:'n', v:2, f:'1+1' }
    // SANS scrubber : cellFormula:false conserve .v=2 → sheet_to_json retourne 2
    // AVEC scrubber : .v supprimé AVANT sheet_to_json → precio = null
    const fileBuffer = readFileSync(FIXTURE_FORMULA_INJ)
    const res = mockRes()
    await handler(parseReq(1, fileBuffer), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      factureGroupe: {
        rows: Array<{ codeFr: string; precio: number | null }>
        warnings: Array<{ row: number; sheet: string; fields: string[] }>
      }
    }

    // (b) precio doit être null — JAMAIS 2 (le scrubber a supprimé la valeur cached forgée)
    const injectionRow = body.factureGroupe.rows.find((r) => r.codeFr === '9999-INJECT')
    expect(injectionRow).toBeDefined()
    expect(injectionRow!.precio).toBeNull()
    expect(injectionRow!.precio).not.toBe(2) // preuve négative explicite : pas la valeur cached

    // (c) Warning formule_neutralisee présent pour L6
    const formulaWarnings = body.factureGroupe.warnings.filter((w) =>
      w.fields.some((f) => f.includes('formule_neutralisee'))
    )
    expect(formulaWarnings.length).toBeGreaterThanOrEqual(1)
    // Au moins un warning doit mentionner L6 (formule precio)
    const l6Warning = formulaWarnings.find((w) =>
      w.fields.some((f) => f.includes('L6'))
    )
    expect(l6Warning).toBeDefined()

    // La ligne normale (1022-5K) n'est PAS affectée — precio = 4.89 (vraie donnée)
    const normalRow = body.factureGroupe.rows.find((r) => r.codeFr === '1022-5K')
    expect(normalRow).toBeDefined()
    expect(normalRow!.precio).toBeCloseTo(4.89)
  })
})

// ===========================================================================
// AC #4 — op=parse-supplier-file dans ALLOWED_OPS (régression router)
// ===========================================================================

describe('PSF-10: Router ALLOWED_OPS (AC #4)', () => {
  it('PSF-10a: op=unknown-op → 404 NOT_FOUND (op hors ALLOWED_OPS)', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: { cookie: opCookie() },
        query: { op: 'not-an-op', id: '1' },
        body: {},
      }),
      res
    )

    expect(res.statusCode).toBe(404)
  })

  it('PSF-10b: op=parse-supplier-file DANS ALLOWED_OPS → pas de 404 (route connue)', async () => {
    // On envoie un body minimal, on vérifie que l'op est reconnu (pas 404)
    const fileBuffer = Buffer.from('test')
    const res = mockRes()
    await handler(parseReq(1, fileBuffer, { cookie: '' }), res)

    // Peut retourner 401 (non auth), 413, 415, etc. — mais PAS 404 (op connu)
    expect(res.statusCode).not.toBe(404)
  })
})

// ===========================================================================
// AC #3 — Rate limit (bucket sav:parse-supplier-file)
// ===========================================================================

describe('PSF-11: Rate limit (AC #3)', () => {
  it('PSF-11a: 429 RATE_LIMITED quand bucket dépassé', async () => {
    db.rateLimitAllowed = false

    const fileBuffer = Buffer.from('test')
    const res = mockRes()
    await handler(parseReq(1, fileBuffer), res)

    expect(res.statusCode).toBe(429)
  })
})

// ===========================================================================
// AC #9 — Forme réponse JSON (champs fileMeta)
// ===========================================================================

describe('PSF-12: Forme réponse JSON (AC #9)', () => {
  it('PSF-12a: fileMeta.sheetsDetected inclut tous les onglets du classeur', async () => {
    const fileBuffer = readFileSync(FIXTURE_VALID)
    const res = mockRes()
    await handler(parseReq(1, fileBuffer), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      fileMeta: { sheetsDetected: string[]; filename: string; sizeBytes: number; parser: string }
    }

    // Les 5 onglets du fixture (MAIL, CMD SIMPLE, VENTAS, FACTURE_GROUPE, BDD)
    expect(body.fileMeta.sheetsDetected).toContain('MAIL')
    expect(body.fileMeta.sheetsDetected).toContain('CMD SIMPLE')
    expect(body.fileMeta.sheetsDetected).toContain('VENTAS')
    expect(body.fileMeta.sheetsDetected).toContain('FACTURE_GROUPE')
    expect(body.fileMeta.sheetsDetected).toContain('BDD')
  })

  it('PSF-12b: fileMeta.filename correspond au nom du fichier soumis', async () => {
    const fileBuffer = readFileSync(FIXTURE_VALID)
    const res = mockRes()
    await handler(parseReq(1, fileBuffer, { filename: 'data.xlsx' }), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { fileMeta: { filename: string } }
    expect(body.fileMeta.filename).toBe('data.xlsx')
  })

  it('PSF-12c: réponse sans chemin disque local ni buffer brut', async () => {
    const fileBuffer = readFileSync(FIXTURE_VALID)
    const res = mockRes()
    await handler(parseReq(1, fileBuffer), res)

    expect(res.statusCode).toBe(200)
    const jsonStr = JSON.stringify(res.jsonBody)
    // Aucun chemin disque
    expect(jsonStr).not.toMatch(/\/tmp\/|\/var\/task\/|C:\\\\|process\.cwd/)
    // Aucun buffer brut
    expect(jsonStr).not.toMatch(/"fileBuffer"\s*:/)
  })

  it('PSF-12d: metadata.warnings est un tableau vide quand N2/N3/N4 sont valides', async () => {
    const fileBuffer = readFileSync(FIXTURE_VALID)
    const res = mockRes()
    await handler(parseReq(1, fileBuffer), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { metadata: { warnings: unknown[] } }
    expect(Array.isArray(body.metadata.warnings)).toBe(true)
    // Fixture a des valeurs valides → warnings vide
    expect(body.metadata.warnings).toHaveLength(0)
  })
})
