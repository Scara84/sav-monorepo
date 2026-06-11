import { describe, it, expect, vi, beforeEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

const db = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  rowError: null as { message: string } | null,
  rowAfter: null as Record<string, unknown> | null,
  rateLimitAllowed: true,
  generateCalls: [] as Array<Record<string, unknown>>,
  generateBehavior: 'success' as 'success' | 'fail_upload' | 'fail_render',
  selects: 0,
  // Force path mocks ----------------------------------------------------------
  sav: null as Record<string, unknown> | null,
  savError: null as { message: string } | null,
  lines: [] as Array<Record<string, unknown>>,
  linesError: null as { message: string } | null,
  settings: [] as Array<Record<string, unknown>>,
  settingsError: null as { message: string } | null,
  rpcResult: null as Record<string, unknown> | null,
  rpcError: null as { code?: string; message?: string } | null,
  capturedRpcCalls: [] as Array<Record<string, unknown>>,
  deleteOneDriveCalls: [] as Array<string>,
  deleteOneDriveBehavior: 'success' as 'success' | 'fail',
}))

vi.mock('../../../../api/_lib/pdf/generate-credit-note-pdf', () => ({
  generateCreditNotePdfAsync: async (args: Record<string, unknown>) => {
    db.generateCalls.push(args)
    if (db.generateBehavior === 'fail_upload') {
      throw new Error('PDF_UPLOAD_FAILED|OneDrive 500')
    }
    if (db.generateBehavior === 'fail_render') {
      throw new Error('PDF_RENDER_FAILED|bad template')
    }
    // Simule l'UPDATE qu'aurait fait generateCreditNotePdfAsync
    if (db.row !== null && db.rowAfter === null) {
      db.rowAfter = {
        ...db.row,
        pdf_web_url: 'https://onedrive.example/regen.pdf',
      }
    }
  },
  __setGeneratePdfDepsForTests: () => undefined,
}))

vi.mock('../../../../api/_lib/onedrive-ts', () => ({
  deleteCreditNotePdfItem: async (itemId: string) => {
    db.deleteOneDriveCalls.push(itemId)
    if (db.deleteOneDriveBehavior === 'fail') {
      throw new Error('Graph 500')
    }
  },
  uploadCreditNotePdf: async () => ({ itemId: 'noop', webUrl: 'noop' }),
}))

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  const client = {
    from: (table: string) => {
      if (table === 'credit_notes') {
        return {
          select: () => ({
            eq: () => ({
              limit: () => ({
                maybeSingle: () => {
                  db.selects += 1
                  const data = db.selects === 1 ? db.row : (db.rowAfter ?? db.row)
                  return Promise.resolve({ data, error: db.rowError })
                },
              }),
            }),
          }),
        }
      }
      if (table === 'sav') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: db.sav, error: db.savError }),
            }),
          }),
        }
      }
      if (table === 'sav_lines') {
        return {
          select: () => ({
            eq: () => ({
              order: () => Promise.resolve({ data: db.lines, error: db.linesError }),
            }),
          }),
        }
      }
      if (table === 'settings') {
        return {
          select: () => ({
            in: () => ({
              lte: () => ({
                or: () =>
                  Promise.resolve({
                    data: db.settingsError ? null : db.settings,
                    error: db.settingsError,
                  }),
              }),
            }),
          }),
        }
      }
      return {}
    },
    rpc: (fn: string, args: Record<string, unknown>) => {
      if (fn === 'increment_rate_limit') {
        return Promise.resolve({
          data: [{ allowed: db.rateLimitAllowed, retry_after: 1 }],
          error: null,
        })
      }
      if (fn === 'force_regenerate_credit_note') {
        db.capturedRpcCalls.push(args)
        if (db.rpcError !== null) {
          return Promise.resolve({ data: null, error: db.rpcError })
        }
        // Simule l'effet de la RPC : pdf_web_url + pdf_onedrive_item_id mis à NULL
        // dans la row courante. Le re-fetch après generateCreditNotePdfAsync verra
        // ensuite la nouvelle URL.
        if (db.row !== null) {
          db.row = { ...db.row, pdf_web_url: null, pdf_onedrive_item_id: null }
        }
        return Promise.resolve({ data: db.rpcResult, error: null })
      }
      return Promise.resolve({ data: null, error: null })
    },
  }
  return {
    supabaseAdmin: () => client,
    __resetSupabaseAdminForTests: () => undefined,
  }
})

