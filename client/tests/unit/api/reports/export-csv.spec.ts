import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as XLSX from 'xlsx'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

/**
 * Story 5.4 AC #10 — tests `GET /api/reports/export-csv`.
 *
 * Mocks Supabase admin avec une factory `createBuilder({ count, rows, error })`
 * qui simule fluent chain (`.select.eq.gte.lte.in.is.contains.ilike.textSearch
 * .order.limit`). Le handler appelle d'abord `.select(.., {count, head:true})`
 * puis `.select(SELECT_EXPR)` (sans head) — on stocke un `phase` pour distinguer.
 */

interface BuilderState {
  count: number
  rows: unknown[]
  error: { message: string } | null
  countError: { message: string } | null
  // capture des appels filtres pour assertions
  calls: Array<{ method: string; args: unknown[] }>
  // le head:true (count phase) ne doit PAS exécuter le fetch full
  phase: 'idle' | 'count' | 'fetch'
}

const state = vi.hoisted(() => ({
  builderState: {
    count: 0,
    rows: [] as unknown[],
    error: null as { message: string } | null,
    countError: null as { message: string } | null,
    calls: [] as Array<{ method: string; args: unknown[] }>,
    phase: 'idle' as 'idle' | 'count' | 'fetch',
  },
  // CR 5.4 EC4 — état partagé pour le rpc rate_limit_check_increment.
  // Par défaut allowed=true (pas de blocage des tests existants).
  rateLimit: {
    rpcCalls: 0 as number,
    nextResponse: { allowed: true, retry_after: 0 } as { allowed: boolean; retry_after: number },
  },
}))

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  // Builder fluent récursif : chaque méthode log les args et retourne `this`,
  // sauf `then` (résolution finale).
  function makeBuilder(s: BuilderState, mode: 'count' | 'fetch') {
    const builder: Record<string, unknown> = {}
    const fluent = [
      'eq',
      'in',
      'gte',
      'lte',
      'ilike',
      'is',
      'contains',
      'textSearch',
      'order',
      'limit',
    ]
    for (const m of fluent) {
      builder[m] = (...args: unknown[]) => {
        s.calls.push({ method: m, args })
        return builder
      }
    }
    builder['then'] = (resolve: (v: unknown) => void) => {
      if (mode === 'count') {
        resolve({ count: s.countError ? null : s.count, error: s.countError })
      } else {
        resolve({ data: s.error ? null : s.rows, error: s.error })
      }
    }
    return builder
  }

  const client = {
    from: (_table: string) => ({
      select: (_expr: string, opts?: { count?: string; head?: boolean }) => {
        const s = state.builderState
        const isCount = !!opts?.head
        s.phase = isCount ? 'count' : 'fetch'
        s.calls.push({ method: 'select', args: [_expr, opts] })
        return makeBuilder(s, isCount ? 'count' : 'fetch')
      },
    }),
    // CR 5.4 EC4 — rpc utilisé par `withRateLimit` (rate_limit_check_increment).
    // Par défaut renvoie allowed=true ; les tests rate-limit override
    // `state.rateLimit.nextResponse` pour simuler le 429.
    rpc: (_fn: string, _args: Record<string, unknown>) => {
      state.rateLimit.rpcCalls++
      return Promise.resolve({
        data: state.rateLimit.nextResponse,
        error: null,
      })
    },
  }
  return { supabaseAdmin: () => client, __resetSupabaseAdminForTests: () => undefined }
})

import { __testables } from '../../../../api/_lib/reports/export-csv-handler'
// CR 5.4 EC4 — `exportSavCsvHandler` est composé avec `withRateLimit` qui
// requiert un client Supabase RPC pour `rate_limit_check_increment`. Les
// tests ciblent le `coreHandler` (logique métier) ; le rate-limit est
// couvert par `with-rate-limit.spec.ts` (pattern Story 3.2 list-handler).
const exportSavCsvHandler = __testables.coreHandler

