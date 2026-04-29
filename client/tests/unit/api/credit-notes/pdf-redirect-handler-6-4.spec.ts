import { describe, it, expect, vi, beforeEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

/**
 * Story 6.4 — TDD RED PHASE — extension `pdfRedirectHandler` polymorphique
 * member/operator (cf. AC #1, #2, #3, #4, #5).
 *
 * Cible :
 *   client/api/_lib/credit-notes/pdf-redirect-handler.ts
 *   client/api/credit-notes.ts (router withAuth.types = ['operator', 'member'])
 *
 * Cas couverts (6 nouveaux par rapport à la suite Story 4.4 existante
 * `pdf-redirect.spec.ts`, qui reste verte en régression) :
 *
 *   (a) member auth + own credit_note (sav.member_id === user.sub)        → 302
 *   (b) member auth + autre member's credit_note                          → 404 (anti-énumération, jamais 403)
 *   (c) operator auth + n'importe quelle credit_note (régression 4.4)     → 302
 *   (d) member auth + credit_note d'un sav cancelled — décision Story 6.4 → 302 (le PDF reste accessible)
 *   (e) member sans cookie de session                                     → 401
 *   (f) regenerate-pdf appelé par member                                  → 403 (operator-only, Story 4.5)
 *
 * Tous les cas DOIVENT échouer tant que :
 *   - `pdfRedirectCore` ligne 51 contient encore `if (user.type !== 'operator')` → 403,
 *   - le router `api/credit-notes.ts` exige `withAuth({ types: ['operator'] })`.
 */

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

interface CreditNoteRow {
  id: number
  number: number
  number_formatted: string
  pdf_web_url: string | null
  issued_at: string
  // Story 6.4 — projection PostgREST embedded (jointure inner sav)
  sav?: { member_id: number; cancelled_at: string | null } | null
}

const db = vi.hoisted(() => ({
  row: null as CreditNoteRow | null,
  rowError: null as { message: string } | null,
  // Story 6.4 — la query polymorphique ajoute `.eq('sav.member_id', user.sub)`
  // côté member. On capture les filtres effectivement appliqués pour assertion.
  appliedFilters: [] as Array<{ col: string; val: unknown }>,
  // Sav d'un autre member : si appliedFilters contient sav.member_id !== row.sav.member_id,
  // la query renvoie row=null (PostgREST inner join filter).
  rateLimitAllowed: true,
}))

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  const client = {
    from: (table: string) => {
      if (table === 'credit_notes') {
        return {
          select: () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const builder: any = {}
            builder['eq'] = (col: string, val: unknown) => {
              db.appliedFilters.push({ col, val })
              return builder
            }
            builder['limit'] = () => builder
            builder['maybeSingle'] = () => {
              // Si un filtre `sav.member_id` est appliqué et ne matche pas → null
              const memberFilter = db.appliedFilters.find((f) => f.col === 'sav.member_id')
              if (
                memberFilter &&
                db.row &&
                db.row.sav &&
                db.row.sav.member_id !== memberFilter.val
              ) {
                return Promise.resolve({ data: null, error: db.rowError })
              }
              return Promise.resolve({ data: db.row, error: db.rowError })
            }
            return builder
          },
        }
      }
      return {}
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

import handler from '../../../../api/credit-notes'

function farFuture(): number {
  return Math.floor(Date.now() / 1000) + 3600
}

function memberCookie(memberId: number): string {
  const p: SessionUser = { sub: memberId, type: 'member', exp: farFuture() }
  return `sav_session=${signJwt(p, SECRET)}`
}

function operatorCookie(operatorId: number): string {
  const p: SessionUser = {
    sub: operatorId,
    type: 'operator',
    role: 'sav-operator',
    exp: farFuture(),
  }
  return `sav_session=${signJwt(p, SECRET)}`
}

function pdfReq(numberInput: string, cookie: string) {
  return mockReq({
    method: 'GET',
    headers: { cookie },
    query: { op: 'pdf', number: numberInput } as Record<string, string | string[] | undefined>,
  })
}

function regenerateReq(numberInput: string, cookie: string) {
  return mockReq({
    method: 'POST',
    headers: { cookie },
    query: { op: 'regenerate', number: numberInput } as Record<
      string,
      string | string[] | undefined
    >,
  })
}

beforeEach(() => {
  vi.stubEnv('SESSION_COOKIE_SECRET', SECRET)
  vi.stubEnv('SUPABASE_URL', 'http://localhost')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test')
  db.row = null
  db.rowError = null
  db.appliedFilters = []
  db.rateLimitAllowed = true
})

describe('pdfRedirectHandler polymorphique member/operator (Story 6.4)', () => {
  it('AC#1/#2 (a) member authentifié + own credit_note → 302 vers OneDrive', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      pdf_web_url: 'https://onedrive.example.com/file.pdf',
      issued_at: '2026-04-26T10:00:00Z',
      sav: { member_id: 42, cancelled_at: null },
    }
    const res = mockRes()
    await handler(pdfReq('AV-2026-00042', memberCookie(42)), res)
    expect(res.statusCode).toBe(302)
    expect(res.headers['location']).toBe('https://onedrive.example.com/file.pdf')
    // Le handler DOIT avoir appliqué le filtre sav.member_id côté query (anti-leak)
    expect(db.appliedFilters.some((f) => f.col === 'sav.member_id' && f.val === 42)).toBe(true)
  })

  it("AC#2/#4 (b) member authentifié + credit_note d'un AUTRE member → 404 (anti-énumération)", async () => {
    // La credit_note existe en DB mais appartient au sav du member 99.
    db.row = {
      id: 99,
      number: 99,
      number_formatted: 'AV-2026-00099',
      pdf_web_url: 'https://onedrive.example.com/other.pdf',
      issued_at: '2026-04-26T10:00:00Z',
      sav: { member_id: 99, cancelled_at: null },
    }
    const res = mockRes()
    await handler(pdfReq('AV-2026-00099', memberCookie(42)), res)
    expect(res.statusCode).toBe(404)
    const body = res.jsonBody as { error: { code: string; details?: { code?: string } } }
    // NOT_FOUND, JAMAIS FORBIDDEN — on ne révèle pas l'existence de l'avoir.
    expect(body.error.code).toBe('NOT_FOUND')
    if (body.error.details && 'code' in body.error.details) {
      expect(body.error.details.code).toBe('CREDIT_NOTE_NOT_FOUND')
    }
  })

  it('AC#2 (c) operator authentifié → 302 (régression Story 4.4 préservée)', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      pdf_web_url: 'https://onedrive.example.com/file.pdf',
      issued_at: '2026-04-26T10:00:00Z',
      sav: { member_id: 99, cancelled_at: null }, // sav d'un autre member, mais operator passe
    }
    const res = mockRes()
    await handler(pdfReq('AV-2026-00042', operatorCookie(7)), res)
    expect(res.statusCode).toBe(302)
    expect(res.headers['location']).toBe('https://onedrive.example.com/file.pdf')
    // L'operator NE DOIT PAS appliquer de filtre sav.member_id (toutes les access)
    expect(db.appliedFilters.some((f) => f.col === 'sav.member_id')).toBe(false)
  })

  it("AC#13 (d) member + credit_note d'un sav cancelled → 302 (le PDF reste accessible — décision Story 6.4)", async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      pdf_web_url: 'https://onedrive.example.com/file.pdf',
      issued_at: '2026-04-26T10:00:00Z',
      sav: { member_id: 42, cancelled_at: '2026-04-27T10:00:00Z' },
    }
    const res = mockRes()
    await handler(pdfReq('AV-2026-00042', memberCookie(42)), res)
    expect(res.statusCode).toBe(302)
  })

  it('AC#3 (e) absence de cookie → 401 (router withAuth)', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      pdf_web_url: 'https://onedrive.example.com/file.pdf',
      issued_at: '2026-04-26T10:00:00Z',
      sav: { member_id: 42, cancelled_at: null },
    }
    const res = mockRes()
    await handler(
      mockReq({
        method: 'GET',
        headers: {},
        query: { op: 'pdf', number: 'AV-2026-00042' },
      }),
      res
    )
    expect(res.statusCode).toBe(401)
  })

  it('AC#5 (f) member appelle POST /regenerate-pdf → 403 (operator-only)', async () => {
    const res = mockRes()
    await handler(regenerateReq('AV-2026-00042', memberCookie(42)), res)
    // Soit le router refuse au niveau withAuth({ types: ['operator'] }) sur l'op regenerate,
    // soit le regeneratePdfHandler renvoie 403 explicitement.
    expect(res.statusCode).toBe(403)
  })

  it('AC#3 — member dépasse le quota rate-limit `credit-note-pdf:member` → 429', async () => {
    db.row = {
      id: 1,
      number: 42,
      number_formatted: 'AV-2026-00042',
      pdf_web_url: 'https://onedrive.example.com/file.pdf',
      issued_at: '2026-04-26T10:00:00Z',
      sav: { member_id: 42, cancelled_at: null },
    }
    // Simulation du débordement quota côté RPC `increment_rate_limit` :
    // le runner DB répond `allowed=false` au-delà de max=30/window=1m.
    db.rateLimitAllowed = false
    const res = mockRes()
    await handler(pdfReq('AV-2026-00042', memberCookie(42)), res)
    // 429 TOO_MANY_REQUESTS — le member ne peut pas DDoS le redirect 302
    // (et OneDrive en aval). L'operator garde son propre bucket isolé.
    expect(res.statusCode).toBe(429)
    db.rateLimitAllowed = true
  })
})
