import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { effectScope } from 'vue'
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
    expect(exp.generating.value).toBe(false)
    expect(exp.generateError.value).toBeNull()
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
    expect(exp.generateError.value).toBe('Fournisseur inconnu.')
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
    expect(exp.historyError.value).toBe('Trop de tentatives. Attendez 1 minute.')
  })

  // W42 (CR Story 5.2) — refs séparées : un appel concurrent ne réinitialise
  // pas l'UI de l'autre.
  it('W42 generating et fetchingHistory sont indépendants', async () => {
    let resolveGen: (v: Response) => void = () => undefined
    const pendingGen = new Promise<Response>((r) => (resolveGen = r))
    globalThis.fetch = vi.fn(((url: string) => {
      if (String(url).startsWith('/api/exports/supplier/history')) {
        return Promise.resolve(jsonResponse(200, { data: { items: [], next_cursor: null } }))
      }
      return pendingGen
    }) as unknown as typeof fetch)

    const exp = useSupplierExport()
    const genPromise = exp.generateExport({
      supplier: 'RUFINO',
      period_from: new Date(Date.UTC(2026, 0, 1)),
      period_to: new Date(Date.UTC(2026, 0, 31)),
    })
    expect(exp.generating.value).toBe(true)
    expect(exp.fetchingHistory.value).toBe(false)
    // Un fetchHistory en parallèle ne touche pas generating ni generateError.
    await exp.fetchHistory({ supplier: 'RUFINO' })
    expect(exp.generating.value).toBe(true)
    resolveGen(
      jsonResponse(201, {
        data: {
          id: 1,
          supplier_code: 'RUFINO',
          web_url: 'x',
          file_name: 'f',
          line_count: 1,
          total_amount_cents: '1',
          created_at: '2026-04-25T00:00:00Z',
        },
      })
    )
    await genPromise
    expect(exp.generating.value).toBe(false)
  })

  // W49 (CR Story 5.2) — 5xx → GATEWAY (504 Vercel renvoie HTML, body
  // vide après res.json().catch).
  it('W49 fetchHistory 504 → GATEWAY message FR', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(504, {}))
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const exp = useSupplierExport()
    await expect(exp.fetchHistory({ supplier: 'RUFINO' })).rejects.toThrow()
    expect(exp.historyError.value).toBe('Service indisponible, réessayez dans quelques instants.')
  })

  it('W49 generateExport 502 → GATEWAY message FR', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(502, {}))
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const exp = useSupplierExport()
    await expect(
      exp.generateExport({
        supplier: 'RUFINO',
        period_from: new Date(Date.UTC(2026, 0, 1)),
        period_to: new Date(Date.UTC(2026, 0, 31)),
      })
    ).rejects.toThrow()
    expect(exp.generateError.value).toBe('Service indisponible, réessayez dans quelques instants.')
  })

  // W46 (CR Story 5.2) — un nouvel appel annule le fetch précédent du même
  // type via AbortController.
  it('W46 second fetchHistory annule le premier (signal abort)', async () => {
    const fetches: AbortSignal[] = []
    globalThis.fetch = vi.fn(((url: string, init?: RequestInit) => {
      const sig = init?.signal as AbortSignal
      fetches.push(sig)
      // Le mock écoute le signal pour rejeter quand le composable abort.
      return new Promise<Response>((resolve, reject) => {
        sig.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
        // Le 2e fetch ne sera jamais aborté ici → on le résout pour clore.
        setTimeout(() => resolve(jsonResponse(200, { data: { items: [], next_cursor: null } })), 0)
      })
    }) as unknown as typeof fetch)

    const exp = useSupplierExport()
    const first = exp.fetchHistory({ supplier: 'RUFINO' })
    const second = exp.fetchHistory({ supplier: 'MARTINEZ' })
    await expect(first).rejects.toThrow(/aborted/)
    await second
    expect(fetches[0]!.aborted).toBe(true)
    expect(fetches[1]!.aborted).toBe(false)
  })

  it('W46 onScopeDispose abort tous les fetch en cours', async () => {
    const signals: AbortSignal[] = []
    globalThis.fetch = vi.fn(((url: string, init?: RequestInit) => {
      const sig = init?.signal as AbortSignal
      signals.push(sig)
      return new Promise<Response>((_, reject) => {
        sig.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    }) as unknown as typeof fetch)

    const scope = effectScope()
    let exp: ReturnType<typeof useSupplierExport>
    scope.run(() => {
      exp = useSupplierExport()
    })
    const f1 = exp!.fetchHistory({ supplier: 'RUFINO' })
    const f2 = exp!.generateExport({
      supplier: 'RUFINO',
      period_from: new Date(Date.UTC(2026, 0, 1)),
      period_to: new Date(Date.UTC(2026, 0, 31)),
    })
    // Catch sur les promesses pour éviter l'unhandled rejection après abort.
    f1.catch(() => undefined)
    f2.catch(() => undefined)
    scope.stop()
    expect(signals.length).toBe(2)
    expect(signals[0]!.aborted).toBe(true)
    expect(signals[1]!.aborted).toBe(true)
  })
})
