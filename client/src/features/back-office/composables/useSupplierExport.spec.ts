import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useSupplierExport } from './useSupplierExport'

const originalFetch = globalThis.fetch

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    headers: new Headers(),
    statusText: '',
    redirected: false,
    type: 'basic',
    url: '',
    clone: () => {
      throw new Error('not impl')
    },
  } as unknown as Response
}

describe('useSupplierExport (composable)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('generateExport appelle POST /api/exports/supplier avec payload ISO date', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        data: {
          id: 10,
          supplier_code: 'RUFINO',
          web_url: 'https://onedrive.live.com/file/10',
          file_name: 'RUFINO_2026-01-01_2026-01-31.xlsx',
          line_count: 42,
          total_amount_cents: '123456',
          created_at: '2026-04-24T10:00:00Z',
        },
      })
    )
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const exp = useSupplierExport()
    const result = await exp.generateExport({
      supplier: 'RUFINO',
      period_from: new Date(Date.UTC(2026, 0, 1)),
      period_to: new Date(Date.UTC(2026, 0, 31)),
    })
    expect(result.id).toBe(10)
    expect(exp.loading.value).toBe(false)
    expect(exp.error.value).toBeNull()
    const call = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(call[0]).toBe('/api/exports/supplier')
    const body = JSON.parse(String(call[1].body)) as { period_from: string; period_to: string }
    expect(body.period_from).toBe('2026-01-01')
    expect(body.period_to).toBe('2026-01-31')
  })

  it('generateExport traduit UNKNOWN_SUPPLIER en message FR', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse(400, {
        error: { code: 'VALIDATION_FAILED', details: { code: 'UNKNOWN_SUPPLIER' } },
      })
    )
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const exp = useSupplierExport()
    await expect(
      exp.generateExport({
        supplier: 'FAKE',
        period_from: new Date(),
        period_to: new Date(),
      })
    ).rejects.toThrow()
    expect(exp.error.value).toBe('Fournisseur inconnu.')
  })

  it('fetchHistory propage supplier/limit en query string', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { data: { items: [], next_cursor: null } }))
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const exp = useSupplierExport()
    await exp.fetchHistory({ supplier: 'RUFINO', limit: 5 })
    const call = mockFetch.mock.calls[0] as [string]
    expect(call[0]).toBe('/api/exports/supplier/history?supplier=RUFINO&limit=5')
  })

  it('fetchHistory traduit RATE_LIMITED', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(429, { error: { code: 'RATE_LIMITED' } }))
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const exp = useSupplierExport()
    await expect(exp.fetchHistory({ supplier: 'RUFINO' })).rejects.toThrow()
    expect(exp.error.value).toBe('Trop de tentatives. Attendez 1 minute.')
  })
})