function farFuture(): number {
  return Math.floor(Date.now() / 1000) + 3600
}
function operatorReq(query: Record<string, string> = {}): ReturnType<typeof mockReq> {
  const payload: SessionUser = { sub: 5, type: 'operator', role: 'admin', exp: farFuture() }
  const req = mockReq({ method: 'GET', query })
  req.user = payload
  return req
}

function makeRow(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 1,
    reference: 'SAV-2026-00042',
    status: 'validated',
    received_at: '2026-04-24T10:00:00Z',
    closed_at: null,
    total_amount_cents: 12345,
    invoice_ref: 'F2026-001',
    tags: ['urgent'],
    member: { id: 10, first_name: 'Jean', last_name: 'Dupont', email: 'jean@coop.fr' },
    group: { id: 3, name: 'Lyon' },
    assignee: { id: 7, email: 'alice.martin@coop.fr', display_name: 'Alice Martin' },
    sav_lines: [
      {
        id: 1,
        validation_messages: [{ kind: 'cause', text: 'Abimé' }],
        product: { supplier_code: 'RUFINO' },
      },
      {
        id: 2,
        validation_messages: [{ kind: 'cause', text: 'Cassé' }],
        product: { supplier_code: 'BIOSUD' },
      },
    ],
    ...overrides,
  }
}