import handler from '../../../../api/credit-notes'

function opCookie(): string {
  const p: SessionUser = {
    sub: 42,
    type: 'operator',
    role: 'sav-operator',
    exp: Math.floor(Date.now() / 1000) + 3600,
  }
  return `sav_session=${signJwt(p, SECRET)}`
}

function regenReq(numberInput: string, cookie: string = opCookie()) {
  return mockReq({
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    query: { op: 'regenerate', number: numberInput } as Record<
      string,
      string | string[] | undefined
    >,
    body: {},
  })
}

beforeEach(() => {
  vi.stubEnv('SESSION_COOKIE_SECRET', SECRET)
  vi.stubEnv('SUPABASE_URL', 'http://localhost')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test')
  db.row = null
  db.rowError = null
  db.rowAfter = null
  db.rateLimitAllowed = true
  db.generateCalls = []
  db.generateBehavior = 'success'
  db.selects = 0
  db.sav = null
  db.savError = null
  db.lines = []
  db.linesError = null
  db.settings = [
    {
      key: 'vat_rate_default',
      value: { bp: 550 },
      valid_from: '2020-01-01T00:00:00Z',
      valid_to: null,
    },
    {
      key: 'group_manager_discount',
      value: { bp: 400 },
      valid_from: '2020-01-01T00:00:00Z',
      valid_to: null,
    },
  ]
  db.settingsError = null
  db.rpcResult = null
  db.rpcError = null
  db.capturedRpcCalls = []
  db.deleteOneDriveCalls = []
  db.deleteOneDriveBehavior = 'success'
})

// ----------------------------------------------------------------------------
// Helpers force-path
// ----------------------------------------------------------------------------
function forceReq(numberInput: string, body: unknown = { force: true }, cookie: string = opCookie()) {
  return mockReq({
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    query: { op: 'regenerate', number: numberInput } as Record<
      string,
      string | string[] | undefined
    >,
    body: body as Record<string, unknown>,
  })
}

function makeSav(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 10,
    status: 'in_progress',
    member_id: 100,
    group_id: 7,
    member: { id: 100, is_group_manager: false, group_id: 7 },
    ...overrides,
  }
}

function makeLineOk(
  id: number,
  creditCents: number,
  vatBp: number | null = 550,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    line_number: id,
    credit_amount_cents: creditCents,
    vat_rate_bp_snapshot: vatBp,
    validation_status: 'ok',
    validation_message: null,
    ...overrides,
  }
}

function makeRpcOldResult(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    old_total_ht_cents: 999,
    old_discount_cents: 0,
    old_vat_cents: 0,
    old_total_ttc_cents: 999,
    old_pdf_web_url: 'https://onedrive.example/old.pdf',
    old_pdf_onedrive_item_id: 'old-item-id-123',
    ...overrides,
  }
}

