import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockReq, mockRes } from '../_lib/test-helpers'

/**
 * Story 5.7 AC #11.1 — `GET /api/invoices/lookup` (op=lookup).
 * Mocks : pennylane client, supabase rate-limit RPC.
 */

const mocks = vi.hoisted(() => ({
  rateLimitAllowed: true as boolean,
  retryAfter: 30,
  pennylaneImpl: null as
    | (() => Promise<{
        invoice_number: string
        customer: { id: number | string; emails: string[] }
        [k: string]: unknown
      } | null>)
    | null,
}))

vi.mock('../../../../api/_lib/clients/supabase-admin', () => ({
  supabaseAdmin: () => ({
    rpc: (fn: string) => {
      if (fn === 'increment_rate_limit') {
        return Promise.resolve({
          data: [{ allowed: mocks.rateLimitAllowed, retry_after: mocks.retryAfter }],
          error: null,
        })
      }
      return Promise.resolve({ data: null, error: null })
    },
  }),
  __resetSupabaseAdminForTests: () => undefined,
}))

vi.mock('../../../../api/_lib/clients/pennylane', async () => {
  const actual = await vi.importActual<typeof import('../../../../api/_lib/clients/pennylane')>(
    '../../../../api/_lib/clients/pennylane'
  )
  return {
    ...actual,
    findInvoiceByNumber: async (n: string) => {
      if (mocks.pennylaneImpl) return mocks.pennylaneImpl()
      return null
    },
  }
})

import handler from '../../../../api/invoices'
import {
  PennylaneTimeoutError,
  PennylaneUnauthorizedError,
  PennylaneUpstreamError,
} from '../../../../api/_lib/clients/pennylane'

beforeEach(() => {
  mocks.rateLimitAllowed = true
  mocks.retryAfter = 30
  mocks.pennylaneImpl = null
  vi.stubEnv('PENNYLANE_API_KEY', 'test-key')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

function getReq(query: Record<string, string>): ReturnType<typeof mockReq> {
  return mockReq({
    method: 'GET',
    query,
    headers: { 'x-forwarded-for': '203.0.113.1' },
    ip: '203.0.113.1',
  })
}

describe('IL-01 happy path', () => {
  it('200 + { invoice } si Pennylane retourne invoice avec email matching', async () => {
    mocks.pennylaneImpl = async () => ({
      invoice_number: 'F-2025-37039',
      special_mention: '709_25S39_68_20',
      customer: { id: 1833, emails: ['user@example.com'], name: 'User' },
    })
    const res = mockRes()
    await handler(
      getReq({
        op: 'lookup',
        invoiceNumber: 'F-2025-37039',
        email: 'USER@example.com', // case-insensitive
      }),
      res
    )
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { invoice: { invoice_number: string } }
    expect(body.invoice.invoice_number).toBe('F-2025-37039')
    expect(res.headers['cache-control']).toBe('no-store')
  })
})

describe('IL-02 email mismatch → 400', () => {
  it('400 EMAIL_MISMATCH si email pas dans customer.emails', async () => {
    mocks.pennylaneImpl = async () => ({
      invoice_number: 'F-2025-37039',
      customer: { id: 1, emails: ['someone-else@example.com'] },
    })
    const res = mockRes()
    await handler(
      getReq({ op: 'lookup', invoiceNumber: 'F-2025-37039', email: 'user@example.com' }),
      res
    )
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_FAILED')
  })
})

describe('IL-03 format invoiceNumber invalide → 400', () => {
  it('regex F-YYYY-NNNNN refuse hashid legacy 10 chars', async () => {
    const res = mockRes()
    await handler(
      getReq({ op: 'lookup', invoiceNumber: 'ZF4SLLB1CU', email: 'user@example.com' }),
      res
    )
    expect(res.statusCode).toBe(400)
  })

  it('refuse format incomplet F-25-X', async () => {
    const res = mockRes()
    await handler(getReq({ op: 'lookup', invoiceNumber: 'F-25-X', email: 'user@example.com' }), res)
    expect(res.statusCode).toBe(400)
  })
})

describe('IL-04 invoice_not_found → 404', () => {
  it('Pennylane retourne null → 404', async () => {
    mocks.pennylaneImpl = async () => null
    const res = mockRes()
    await handler(
      getReq({ op: 'lookup', invoiceNumber: 'F-2099-99999', email: 'user@example.com' }),
      res
    )
    expect(res.statusCode).toBe(404)
  })
})

describe('IL-05 Pennylane 5xx → 503 (DEPENDENCY_DOWN) avec Retry-After', () => {
  it('upstream error → 503', async () => {
    mocks.pennylaneImpl = async () => {
      throw new PennylaneUpstreamError(500, 'boom')
    }
    const res = mockRes()
    await handler(
      getReq({ op: 'lookup', invoiceNumber: 'F-2025-37039', email: 'user@example.com' }),
      res
    )
    expect(res.statusCode).toBe(503)
    expect(res.headers['retry-after']).toBe('30')
  })
})

describe('IL-06 Pennylane timeout → 503 (DEPENDENCY_DOWN)', () => {
  it('timeout error → 503', async () => {
    mocks.pennylaneImpl = async () => {
      throw new PennylaneTimeoutError()
    }
    const res = mockRes()
    await handler(
      getReq({ op: 'lookup', invoiceNumber: 'F-2025-37039', email: 'user@example.com' }),
      res
    )
    expect(res.statusCode).toBe(503)
  })
})

describe('IL-07 Pennylane 401 → 503 + log error fail-fast', () => {
  it('clé API invalide → 503 (caché derrière dependency-down côté client)', async () => {
    mocks.pennylaneImpl = async () => {
      throw new PennylaneUnauthorizedError()
    }
    const res = mockRes()
    await handler(
      getReq({ op: 'lookup', invoiceNumber: 'F-2025-37039', email: 'user@example.com' }),
      res
    )
    expect(res.statusCode).toBe(503)
  })
})

describe('IL-08 rate limit → 429', () => {
  it('rateLimitAllowed=false → 429 + Retry-After', async () => {
    mocks.rateLimitAllowed = false
    mocks.retryAfter = 45
    const res = mockRes()
    await handler(
      getReq({ op: 'lookup', invoiceNumber: 'F-2025-37039', email: 'user@example.com' }),
      res
    )
    expect(res.statusCode).toBe(429)
    expect(String(res.headers['retry-after'])).toBe('45')
  })
})

describe('IL-09 méthode non GET → 405', () => {
  it('POST refusé', async () => {
    mocks.pennylaneImpl = async () => null
    const res = mockRes()
    const req = mockReq({
      method: 'POST',
      query: { op: 'lookup' },
      headers: { 'x-forwarded-for': '203.0.113.1' },
      ip: '203.0.113.1',
    })
    await handler(req, res)
    expect(res.statusCode).toBe(405)
  })
})

describe('IL-10 op manquant → 404', () => {
  it('sans op=lookup → 404 (pas de route)', async () => {
    const res = mockRes()
    const req = mockReq({
      method: 'GET',
      query: {},
      headers: { 'x-forwarded-for': '203.0.113.1' },
      ip: '203.0.113.1',
    })
    await handler(req, res)
    expect(res.statusCode).toBe(404)
  })
})
