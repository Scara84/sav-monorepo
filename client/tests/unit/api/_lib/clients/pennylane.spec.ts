import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  findInvoiceByNumber,
  encodePennylaneFilter,
  PennylaneUnauthorizedError,
  PennylaneUpstreamError,
  PennylaneTimeoutError,
  MAX_SUB_RESOURCE_PAGES,
  SUB_RESOURCE_BUDGET_MS,
  type PennylaneInvoice,
} from '../../../../../api/_lib/clients/pennylane'
import { logger } from '../../../../../api/_lib/logger'

/**
 * Tests Story 5.7 AC #11.5 — `pennylane.ts` (5 tests minimum).
 * Mock global fetch ; pas d'appel réseau réel.
 */

interface FetchCall {
  url: string
  init: RequestInit | undefined
}

const calls: FetchCall[] = []

function mockFetch(impl: (call: FetchCall) => Promise<Response> | Response): void {
  globalThis.fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = { url: String(url), init }
    calls.push(call)
    return Promise.resolve(impl(call))
  }) as unknown as typeof fetch
}

beforeEach(() => {
  calls.length = 0
  vi.stubEnv('PENNYLANE_API_KEY', 'test-key-secret-abc123')
  vi.stubEnv('PENNYLANE_API_BASE_URL', 'https://app.pennylane.com/api/external/v2')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('PL-01 happy path : invoice trouvée → items[0]', () => {
  it('appelle GET /customer_invoices avec filter encodé + Authorization Bearer', async () => {
    const invoice: PennylaneInvoice = {
      invoice_number: 'F-2025-37039',
      special_mention: '709_25S39_68_20',
      label: 'Facture Laurence Panetta',
      customer: {
        id: 1833,
        name: 'Laurence Panetta',
        emails: ['laurence@example.com'],
      },
    }
    mockFetch(
      () =>
        new Response(JSON.stringify({ items: [invoice] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    )

    const result = await findInvoiceByNumber('F-2025-37039')

    expect(result).toMatchObject({
      invoice_number: 'F-2025-37039',
      customer: { emails: ['laurence@example.com'] },
    })
    expect(calls.length).toBe(1)
    const url = calls[0]!.url
    // Filter encodé : `:` → `%3A`
    expect(url).toContain(
      'filter=%5B%7B%22field%22%3A%22invoice_number%22%2C%22operator%22%3A%22eq%22%2C%22value%22%3A%22F-2025-37039%22%7D%5D'
    )
    expect(url).toContain('limit=1')
    expect(url.startsWith('https://app.pennylane.com/api/external/v2/customer_invoices')).toBe(true)
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer test-key-secret-abc123')
    expect(headers['Accept']).toBe('application/json')
  })
})

describe('PL-02 timeout 8s → PennylaneTimeoutError', () => {
  it('AbortController déclenché → throw timeout error', async () => {
    mockFetch(() => {
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    })
    await expect(findInvoiceByNumber('F-2025-37039')).rejects.toBeInstanceOf(PennylaneTimeoutError)
  })

  it('network error (DNS / refused) → PennylaneTimeoutError aussi', async () => {
    mockFetch(() => {
      throw new TypeError('fetch failed')
    })
    await expect(findInvoiceByNumber('F-2025-37039')).rejects.toBeInstanceOf(PennylaneTimeoutError)
  })
})

describe('PL-03 items: [] → null', () => {
  it('résultat vide retourne null (pas throw)', async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    )
    const result = await findInvoiceByNumber('F-2099-99999')
    expect(result).toBeNull()
  })
})

describe('PL-04 401 → PennylaneUnauthorizedError', () => {
  it('clé API invalide → throw distinct (pas confondu avec 5xx)', async () => {
    mockFetch(() => new Response('Unauthorized', { status: 401 }))
    await expect(findInvoiceByNumber('F-2025-37039')).rejects.toBeInstanceOf(
      PennylaneUnauthorizedError
    )
  })
})

describe('PL-05 5xx → PennylaneUpstreamError avec status', () => {
  it('500 → upstream error (status preserved)', async () => {
    mockFetch(() => new Response('Internal Server Error', { status: 500 }))
    try {
      await findInvoiceByNumber('F-2025-37039')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(PennylaneUpstreamError)
      expect((err as PennylaneUpstreamError).status).toBe(500)
    }
  })

  it('502 / 503 → idem upstream', async () => {
    mockFetch(() => new Response('Bad Gateway', { status: 502 }))
    await expect(findInvoiceByNumber('F-2025-37039')).rejects.toBeInstanceOf(PennylaneUpstreamError)
  })

  it('429 (rate-limit Pennylane) → upstream error', async () => {
    mockFetch(() => new Response('Too Many Requests', { status: 429 }))
    await expect(findInvoiceByNumber('F-2025-37039')).rejects.toBeInstanceOf(PennylaneUpstreamError)
  })
})

describe('PL-06 PENNYLANE_API_KEY missing → fail-fast', () => {
  it('throw "PENNYLANE_API_KEY manquant" sans appeler fetch', async () => {
    vi.stubEnv('PENNYLANE_API_KEY', '')
    await expect(findInvoiceByNumber('F-2025-37039')).rejects.toThrow('PENNYLANE_API_KEY manquant')
    expect(calls.length).toBe(0)
  })
})

describe('encodePennylaneFilter helper', () => {
  it('encode le filtre v2 en JSON array URL-encoded', () => {
    expect(encodePennylaneFilter('invoice_number', 'eq', 'F-2025-37039')).toBe(
      '%5B%7B%22field%22%3A%22invoice_number%22%2C%22operator%22%3A%22eq%22%2C%22value%22%3A%22F-2025-37039%22%7D%5D'
    )
  })
})

/**
 * Tests PL-07 — pagination sub-resource `invoice_lines` (cf. spec
 * `spec-pennylane-v2-invoice-lines-pagination`).
 *
 * Contrat Pennylane v2 sub-resource : `{ items[], has_more, next_cursor }` —
 * mocks réalistes (pas de validation du mock lui-même, leçon
 * `project_pennylane_v2_breaking_change`).
 *
 * On route le mock selon l'URL : GET LIST invoice (filter) vs GET sub-resource
 * (`/invoice_lines`). Pour les warns, on spy sur `logger.warn` du module
 * importé statiquement (logger est un object literal exporté).
 */
describe('PL-07 pagination sub-resource invoice_lines', () => {
  // Helper : invoice retourné par le LIST customer_invoices, avec
  // `invoice_lines: { url }` à matérialiser. Customer.emails déjà présent →
  // pas d'appel /customers/{id}.
  function buildInvoice(): PennylaneInvoice {
    return {
      invoice_number: 'F-2026-39939',
      customer: {
        id: 1833,
        emails: ['nathan91cov@hotmail.fr'],
      },
      invoice_lines: {
        url: 'https://app.pennylane.com/api/external/v2/customer_invoices/123/invoice_lines?foo=bar',
      },
    } as PennylaneInvoice
  }

  function buildLine(i: number, amount: number | string | null = null): Record<string, unknown> {
    const line: Record<string, unknown> = { id: i, label: `line-${i}` }
    if (amount !== null) line['currency_amount'] = amount
    return line
  }

  // Router fetch selon URL : retourne le handler invoice ou la séquence
  // sub-resource. `subResponses` est consommé dans l'ordre des GET
  // sub-resource (page 1, page 2, …).
  function setupRouter(
    invoice: PennylaneInvoice,
    subResponses: Array<() => Response>
  ): { subCalls: FetchCall[] } {
    const subCalls: FetchCall[] = []
    let subIdx = 0
    mockFetch((call) => {
      if (call.url.includes('/invoice_lines')) {
        subCalls.push(call)
        const handler = subResponses[subIdx]
        subIdx += 1
        if (!handler) {
          // Sécurité test : un GET sub-resource non prévu = signal d'erreur.
          return new Response('unexpected sub-resource call', { status: 599 })
        }
        return handler()
      }
      // GET LIST customer_invoices
      return new Response(JSON.stringify({ items: [invoice] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    return { subCalls }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let warnSpy: any

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('(a) multi-pages 20+12 → 32 lignes, ordre préservé, 2 GET séquentiels avec cursor + foo=bar + Bearer', async () => {
    const page1Items = Array.from({ length: 20 }, (_, i) => buildLine(i + 1))
    const page2Items = Array.from({ length: 12 }, (_, i) => buildLine(i + 21))

    const { subCalls } = setupRouter(buildInvoice(), [
      () =>
        new Response(
          JSON.stringify({ items: page1Items, has_more: true, next_cursor: 'cur2' }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
      () =>
        new Response(
          JSON.stringify({ items: page2Items, has_more: false, next_cursor: null }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
    ])

    const result = await findInvoiceByNumber('F-2026-39939')

    expect(result).not.toBeNull()
    expect(Array.isArray(result!.line_items)).toBe(true)
    expect(result!.line_items!.length).toBe(32)
    // Ordre préservé : 1er item = id 1, dernier = id 32
    expect((result!.line_items![0] as { id: number }).id).toBe(1)
    expect((result!.line_items![31] as { id: number }).id).toBe(32)

    // Exactement 2 GET sub-resource séquentiels
    expect(subCalls.length).toBe(2)

    // 1er GET : foo=bar + limit=100 préservés, pas de cursor
    const url1 = new URL(subCalls[0]!.url)
    expect(url1.searchParams.get('foo')).toBe('bar')
    expect(url1.searchParams.get('limit')).toBe('100')
    expect(url1.searchParams.get('cursor')).toBeNull()

    // 2ᵉ GET : cursor=cur2 ajouté, foo=bar + limit=100 toujours là
    const url2 = new URL(subCalls[1]!.url)
    expect(url2.searchParams.get('foo')).toBe('bar')
    expect(url2.searchParams.get('limit')).toBe('100')
    expect(url2.searchParams.get('cursor')).toBe('cur2')

    // Chaque GET porte Authorization: Bearer ET un signal défini.
    for (const c of subCalls) {
      const headers = c.init?.headers as Record<string, string>
      expect(headers['Authorization']).toBe('Bearer test-key-secret-abc123')
      expect(c.init?.signal).toBeDefined()
    }
    // T4(i) — chaque page a son propre AbortController (pas de timer global
    // partagé qui fuirait). Les deux signaux doivent être des instances
    // distinctes.
    expect(subCalls[0]!.init!.signal).not.toBe(subCalls[1]!.init!.signal)
  })

  it('(b) pin no-partial : p1 OK + p2 500 → AUCUNE ligne matérialisée + warn dédié', async () => {
    const page1Items = Array.from({ length: 20 }, (_, i) => buildLine(i + 1))

    const { subCalls } = setupRouter(buildInvoice(), [
      () =>
        new Response(
          JSON.stringify({ items: page1Items, has_more: true, next_cursor: 'cur2' }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
      () => new Response('Internal Server Error', { status: 500 }),
    ])

    const result = await findInvoiceByNumber('F-2026-39939')

    expect(result).not.toBeNull()
    // line_items undefined (jamais matérialisé) ET invoice_lines reste { url }
    expect(result!.line_items).toBeUndefined()
    expect(Array.isArray(result!.invoice_lines)).toBe(false)
    expect(
      typeof (result!.invoice_lines as { url?: string } | undefined)?.url === 'string'
    ).toBe(true)

    // 2 GET tentés, exactement un warn non-ok émis (T4(ii)).
    expect(subCalls.length).toBe(2)
    const warnCalls = warnSpy.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(warnCalls.filter((n: string) => n === 'pennylane.sub_resource_fetch_non_ok')).toHaveLength(1)
  })

  it('(c) borne 5 pages : toutes has_more=true → null + warn page_cap, exactement 5 GET', async () => {
    const subResponses: Array<() => Response> = []
    for (let i = 0; i < 6; i += 1) {
      const cursor = `cur${i + 2}`
      const items = Array.from({ length: 100 }, (_, k) => buildLine(i * 100 + k + 1))
      subResponses.push(
        () =>
          new Response(
            JSON.stringify({ items, has_more: true, next_cursor: cursor }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
      )
    }

    const { subCalls } = setupRouter(buildInvoice(), subResponses)

    const result = await findInvoiceByNumber('F-2026-39939')

    expect(result).not.toBeNull()
    expect(result!.line_items).toBeUndefined()
    // Exactement 5 GET (pas 6 — borne respectée). T4(ii) : exactement un warn
    // page_cap.
    expect(subCalls.length).toBe(5)
    const warnCalls = warnSpy.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(warnCalls.filter((n: string) => n === 'pennylane.sub_resource_page_cap')).toHaveLength(1)
    // T3(8) miroir : MAX_SUB_RESOURCE_PAGES doit être bien la borne pin.
    expect(subCalls.length).toBe(MAX_SUB_RESOURCE_PAGES)
  })

  it('(d) budget temps épuisé entre p1 et p2 → null + warn time_budget', async () => {
    const page1Items = Array.from({ length: 20 }, (_, i) => buildLine(i + 1))

    // T2 — pattern robuste : `fakeNow` mutable retourné par le spy. Le handler
    // du mock fetch de la page 1 avance fakeNow APRÈS avoir servi la page,
    // donc la 2ᵉ vérif de budget (avant page 2) voit un budget négatif. Le
    // spy ne dépend PAS du compte exact d'appels Date.now (cascade illisible
    // sinon — vitest 1.6 + mockReset:true).
    const t0 = 1_700_000_000_000
    let fakeNow = t0
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => fakeNow)

    try {
      const { subCalls } = setupRouter(buildInvoice(), [
        () => {
          // Après avoir servi p1, on saute très loin pour épuiser le budget
          // global avant l'évaluation pré-page-2.
          const res = new Response(
            JSON.stringify({ items: page1Items, has_more: true, next_cursor: 'cur2' }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
          fakeNow = t0 + 10 * SUB_RESOURCE_BUDGET_MS
          return res
        },
        () =>
          new Response(JSON.stringify({ items: [], has_more: false }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ])

      const result = await findInvoiceByNumber('F-2026-39939')

      expect(result).not.toBeNull()
      expect(result!.line_items).toBeUndefined()
      // Seule la p1 a été appelée (budget épuisé avant p2)
      expect(subCalls.length).toBe(1)
      const warnCalls = warnSpy.mock.calls.map((c: unknown[]) => c[0] as string)
      expect(warnCalls.filter((n: string) => n === 'pennylane.sub_resource_time_budget')).toHaveLength(1)
    } finally {
      dateNowSpy.mockRestore()
    }
  })

  it('(e) garde-fou somme — divergence >1 % → warn mismatch', async () => {
    // Invoice total 100, lignes somme 200 → divergence 100 %.
    const invoice = buildInvoice()
    invoice.currency_amount = '100.00'
    const lines = [buildLine(1, 100), buildLine(2, 100)]

    setupRouter(invoice, [
      () =>
        new Response(
          JSON.stringify({ items: lines, has_more: false, next_cursor: null }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
    ])

    const result = await findInvoiceByNumber('F-2026-39939')

    expect(result!.line_items!.length).toBe(2)
    const warnCalls = warnSpy.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(warnCalls).toContain('pennylane.invoice_lines_sum_mismatch')
  })

  it('(e) garde-fou somme — concordance <1 % → silence', async () => {
    // Invoice total 100, lignes somme 100,50 → 0,5 % de divergence < 1 %.
    const invoice = buildInvoice()
    invoice.currency_amount = 100
    const lines = [buildLine(1, '50.25'), buildLine(2, '50.25')]

    setupRouter(invoice, [
      () =>
        new Response(
          JSON.stringify({ items: lines, has_more: false, next_cursor: null }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
    ])

    const result = await findInvoiceByNumber('F-2026-39939')

    expect(result!.line_items!.length).toBe(2)
    const warnCalls = warnSpy.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(warnCalls).not.toContain('pennylane.invoice_lines_sum_mismatch')
  })

  // ───────────────────────── T3 — tests adversariaux ─────────────────────────
  // Helper : asserter que zéro ligne n'a été matérialisée.
  function expectNoLinesMaterialized(result: PennylaneInvoice | null): void {
    expect(result).not.toBeNull()
    expect(result!.line_items).toBeUndefined()
    expect(Array.isArray(result!.invoice_lines)).toBe(false)
    expect(
      typeof (result!.invoice_lines as { url?: string } | undefined)?.url === 'string'
    ).toBe(true)
  }

  it("T3-1 p2 '{}' (items absent) → null + warn malformed", async () => {
    const page1Items = Array.from({ length: 20 }, (_, i) => buildLine(i + 1))
    const { subCalls } = setupRouter(buildInvoice(), [
      () =>
        new Response(
          JSON.stringify({ items: page1Items, has_more: true, next_cursor: 'cur2' }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
      () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ])

    const result = await findInvoiceByNumber('F-2026-39939')

    expectNoLinesMaterialized(result)
    expect(subCalls.length).toBe(2)
    const warnCalls = warnSpy.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(warnCalls.filter((n: string) => n === 'pennylane.sub_resource_malformed')).toHaveLength(1)
  })

  it("T3-2 p2 items non-array ('nope') → null + warn malformed", async () => {
    const page1Items = Array.from({ length: 20 }, (_, i) => buildLine(i + 1))
    setupRouter(buildInvoice(), [
      () =>
        new Response(
          JSON.stringify({ items: page1Items, has_more: true, next_cursor: 'cur2' }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
      () =>
        new Response(JSON.stringify({ items: 'nope', has_more: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ])

    const result = await findInvoiceByNumber('F-2026-39939')

    expectNoLinesMaterialized(result)
    const warnCalls = warnSpy.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(warnCalls.filter((n: string) => n === 'pennylane.sub_resource_malformed')).toHaveLength(1)
  })

  it('T3-3 p2 body non-JSON → null + warn malformed, zéro ligne', async () => {
    const page1Items = Array.from({ length: 20 }, (_, i) => buildLine(i + 1))
    setupRouter(buildInvoice(), [
      () =>
        new Response(
          JSON.stringify({ items: page1Items, has_more: true, next_cursor: 'cur2' }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
      () => new Response('not json', { status: 200 }),
    ])

    const result = await findInvoiceByNumber('F-2026-39939')

    expectNoLinesMaterialized(result)
    const warnCalls = warnSpy.mock.calls.map((c: unknown[]) => c[0] as string)
    // Pin du P2 : parse KO → un warn et zéro ligne.
    expect(warnCalls.filter((n: string) => n === 'pennylane.sub_resource_malformed')).toHaveLength(1)
  })

  it('T3-4 p2 items contenant null → null + warn malformed (pin P3)', async () => {
    const page1Items = Array.from({ length: 20 }, (_, i) => buildLine(i + 1))
    setupRouter(buildInvoice(), [
      () =>
        new Response(
          JSON.stringify({ items: page1Items, has_more: true, next_cursor: 'cur2' }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
      () =>
        new Response(
          JSON.stringify({ items: [buildLine(21), null, buildLine(23)], has_more: false }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
    ])

    const result = await findInvoiceByNumber('F-2026-39939')

    expectNoLinesMaterialized(result)
    const warnCalls = warnSpy.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(warnCalls.filter((n: string) => n === 'pennylane.sub_resource_malformed')).toHaveLength(1)
  })

  it('T3-5 p1 has_more:null + next_cursor valide → p2 fetchée (pin P1 drift) → 32 lignes', async () => {
    const page1Items = Array.from({ length: 20 }, (_, i) => buildLine(i + 1))
    const page2Items = Array.from({ length: 12 }, (_, i) => buildLine(i + 21))

    const { subCalls } = setupRouter(buildInvoice(), [
      () =>
        new Response(
          // has_more: null (ambigu) + next_cursor valide → on suit défensivement.
          JSON.stringify({ items: page1Items, has_more: null, next_cursor: 'cur2' }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
      () =>
        new Response(
          JSON.stringify({ items: page2Items, has_more: false, next_cursor: null }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
    ])

    const result = await findInvoiceByNumber('F-2026-39939')

    expect(result).not.toBeNull()
    expect(Array.isArray(result!.line_items)).toBe(true)
    expect(result!.line_items!.length).toBe(32)
    expect(subCalls.length).toBe(2)
  })

  it('T3-6 p1 has_more:true sans next_cursor → null + warn malformed', async () => {
    const page1Items = Array.from({ length: 20 }, (_, i) => buildLine(i + 1))
    setupRouter(buildInvoice(), [
      () =>
        new Response(JSON.stringify({ items: page1Items, has_more: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ])

    const result = await findInvoiceByNumber('F-2026-39939')

    expectNoLinesMaterialized(result)
    const warnCalls = warnSpy.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(warnCalls.filter((n: string) => n === 'pennylane.sub_resource_malformed')).toHaveLength(1)
  })

  it('T3-7 p1 500 dès la 1ère page → zéro ligne + warn fetch_non_ok', async () => {
    const { subCalls } = setupRouter(buildInvoice(), [
      () => new Response('Internal Server Error', { status: 500 }),
    ])

    const result = await findInvoiceByNumber('F-2026-39939')

    expectNoLinesMaterialized(result)
    expect(subCalls.length).toBe(1)
    const warnCalls = warnSpy.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(warnCalls.filter((n: string) => n === 'pennylane.sub_resource_fetch_non_ok')).toHaveLength(1)
  })

  it('T3-8 succès exactement à la borne : 5 pages, 5e has_more:false → toutes les lignes (off-by-one)', async () => {
    // Pages petites (2 items/page) pour rester lisible. Total = 10 items.
    const subResponses: Array<() => Response> = []
    for (let p = 0; p < MAX_SUB_RESOURCE_PAGES; p += 1) {
      const isLast = p === MAX_SUB_RESOURCE_PAGES - 1
      const items = [buildLine(p * 2 + 1), buildLine(p * 2 + 2)]
      subResponses.push(
        () =>
          new Response(
            JSON.stringify({
              items,
              has_more: !isLast,
              next_cursor: isLast ? null : `cur${p + 2}`,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
      )
    }

    const { subCalls } = setupRouter(buildInvoice(), subResponses)

    const result = await findInvoiceByNumber('F-2026-39939')

    expect(result).not.toBeNull()
    expect(Array.isArray(result!.line_items)).toBe(true)
    expect(result!.line_items!.length).toBe(MAX_SUB_RESOURCE_PAGES * 2)
    expect(subCalls.length).toBe(MAX_SUB_RESOURCE_PAGES)
    // Pas de warn cap : la 5e page termine proprement.
    const warnCalls = warnSpy.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(warnCalls).not.toContain('pennylane.sub_resource_page_cap')
  })

  it('T3-9 abort sur p2 → pas de crash, zéro ligne + warn invoice_lines_fetch_failed', async () => {
    const page1Items = Array.from({ length: 20 }, (_, i) => buildLine(i + 1))
    setupRouter(buildInvoice(), [
      () =>
        new Response(
          JSON.stringify({ items: page1Items, has_more: true, next_cursor: 'cur2' }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
      () => {
        // Simule un AbortError (timeout page 2 / réseau coupé).
        const err = new Error('aborted')
        err.name = 'AbortError'
        throw err
      },
    ])

    const result = await findInvoiceByNumber('F-2026-39939')

    // Pas de crash de findInvoiceByNumber (catch existant).
    expectNoLinesMaterialized(result)
    const warnCalls = warnSpy.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(warnCalls.filter((n: string) => n === 'pennylane.invoice_lines_fetch_failed')).toHaveLength(1)
  })

  it('T3-10 garde-fou somme — partiellement parsable → PAS de warn mismatch (pin P4b)', async () => {
    // 3 lignes : 2 avec montant parsable (50 + 50 = 100), 1 sans montant.
    // P4b exige TOUTES parsables → pas de comparaison du tout, donc pas de
    // warn quels que soient les montants.
    const invoice = buildInvoice()
    invoice.currency_amount = '100.00'
    const lines = [buildLine(1, 50), buildLine(2, 50), buildLine(3)]

    setupRouter(invoice, [
      () =>
        new Response(
          JSON.stringify({ items: lines, has_more: false, next_cursor: null }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
    ])

    const result = await findInvoiceByNumber('F-2026-39939')

    expect(result!.line_items!.length).toBe(3)
    const warnCalls = warnSpy.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(warnCalls).not.toContain('pennylane.invoice_lines_sum_mismatch')
  })

  it('T3-11 garde-fou somme — total 0 + lignes compensées (0.1+0.2-0.3) → PAS de warn (pin P4c)', async () => {
    const invoice = buildInvoice()
    invoice.currency_amount = 0
    const lines = [buildLine(1, 0.1), buildLine(2, 0.2), buildLine(3, -0.3)]

    setupRouter(invoice, [
      () =>
        new Response(
          JSON.stringify({ items: lines, has_more: false, next_cursor: null }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
    ])

    const result = await findInvoiceByNumber('F-2026-39939')

    expect(result!.line_items!.length).toBe(3)
    const warnCalls = warnSpy.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(warnCalls).not.toContain('pennylane.invoice_lines_sum_mismatch')
  })
})