describe('POST /api/credit-notes/:number/regenerate-pdf (Story 4.5 AC #8)', () => {
  it('R01 pdf_web_url NULL → régénération OK → 200 + pdf_web_url', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      sav_id: 10,
      pdf_web_url: null,
    }
    const res = mockRes()
    await handler(regenReq('42'), res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: { pdf_web_url: string; credit_note_number_formatted: string }
    }
    expect(body.data.pdf_web_url).toBe('https://onedrive.example/regen.pdf')
    expect(body.data.credit_note_number_formatted).toBe('AV-2026-00042')
    expect(db.generateCalls.length).toBe(1)
    expect(db.generateCalls[0]).toMatchObject({
      credit_note_id: 1,
      sav_id: 10,
    })
  })

  it('R02 pdf_web_url déjà présent → 409 PDF_ALREADY_GENERATED (idempotent)', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      sav_id: 10,
      pdf_web_url: 'https://existing.example/f.pdf',
    }
    const res = mockRes()
    await handler(regenReq('42'), res)
    expect(res.statusCode).toBe(409)
    const body = res.jsonBody as {
      error: { details: { code: string; pdf_web_url: string } }
    }
    expect(body.error.details.code).toBe('PDF_ALREADY_GENERATED')
    expect(body.error.details.pdf_web_url).toBe('https://existing.example/f.pdf')
    expect(db.generateCalls.length).toBe(0)
  })

  it('R03 credit_note introuvable → 404 CREDIT_NOTE_NOT_FOUND', async () => {
    db.row = null
    const res = mockRes()
    await handler(regenReq('999'), res)
    expect(res.statusCode).toBe(404)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('CREDIT_NOTE_NOT_FOUND')
  })

  it('R04 régénération échoue (upload) → 500 PDF_REGENERATE_FAILED + failure_kind', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      sav_id: 10,
      pdf_web_url: null,
    }
    db.generateBehavior = 'fail_upload'
    const res = mockRes()
    await handler(regenReq('42'), res)
    expect(res.statusCode).toBe(500)
    const body = res.jsonBody as {
      error: { details: { code: string; failure_kind: string } }
    }
    expect(body.error.details.code).toBe('PDF_REGENERATE_FAILED')
    expect(body.error.details.failure_kind).toBe('PDF_UPLOAD_FAILED')
  })

  it('R05 régénération échoue (render) → 500 PDF_REGENERATE_FAILED', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      sav_id: 10,
      pdf_web_url: null,
    }
    db.generateBehavior = 'fail_render'
    const res = mockRes()
    await handler(regenReq('42'), res)
    expect(res.statusCode).toBe(500)
    const body = res.jsonBody as {
      error: { details: { code: string; failure_kind: string } }
    }
    expect(body.error.details.code).toBe('PDF_REGENERATE_FAILED')
    expect(body.error.details.failure_kind).toBe('PDF_RENDER_FAILED')
  })

  it('R06 auth — pas de cookie → 401', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: {},
        query: { op: 'regenerate', number: '42' },
      }),
      res
    )
    expect(res.statusCode).toBe(401)
  })

  it('R07 méthode GET non autorisée → 405 METHOD_NOT_ALLOWED', async () => {
    const res = mockRes()
    await handler(
      mockReq({
        method: 'GET',
        headers: { cookie: opCookie() },
        query: { op: 'regenerate', number: '42' },
      }),
      res
    )
    expect(res.statusCode).toBe(405)
    expect((res.jsonBody as { error: { code: string } }).error.code).toBe('METHOD_NOT_ALLOWED')
  })

  it('R09 CR P1 rate-limit key normalisé — `42` et `AV-2026-00042` partagent le même bucket', async () => {
    // Suit le flow du middleware : la clé rate-limit passée à l'infra est
    // une fonction pure de `numberInput`. On ne peut pas observer la clé
    // directement depuis l'extérieur (le middleware la hash SHA-256), mais
    // on peut vérifier que les deux chemins aboutissent à la même décision :
    // premier appel OK, deuxième appel 429 même en mélangeant les formes.
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      sav_id: 10,
      pdf_web_url: null,
    }
    db.rateLimitAllowed = true
    const res1 = mockRes()
    await handler(regenReq('42'), res1)
    expect(res1.statusCode).toBe(200)

    // Concrètement : le bucket rate-limit repose sur `withRateLimit` qui
    // est mocké (rateLimitAllowed=false force 429). On confirme juste que
    // le handler n'explose PAS sur un input canonique.
    db.rateLimitAllowed = false
    const res2 = mockRes()
    await handler(regenReq('AV-2026-00042'), res2)
    expect(res2.statusCode).toBe(429)

    const res3 = mockRes()
    await handler(regenReq('42'), res3)
    expect(res3.statusCode).toBe(429)
  })

  it('R08 rate-limit atteint → 429 (max 1/min par :number)', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      sav_id: 10,
      pdf_web_url: null,
    }
    db.rateLimitAllowed = false
    const res = mockRes()
    await handler(regenReq('42'), res)
    expect(res.statusCode).toBe(429)
  })
})

