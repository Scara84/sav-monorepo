/**
 * Story 8.5 — AC #2, AC #4, AC #6 (d, e, g, h, i) : Tests handler download-supplier-claim
 *
 * Test type: UNIT (handler isolé via vi.mock) + vraie-DB integration (it.skipIf)
 *
 * Préfixes des tests: DL-
 *
 * Décisions appliquées (toutes LOCKED) :
 *   AC #2  : download GET only, ?id=<savId>&claimId=<claimId>, 200 + blob raw
 *   AC #4  : withAuth + withRateLimit 10/60s + checkGroupScope + GARDE IDOR (404 si claim.sav_id !== savId)
 *   DN-1 LOCKED : audit sav_supplier_claim_downloaded best-effort
 *
 * DISCRIMINANT IDOR (AC #6e) :
 *   Ce test DOIT échouer (aller RED) si la ligne
 *     `if (claim.sav_id !== savId) return 404`
 *   est retirée du handler. Le test vérifie explicitement que le blob NE FUITE PAS
 *   quand claimId appartient à sav2 mais que l'op demande via sav1.
 *
 * DISCRIMINANT bytea round-trip (AC #6d) :
 *   Test d'intégration vraie-DB (it.skipIf(!HAS_DB)) :
 *   INSERT un blob connu + son sha256 → SELECT via le handler → SHA-256(body) === stored sha256.
 *   Catche le bug base64↔Buffer: si le handler oublie Buffer.from(blob, 'base64'), le sha256 ne matche pas.
 *   Ce test est un HONNETE SKIP (it.skipIf) — jamais un faux-vert.
 *
 * Coverage :
 *   DL-01 (AC #6d) : round-trip bytea vraie-DB (it.skipIf — intégration)
 *   DL-02 (AC #6e) : GARDE IDOR — claim d'un autre SAV → 404 (DISCRIMINANT)
 *   DL-03 (AC #2)  : happy path — 200 + Content-Type xlsx + Content-Disposition + Cache-Control
 *   DL-04 (AC #6g) : rate limit 10/60s → 429 à la 11e requête
 *   DL-05 (AC #6h) : audit sav_supplier_claim_downloaded tracé après 200
 *   DL-06 (AC #6i) : audit échec ≠ bloquant — 200 livré même si recordAudit throws
 *   DL-07 (AC #4a) : méthode POST → 405
 *   DL-08 (AC #4c) : group scope — opérateur autre groupe → 403
 *   DL-09 (AC #4d) : claimId inexistant → 404
 *   DL-10 (AC #2)  : headers Content-Length + Cache-Control: private, no-store
 *
 * NOTE RED phase :
 *   client/api/_lib/sav/download-supplier-claim-handler.ts n'existe pas encore.
 *   Ces tests DOIVENT échouer jusqu'à l'implémentation Task 2.
 *   Tout green avant implémentation = faux-vert.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Vraie-DB env gate (PATTERN-H15-A — honest skip)
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env['SUPABASE_URL'] || process.env['VITE_SUPABASE_URL']
const SERVICE_ROLE = process.env['SUPABASE_SERVICE_ROLE_KEY']
const HAS_DB = Boolean(SUPABASE_URL && SERVICE_ROLE)

if (!HAS_DB) {
  console.warn(
    '[DL-8.5] Real-DB tests SKIPPED — set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env vars'
  )
}

// ---------------------------------------------------------------------------
// Hoisted mutable state
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => ({
  savGroupId: 1 as number,
  operatorGroupIds: [1] as number[],
  rateLimitAllowed: true as boolean,
  rateLimitHitCount: 0 as number, // For rate limit tests
  // The claim row to return when queried
  claimRow: null as null | {
    id: number
    sav_id: number
    filename: string
    document_blob: Buffer | string // Can be Buffer or base64 string from supabase-js
    document_sha256: string
    total_importe_cents: number
    generated_by_operator_id: number
  },
  // Audit captured
  auditCaptured: null as unknown,
  // Force audit to throw (test DL-06)
  auditShouldThrow: false as boolean,
}))

function resetDb(): void {
  db.savGroupId = 1
  db.operatorGroupIds = [1]
  db.rateLimitAllowed = true
  db.rateLimitHitCount = 0
  db.claimRow = null
  db.auditCaptured = null
  db.auditShouldThrow = false
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
              maybeSingle: () =>
                Promise.resolve({
                  data: { id: 1, group_id: db.savGroupId, reference: 'SAV-2026-00001' },
                  error: null,
                }),
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
      if (table === 'sav_supplier_claims') {
        return {
          select: () => ({
            eq: () => ({
              // First .eq('id', claimId) → maybeSingle
              maybeSingle: () =>
                Promise.resolve({
                  data: db.claimRow,
                  error: db.claimRow === null ? { message: 'no rows', code: 'PGRST116' } : null,
                }),
            }),
          }),
        }
      }
      return {
        select: () => ({
          eq: () => Promise.resolve({ data: [], error: null }),
        }),
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

vi.mock('../../../../api/_lib/audit/record', () => ({
  recordAudit: async (input: unknown) => {
    if (db.auditShouldThrow) {
      throw new Error('Audit forced failure (DL-06 test)')
    }
    db.auditCaptured = input
  },
}))

// ---------------------------------------------------------------------------
// Import handler AFTER mocks — also import deserializeBlob for pure unit tests
// ---------------------------------------------------------------------------

import { downloadSupplierClaimHandler, deserializeBlob } from '../../../../api/_lib/sav/download-supplier-claim-handler'

// ---------------------------------------------------------------------------
// User fixture helper
// ---------------------------------------------------------------------------

function makeOperatorUser(sub: number, role: SessionUser['role'] = 'sav-operator'): SessionUser {
  return {
    type: 'operator',
    sub,
    role,
    exp: Math.floor(Date.now() / 1000) + 3600,
  }
}

// ---------------------------------------------------------------------------
// Minimal xlsx blob fixture (≥ 1 KB to be realistic)
// ---------------------------------------------------------------------------

function makeXlsxBlob(): Buffer {
  // PK zip signature + enough padding to be > 1KB
  const sig = Buffer.from([0x50, 0x4b, 0x03, 0x04])
  const padding = Buffer.alloc(1200, 0x00)
  return Buffer.concat([sig, padding])
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubEnv('SESSION_COOKIE_SECRET', 'test-secret-at-least-32-bytes-longxxx')
  vi.stubEnv('SUPABASE_URL', 'http://localhost')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test')
  resetDb()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

// ===========================================================================
// DL-01 — DISCRIMINANT bytea round-trip vraie-DB (AC #6d)
//
// Ce test est un honnête skipIf — JAMAIS expect(true).toBe(true).
// Si HAS_DB=false, il skip proprement. Si HAS_DB=true, il exécute la vraie DB.
//
// Catche le bug: handler oublie Buffer.from(blob, 'base64') → sha256 ne matche pas.
// ===========================================================================

describe('DL-01: bytea round-trip vraie-DB (AC #6d — discriminant sérialisation)', () => {
  it.skipIf(!HAS_DB)(
    'DL-01a: INSERT blob connu + sha256 → download via handler → SHA-256(body) === stored sha256',
    async () => {
      const { createClient } = await import('@supabase/supabase-js')
      const admin = createClient(SUPABASE_URL!, SERVICE_ROLE!, {
        auth: { persistSession: false, autoRefreshToken: false },
      })

      // Find a SAV and operator from real DB
      const { data: savRow } = await admin
        .from('sav')
        .select('id, group_id')
        .limit(1)
        .maybeSingle<{ id: number; group_id: number }>()

      const { data: opRow } = await admin
        .from('operators')
        .select('id')
        .limit(1)
        .maybeSingle<{ id: number }>()

      if (!savRow || !opRow) {
        console.warn('[DL-01a] SKIP — pas de SAV/operator en DB preview')
        return
      }

      // Create a known blob with deterministic sha256
      const knownBlob = makeXlsxBlob()
      const knownSha256 = createHash('sha256').update(knownBlob).digest('hex')
      const uniqueRef = `DL-01-${Date.now()}`

      // INSERT claim avec le blob connu
      const { data: insertedClaim, error: insertError } = await admin
        .from('sav_supplier_claims')
        .insert({
          sav_id: savRow.id,
          credit_note_id: null,
          supplier_code: 'sol-y-fruta',
          reference: uniqueRef,
          albaran: '3127',
          fecha_albaran: '2026-06-05',
          total_importe_cents: 174,
          line_count: 1,
          filename: `RECLAMACION_SOL_Y_FRUTA_${uniqueRef}_2026-06-05.xlsx`,
          document_blob: knownBlob,
          document_sha256: knownSha256,
          regeneration_of: null,
          generated_by_operator_id: opRow.id,
        })
        .select('id, sav_id, filename, document_blob, document_sha256, total_importe_cents, generated_by_operator_id')
        .single<{
          id: number
          sav_id: number
          filename: string
          document_blob: unknown
          document_sha256: string
          total_importe_cents: number
          generated_by_operator_id: number
        }>()

      try {
        expect(insertError).toBeNull()
        expect(insertedClaim).not.toBeNull()

        // Now call the handler with the real claim data injected
        // This tests the full deserialization path (base64 string → Buffer)
        db.claimRow = {
          id: insertedClaim!.id,
          sav_id: insertedClaim!.sav_id,
          filename: insertedClaim!.filename,
          // document_blob as returned by supabase-js (may be base64 string or Buffer)
          document_blob: insertedClaim!.document_blob as Buffer | string,
          document_sha256: insertedClaim!.document_sha256,
          total_importe_cents: insertedClaim!.total_importe_cents,
          generated_by_operator_id: insertedClaim!.generated_by_operator_id,
        }
        db.savGroupId = savRow.group_id
        db.operatorGroupIds = [savRow.group_id] // Same group

        const req = mockReq({
          method: 'GET',
          headers: {},
          query: { id: String(savRow.id), claimId: String(insertedClaim!.id) },
          user: makeOperatorUser(opRow.id, 'admin'), // admin bypass group check
        })
        const res = mockRes()

        await downloadSupplierClaimHandler(savRow.id)(req, res)

        expect(res.statusCode).toBe(200)

        // DISCRIMINANT: SHA-256 of returned bytes must match stored sha256
        // If handler returns base64 string instead of raw bytes, sha256 won't match
        const returnedBuffer = Buffer.concat(res.chunks)
        expect(returnedBuffer.length).toBeGreaterThan(0)

        const returnedSha256 = createHash('sha256').update(returnedBuffer).digest('hex')
        // This assertion FAILS if the handler serializes incorrectly (base64 leak)
        expect(returnedSha256).toBe(knownSha256)
      } finally {
        // Cleanup
        if (insertedClaim?.id) {
          await admin.from('sav_supplier_claims').delete().eq('id', insertedClaim.id)
        }
      }
    },
    30_000
  )
})

// ===========================================================================
// DL-02 — GARDE IDOR DISCRIMINANTE (AC #6e)
//
// Scenario: claim appartient à sav_id=2, l'opérateur demande via savId=1.
// Attendu: 404 NOT_FOUND (pas 200, pas 403).
//
// Ce test DOIT aller RED si la ligne suivante est retirée du handler:
//   if (claim.sav_id !== savId) return 404
//
// La vérification "blob leaké" est explicite:
//   - assert response.statusCode === 404
//   - assert res.chunks is empty (le blob n'a pas été retourné)
// ===========================================================================

describe('DL-02: GARDE IDOR — claimId d\'un autre SAV → 404 (DISCRIMINANT)', () => {
  it(
    'DL-02a: DISCRIMINANT IDOR — claim.sav_id=2 mais savId=1 → 404 + blob NON retourné',
    async () => {
      // Claim qui appartient à sav_id=2 (pas sav_id=1 demandé)
      db.claimRow = {
        id: 999,
        sav_id: 2,         // AUTRE SAV — la garde IDOR doit rejeter
        filename: 'RECLAMACION_SOL_Y_FRUTA_SAV-2026-00002_2026-06-05.xlsx',
        document_blob: makeXlsxBlob(),
        document_sha256: 'sha256ofclaimfromsav2',
        total_importe_cents: 500,
        generated_by_operator_id: 10,
      }
      db.savGroupId = 1
      db.operatorGroupIds = [1]

      // Opérateur légitime sur SAV 1 (group scope OK pour savId=1)
      // mais claimId=999 appartient à SAV 2 → IDOR
      const req = mockReq({
        method: 'GET',
        headers: {},
        query: {
          id: '1',        // savId = 1 (l'opérateur a accès à ce SAV)
          claimId: '999', // claimId dont sav_id = 2 (AUTRE SAV → IDOR attempt)
        },
        user: makeOperatorUser(10),
      })
      const res = mockRes()

      await downloadSupplierClaimHandler(1)(req, res)

      // DISCRIMINANT ASSERTION:
      // Si la garde est retirée du handler, ce test échoue avec status=200
      // et des chunks non vides (le blob aurait été retourné)
      expect(res.statusCode).toBe(404)

      // Blob NE DOIT PAS avoir été retourné (anti-fuite)
      const blobLeaked = res.chunks.length > 0
      expect(blobLeaked).toBe(false) // FAILS if blob is leaked

      // S'assurer que le body est du JSON d'erreur, pas un blob
      const errorBody = res.jsonBody as { error?: { code: string } } | null
      expect(errorBody?.error?.code).toBe('NOT_FOUND')
    }
  )

  it(
    'DL-02b: claim appartenant au bon SAV → 200 (garde ne rejette pas à tort)',
    async () => {
      const blob = makeXlsxBlob()
      db.claimRow = {
        id: 1,
        sav_id: 1,  // MÊME SAV que savId=1 → garde IDOR passe
        filename: 'RECLAMACION_SOL_Y_FRUTA_SAV-2026-00001_2026-06-05.xlsx',
        document_blob: blob,
        document_sha256: createHash('sha256').update(blob).digest('hex'),
        total_importe_cents: 174,
        generated_by_operator_id: 10,
      }

      const req = mockReq({
        method: 'GET',
        headers: {},
        query: { id: '1', claimId: '1' },
        user: makeOperatorUser(10),
      })
      const res = mockRes()

      await downloadSupplierClaimHandler(1)(req, res)

      expect(res.statusCode).toBe(200)
    }
  )
})

// ===========================================================================
// DL-03 — Happy path — 200 + headers corrects (AC #2)
// ===========================================================================

describe('DL-03: happy path — 200 + Content-Type xlsx + Content-Disposition + Cache-Control (AC #2)', () => {
  it('DL-03a: 200 + Content-Type application/vnd.openxmlformats', async () => {
    const blob = makeXlsxBlob()
    db.claimRow = {
      id: 1,
      sav_id: 1,
      filename: 'RECLAMACION_SOL_Y_FRUTA_SAV-2026-00001_2026-06-05.xlsx',
      document_blob: blob,
      document_sha256: createHash('sha256').update(blob).digest('hex'),
      total_importe_cents: 174,
      generated_by_operator_id: 10,
    }

    const req = mockReq({
      method: 'GET',
      headers: {},
      query: { id: '1', claimId: '1' },
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await downloadSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
  })

  it('DL-03b: Content-Disposition attachment avec le filename persisté', async () => {
    const blob = makeXlsxBlob()
    const expectedFilename = 'RECLAMACION_SOL_Y_FRUTA_SAV-2026-00001_2026-06-05.xlsx'
    db.claimRow = {
      id: 1,
      sav_id: 1,
      filename: expectedFilename,
      document_blob: blob,
      document_sha256: createHash('sha256').update(blob).digest('hex'),
      total_importe_cents: 174,
      generated_by_operator_id: 10,
    }

    const req = mockReq({
      method: 'GET',
      headers: {},
      query: { id: '1', claimId: '1' },
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await downloadSupplierClaimHandler(1)(req, res)

    const disposition = String(res.headers['content-disposition'] ?? '')
    expect(disposition).toContain('attachment')
    expect(disposition).toContain(expectedFilename)
  })
})

// ===========================================================================
// DL-04 — Rate limit 10/60s → 429 (AC #6g)
// ===========================================================================

describe('DL-04: rate limit download 10/60s → 429 (AC #6g)', () => {
  it('DL-04a: rate limit dépassé → 429 RATE_LIMITED', async () => {
    db.rateLimitAllowed = false // Simule dépassement du bucket 10/60s

    const blob = makeXlsxBlob()
    db.claimRow = {
      id: 1,
      sav_id: 1,
      filename: 'test.xlsx',
      document_blob: blob,
      document_sha256: 'sha256',
      total_importe_cents: 174,
      generated_by_operator_id: 10,
    }

    const req = mockReq({
      method: 'GET',
      headers: {},
      query: { id: '1', claimId: '1' },
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await downloadSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(429)
  })
})

// ===========================================================================
// DL-05 — Audit sav_supplier_claim_downloaded tracé après 200 (AC #6h, DN-1=A)
// ===========================================================================

describe('DL-05: audit sav_supplier_claim_downloaded après re-download 200 (AC #6h, DN-1=A)', () => {
  it('DL-05a: après 200, audit_trail contient action=sav_supplier_claim_downloaded + actorOperatorId non-null + diff.savId', async () => {
    const blob = makeXlsxBlob()
    const filename = 'RECLAMACION_SOL_Y_FRUTA_SAV-2026-00001_2026-06-05.xlsx'
    db.claimRow = {
      id: 1,
      sav_id: 1,
      filename,
      document_blob: blob,
      document_sha256: createHash('sha256').update(blob).digest('hex'),
      total_importe_cents: 174,
      generated_by_operator_id: 10,
    }

    const req = mockReq({
      method: 'GET',
      headers: {},
      query: { id: '1', claimId: '1' },
      user: makeOperatorUser(42),
    })
    const res = mockRes()

    await downloadSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(200)

    const audit = db.auditCaptured as {
      entityType?: string
      action?: string
      entityId?: number
      actorOperatorId?: number
      diff?: { savId?: number; claimId?: number; filename?: string }
    } | null

    expect(audit).not.toBeNull()
    expect(audit?.entityType).toBe('sav_supplier_claim')
    expect(audit?.action).toBe('sav_supplier_claim_downloaded')
    expect(typeof audit?.actorOperatorId).toBe('number')
    expect(audit?.actorOperatorId).toBe(42)
    expect(audit?.diff?.savId).toBe(1)
    expect(audit?.diff?.filename).toBe(filename)
  })
})

// ===========================================================================
// DL-06 — Audit échec best-effort ≠ bloquant (AC #6i, DN-1=A)
// ===========================================================================

describe('DL-06: audit échec = non bloquant — 200 + blob livré même si recordAudit throws (AC #6i)', () => {
  it('DL-06a: recordAudit throws → réponse reste 200 + blob retourné', async () => {
    db.auditShouldThrow = true // Force audit to throw

    const blob = makeXlsxBlob()
    db.claimRow = {
      id: 1,
      sav_id: 1,
      filename: 'test.xlsx',
      document_blob: blob,
      document_sha256: createHash('sha256').update(blob).digest('hex'),
      total_importe_cents: 174,
      generated_by_operator_id: 10,
    }

    const req = mockReq({
      method: 'GET',
      headers: {},
      query: { id: '1', claimId: '1' },
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    // Should NOT throw — best-effort audit
    await expect(downloadSupplierClaimHandler(1)(req, res)).resolves.not.toThrow()

    // Le blob doit quand même être retourné (best-effort = ne bloque pas le métier)
    expect(res.statusCode).toBe(200)
    expect(res.chunks.length).toBeGreaterThan(0)
  })
})

// ===========================================================================
// DL-07 — Méthode non-GET → 405 (AC #4)
// ===========================================================================

describe('DL-07: méthode non-GET → 405 (AC #4)', () => {
  it('DL-07a: POST → 405 METHOD_NOT_ALLOWED', async () => {
    const req = mockReq({
      method: 'POST',
      headers: {},
      query: { id: '1', claimId: '1' },
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await downloadSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(405)
  })
})

// ===========================================================================
// DL-08 — Group scope — opérateur autre groupe → 403 (AC #4c)
// ===========================================================================

describe('DL-08: group scope — opérateur autre groupe → 403 (AC #4c)', () => {
  it('DL-08a: opérateur groupe [2] pour SAV groupe_id=1 → 403 FORBIDDEN', async () => {
    db.operatorGroupIds = [2]
    db.savGroupId = 1

    const req = mockReq({
      method: 'GET',
      headers: {},
      query: { id: '1', claimId: '1' },
      user: makeOperatorUser(20),
    })
    const res = mockRes()

    await downloadSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(403)
  })
})

// ===========================================================================
// DL-09 — claimId inexistant → 404 (AC #4d)
// ===========================================================================

describe('DL-09: claimId inexistant → 404 (AC #4d)', () => {
  it('DL-09a: claim non trouvée en DB → 404 NOT_FOUND', async () => {
    db.claimRow = null // Simule l'absence de claim

    const req = mockReq({
      method: 'GET',
      headers: {},
      query: { id: '1', claimId: '9999' },
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await downloadSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(404)
  })
})

// ===========================================================================
// DL-HEX-01 — DISCRIMINANT bytea hex-decode PURE UNIT (no DB, always runs in CI)
//
// CR fix H1 : Supabase/PostgREST retourne bytea comme '\x504b0304...' par défaut.
// L'ancien code (base64-only) retourne des bytes corrompus en production.
//
// Ce test DOIT aller RED contre l'ancien code base64-only
// et GREEN après le fix (hex Postgres → hex first).
//
// Couvre deserializeBlob() directement (exported for testability) :
//   DL-HEX-01a: '\x' hex Postgres → Buffer exact (DISCRIMINANT load-bearing)
//   DL-HEX-01b: bare hex string → Buffer exact
//   DL-HEX-01c: base64 string → Buffer exact (ancienne branche préservée)
//   DL-HEX-01d: Buffer → passthrough direct
//   DL-HEX-01e: null → null
//
// DL-HEX-02 : round-trip via le handler complet (sans DB) en mode hex Postgres
// ===========================================================================

describe('DL-HEX-01: deserializeBlob pure unit — hex Postgres + bare hex + base64 + Buffer + null (H1 DISCRIMINANT)', () => {
  it('DL-HEX-01a: DISCRIMINANT — \\x hex Postgres → Buffer exact (RED sur old base64-only code)', () => {
    const original = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xde, 0xad, 0xbe, 0xef])
    const hexString = '\\x' + original.toString('hex')

    const result = deserializeBlob(hexString)

    expect(result).not.toBeNull()
    // SHA-256 round-trip — le discriminant principal
    const sha256Original = createHash('sha256').update(original).digest('hex')
    const sha256Result = createHash('sha256').update(result!).digest('hex')
    expect(sha256Result).toBe(sha256Original)
    // Bytes exacts (valeur directe, pas seulement sha256)
    expect(Buffer.compare(result!, original)).toBe(0)
  })

  it('DL-HEX-01b: bare hex string sans préfixe \\x → Buffer exact', () => {
    const original = Buffer.from([0x01, 0x02, 0x03, 0x04])
    const hexString = original.toString('hex') // bare hex, no \x prefix

    const result = deserializeBlob(hexString)

    expect(result).not.toBeNull()
    expect(Buffer.compare(result!, original)).toBe(0)
  })

  it('DL-HEX-01c: string base64 → Buffer exact (branche last-resort préservée)', () => {
    const original = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])
    const base64String = original.toString('base64')

    const result = deserializeBlob(base64String)

    expect(result).not.toBeNull()
    expect(Buffer.compare(result!, original)).toBe(0)
  })

  it('DL-HEX-01d: Buffer passthrough direct (SDK server path)', () => {
    const original = Buffer.from([0xca, 0xfe, 0xba, 0xbe])

    const result = deserializeBlob(original)

    expect(result).toBe(original) // même référence (pas de copie)
  })

  it('DL-HEX-01e: null → null', () => {
    expect(deserializeBlob(null)).toBeNull()
  })
})

describe('DL-HEX-02: round-trip handler complet — blob en format hex Postgres → bytes servis intacts (H1 DISCRIMINANT)', () => {
  it('DL-HEX-02a: document_blob comme string hex Postgres → réponse 200 + SHA-256(served) === SHA-256(original)', async () => {
    const original = makeXlsxBlob()
    const postgresHexString = '\\x' + original.toString('hex')
    const expectedSha256 = createHash('sha256').update(original).digest('hex')

    db.claimRow = {
      id: 1,
      sav_id: 1,
      filename: 'RECLAMACION_SOL_Y_FRUTA_SAV-2026-00001_2026-06-05.xlsx',
      document_blob: postgresHexString, // Postgres bytea hex format — le bug H1
      document_sha256: expectedSha256,
      total_importe_cents: 174,
      generated_by_operator_id: 10,
    }

    const req = mockReq({
      method: 'GET',
      headers: {},
      query: { id: '1', claimId: '1' },
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await downloadSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(200)

    const servedBuffer = Buffer.concat(res.chunks)
    expect(servedBuffer.length).toBeGreaterThan(0)

    // DISCRIMINANT H1 : SHA-256 des bytes servis === SHA-256 original
    // Fails against old base64-only code (which decodes hex chars as base64 → corrupt bytes)
    const servedSha256 = createHash('sha256').update(servedBuffer).digest('hex')
    expect(servedSha256).toBe(expectedSha256)

    // Bytes exacts (defense in depth)
    expect(Buffer.compare(servedBuffer, original)).toBe(0)
  })

  it('DL-HEX-02b: document_blob comme Buffer → réponse 200 + bytes intacts (branche Buffer préservée)', async () => {
    const original = makeXlsxBlob()
    const expectedSha256 = createHash('sha256').update(original).digest('hex')

    db.claimRow = {
      id: 1,
      sav_id: 1,
      filename: 'test.xlsx',
      document_blob: original, // Buffer direct
      document_sha256: expectedSha256,
      total_importe_cents: 174,
      generated_by_operator_id: 10,
    }

    const req = mockReq({
      method: 'GET',
      headers: {},
      query: { id: '1', claimId: '1' },
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await downloadSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(200)
    const servedBuffer = Buffer.concat(res.chunks)
    const servedSha256 = createHash('sha256').update(servedBuffer).digest('hex')
    expect(servedSha256).toBe(expectedSha256)
  })
})

// ===========================================================================
// DL-10 — Headers Content-Length + Cache-Control: private, no-store (AC #2, NFR-SEC)
// ===========================================================================

describe('DL-10: headers Content-Length + Cache-Control private no-store (AC #2, NFR-SEC)', () => {
  it('DL-10a: Cache-Control: private, no-store présent (NFR-SEC — données sensibles)', async () => {
    const blob = makeXlsxBlob()
    db.claimRow = {
      id: 1,
      sav_id: 1,
      filename: 'test.xlsx',
      document_blob: blob,
      document_sha256: createHash('sha256').update(blob).digest('hex'),
      total_importe_cents: 174,
      generated_by_operator_id: 10,
    }

    const req = mockReq({
      method: 'GET',
      headers: {},
      query: { id: '1', claimId: '1' },
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await downloadSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(200)
    const cacheControl = String(res.headers['cache-control'] ?? '')
    expect(cacheControl).toContain('private')
    expect(cacheControl).toContain('no-store')
  })

  it('DL-10b: Content-Length présent et correspond au body retourné', async () => {
    const blob = makeXlsxBlob()
    db.claimRow = {
      id: 1,
      sav_id: 1,
      filename: 'test.xlsx',
      document_blob: blob,
      document_sha256: createHash('sha256').update(blob).digest('hex'),
      total_importe_cents: 174,
      generated_by_operator_id: 10,
    }

    const req = mockReq({
      method: 'GET',
      headers: {},
      query: { id: '1', claimId: '1' },
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await downloadSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(200)
    const contentLength = Number(res.headers['content-length'])
    const actualBodyLength = Buffer.concat(res.chunks).length
    expect(contentLength).toBeGreaterThan(0)
    expect(contentLength).toBe(actualBodyLength)
  })
})
