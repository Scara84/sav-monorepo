/**
 * Story 8.5 — AC #1, AC #4, AC #6 (a, b, c, f, j) : Tests handler get-supplier-claim-history
 *
 * Test type: UNIT (handler isolé via vi.mock)
 *
 * Préfixes des tests: HIST-
 *
 * Décisions appliquées (toutes LOCKED) :
 *   AC #1 : op 'get-supplier-claim-history' accepte GET, reçoit ?id=<savId>
 *   AC #4 (a,b,c) : withAuth + withRateLimit 30/60s + checkGroupScope
 *   DN-3 LOCKED : 0 migration, tri en mémoire dans le handler
 *   AC #1 : document_blob JAMAIS retourné dans cet op (NFR-PERF)
 *
 * Mock strategy :
 *   - Supabase admin client : STRICT — si document_blob est lu dans ce handler,
 *     le mock lève une erreur détectable (catching NFR-PERF regression).
 *   - recordAudit : capturé dans db.auditCaptured
 *   - withRateLimit : contrôlé via db.rateLimitAllowed
 *
 * Coverage :
 *   HIST-01 (AC #6a) : SAV sans claim → 200 + { claims: [] }
 *   HIST-02 (AC #6b) : 1 claim → version=1, isLatest=true, regenerationOf=null
 *   HIST-03 (AC #6c) : 3 claims régénérées → tri DESC, version ordinal, isLatest exclusif
 *   HIST-04 (AC #6f) : group scope — opérateur autre groupe → 403
 *   HIST-05 (AC #4b) : méthode POST → 405 METHOD_NOT_ALLOWED
 *   HIST-06 (AC #4b) : rate limit → 429
 *   HIST-07 (AC #6j) : cap Vercel 12/12 — ls client/api/*.ts | wc -l == 5
 *   HIST-08 (NFR-PERF strict) : document_blob jamais sélectionné dans cet op
 *   HIST-09 (AC #1) : hasDocument = true ssi octet_length > 0
 *
 * NOTE RED phase :
 *   client/api/_lib/sav/get-supplier-claim-history-handler.ts n'existe pas encore.
 *   Ces tests DOIVENT échouer jusqu'à l'implémentation Task 1.
 *   Tout green avant implémentation = faux-vert.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

// ---------------------------------------------------------------------------
// Hoisted mutable state
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => ({
  savGroupId: 1 as number,
  operatorGroupIds: [1] as number[],
  rateLimitAllowed: true as boolean,
  // claims to return for this SAV (no document_blob — STRICT)
  claimsForSav: [] as Array<{
    id: number
    sav_id: number
    generated_at: string
    total_importe_cents: number
    line_count: number
    filename: string
    regeneration_of: number | null
    document_sha256: string
    generated_by_operator_id: number
    operators: { id: number; full_name: string } | null
  }>,
  // Strict sentinel: if document_blob is read, set this to true
  documentBlobRead: false as boolean,
}))

function resetDb(): void {
  db.savGroupId = 1
  db.operatorGroupIds = [1]
  db.rateLimitAllowed = true
  db.claimsForSav = []
  db.documentBlobRead = false
}

// ---------------------------------------------------------------------------
// vi.mock declarations (hoisted)
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
          select: (cols: string) => {
            // STRICT NFR-PERF guard — document_blob MUST NOT be selected
            if (typeof cols === 'string' && cols.includes('document_blob')) {
              db.documentBlobRead = true
            }
            return {
              eq: () => ({
                order: () =>
                  Promise.resolve({
                    data: db.claimsForSav,
                    error: null,
                  }),
              }),
            }
          },
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
  recordAudit: async () => {},
}))

// ---------------------------------------------------------------------------
// Import handler AFTER mocks
// ---------------------------------------------------------------------------

import { getSupplierClaimHistoryHandler } from '../../../../api/_lib/sav/get-supplier-claim-history-handler'

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
// Claim fixture helper (no document_blob — STRICT)
// ---------------------------------------------------------------------------

function makeClaimRow(overrides: Partial<typeof db.claimsForSav[0]> = {}): typeof db.claimsForSav[0] {
  return {
    id: 1,
    sav_id: 1,
    generated_at: '2026-06-05T10:00:00Z',
    total_importe_cents: 174,
    line_count: 1,
    filename: 'RECLAMACION_SOL_Y_FRUTA_SAV-2026-00001_2026-06-05.xlsx',
    regeneration_of: null,
    document_sha256: 'abc123',
    generated_by_operator_id: 10,
    operators: { id: 10, full_name: 'Antho Test' },
    ...overrides,
  }
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
// HIST-01 — SAV sans claim → 200 + { claims: [] } (AC #6a)
// ===========================================================================

describe('HIST-01: SAV sans claim → 200 + { claims: [] } (AC #6a)', () => {
  it('HIST-01a: réponse 200 avec claims vide (pas d\'erreur, pas de leak)', async () => {
    db.claimsForSav = []

    const req = mockReq({
      method: 'GET',
      headers: {},
      query: { id: '1' },
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await getSupplierClaimHistoryHandler(1)(req, res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { savId?: number; claims?: unknown[] }
    expect(Array.isArray(body?.claims)).toBe(true)
    expect(body?.claims).toHaveLength(0)
  })

  it('HIST-01b: body contient savId', async () => {
    db.claimsForSav = []

    const req = mockReq({
      method: 'GET',
      headers: {},
      query: { id: '1' },
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await getSupplierClaimHistoryHandler(1)(req, res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { savId?: number }
    expect(body?.savId).toBe(1)
  })
})

// ===========================================================================
// HIST-02 — 1 claim → version=1, isLatest=true, regenerationOf=null (AC #6b)
// ===========================================================================

describe('HIST-02: 1 claim → version=1, isLatest=true, regenerationOf=null (AC #6b)', () => {
  it('HIST-02a: claims[0].version === 1 + isLatest === true + regenerationOf === null', async () => {
    db.claimsForSav = [
      makeClaimRow({ id: 1, regeneration_of: null }),
    ]

    const req = mockReq({
      method: 'GET',
      headers: {},
      query: { id: '1' },
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await getSupplierClaimHistoryHandler(1)(req, res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { claims: Array<{
      id: number
      version: number
      isLatest: boolean
      regenerationOf: number | null
      generatedByOperator: { id: number; fullName: string }
      totalImporteCents: number
      lineCount: number
      filename: string
      generatedAt: string
      hasDocument: boolean
    }> }
    expect(body.claims).toHaveLength(1)
    expect(body.claims[0]?.version).toBe(1)
    expect(body.claims[0]?.isLatest).toBe(true)
    expect(body.claims[0]?.regenerationOf).toBeNull()
  })

  it('HIST-02b: claims[0].generatedByOperator contient id + fullName', async () => {
    db.claimsForSav = [
      makeClaimRow({
        id: 1,
        operators: { id: 10, full_name: 'Antho Test' },
      }),
    ]

    const req = mockReq({
      method: 'GET',
      headers: {},
      query: { id: '1' },
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await getSupplierClaimHistoryHandler(1)(req, res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { claims: Array<{ generatedByOperator: { id: number; fullName: string } }> }
    expect(body.claims[0]?.generatedByOperator?.id).toBe(10)
    expect(body.claims[0]?.generatedByOperator?.fullName).toBe('Antho Test')
  })
})

// ===========================================================================
// HIST-03 — 3 claims régénérées → tri DESC, versions ordinals, isLatest exclusif (AC #6c)
// ===========================================================================

describe('HIST-03: 3 claims régénérées → ordinal version + isLatest exclusif (AC #6c)', () => {
  it('HIST-03a: claims triées DESC par generatedAt — claims[0] est la plus récente (version=3)', async () => {
    // La DB retourne déjà en DESC order (le handler demande ORDER BY generated_at DESC)
    // Ici on simule ce que la DB renvoie : la plus récente en premier
    db.claimsForSav = [
      makeClaimRow({ id: 3, sav_id: 1, generated_at: '2026-06-07T10:00:00Z', regeneration_of: 2 }),
      makeClaimRow({ id: 2, sav_id: 1, generated_at: '2026-06-06T10:00:00Z', regeneration_of: 1 }),
      makeClaimRow({ id: 1, sav_id: 1, generated_at: '2026-06-05T10:00:00Z', regeneration_of: null }),
    ]

    const req = mockReq({
      method: 'GET',
      headers: {},
      query: { id: '1' },
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await getSupplierClaimHistoryHandler(1)(req, res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { claims: Array<{ id: number; version: number; isLatest: boolean; regenerationOf: number | null }> }
    expect(body.claims).toHaveLength(3)

    // claims[0] = la plus récente (id=3) → version=3, isLatest=true
    expect(body.claims[0]?.id).toBe(3)
    expect(body.claims[0]?.version).toBe(3)
    expect(body.claims[0]?.isLatest).toBe(true)
    expect(body.claims[0]?.regenerationOf).toBe(2)

    // claims[1] = version=2, isLatest=false
    expect(body.claims[1]?.id).toBe(2)
    expect(body.claims[1]?.version).toBe(2)
    expect(body.claims[1]?.isLatest).toBe(false)
    expect(body.claims[1]?.regenerationOf).toBe(1)

    // claims[2] = la première (id=1) → version=1, isLatest=false, regenerationOf=null
    expect(body.claims[2]?.id).toBe(1)
    expect(body.claims[2]?.version).toBe(1)
    expect(body.claims[2]?.isLatest).toBe(false)
    expect(body.claims[2]?.regenerationOf).toBeNull()
  })

  it('HIST-03b: isLatest === true exclusivement pour la 1ère claim (plus récente)', async () => {
    db.claimsForSav = [
      makeClaimRow({ id: 3, generated_at: '2026-06-07T10:00:00Z', regeneration_of: 2 }),
      makeClaimRow({ id: 2, generated_at: '2026-06-06T10:00:00Z', regeneration_of: 1 }),
      makeClaimRow({ id: 1, generated_at: '2026-06-05T10:00:00Z', regeneration_of: null }),
    ]

    const req = mockReq({
      method: 'GET',
      headers: {},
      query: { id: '1' },
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await getSupplierClaimHistoryHandler(1)(req, res)

    const body = res.jsonBody as { claims: Array<{ isLatest: boolean }> }
    const latestCount = body.claims.filter((c) => c.isLatest).length
    expect(latestCount).toBe(1) // Exactement 1 isLatest
  })
})

// ===========================================================================
// HIST-04 — Group scope : opérateur autre groupe → 403 (AC #6f)
// ===========================================================================

describe('HIST-04: group scope — opérateur autre groupe → 403 (AC #6f)', () => {
  it('HIST-04a: opérateur groupe [2] pour SAV groupe_id=1 → 403 FORBIDDEN', async () => {
    db.operatorGroupIds = [2]
    db.savGroupId = 1

    const req = mockReq({
      method: 'GET',
      headers: {},
      query: { id: '1' },
      user: makeOperatorUser(20),
    })
    const res = mockRes()

    await getSupplierClaimHistoryHandler(1)(req, res)

    expect(res.statusCode).toBe(403)
  })

  it('HIST-04b: admin bypass — admin peut accéder même si groupe mismatch → 200', async () => {
    db.operatorGroupIds = [99]
    db.savGroupId = 1
    db.claimsForSav = []

    const req = mockReq({
      method: 'GET',
      headers: {},
      query: { id: '1' },
      user: makeOperatorUser(99, 'admin' as const),
    })
    const res = mockRes()

    await getSupplierClaimHistoryHandler(1)(req, res)

    expect(res.statusCode).toBe(200)
  })
})

// ===========================================================================
// HIST-05 — Méthode non-GET → 405 METHOD_NOT_ALLOWED (AC #1, AC #4)
// ===========================================================================

describe('HIST-05: méthode non-GET → 405 (AC #1)', () => {
  it('HIST-05a: POST → 405 METHOD_NOT_ALLOWED', async () => {
    const req = mockReq({
      method: 'POST',
      headers: {},
      query: { id: '1' },
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await getSupplierClaimHistoryHandler(1)(req, res)

    expect(res.statusCode).toBe(405)
  })

  it('HIST-05b: PATCH → 405', async () => {
    const req = mockReq({
      method: 'PATCH',
      headers: {},
      query: { id: '1' },
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await getSupplierClaimHistoryHandler(1)(req, res)

    expect(res.statusCode).toBe(405)
  })
})

// ===========================================================================
// HIST-06 — Rate limit → 429 RATE_LIMITED (AC #4b)
// ===========================================================================

describe('HIST-06: rate limit bucket sav:get-supplier-claim-history (AC #4b)', () => {
  it('HIST-06a: rate limit dépassé → 429', async () => {
    db.rateLimitAllowed = false

    const req = mockReq({
      method: 'GET',
      headers: {},
      query: { id: '1' },
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await getSupplierClaimHistoryHandler(1)(req, res)

    expect(res.statusCode).toBe(429)
  })
})

// ===========================================================================
// HIST-07 — Cap Vercel 12/12 — ls client/api/*.ts | wc -l == 5 (AC #6j)
// ===========================================================================

describe('HIST-07: cap Vercel 12/12 — pas de nouveau fichier api/*.ts (AC #6j)', () => {
  it('HIST-07a: ls client/api/*.ts | wc -l == 5 (baseline)', () => {
    const { readdirSync } = require('node:fs')
    const { join } = require('node:path')
    const apiDir = join(__dirname, '../../../../api')
    const apiFiles = readdirSync(apiDir).filter((f: string) => f.endsWith('.ts'))
    // Baseline = 5 fichiers : credit-notes.ts, health.ts, invoices.ts, pilotage.ts, sav.ts
    expect(apiFiles.length).toBe(5)
  })
})

// ===========================================================================
// HIST-08 — NFR-PERF strict : document_blob JAMAIS sélectionné (AC #3 + AC #1)
// Test discriminant : si le handler sélectionne document_blob, ce test ÉCHOUE
// ===========================================================================

describe('HIST-08: NFR-PERF — document_blob jamais lu dans get-supplier-claim-history (discriminant)', () => {
  it('HIST-08a: après appel, db.documentBlobRead === false (document_blob non sélectionné)', async () => {
    db.claimsForSav = [makeClaimRow()]
    db.documentBlobRead = false

    const req = mockReq({
      method: 'GET',
      headers: {},
      query: { id: '1' },
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await getSupplierClaimHistoryHandler(1)(req, res)

    // Ce test DOIT échouer si le handler sélectionne document_blob
    // car le mock positionne db.documentBlobRead = true si 'document_blob' est dans la string SELECT
    expect(db.documentBlobRead).toBe(false)
  })
})

// ===========================================================================
// HIST-09 — hasDocument = true ssi sha256 présent (AC #1 hasDocument)
// ===========================================================================

describe('HIST-09: hasDocument présent dans chaque claim (AC #1)', () => {
  it('HIST-09a: claim avec document_sha256 non-null → hasDocument === true', async () => {
    db.claimsForSav = [makeClaimRow({ document_sha256: 'abc123nonNull' })]

    const req = mockReq({
      method: 'GET',
      headers: {},
      query: { id: '1' },
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await getSupplierClaimHistoryHandler(1)(req, res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { claims: Array<{ hasDocument: boolean }> }
    expect(body.claims[0]?.hasDocument).toBe(true)
  })
})