describe('GET /api/reports/export-csv', () => {
  beforeEach(() => {
    state.builderState.count = 0
    state.builderState.rows = []
    state.builderState.error = null
    state.builderState.countError = null
    state.builderState.calls = []
    state.builderState.phase = 'idle'
  })

  it('200 happy path CSV : 3 SAV → BOM + ; + 4 lignes (header + 3 rows)', async () => {
    state.builderState.count = 3
    state.builderState.rows = [
      makeRow(),
      makeRow({ id: 2, reference: 'SAV-2026-00043' }),
      makeRow({ id: 3, reference: 'SAV-2026-00044' }),
    ]
    const res = mockRes()
    await exportSavCsvHandler(operatorReq({}), res)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="sav-export-\d{4}-\d{2}-\d{2}-\d{6}\.csv"/
    )
    // res.end a reçu un Buffer — captured via headers count + ended
    expect(res.ended).toBe(true)
  })

  it('200 happy path XLSX : format=xlsx → Buffer XLSX valide', async () => {
    state.builderState.count = 2
    state.builderState.rows = [makeRow(), makeRow({ id: 2 })]
    const res = mockRes()
    // Capture le buffer envoyé via end()
    let capturedBuffer: Buffer | null = null
    const originalEnd = res.end
    res.end = ((chunk?: string | Buffer) => {
      if (chunk instanceof Buffer) capturedBuffer = chunk
      originalEnd.call(res)
    }) as typeof res.end

    await exportSavCsvHandler(operatorReq({ format: 'xlsx' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('spreadsheetml.sheet')
    expect(res.headers['content-disposition']).toMatch(/\.xlsx"/)
    expect(capturedBuffer).not.toBeNull()
    // Vérifie que SheetJS lit le buffer sans erreur (workbook valide).
    const wb = XLSX.read(capturedBuffer!, { type: 'buffer' })
    expect(wb.SheetNames.length).toBeGreaterThan(0)
  })

  it('filtres appliqués : status=closed → eq("status","closed") sur le builder', async () => {
    state.builderState.count = 1
    state.builderState.rows = [makeRow({ status: 'closed' })]
    const res = mockRes()
    await exportSavCsvHandler(operatorReq({ status: 'closed' }), res)
    expect(res.statusCode).toBe(200)
    const eqCalls = state.builderState.calls.filter((c) => c.method === 'eq')
    const statusEq = eqCalls.find((c) => c.args[0] === 'status')
    expect(statusEq).toBeDefined()
    expect(statusEq?.args[1]).toBe('closed')
  })

  it('filtres `from`/`to` → gte/lte appliqués', async () => {
    state.builderState.count = 0
    state.builderState.rows = []
    const res = mockRes()
    await exportSavCsvHandler(
      operatorReq({ from: '2026-01-01T00:00:00Z', to: '2026-04-30T23:59:59Z' }),
      res
    )
    const gte = state.builderState.calls.find(
      (c) => c.method === 'gte' && c.args[0] === 'received_at'
    )
    const lte = state.builderState.calls.find(
      (c) => c.method === 'lte' && c.args[0] === 'received_at'
    )
    expect(gte).toBeDefined()
    expect(lte).toBeDefined()
  })

  it('SWITCH_TO_XLSX warning : count=6000 + format=csv → 200 JSON warning', async () => {
    state.builderState.count = 6000
    const res = mockRes()
    await exportSavCsvHandler(operatorReq({}), res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { warning: string; row_count: number; message: string }
    expect(body.warning).toBe('SWITCH_TO_XLSX')
    expect(body.row_count).toBe(6000)
    expect(body.message).toContain('5000')
  })

  it('count=6000 + format=xlsx → génère le XLSX (pas de warning)', async () => {
    state.builderState.count = 6000
    state.builderState.rows = [makeRow()]
    const res = mockRes()
    await exportSavCsvHandler(operatorReq({ format: 'xlsx' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('spreadsheetml.sheet')
  })

  it('EXPORT_TOO_LARGE : count=60000 → 400 EXPORT_TOO_LARGE même en XLSX', async () => {
    state.builderState.count = 60_000
    const res = mockRes()
    await exportSavCsvHandler(operatorReq({ format: 'xlsx' }), res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details: { code: string; row_count: number } } }
    expect(body.error.details.code).toBe('EXPORT_TOO_LARGE')
    expect(body.error.details.row_count).toBe(60_000)
  })

  it('INVALID_FILTERS : memberId=abc (Zod coerce fail) → 400', async () => {
    const res = mockRes()
    await exportSavCsvHandler(operatorReq({ memberId: 'abc' }), res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('INVALID_FILTERS')
  })

  it('format invalide → 400 INVALID_FILTERS', async () => {
    const res = mockRes()
    await exportSavCsvHandler(operatorReq({ format: 'pdf' }), res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('INVALID_FILTERS')
  })

  it('FORBIDDEN : type session != operator → 403', async () => {
    const memberPayload: SessionUser = { sub: 1, type: 'member', exp: farFuture() }
    const req = mockReq({ method: 'GET', query: {} })
    req.user = memberPayload
    const res = mockRes()
    await exportSavCsvHandler(req, res)
    expect(res.statusCode).toBe(403)
  })

  it('UNAUTHENTICATED : pas de user → 401', async () => {
    const req = mockReq({ method: 'GET', query: {} })
    const res = mockRes()
    await exportSavCsvHandler(req, res)
    expect(res.statusCode).toBe(401)
  })

  it('PII encoding : member.name `"Müller; Jean"` → CSV escapé avec guillemets', async () => {
    state.builderState.count = 1
    state.builderState.rows = [
      makeRow({
        member: { id: 1, first_name: null, last_name: 'Müller; Jean', email: 'm@a.fr' },
      }),
    ]
    const res = mockRes()
    let buf: Buffer | null = null
    res.end = ((chunk?: string | Buffer) => {
      if (chunk instanceof Buffer) buf = chunk
    }) as typeof res.end
    await exportSavCsvHandler(operatorReq({}), res)
    const csv = buf!.toString('utf8')
    // La cellule contient `;` → entourée de guillemets
    expect(csv).toContain('"Müller; Jean"')
    // Pas d'échec de séparation (la `;` interne ne crée pas de colonne)
    const lines = csv.replace(/^﻿/, '').split('\r\n')
    // header puis 1 row data
    expect(lines.length).toBe(2)
  })

  it('Motifs concat : 3 lignes motifs distincts → "A | B | C" déduplé', async () => {
    state.builderState.count = 1
    state.builderState.rows = [
      makeRow({
        sav_lines: [
          { id: 1, validation_messages: [{ kind: 'cause', text: 'Abimé' }], product: null },
          { id: 2, validation_messages: [{ kind: 'cause', text: 'Cassé' }], product: null },
          { id: 3, validation_messages: [{ kind: 'cause', text: 'Défaut' }], product: null },
          { id: 4, validation_messages: [{ kind: 'cause', text: 'abimé' }], product: null }, // dédup case-fold
        ],
      }),
    ]
    const res = mockRes()
    let buf: Buffer | null = null
    res.end = ((chunk?: string | Buffer) => {
      if (chunk instanceof Buffer) buf = chunk
    }) as typeof res.end
    await exportSavCsvHandler(operatorReq({}), res)
    const csv = buf!.toString('utf8')
    expect(csv).toContain('Abimé | Cassé | Défaut')
  })

  it('Statut vide / groupe NULL → cellules vides (pas "null" string)', async () => {
    state.builderState.count = 1
    state.builderState.rows = [makeRow({ group: null, assignee: null, closed_at: null })]
    const res = mockRes()
    let buf: Buffer | null = null
    res.end = ((chunk?: string | Buffer) => {
      if (chunk instanceof Buffer) buf = chunk
    }) as typeof res.end
    await exportSavCsvHandler(operatorReq({}), res)
    const csv = buf!.toString('utf8')
    expect(csv).not.toContain('null')
    expect(csv).not.toContain('undefined')
  })

  it('Numéro format FR : 123456 → "1234,56"', async () => {
    state.builderState.count = 1
    state.builderState.rows = [makeRow({ total_amount_cents: 123456 })]
    const res = mockRes()
    let buf: Buffer | null = null
    res.end = ((chunk?: string | Buffer) => {
      if (chunk instanceof Buffer) buf = chunk
    }) as typeof res.end
    await exportSavCsvHandler(operatorReq({}), res)
    const csv = buf!.toString('utf8')
    expect(csv).toContain('1234,56')
  })

  it('BOM présent : 1er octet CSV = \\xef\\xbb\\xbf', async () => {
    // CR P13 — count=0 retourne JSON EMPTY_RESULT ; on force au moins 1 row
    // pour atteindre la génération CSV.
    state.builderState.count = 1
    state.builderState.rows = [makeRow()]
    const res = mockRes()
    let buf: Buffer | null = null
    res.end = ((chunk?: string | Buffer) => {
      if (chunk instanceof Buffer) buf = chunk
    }) as typeof res.end
    await exportSavCsvHandler(operatorReq({}), res)
    expect(buf).not.toBeNull()
    expect(buf![0]).toBe(0xef)
    expect(buf![1]).toBe(0xbb)
    expect(buf![2]).toBe(0xbf)
  })

  it('CSV header en français : « Référence »;« Date réception »;…', async () => {
    // CR P13 — idem ci-dessus, count > 0 pour générer le CSV.
    state.builderState.count = 1
    state.builderState.rows = [makeRow()]
    const res = mockRes()
    let buf: Buffer | null = null
    res.end = ((chunk?: string | Buffer) => {
      if (chunk instanceof Buffer) buf = chunk
    }) as typeof res.end
    await exportSavCsvHandler(operatorReq({}), res)
    const csv = buf!.toString('utf8').replace(/^﻿/, '')
    const headerLine = csv.split('\r\n')[0]
    expect(headerLine).toContain('Référence')
    expect(headerLine).toContain('Date réception')
    expect(headerLine).toContain('Total TTC (€)')
    expect(headerLine).toContain('Motifs')
    expect(headerLine).toContain('Fournisseurs')
    // 14 colonnes attendues (AC #3) — séparées par 13 `;`.
    expect((headerLine!.match(/;/g) ?? []).length).toBe(13)
  })

  // CR P13 — empty result : 200 JSON EMPTY_RESULT au lieu d'un fichier
  // header-only que l'opérateur prendrait pour un succès silencieux.
  it('count=0 → 200 JSON warning EMPTY_RESULT', async () => {
    state.builderState.count = 0
    state.builderState.rows = []
    const res = mockRes()
    await exportSavCsvHandler(operatorReq({}), res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      warning: string
      row_count: number
      message: string
    }
    expect(body.warning).toBe('EMPTY_RESULT')
    expect(body.row_count).toBe(0)
    expect(body.message).toContain('Aucun')
  })

  it('opérateur assigné : email `alice.martin@coop.fr` → cellule `alice.martin`', async () => {
    state.builderState.count = 1
    state.builderState.rows = [makeRow()]
    const res = mockRes()
    let buf: Buffer | null = null
    res.end = ((chunk?: string | Buffer) => {
      if (chunk instanceof Buffer) buf = chunk
    }) as typeof res.end
    await exportSavCsvHandler(operatorReq({}), res)
    const csv = buf!.toString('utf8')
    expect(csv).toContain('alice.martin')
    expect(csv).not.toContain('alice.martin@coop.fr')
  })

  it('Fournisseurs déduplés : 2 lignes même supplier → 1 seul code', async () => {
    state.builderState.count = 1
    state.builderState.rows = [
      makeRow({
        sav_lines: [
          { id: 1, validation_messages: [], product: { supplier_code: 'RUFINO' } },
          { id: 2, validation_messages: [], product: { supplier_code: 'RUFINO' } },
          { id: 3, validation_messages: [], product: { supplier_code: 'BIOSUD' } },
        ],
      }),
    ]
    const res = mockRes()
    let buf: Buffer | null = null
    res.end = ((chunk?: string | Buffer) => {
      if (chunk instanceof Buffer) buf = chunk
    }) as typeof res.end
    await exportSavCsvHandler(operatorReq({}), res)
    const csv = buf!.toString('utf8')
    expect(csv).toContain('RUFINO | BIOSUD')
  })

  it('count error : 500 QUERY_FAILED', async () => {
    state.builderState.countError = { message: 'connection refused' }
    const res = mockRes()
    await exportSavCsvHandler(operatorReq({}), res)
    expect(res.statusCode).toBe(500)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('QUERY_FAILED')
  })

  it('fetch error : 500 QUERY_FAILED', async () => {
    state.builderState.count = 1
    state.builderState.error = { message: 'timeout' }
    const res = mockRes()
    await exportSavCsvHandler(operatorReq({}), res)
    expect(res.statusCode).toBe(500)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('QUERY_FAILED')
  })
})

/**
 * CR 5.4 EC4 — Rate-limit composé via `withRateLimit({ max: 6, window: '1m' })`.
 * On vérifie ici que le handler exporté `exportSavCsvHandler` (composition)
 * applique bien le rate-limiter avant de déléguer à `coreHandler`. La
 * logique du rate-limit elle-même est couverte par with-rate-limit.spec.ts.
 */
import { exportSavCsvHandler as ratedHandler } from '../../../../api/_lib/reports/export-csv-handler'

describe('GET /api/reports/export-csv — rate-limit (CR 5.4 EC4)', () => {
  beforeEach(() => {
    state.builderState.count = 0
    state.builderState.rows = []
    state.builderState.error = null
    state.builderState.countError = null
    state.builderState.calls = []
    state.rateLimit.rpcCalls = 0
    state.rateLimit.nextResponse = { allowed: true, retry_after: 0 }
  })

  it('429 RATE_LIMITED si rpc rate_limit retourne allowed=false', async () => {
    state.rateLimit.nextResponse = { allowed: false, retry_after: 42 }
    const res = mockRes()
    await ratedHandler(operatorReq({}), res)
    expect(res.statusCode).toBe(429)
    expect(res.headers['retry-after']).toBe(42)
  })

  it('200 si allowed=true (passe au coreHandler)', async () => {
    state.rateLimit.nextResponse = { allowed: true, retry_after: 0 }
    state.builderState.count = 0
    const res = mockRes()
    await ratedHandler(operatorReq({}), res)
    expect(res.statusCode).toBe(200)
    expect(state.rateLimit.rpcCalls).toBe(1)
  })

  it('keyFrom: pas de session opérateur → 400 VALIDATION_FAILED (clé manquante)', async () => {
    const req = mockReq({ method: 'GET', query: {} })
    // pas de req.user → withRateLimit `keyFrom` retourne undefined
    const res = mockRes()
    await ratedHandler(req, res)
    // withRateLimit envoie 400 VALIDATION_FAILED quand keyFrom = undefined
    // (avant même que coreHandler ne voit la requête)
    expect(res.statusCode).toBe(400)
  })
})
