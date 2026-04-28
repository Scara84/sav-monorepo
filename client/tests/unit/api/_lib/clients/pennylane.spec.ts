import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  findInvoiceByNumber,
  encodePennylaneFilter,
  PennylaneUnauthorizedError,
  PennylaneUpstreamError,
  PennylaneTimeoutError,
  type PennylaneInvoice,
} from '../../../../../api/_lib/clients/pennylane'

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

describe('PL-01 happy path : invoice trouvée → data[0]', () => {
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
        new Response(JSON.stringify({ data: [invoice] }), {
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
    expect(url).toContain('filter=invoice_number%3Aeq%3AF-2025-37039')
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

describe('PL-03 data: [] → null', () => {
  it('résultat vide retourne null (pas throw)', async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ data: [] }), {
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
  it('encode field:op:value avec %3A pour les colons', () => {
    expect(encodePennylaneFilter('invoice_number', 'eq', 'F-2025-37039')).toBe(
      'invoice_number%3Aeq%3AF-2025-37039'
    )
  })
})