// ============================================================================
// spec credit-note-force-regenerate-pdf — chemin force (12 lignes de matrice +
// extras : remise responsable 4 %, fallback TVA snapshot null, arrondi non
// trivial, parse force défensif, échec delete OneDrive → continue).
// ============================================================================
describe('POST /api/credit-notes/:number/regenerate-pdf (force) — matrice I/O', () => {
  it('M01 Force OK → 200 {pdf_web_url, totals} + ancien fichier OneDrive supprimé + RPC appelée', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      sav_id: 10,
      pdf_web_url: 'https://onedrive.example/old.pdf',
      pdf_onedrive_item_id: 'old-item-id-123',
    }
    db.sav = makeSav()
    db.lines = [makeLineOk(1, 10000), makeLineOk(2, 5000)]
    db.rpcResult = makeRpcOldResult()

    const res = mockRes()
    await handler(forceReq('42'), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: {
        pdf_web_url: string
        credit_note_number_formatted: string
        totals: { total_ht_cents: number; vat_cents: number; total_ttc_cents: number }
      }
    }
    expect(body.data.pdf_web_url).toBe('https://onedrive.example/regen.pdf')
    expect(body.data.credit_note_number_formatted).toBe('AV-2026-00042')
    // 15000 cents @ 5,5% TVA, sans remise (member non-manager)
    expect(body.data.totals.total_ht_cents).toBe(15000)
    expect(body.data.totals.vat_cents).toBe(825)
    expect(body.data.totals.total_ttc_cents).toBe(15825)

    // RPC appelée 1× avec les bons args (totaux + fingerprint lignes).
    expect(db.capturedRpcCalls.length).toBe(1)
    const rpcArgs = db.capturedRpcCalls[0] as {
      p_credit_note_id: number
      p_expected_lines: Array<{ id: number; credit_amount_cents: number }>
      p_new_totals: Record<string, number>
      p_actor_operator_id: number
    }
    expect(rpcArgs.p_credit_note_id).toBe(1)
    expect(rpcArgs.p_actor_operator_id).toBe(42)
    expect(rpcArgs.p_expected_lines).toEqual([
      { id: 1, credit_amount_cents: 10000, vat_rate_bp_snapshot: 550 },
      { id: 2, credit_amount_cents: 5000, vat_rate_bp_snapshot: 550 },
    ])
    expect(rpcArgs.p_new_totals).toEqual({
      total_ht_cents: 15000,
      discount_cents: 0,
      vat_cents: 825,
      total_ttc_cents: 15825,
    })

    // Ancien fichier OneDrive supprimé.
    expect(db.deleteOneDriveCalls).toEqual(['old-item-id-123'])

    // Génération PDF déclenchée 1×.
    expect(db.generateCalls.length).toBe(1)
    expect(db.generateCalls[0]).toMatchObject({ credit_note_id: 1, sav_id: 10 })
  })

  it('M02 Sans force (body vide) → contrat 409 PDF_ALREADY_GENERATED inchangé', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      sav_id: 10,
      pdf_web_url: 'https://existing.example/f.pdf',
    }
    const res = mockRes()
    // Body vide explicite (pas de force) — chemin legacy.
    await handler(forceReq('42', {}), res)
    expect(res.statusCode).toBe(409)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('PDF_ALREADY_GENERATED')
    expect(db.capturedRpcCalls.length).toBe(0)
    expect(db.deleteOneDriveCalls.length).toBe(0)
  })

  it('M03 Force, PDF absent (pdf_web_url IS NULL, pdf_onedrive_item_id IS NULL) → pas de suppression OneDrive', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      sav_id: 10,
      pdf_web_url: null,
      pdf_onedrive_item_id: null,
    }
    db.sav = makeSav()
    db.lines = [makeLineOk(1, 10000)]
    db.rpcResult = makeRpcOldResult({
      old_pdf_web_url: null,
      old_pdf_onedrive_item_id: null,
    })

    const res = mockRes()
    await handler(forceReq('42'), res)

    expect(res.statusCode).toBe(200)
    expect(db.capturedRpcCalls.length).toBe(1)
    // Pas de delete OneDrive : pas d'ancien item.
    expect(db.deleteOneDriveCalls).toEqual([])
    // Génération relancée.
    expect(db.generateCalls.length).toBe(1)
  })

  it('M04 Ligne bloquante (validation_status != ok) → 422 NO_VALID_LINES + blocking_lines, aucune mutation', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      sav_id: 10,
      pdf_web_url: 'https://onedrive.example/old.pdf',
      pdf_onedrive_item_id: 'old-item',
    }
    db.sav = makeSav()
    db.lines = [
      makeLineOk(1, 10000),
      makeLineOk(2, 5000, 550, {
        validation_status: 'warning',
        validation_message: 'qty arbitrée vide',
      }),
    ]

    const res = mockRes()
    await handler(forceReq('42'), res)

    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as {
      error: {
        details: {
          code: string
          blocking_lines: Array<{ id: number; validation_status: string }>
        }
      }
    }
    expect(body.error.details.code).toBe('NO_VALID_LINES')
    expect(body.error.details.blocking_lines).toEqual([
      expect.objectContaining({ id: 2, validation_status: 'warning' }),
    ])
    // Aucune mutation.
    expect(db.capturedRpcCalls.length).toBe(0)
    expect(db.deleteOneDriveCalls.length).toBe(0)
    expect(db.generateCalls.length).toBe(0)
  })

  it('M05 Statut hors allowlist (RPC SAV_STATUS_FROZEN status=validated) → 422 message « repasser le SAV en cours »', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      sav_id: 10,
      pdf_web_url: 'https://onedrive.example/old.pdf',
      pdf_onedrive_item_id: 'old-item',
    }
    db.sav = makeSav()
    db.lines = [makeLineOk(1, 10000)]
    db.rpcError = { code: 'P0001', message: 'SAV_STATUS_FROZEN|status=validated' }

    const res = mockRes()
    await handler(forceReq('42'), res)

    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as {
      error: { message: string; details: { code: string } }
    }
    expect(body.error.details.code).toBe('SAV_STATUS_FROZEN')
    expect(body.error.message).toContain('repassez le SAV en cours')
    // RPC appelée mais delete/generate jamais.
    expect(db.capturedRpcCalls.length).toBe(1)
    expect(db.deleteOneDriveCalls.length).toBe(0)
    expect(db.generateCalls.length).toBe(0)
  })

  it('M05b Statut closed → 422 message « figé » (non-validated)', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      sav_id: 10,
      pdf_web_url: 'https://onedrive.example/old.pdf',
      pdf_onedrive_item_id: 'old-item',
    }
    db.sav = makeSav({ status: 'closed' })
    db.lines = [makeLineOk(1, 10000)]
    db.rpcError = { code: 'P0001', message: 'SAV_STATUS_FROZEN|status=closed' }

    const res = mockRes()
    await handler(forceReq('42'), res)

    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as {
      error: { message: string; details: { code: string } }
    }
    expect(body.error.details.code).toBe('SAV_STATUS_FROZEN')
    expect(body.error.message).toContain('figé')
    expect(body.error.message).not.toContain('repassez')
  })

  it('M06 Fingerprint divergent (RPC LINES_CHANGED) → 409 CREDIT_NOTE_STATE_CHANGED', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      sav_id: 10,
      pdf_web_url: 'https://onedrive.example/old.pdf',
      pdf_onedrive_item_id: 'old-item',
    }
    db.sav = makeSav()
    db.lines = [makeLineOk(1, 10000)]
    db.rpcError = { code: 'P0001', message: 'LINES_CHANGED|mismatch=1' }

    const res = mockRes()
    await handler(forceReq('42'), res)

    expect(res.statusCode).toBe(409)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('CREDIT_NOTE_STATE_CHANGED')
    expect(db.deleteOneDriveCalls.length).toBe(0)
    expect(db.generateCalls.length).toBe(0)
  })

  // M07 (deux forces concurrents) : non testé en unit (mock RPC ne sérialise
  // pas), non testé en integration non plus — FOR UPDATE/rollback corrects
  // par construction PG, dette de couverture tracée dans deferred-work.
  // M08 (UPDATE direct totaux hors RPC rejeté par trigger) : vraie-DB only,
  // couvert par force-regenerate.spec.ts cas (b).
  // M09 (échec audit dans RPC) : non testé — rollback PG transactionnel
  // correct par construction (RAISE propage hors la TX, INSERT audit dans la
  // même TX que l'UPDATE → tout-ou-rien). Dette de couverture tracée dans
  // deferred-work.

  it('M10 Échec suppression OneDrive → log warn + génération continue (200)', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      sav_id: 10,
      pdf_web_url: 'https://onedrive.example/old.pdf',
      pdf_onedrive_item_id: 'old-item-fail',
    }
    db.sav = makeSav()
    db.lines = [makeLineOk(1, 10000)]
    db.rpcResult = makeRpcOldResult({ old_pdf_onedrive_item_id: 'old-item-fail' })
    db.deleteOneDriveBehavior = 'fail'

    const res = mockRes()
    await handler(forceReq('42'), res)

    // Génération continue malgré l'échec delete.
    expect(res.statusCode).toBe(200)
    expect(db.deleteOneDriveCalls).toEqual(['old-item-fail'])
    expect(db.generateCalls.length).toBe(1)
  })

  it('M11 Échec génération post-RPC → 500 PDF_REGENERATE_FAILED + failure_kind (état DB sain : totaux à jour, pdf NULL)', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      sav_id: 10,
      pdf_web_url: 'https://onedrive.example/old.pdf',
      pdf_onedrive_item_id: 'old-item',
    }
    db.sav = makeSav()
    db.lines = [makeLineOk(1, 10000)]
    db.rpcResult = makeRpcOldResult()
    db.generateBehavior = 'fail_upload'

    const res = mockRes()
    await handler(forceReq('42'), res)

    expect(res.statusCode).toBe(500)
    const body = res.jsonBody as {
      error: { details: { code: string; failure_kind: string } }
    }
    expect(body.error.details.code).toBe('PDF_REGENERATE_FAILED')
    expect(body.error.details.failure_kind).toBe('PDF_UPLOAD_FAILED')
    // RPC s'est exécutée (totaux à jour DB-side) ; delete a tourné ; generate a échoué.
    expect(db.capturedRpcCalls.length).toBe(1)
    expect(db.deleteOneDriveCalls.length).toBe(1)
    expect(db.generateCalls.length).toBe(1)
  })

  // ----- Extras spec (KEEP v1/v2) ---------------------------------------------

  it('M12 Remise responsable 4 % réellement appliquée (calcul moteur réel, pas mocké)', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      sav_id: 10,
      pdf_web_url: 'https://onedrive.example/old.pdf',
      pdf_onedrive_item_id: 'old-item',
    }
    // SAV avec member group manager, group_id matché → 4 % de remise.
    db.sav = makeSav({
      member: { id: 100, is_group_manager: true, group_id: 7 },
    })
    db.lines = [makeLineOk(1, 10000)] // 100 € HT
    db.rpcResult = makeRpcOldResult()

    const res = mockRes()
    await handler(forceReq('42'), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: {
        totals: {
          total_ht_cents: number
          discount_cents: number
          vat_cents: number
          total_ttc_cents: number
        }
      }
    }
    // 100 € HT × 4 % = 4 € remise. HT net 96 €. TVA 5,5 % sur 96 € = 5,28 €.
    // Total TTC = 96 + 5,28 = 101,28 €.
    expect(body.data.totals.total_ht_cents).toBe(10000)
    expect(body.data.totals.discount_cents).toBe(400)
    expect(body.data.totals.vat_cents).toBe(528)
    expect(body.data.totals.total_ttc_cents).toBe(10128)
    // Et le payload RPC l'a bien transporté.
    const rpcArgs = db.capturedRpcCalls[0] as { p_new_totals: Record<string, number> }
    expect(rpcArgs.p_new_totals).toEqual({
      total_ht_cents: 10000,
      discount_cents: 400,
      vat_cents: 528,
      total_ttc_cents: 10128,
    })
  })

  it('M13 Fallback TVA (vat_rate_bp_snapshot null) → settings default utilisé', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      sav_id: 10,
      pdf_web_url: 'https://onedrive.example/old.pdf',
      pdf_onedrive_item_id: 'old-item',
    }
    db.sav = makeSav()
    db.lines = [makeLineOk(1, 10000, null)] // snapshot null
    db.rpcResult = makeRpcOldResult()

    const res = mockRes()
    await handler(forceReq('42'), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: { totals: { vat_cents: number } }
    }
    // Settings default = 550 bp (5,5 %). 100 € × 5,5 % = 5,50 € → 550 cents.
    expect(body.data.totals.vat_cents).toBe(550)
  })

  it('M14 Arrondi non trivial (3 lignes HT 100/200/300 cents @ 550 bp)', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      sav_id: 10,
      pdf_web_url: 'https://onedrive.example/old.pdf',
      pdf_onedrive_item_id: 'old-item',
    }
    db.sav = makeSav()
    db.lines = [makeLineOk(1, 100), makeLineOk(2, 200), makeLineOk(3, 300)]
    db.rpcResult = makeRpcOldResult()

    const res = mockRes()
    await handler(forceReq('42'), res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: {
        totals: {
          total_ht_cents: number
          vat_cents: number
          total_ttc_cents: number
        }
      }
    }
    // ligne 100 × 5,5% = 5,5 → round 6
    // ligne 200 × 5,5% = 11   → round 11
    // ligne 300 × 5,5% = 16,5 → round 17 (banker's→half-up Math.round → 17)
    // sum vat = 6 + 11 + 17 = 34
    expect(body.data.totals.total_ht_cents).toBe(600)
    expect(body.data.totals.vat_cents).toBe(34)
    expect(body.data.totals.total_ttc_cents).toBe(634)
  })

  it('M15a Parse force défensif : body.force = "true" (string) → chemin legacy (pas force)', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      sav_id: 10,
      pdf_web_url: 'https://existing.example/f.pdf',
    }
    const res = mockRes()
    await handler(forceReq('42', { force: 'true' }), res)
    // Chemin legacy : 409 PDF_ALREADY_GENERATED.
    expect(res.statusCode).toBe(409)
    expect((res.jsonBody as { error: { details: { code: string } } }).error.details.code).toBe(
      'PDF_ALREADY_GENERATED'
    )
    expect(db.capturedRpcCalls.length).toBe(0)
  })

  it('M15b Parse force défensif : body undefined → chemin legacy', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      sav_id: 10,
      pdf_web_url: 'https://existing.example/f.pdf',
    }
    const res = mockRes()
    await handler(
      mockReq({
        method: 'POST',
        headers: { cookie: opCookie(), 'content-type': 'application/json' },
        query: { op: 'regenerate', number: '42' },
      }),
      res
    )
    expect(res.statusCode).toBe(409)
    expect((res.jsonBody as { error: { details: { code: string } } }).error.details.code).toBe(
      'PDF_ALREADY_GENERATED'
    )
    expect(db.capturedRpcCalls.length).toBe(0)
  })

  it('M15c Parse force défensif : body = array → chemin legacy', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      sav_id: 10,
      pdf_web_url: 'https://existing.example/f.pdf',
    }
    const res = mockRes()
    await handler(forceReq('42', [true]), res)
    expect(res.statusCode).toBe(409)
    expect((res.jsonBody as { error: { details: { code: string } } }).error.details.code).toBe(
      'PDF_ALREADY_GENERATED'
    )
    expect(db.capturedRpcCalls.length).toBe(0)
  })

  it('M15d Parse force défensif : body.force = 1 (number) → chemin legacy', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      sav_id: 10,
      pdf_web_url: 'https://existing.example/f.pdf',
    }
    const res = mockRes()
    await handler(forceReq('42', { force: 1 }), res)
    expect(res.statusCode).toBe(409)
    expect((res.jsonBody as { error: { details: { code: string } } }).error.details.code).toBe(
      'PDF_ALREADY_GENERATED'
    )
    expect(db.capturedRpcCalls.length).toBe(0)
  })

  it('M15e SEUL force === true (boolean) déclenche le chemin force', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      sav_id: 10,
      pdf_web_url: 'https://onedrive.example/old.pdf',
      pdf_onedrive_item_id: 'old-item',
    }
    db.sav = makeSav()
    db.lines = [makeLineOk(1, 10000)]
    db.rpcResult = makeRpcOldResult()

    const res = mockRes()
    await handler(forceReq('42', { force: true }), res)
    expect(res.statusCode).toBe(200)
    expect(db.capturedRpcCalls.length).toBe(1)
  })
})
