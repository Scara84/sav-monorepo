/**
 * Story 8.4 — AC #1, #2, #3, #5, #6, #7, #8, #9, #10, #11 : Tests handler generate-supplier-claim
 *
 * Test type: UNIT (handler isolé via vi.mock — pas de vraie DB dans CE fichier)
 * NOTE : Les tests vraie-DB (atomicité RPC, CHECK constraints, FK) sont dans
 *        client/tests/integration/sav/sav-supplier-claims-migration.test.ts (PATTERN-H15-A)
 *
 * Décisions appliquées :
 *   DN-2=B LOCKED : credit_note_id nullable — génération sans avoir autorisée
 *   DN-3=B LOCKED : writer dédié supplier-claim-writer.ts (pas supplierExportBuilder)
 *   DN-4=A LOCKED : régénération = nouvelle row + regeneration_of self-FK
 *   DN-5=A LOCKED : IMPORTE calculé serveur, valeur numérique dans xlsx
 *   DN-6=iii LOCKED : confiance cap 8.2, rejet 400 si blockingForGeneration && !excluded
 *   DN-7=B LOCKED : persistance via RPC insert_supplier_claim_with_lines SECURITY DEFINER
 *   DN-8=A LOCKED : filename pattern RECLAMACION_SOL_Y_FRUTA_<ref>_<YYYY-MM-DD>.xlsx
 *
 * Leçons appliquées :
 *   - feedback_test_integration_gap.md : tests discriminants doivent ÉCHOUER avant implémentation
 *   - Les tests qui touchent la vraie DB CHECK/FK/RPC sont dans integration/ (PATTERN-H15-A)
 *
 * Coverage (≥ 14 scénarios AC #11) :
 *   GEN-01 (AC #11a) : Happy path 2 lignes → 200 + Content-Type xlsx + body parseable
 *   GEN-02 (AC #11b) : CODIGO = codigoEs (FR23), jamais codigFr
 *   GEN-03 (AC #11c) : IMPORTE recalculé serveur — importe injecté ignoré
 *   GEN-04 (AC #11d) : [NOTE DN-6=iii] le cap qty serveur fait confiance au payload 8.2
 *                      — test rejet blockingForGeneration && !excluded (guard DN-6)
 *   GEN-05 (AC #11e) : Ligne excluded:true exclue du doc ET de la persistance
 *   GEN-06 (AC #11f) : Rejet si toutes lignes exclues → 400 no_valid_lines
 *   GEN-07 (AC #11g) : Sanitization formula-injection comentarios
 *   GEN-08 (AC #11h) : Group scope — opérateur groupe A pour SAV groupe B → 403
 *   GEN-09 (AC #11i) : Avoir absent autorisé (DN-2=B LOCKED) → 200 + credit_note_id IS NULL
 *   GEN-10 (AC #11i) : creditNoteId invalide (inexistant) → 400 invalid_credit_note_id
 *   GEN-11 (AC #11j) : Régénération chainée — 2 appels → regeneration_of chaîné
 *   GEN-12 (AC #11k) : Atomicité — RPC appelé (DN-7=B) ; test rollback = tests/integration/
 *   GEN-13 (AC #11l) : Audit — recordAudit appelé avec entity_type + action corrects
 *   GEN-14 (AC #11m) : Déterminisme blob — FECHA figée → sha256 identique
 *   GEN-15 (AC #1)   : Cap Vercel — pas de nouveau fichier api/*.ts
 *   GEN-16 (AC #1)   : Méthode non-POST → 405 METHOD_NOT_ALLOWED
 *   GEN-17 (AC #2)   : Body invalide (champ requis manquant) → 400
 *   GEN-18 (AC #3)   : Rate limit bucket 'sav:generate-supplier-claim' appliqué
 *   GEN-19 (AC #10)  : Régénération → filename inclut _v2
 *
 * NOTE RED phase :
 *   Le module client/api/_lib/sav/generate-supplier-claim-handler.ts n'existe pas encore.
 *   Ces tests DOIVENT échouer jusqu'à l'implémentation Task 3.
 *   Tout green avant implémentation = faux-vert.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'
import * as XLSX from 'xlsx'

// SECRET kept for legacy reference — auth is now injected directly (HIGH-5 : withAuth retiré du handler)
const SECRET = 'test-secret-at-least-32-bytes-longxxx'

// ---------------------------------------------------------------------------
// Hoisted mocks — mutable state
// ---------------------------------------------------------------------------

const db = vi.hoisted(() => ({
  // Simulation de l'état DB pour les tests
  savGroupId: 1 as number,
  operatorGroupIds: [1] as number[],
  rateLimitAllowed: true as boolean,
  // credit_notes row lookup
  creditNoteRow: null as null | { id: number; sav_id: number },
  // RPC result pour insert_supplier_claim_with_lines
  rpcInsertData: 42 as number | null, // retourne l'id de la claim créée
  rpcInsertError: null as null | { message: string; code?: string },
  // Existing claims pour régénération (AC #10, GEN-11)
  existingClaimsForSav: [] as Array<{ id: number; generated_at: string }>,
  // audit captured
  auditCaptured: null as unknown,
  // writer mock result (contrôlé dans buildClaimWorkbook mock)
  writerResult: null as null | { blob: Buffer; sha256: string; filename: string },
}))

function resetDb(): void {
  db.savGroupId = 1
  db.operatorGroupIds = [1]
  db.rateLimitAllowed = true
  db.creditNoteRow = null
  db.rpcInsertData = 42
  db.rpcInsertError = null
  db.existingClaimsForSav = []
  db.auditCaptured = null
  db.writerResult = null
}

// ---------------------------------------------------------------------------
// vi.mock declarations (hoisted by Vitest)
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
      if (table === 'credit_notes') {
        return {
          select: () => ({
            eq: (_col: string, _val: unknown) => ({
              eq: (_col2: string, _val2: unknown) => ({
                maybeSingle: () =>
                  Promise.resolve({ data: db.creditNoteRow, error: null }),
              }),
            }),
          }),
        }
      }
      if (table === 'sav_supplier_claims') {
        return {
          // Lookup des claims existantes pour régénération (AC #10)
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () =>
                  Promise.resolve({ data: db.existingClaimsForSav, error: null }),
              }),
              // Pour le count de régénération
              select: () =>
                Promise.resolve({
                  count: db.existingClaimsForSav.length,
                  error: null,
                }),
            }),
          }),
        }
      }
      if (table === 'audit_trail') {
        return {
          insert: (row: unknown) => {
            db.auditCaptured = row
            return Promise.resolve({ error: null })
          },
        }
      }
      return {
        select: () => ({
          eq: () => Promise.resolve({ data: [], error: null }),
        }),
        insert: () => Promise.resolve({ error: null }),
      }
    },
    rpc: (fn: string, _args: Record<string, unknown>) => {
      if (fn === 'increment_rate_limit') {
        return Promise.resolve({
          data: [{ allowed: db.rateLimitAllowed, retry_after: 1 }],
          error: null,
        })
      }
      if (fn === 'insert_supplier_claim_with_lines') {
        if (db.rpcInsertError) {
          return Promise.resolve({ data: null, error: db.rpcInsertError })
        }
        return Promise.resolve({ data: db.rpcInsertData, error: null })
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
    db.auditCaptured = input
  },
}))

// Mock du writer — retourne un blob xlsx minimal parseable
vi.mock('../../../../api/_lib/sav/supplier-claim-writer', () => ({
  buildClaimWorkbook: (input: { generatedAt: Date; savReference: string; regenerationIndex: number | null }) => {
    if (db.writerResult) return db.writerResult
    // Créer un vrai classeur SheetJS minimal (évite les faux-verts par fixture dégénérée)
    const wb = XLSX.utils.book_new()
    const wsData = [
      ['FECHA', 'REFERENCE COMMANDE', 'FECHA ALBARAN', 'ALBARAN', 'CODIGO', 'PRODUCTO', 'ORIGEN', 'PESO', 'ENVASE', 'CAUSA', 'PRECIO', 'COMENTARIOS', 'IMPORTE'],
      ['2026-06-05', '278_26S21_11', '2026-05-26', '3127', '1022', 'Aguacate', 'Málaga', 5, 'Kilos', 'estropeado', 5.29, '', 26.45],
    ]
    const ws = XLSX.utils.aoa_to_sheet(wsData)
    XLSX.utils.book_append_sheet(wb, ws, 'SUIVI')
    const blob = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
    const { createHash } = require('node:crypto')
    const sha256 = createHash('sha256').update(blob).digest('hex')
    const dateStr = input.generatedAt.toISOString().slice(0, 10)
    const suffix = input.regenerationIndex !== null ? `_v${input.regenerationIndex}` : ''
    const filename = `RECLAMACION_SOL_Y_FRUTA_${input.savReference}_${dateStr}${suffix}.xlsx`
    return { blob, sha256, filename }
  },
}))

// ---------------------------------------------------------------------------
// Import handler AFTER mocks
// ---------------------------------------------------------------------------

import { generateSupplierClaimHandler } from '../../../../api/_lib/sav/generate-supplier-claim-handler'

// ---------------------------------------------------------------------------
// User fixture helper — HIGH-5 : withAuth retiré du handler (router l'applique déjà).
// Les tests injectent req.user directement (plus propre pour tests unitaires).
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
// Fixture payload AC #2 (PATTERN-ARBITRATED-CLAIM-PAYLOAD)
// ---------------------------------------------------------------------------

function makeValidPayload(overrides: Record<string, unknown> = {}) {
  return {
    metadata: {
      reference: '278_26S21_11',
      albaran: '3127',
      fechaAlbaran: '2026-05-26',
    },
    creditNoteId: null, // DN-2=B nullable par défaut
    claimLines: [
      {
        savLineId: 1,
        codigoEs: '1022',
        productoEs: 'Aguacate Hass BIO',
        origen: 'Málaga',
        qty: 5,
        unidad: 'Kilos',
        causaEs: 'estropeado',
        precio: 5.29,
        comentarios: '',
        excluded: false,
        blockingForGeneration: false,
        conversionFlag: 'ok',
      },
      {
        savLineId: 2,
        codigoEs: '3301',
        productoEs: 'Tomate',
        origen: 'Almería',
        qty: 10,
        unidad: 'Kilos',
        causaEs: 'podrido',
        precio: 3.20,
        comentarios: '',
        excluded: false,
        blockingForGeneration: false,
        conversionFlag: 'ok',
      },
    ],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Process.env mock for session secret (align with reconcile-supplier-claim.spec.ts pattern)
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
// GEN-01 — Happy path : 200 + Content-Type xlsx + body parseable (AC #11a)
// ===========================================================================

describe('GEN-01: happy path — 200 + Content-Type xlsx (AC #11a)', () => {
  it('GEN-01a: payload 2 lignes valides → 200 + Content-Type xlsx', async () => {
    const req = mockReq({
      method: 'POST',
      headers: {},
      query: { id: '1' },
      body: makeValidPayload(),
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await generateSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
  })

  it('GEN-01b: body retourné est un blob xlsx parseable par SheetJS', async () => {
    const req = mockReq({
      method: 'POST',
      headers: {},
      query: { id: '1' },
      body: makeValidPayload(),
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await generateSupplierClaimHandler(1)(req, res)

    // Le body est un buffer xlsx
    const buf = Buffer.concat(res.chunks)
    expect(buf.length).toBeGreaterThan(0)

    // Parseable par SheetJS
    const wb = XLSX.read(buf, { type: 'buffer' })
    expect(wb.SheetNames).toContain('SUIVI')
  })

  it('GEN-01c: Content-Disposition attachment avec filename présent', async () => {
    const req = mockReq({
      method: 'POST',
      headers: {},
      query: { id: '1' },
      body: makeValidPayload(),
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await generateSupplierClaimHandler(1)(req, res)

    const disposition = res.headers['content-disposition']
    expect(typeof disposition).toBe('string')
    expect(String(disposition)).toContain('attachment')
    expect(String(disposition)).toContain('.xlsx')
  })

  // Anti-régression UAT 2026-06-05 : le parser xlsx produit albaran en NUMBER (ex. 3127),
  // pas en string. La validation exigeait string → 400 VALIDATION_FAILED en réel (faux-vert
  // car les fixtures utilisaient '3127' string). Discriminant : albaran number → 200.
  it('GEN-01d: metadata.albaran en number (3127) → 200 (tolérance string|number, leçon UAT)', async () => {
    const payload = makeValidPayload()
    ;(payload.metadata as Record<string, unknown>)['albaran'] = 3127 // number, pas '3127'
    const req = mockReq({
      method: 'POST',
      headers: {},
      query: { id: '1' },
      body: payload,
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await generateSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(200)
  })
})

// ===========================================================================
// GEN-02 — CODIGO = codigoEs (FR23) (AC #11b)
// ===========================================================================

describe('GEN-02: CODIGO = codigoEs, jamais code FR (AC #11b, FR23)', () => {
  it('GEN-02a: le writer reçoit codigoEs dans claimLines (pas le code FR)', async () => {
    const writeSpy = vi.fn().mockImplementation((...args: unknown[]) => {
      // Vérifier que les lignes passées au writer ont codigoEs = '1022'
      const input = args[0] as { claimLines: Array<{ codigoEs: string }> }
      expect(input.claimLines[0]?.codigoEs).toBe('1022')
      // Simuler le retour
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['FECHA']]), 'SUIVI')
      const blob = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
      const { createHash } = require('node:crypto')
      return { blob, sha256: createHash('sha256').update(blob).digest('hex'), filename: 'test.xlsx' }
    })

    // On re-mock le writer pour ce test spécifique
    const writerModule = await import('../../../../api/_lib/sav/supplier-claim-writer')
    vi.spyOn(writerModule, 'buildClaimWorkbook').mockImplementation(writeSpy as typeof writerModule.buildClaimWorkbook)

    const req = mockReq({
      method: 'POST',
      headers: {},
      query: { id: '1' },
      body: makeValidPayload(),
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await generateSupplierClaimHandler(1)(req, res)

    expect(writeSpy).toHaveBeenCalled()
  })
})

// ===========================================================================
// GEN-03 — IMPORTE recalculé serveur (AC #11c)
// ===========================================================================

describe('GEN-03: IMPORTE recalculé serveur — importe injecté ignoré (AC #11c)', () => {
  it('GEN-03a: payload qty=5, precio=5.29, importe injecté=99999 → RPC reçoit importe_cents=2645 (5×5.29×100)', async () => {
    // Spy sur le RPC pour capturer les lignes passées
    let rpcArgs: Record<string, unknown> | null = null
    const supabaseModule = await import('../../../../api/_lib/clients/supabase-admin')
    const adminClient = supabaseModule.supabaseAdmin()
    const rpcSpy = vi.spyOn(adminClient as { rpc: (fn: string, args: Record<string, unknown>) => unknown }, 'rpc').mockImplementation((fn: string, args: Record<string, unknown>) => {
      if (fn === 'insert_supplier_claim_with_lines') {
        rpcArgs = args
      }
      if (fn === 'increment_rate_limit') {
        return Promise.resolve({ data: [{ allowed: true, retry_after: 1 }], error: null })
      }
      return Promise.resolve({ data: 42, error: null })
    })

    const payload = makeValidPayload({
      claimLines: [
        {
          savLineId: 1,
          codigoEs: '1022',
          productoEs: 'Aguacate',
          origen: 'Málaga',
          qty: 5,
          unidad: 'Kilos',
          causaEs: 'estropeado',
          precio: 5.29,
          comentarios: '',
          excluded: false,
          blockingForGeneration: false,
          conversionFlag: 'ok',
          // Importe injecté (doit être ignoré côté serveur — recalcul authoritative)
          importe: 99999,
        },
      ],
    })

    const req = mockReq({
      method: 'POST',
      headers: {},
      query: { id: '1' },
      body: payload,
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await generateSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(200)
    // Vérifier que le RPC a été appelé avec importe_cents = Math.round(5 × 5.29 × 100) = 2645
    expect(rpcArgs).not.toBeNull()
    const lines = rpcArgs?.['p_lines'] as Array<{ importe_cents: number }> | undefined
    expect(Array.isArray(lines)).toBe(true)
    expect(lines?.[0]?.importe_cents).toBe(2645)

    rpcSpy.mockRestore()
  })
})

// ===========================================================================
// GEN-04 — Rejet si blockingForGeneration && !excluded (DN-6=iii) (AC #2b)
// ===========================================================================

describe('GEN-04: rejet 400 si ligne blockingForGeneration=true et !excluded (AC #2b, DN-6=iii)', () => {
  it('GEN-04a: 1 ligne blockingForGeneration=true, excluded=false → 400 VALIDATION_FAILED', async () => {
    const req = mockReq({
      method: 'POST',
      headers: {},
      query: { id: '1' },
      body: makeValidPayload({
        claimLines: [
          {
            savLineId: 1,
            codigoEs: '1022',
            productoEs: 'Aguacate',
            origen: 'Málaga',
            qty: 5,
            unidad: 'Kilos',
            causaEs: null,
            precio: null, // precio null → blockingForGeneration=true attendu
            comentarios: '',
            excluded: false,
            blockingForGeneration: true, // EXPLICITEMENT BLOQUANT
            conversionFlag: 'ok',
          },
        ],
      }),
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await generateSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error?.code).toBe('VALIDATION_FAILED')
  })

  it('GEN-04b: même ligne mais excluded=true → PAS de rejet (ligne ignorée)', async () => {
    const payload = makeValidPayload({
      claimLines: [
        {
          savLineId: 1,
          codigoEs: '1022',
          productoEs: 'Aguacate',
          origen: 'Málaga',
          qty: 5,
          unidad: 'Kilos',
          causaEs: null,
          precio: null,
          comentarios: '',
          excluded: true, // EXCLUE → rejet levé
          blockingForGeneration: true,
          conversionFlag: 'ok',
        },
        // Au moins 1 ligne valide (non exclue)
        {
          savLineId: 2,
          codigoEs: '3301',
          productoEs: 'Tomate',
          origen: 'Almería',
          qty: 10,
          unidad: 'Kilos',
          causaEs: 'podrido',
          precio: 3.20,
          comentarios: '',
          excluded: false,
          blockingForGeneration: false,
          conversionFlag: 'ok',
        },
      ],
    })

    const req = mockReq({
      method: 'POST',
      headers: {},
      query: { id: '1' },
      body: payload,
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await generateSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(200)
  })
})

// ===========================================================================
// GEN-05 — Ligne excluded:true exclue du doc ET de la persistance (AC #11e)
// ===========================================================================

describe('GEN-05: ligne excluded:true exclue du doc et de la persistance (AC #11e)', () => {
  it('GEN-05a: 1 ligne excluded=true → RPC reçoit p_lines sans cette ligne', async () => {
    let capturedLines: unknown[] | null = null
    const supabaseModule = await import('../../../../api/_lib/clients/supabase-admin')
    const adminClient = supabaseModule.supabaseAdmin()
    const rpcSpy = vi.spyOn(adminClient as { rpc: (fn: string, args: Record<string, unknown>) => unknown }, 'rpc').mockImplementation((fn: string, args: Record<string, unknown>) => {
      if (fn === 'increment_rate_limit') {
        return Promise.resolve({ data: [{ allowed: true, retry_after: 1 }], error: null })
      }
      if (fn === 'insert_supplier_claim_with_lines') {
        capturedLines = args['p_lines'] as unknown[]
        return Promise.resolve({ data: 42, error: null })
      }
      return Promise.resolve({ data: null, error: null })
    })

    const req = mockReq({
      method: 'POST',
      headers: {},
      query: { id: '1' },
      body: makeValidPayload({
        claimLines: [
          {
            savLineId: 1,
            codigoEs: '1022',
            productoEs: 'Aguacate',
            origen: 'Málaga',
            qty: 5,
            unidad: 'Kilos',
            causaEs: 'estropeado',
            precio: 5.29,
            comentarios: '',
            excluded: false, // INCLUE
            blockingForGeneration: false,
            conversionFlag: 'ok',
          },
          {
            savLineId: 2,
            codigoEs: '3301',
            productoEs: 'Tomate',
            origen: 'Almería',
            qty: 10,
            unidad: 'Kilos',
            causaEs: 'podrido',
            precio: 3.20,
            comentarios: '',
            excluded: true, // EXCLUE — doit être absente du RPC
            blockingForGeneration: false,
            conversionFlag: 'ok',
          },
        ],
      }),
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await generateSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(200)
    // p_lines ne contient que la ligne non exclue
    const lines5 = capturedLines as unknown as Array<{ sav_line_id: number }> | null
    expect(Array.isArray(lines5)).toBe(true)
    expect((lines5 as Array<unknown>).length).toBe(1)
    expect(lines5?.[0]?.sav_line_id).toBe(1)

    rpcSpy.mockRestore()
  })
})

// ===========================================================================
// GEN-06 — Rejet si toutes lignes exclues → 400 no_valid_lines (AC #11f)
// ===========================================================================

describe('GEN-06: rejet si toutes lignes exclues → 400 no_valid_lines (AC #11f)', () => {
  it('GEN-06a: claimLines.every(l => l.excluded) → 400 + error no_valid_lines', async () => {
    const req = mockReq({
      method: 'POST',
      headers: {},
      query: { id: '1' },
      body: makeValidPayload({
        claimLines: [
          {
            savLineId: 1,
            codigoEs: '1022',
            productoEs: 'Aguacate',
            origen: 'Málaga',
            qty: 5,
            unidad: 'Kilos',
            causaEs: 'estropeado',
            precio: 5.29,
            comentarios: '',
            excluded: true, // TOUTES EXCLUES
            blockingForGeneration: false,
            conversionFlag: 'ok',
          },
          {
            savLineId: 2,
            codigoEs: '3301',
            productoEs: 'Tomate',
            origen: 'Almería',
            qty: 10,
            unidad: 'Kilos',
            causaEs: 'podrido',
            precio: 3.20,
            comentarios: '',
            excluded: true, // TOUTES EXCLUES
            blockingForGeneration: false,
            conversionFlag: 'ok',
          },
        ],
      }),
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await generateSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error?.code).toBe('no_valid_lines')
  })
})

// ===========================================================================
// GEN-07 — Sanitization formula-injection comentarios (AC #11g, AC #6)
// ===========================================================================

describe("GEN-07: sanitization formula-injection comentarios (AC #11g, AC #6)", () => {
  it("GEN-07a: comentarios=\"=cmd|'/c calc'!A1\" → writer reçoit la valeur (sanitization dans le writer)", async () => {
    // Le handler passe la valeur brute au writer — la sanitization est dans supplier-claim-writer.ts
    // Ce test vérifie que la valeur est bien transmise au writer (pas tronquée/supprimée par le handler)
    let capturedWriterInput: { claimLines: Array<{ comentarios: string }> } | null = null
    const writerModule = await import('../../../../api/_lib/sav/supplier-claim-writer')
    vi.spyOn(writerModule, 'buildClaimWorkbook').mockImplementation((input) => {
      capturedWriterInput = input as { claimLines: Array<{ comentarios: string }> }
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['FECHA']]), 'SUIVI')
      const blob = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
      const { createHash } = require('node:crypto')
      return { blob, sha256: createHash('sha256').update(blob).digest('hex'), filename: 'test.xlsx' }
    })

    const maliciousComment = "=cmd|'/c calc'!A1"
    const req = mockReq({
      method: 'POST',
      headers: {},
      query: { id: '1' },
      body: makeValidPayload({
        claimLines: [
          {
            savLineId: 1,
            codigoEs: '1022',
            productoEs: 'Aguacate',
            origen: 'Málaga',
            qty: 5,
            unidad: 'Kilos',
            causaEs: 'estropeado',
            precio: 5.29,
            comentarios: maliciousComment,
            excluded: false,
            blockingForGeneration: false,
            conversionFlag: 'ok',
          },
        ],
      }),
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await generateSupplierClaimHandler(1)(req, res)

    // La valeur originale est passée au writer (le writer fait la sanitization)
    expect(capturedWriterInput).not.toBeNull()
    const captured = capturedWriterInput as unknown as { claimLines: Array<{ comentarios: string }> }
    expect(captured.claimLines[0]?.comentarios).toBe(maliciousComment)
  })
})

// ===========================================================================
// GEN-08 — Group scope : opérateur groupe A pour SAV groupe B → 403 (AC #11h)
// ===========================================================================

describe('GEN-08: group scope — opérateur groupe A pour SAV groupe B → 403 (AC #11h)', () => {
  it('GEN-08a: opérateur groupe [2] pour SAV groupe_id=1 → 403 FORBIDDEN', async () => {
    db.operatorGroupIds = [2] // Opérateur dans le groupe 2
    db.savGroupId = 1 // SAV dans le groupe 1 → mismatch

    const req = mockReq({
      method: 'POST',
      headers: {},
      query: { id: '1' },
      body: makeValidPayload(),
      user: makeOperatorUser(20),
    })
    const res = mockRes()

    await generateSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(403)
  })

  it('GEN-08b: admin bypass — admin avec groupe incorrect → 200 (admin voit tous les SAV)', async () => {
    db.operatorGroupIds = [99] // Groupe quelconque
    db.savGroupId = 1

    const req = mockReq({
      method: 'POST',
      headers: {},
      query: { id: '1' },
      body: makeValidPayload(),
      user: makeOperatorUser(99, 'admin' as const), // rôle admin
    })
    const res = mockRes()

    await generateSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(200)
  })
})

// ===========================================================================
// GEN-09 — Avoir absent autorisé (DN-2=B LOCKED) → 200 + credit_note_id IS NULL (AC #11i)
// ===========================================================================

describe('GEN-09: avoir absent autorisé (DN-2=B LOCKED) → 200 (AC #11i)', () => {
  it('GEN-09a: SAV sans avoir + payload creditNoteId=null → 200 + RPC appelé avec credit_note_id=null', async () => {
    db.creditNoteRow = null // Pas d'avoir en DB
    let capturedClaim: { credit_note_id: unknown } | null = null
    const supabaseModule = await import('../../../../api/_lib/clients/supabase-admin')
    const adminClient = supabaseModule.supabaseAdmin()
    const rpcSpy = vi.spyOn(adminClient as { rpc: (fn: string, args: Record<string, unknown>) => unknown }, 'rpc').mockImplementation((fn: string, args: Record<string, unknown>) => {
      if (fn === 'increment_rate_limit') {
        return Promise.resolve({ data: [{ allowed: true, retry_after: 1 }], error: null })
      }
      if (fn === 'insert_supplier_claim_with_lines') {
        capturedClaim = args['p_claim'] as { credit_note_id: unknown }
        return Promise.resolve({ data: 42, error: null })
      }
      return Promise.resolve({ data: null, error: null })
    })

    const req = mockReq({
      method: 'POST',
      headers: {},
      query: { id: '1' },
      body: makeValidPayload({ creditNoteId: null }),
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await generateSupplierClaimHandler(1)(req, res)

    // Test discriminant DN-2=B : la génération réussit SANS avoir lié
    expect(res.statusCode).toBe(200)
    // credit_note_id IS NULL dans la claim persistée
    const claimCaptured = capturedClaim as { credit_note_id: unknown } | null
    expect(claimCaptured?.credit_note_id).toBeNull()

    rpcSpy.mockRestore()
  })

  it('GEN-09b: audit diff.creditNoteId === null pour réclamation sans avoir (DN-2=B LOCKED)', async () => {
    db.creditNoteRow = null

    const req = mockReq({
      method: 'POST',
      headers: {},
      query: { id: '1' },
      body: makeValidPayload({ creditNoteId: null }),
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await generateSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(200)
    // L'audit doit tracer creditNoteId = null
    const audit = db.auditCaptured as {
      diff?: { creditNoteId?: unknown }
    } | null
    expect(audit).not.toBeNull()
    expect(audit?.diff?.creditNoteId).toBeNull()
  })
})

// ===========================================================================
// GEN-10 — creditNoteId invalide → 400 invalid_credit_note_id (AC #11i variante)
// ===========================================================================

describe('GEN-10: creditNoteId invalide (id inexistant) → 400 invalid_credit_note_id (AC #3)', () => {
  it('GEN-10a: payload creditNoteId=9999 mais row credit_notes inexistante → 400', async () => {
    db.creditNoteRow = null // L'avoir id=9999 n'existe pas

    const req = mockReq({
      method: 'POST',
      headers: {},
      query: { id: '1' },
      body: makeValidPayload({ creditNoteId: 9999 }),
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await generateSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error?.code).toBe('invalid_credit_note_id')
  })

  it('GEN-10b: payload creditNoteId=123 avec avoir existant lié au bon savId → 200', async () => {
    db.creditNoteRow = { id: 123, sav_id: 1 } // Avoir 123 lié au SAV 1

    const req = mockReq({
      method: 'POST',
      headers: {},
      query: { id: '1' },
      body: makeValidPayload({ creditNoteId: 123 }),
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await generateSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(200)
  })
})

// ===========================================================================
// GEN-11 — Régénération chainée (AC #11j, AC #10, DN-4=A)
// ===========================================================================

describe('GEN-11: régénération chainée — claim2.regeneration_of = claim1.id (AC #11j, AC #10)', () => {
  it('GEN-11a: 1 claim existante → nouveau claim créé avec regeneration_of = id_existant', async () => {
    db.existingClaimsForSav = [{ id: 7, generated_at: '2026-06-04T10:00:00Z' }]
    let capturedClaim: { regeneration_of: unknown } | null = null
    const supabaseModule = await import('../../../../api/_lib/clients/supabase-admin')
    const adminClient = supabaseModule.supabaseAdmin()
    const rpcSpy = vi.spyOn(adminClient as { rpc: (fn: string, args: Record<string, unknown>) => unknown }, 'rpc').mockImplementation((fn: string, args: Record<string, unknown>) => {
      if (fn === 'increment_rate_limit') {
        return Promise.resolve({ data: [{ allowed: true, retry_after: 1 }], error: null })
      }
      if (fn === 'insert_supplier_claim_with_lines') {
        capturedClaim = args['p_claim'] as { regeneration_of: unknown }
        return Promise.resolve({ data: 42, error: null })
      }
      return Promise.resolve({ data: null, error: null })
    })

    const req = mockReq({
      method: 'POST',
      headers: {},
      query: { id: '1' },
      body: makeValidPayload(),
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await generateSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(200)
    // regeneration_of doit référencer la claim précédente
    const claim11a = capturedClaim as { regeneration_of: unknown } | null
    expect(claim11a?.regeneration_of).toBe(7)

    rpcSpy.mockRestore()
  })

  it('GEN-11b: 1ère génération (pas de claim existante) → regeneration_of = null', async () => {
    db.existingClaimsForSav = [] // Aucune claim existante
    let capturedClaim: { regeneration_of: unknown } | null = null
    const supabaseModule = await import('../../../../api/_lib/clients/supabase-admin')
    const adminClient = supabaseModule.supabaseAdmin()
    const rpcSpy = vi.spyOn(adminClient as { rpc: (fn: string, args: Record<string, unknown>) => unknown }, 'rpc').mockImplementation((fn: string, args: Record<string, unknown>) => {
      if (fn === 'increment_rate_limit') {
        return Promise.resolve({ data: [{ allowed: true, retry_after: 1 }], error: null })
      }
      if (fn === 'insert_supplier_claim_with_lines') {
        capturedClaim = args['p_claim'] as { regeneration_of: unknown }
        return Promise.resolve({ data: 42, error: null })
      }
      return Promise.resolve({ data: null, error: null })
    })

    const req = mockReq({
      method: 'POST',
      headers: {},
      query: { id: '1' },
      body: makeValidPayload(),
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await generateSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(200)
    const claim11b = capturedClaim as { regeneration_of: unknown } | null
    expect(claim11b?.regeneration_of).toBeNull()

    rpcSpy.mockRestore()
  })
})

// ===========================================================================
// GEN-12 — Atomicité RPC insert_supplier_claim_with_lines appelé (AC #11k, DN-7=B)
// Note : le test de rollback (0 row orpheline) est dans integration/ (PATTERN-H15-A)
// ===========================================================================

describe('GEN-12: RPC insert_supplier_claim_with_lines appelé (DN-7=B, AC #11k)', () => {
  it('GEN-12a: happy path → RPC insert_supplier_claim_with_lines est appelé 1 fois', async () => {
    let rpcCallCount = 0
    const supabaseModule = await import('../../../../api/_lib/clients/supabase-admin')
    const adminClient = supabaseModule.supabaseAdmin()
    const rpcSpy = vi.spyOn(adminClient as { rpc: (fn: string, args: Record<string, unknown>) => unknown }, 'rpc').mockImplementation((fn: string, _args: Record<string, unknown>) => {
      if (fn === 'increment_rate_limit') {
        return Promise.resolve({ data: [{ allowed: true, retry_after: 1 }], error: null })
      }
      if (fn === 'insert_supplier_claim_with_lines') {
        rpcCallCount++
        return Promise.resolve({ data: 42, error: null })
      }
      return Promise.resolve({ data: null, error: null })
    })

    const req = mockReq({
      method: 'POST',
      headers: {},
      query: { id: '1' },
      body: makeValidPayload(),
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await generateSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(200)
    expect(rpcCallCount).toBe(1)

    rpcSpy.mockRestore()
  })

  it('GEN-12b: RPC retourne une erreur → 500 + doc PAS retourné (NFR-REL)', async () => {
    db.rpcInsertError = { message: 'DB constraint violation', code: '23514' }

    const req = mockReq({
      method: 'POST',
      headers: {},
      query: { id: '1' },
      body: makeValidPayload(),
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await generateSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(500)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error?.code).toBe('supplier_claim_persist_failed')
    // Aucun blob retourné (NFR-REL « pas de génération partielle »)
    expect(res.chunks).toHaveLength(0)
  })
})

// ===========================================================================
// GEN-13 — Audit recordAudit appelé (AC #11l, AC #7)
// ===========================================================================

describe('GEN-13: audit — recordAudit appelé avec les bons champs (AC #11l)', () => {
  it('GEN-13a: recordAudit action=sav_supplier_claim_generated + entity_type=sav_supplier_claim', async () => {
    const req = mockReq({
      method: 'POST',
      headers: {},
      query: { id: '1' },
      body: makeValidPayload(),
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await generateSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(200)

    const audit = db.auditCaptured as {
      entityType?: string
      action?: string
      entityId?: number
      actorOperatorId?: number
    } | null
    expect(audit).not.toBeNull()
    expect(audit?.entityType).toBe('sav_supplier_claim')
    expect(audit?.action).toBe('sav_supplier_claim_generated')
    expect(typeof audit?.entityId).toBe('number')
    expect(typeof audit?.actorOperatorId).toBe('number')
  })
})

// ===========================================================================
// GEN-14 — Déterminisme blob : FECHA figée → sha256 identique (AC #11m, AC #9)
// ===========================================================================

describe('GEN-14: déterminisme blob — sha256 identique pour même payload + FECHA figée (AC #11m)', () => {
  it('GEN-14a: via audit diff.sha256 — 2 appels avec date mock identique → sha256 identiques', async () => {
    // Figer le temps via vi.useFakeTimers() pour que new Date() retourne toujours la même valeur
    // Évite le bug vi.spyOn(global, 'Date') qui casse Date.now (utilisé dans makeOperatorCookie/signJwt)
    const FIXED_DATE = new Date('2026-06-05T10:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_DATE)

    const sha256Values: string[] = []

    try {
      for (let i = 0; i < 2; i++) {
        db.auditCaptured = null
        const req = mockReq({
          method: 'POST',
          headers: {},
          query: { id: '1' },
          body: makeValidPayload(),
          user: makeOperatorUser(10),
        })
        const res = mockRes()
        await generateSupplierClaimHandler(1)(req, res)
        expect(res.statusCode).toBe(200)

        const audit = db.auditCaptured as { diff?: { sha256?: string } } | null
        if (audit?.diff?.sha256) {
          sha256Values.push(audit.diff.sha256)
        }
      }
    } finally {
      vi.useRealTimers()
    }

    // Test discriminant : même payload + même date → même sha256 (déterminisme NFR-REL)
    expect(sha256Values).toHaveLength(2)
    expect(sha256Values[0]).toBe(sha256Values[1])
  })
})

// ===========================================================================
// GEN-15 — Cap Vercel : pas de nouveau fichier api/*.ts (AC #1, AC #14)
// ===========================================================================

describe('GEN-15: cap Vercel 12/12 — pas de nouveau fichier api/*.ts (AC #1, AC #14)', () => {
  it('GEN-15a: ls client/api/*.ts | wc -l == 5 (baseline)', () => {
    const { readdirSync } = require('node:fs')
    const { join } = require('node:path')
    const apiDir = join(__dirname, '../../../../api')
    const apiFiles = readdirSync(apiDir).filter((f: string) => f.endsWith('.ts'))
    // Baseline = 5 fichiers : credit-notes.ts, health.ts, invoices.ts, pilotage.ts, sav.ts
    expect(apiFiles.length).toBe(5)
  })
})

// ===========================================================================
// GEN-16 — Méthode non-POST → 405 METHOD_NOT_ALLOWED (AC #1)
// ===========================================================================

describe('GEN-16: méthode non-POST → 405 (AC #1)', () => {
  it('GEN-16a: GET → 405 METHOD_NOT_ALLOWED', async () => {
    const req = mockReq({
      method: 'GET',
      headers: {},
      query: { id: '1' },
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await generateSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(405)
  })
})

// ===========================================================================
// GEN-17 — Body invalide → 400 (AC #2a)
// ===========================================================================

describe('GEN-17: body invalide → 400 VALIDATION_FAILED (AC #2a)', () => {
  it('GEN-17a: body null → 400', async () => {
    const req = mockReq({
      method: 'POST',
      headers: {},
      query: { id: '1' },
      body: null,
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await generateSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(400)
  })

  it('GEN-17b: claimLines manquant → 400', async () => {
    const req = mockReq({
      method: 'POST',
      headers: {},
      query: { id: '1' },
      body: { metadata: { reference: '278', albaran: '3127', fechaAlbaran: '2026-05-26' } },
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await generateSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(400)
  })

  it('GEN-17c: claimLines vide [] → 400 no_valid_lines', async () => {
    const req = mockReq({
      method: 'POST',
      headers: {},
      query: { id: '1' },
      body: makeValidPayload({ claimLines: [] }),
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await generateSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(400)
  })
})

// ===========================================================================
// GEN-18 — Rate limit bucket 'sav:generate-supplier-claim' 5/60s (AC #3)
// ===========================================================================

describe('GEN-18: rate limit bucket sav:generate-supplier-claim (AC #3)', () => {
  it('GEN-18a: rate limit dépassé → 429 RATE_LIMITED', async () => {
    db.rateLimitAllowed = false

    const req = mockReq({
      method: 'POST',
      headers: {},
      query: { id: '1' },
      body: makeValidPayload(),
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await generateSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(429)
  })
})

// ===========================================================================
// GEN-19 — Régénération → filename inclut _v2 (AC #10, DN-8=A)
// ===========================================================================

describe('GEN-19: régénération → filename _v2 dans Content-Disposition (AC #10)', () => {
  it('GEN-19a: 1 claim existante → Content-Disposition filename inclut _v2', async () => {
    db.existingClaimsForSav = [{ id: 7, generated_at: '2026-06-04T10:00:00Z' }]

    const req = mockReq({
      method: 'POST',
      headers: {},
      query: { id: '1' },
      body: makeValidPayload(),
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await generateSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(200)
    const disposition = String(res.headers['content-disposition'] ?? '')
    expect(disposition).toContain('_v2')
  })
})

// ===========================================================================
// GEN-20 — Albaran/date vides (fichier 505) → null dans p_claim, PAS '' (hotfix)
// Bug réel UAT 2026-06-09 : fichier sans albaran/date (N3/N4 vides) → metadata.{albaran,
// fechaAlbaran}='' → RPC caste fecha_albaran::date → `invalid input syntax for type
// date: ""` → 500 supplier_claim_persist_failed. Discriminant : sous l'ancien code
// p_claim.fecha_albaran==='' (le test échoue) ; après fix === null.
// ===========================================================================

describe('GEN-20: albaran/date absents → p_claim normalisé en null (hotfix 2026-06-09)', () => {
  it('GEN-20a: metadata.fechaAlbaran="" et albaran="" → RPC reçoit fecha_albaran=null et albaran=null', async () => {
    let capturedClaim: { albaran: unknown; fecha_albaran: unknown } | null = null
    const supabaseModule = await import('../../../../api/_lib/clients/supabase-admin')
    const adminClient = supabaseModule.supabaseAdmin()
    const rpcSpy = vi.spyOn(adminClient as { rpc: (fn: string, args: Record<string, unknown>) => unknown }, 'rpc').mockImplementation((fn: string, args: Record<string, unknown>) => {
      if (fn === 'increment_rate_limit') {
        return Promise.resolve({ data: [{ allowed: true, retry_after: 1 }], error: null })
      }
      if (fn === 'insert_supplier_claim_with_lines') {
        capturedClaim = args['p_claim'] as { albaran: unknown; fecha_albaran: unknown }
        return Promise.resolve({ data: 42, error: null })
      }
      return Promise.resolve({ data: null, error: null })
    })

    const req = mockReq({
      method: 'POST',
      headers: {},
      query: { id: '1' },
      body: makeValidPayload({ metadata: { reference: '505_25S25_30', albaran: '', fechaAlbaran: '' } }),
      user: makeOperatorUser(10),
    })
    const res = mockRes()

    await generateSupplierClaimHandler(1)(req, res)

    expect(res.statusCode).toBe(200)
    const claim = capturedClaim as { albaran: unknown; fecha_albaran: unknown } | null
    // Discriminant : '' aurait fait crasher le ::date côté RPC réel. On exige null.
    expect(claim?.fecha_albaran).toBeNull()
    expect(claim?.albaran).toBeNull()

    rpcSpy.mockRestore()
  })
})
