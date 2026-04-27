import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useSavExport, buildExportQuery, parseFilename } from './useSavExport'
import type { SavListFilters } from './useSavList'

const originalFetch = globalThis.fetch

function defaultFilters(): SavListFilters {
  return {
    status: [],
    q: '',
    from: '',
    to: '',
    invoiceRef: '',
    assignedTo: '',
    tag: '',
    memberId: null,
    groupId: null,
  }
}

function makeResponse(opts: {
  status: number
  contentType?: string
  json?: unknown
  blobBody?: string
  contentDisposition?: string | null
}): Response {
  const headers = new Headers()
  if (opts.contentType) headers.set('content-type', opts.contentType)
  if (opts.contentDisposition) headers.set('content-disposition', opts.contentDisposition)
  return {
    ok: opts.status >= 200 && opts.status < 300,
    status: opts.status,
    headers,
    json: () => Promise.resolve(opts.json ?? {}),
    blob: () =>
      Promise.resolve(
        new Blob([opts.blobBody ?? 'data'], {
          type: opts.contentType ?? 'application/octet-stream',
        })
      ),
    statusText: '',
    redirected: false,
    type: 'basic',
    url: '',
    clone: () => {
      throw new Error('not impl')
    },
  } as unknown as Response
}

describe('useSavExport (Story 5.4 AC #11)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  describe('buildExportQuery', () => {
    it('inclut format + filtres simples', () => {
      const f = defaultFilters()
      f.status = ['validated', 'closed']
      f.q = 'banane'
      f.from = '2026-01-01'
      const qs = buildExportQuery(f, 'csv')
      expect(qs.getAll('status')).toEqual(['validated', 'closed'])
      expect(qs.get('q')).toBe('banane')
      expect(qs.get('from')).toBe('2026-01-01')
      expect(qs.get('format')).toBe('csv')
    })
    it('omet les filtres vides', () => {
      const qs = buildExportQuery(defaultFilters(), 'xlsx')
      expect(qs.has('q')).toBe(false)
      expect(qs.has('from')).toBe(false)
      expect(qs.has('status')).toBe(false)
      expect(qs.get('format')).toBe('xlsx')
    })
    it('encode memberId/groupId numériques', () => {
      const f = defaultFilters()
      f.memberId = 7
      f.groupId = 3
      const qs = buildExportQuery(f, 'csv')
      expect(qs.get('memberId')).toBe('7')
      expect(qs.get('groupId')).toBe('3')
    })
  })

  describe('parseFilename', () => {
    it('extrait depuis Content-Disposition standard', () => {
      expect(parseFilename('attachment; filename="sav-export-2026-04-27-143509.csv"', 'csv')).toBe(
        'sav-export-2026-04-27-143509.csv'
      )
    })
    it('fallback si header absent', () => {
      expect(parseFilename(null, 'csv')).toBe('sav-export.csv')
      expect(parseFilename(null, 'xlsx')).toBe('sav-export.xlsx')
    })
    it('fallback si header malformé', () => {
      expect(parseFilename('attachment', 'xlsx')).toBe('sav-export.xlsx')
    })
  })

  describe('downloadExport', () => {
    it('200 binaire CSV → status="downloaded" + appel fetch sur /api/reports/export-csv', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        makeResponse({
          status: 200,
          contentType: 'text/csv; charset=utf-8',
          contentDisposition: 'attachment; filename="sav-export-2026-04-27-143509.csv"',
          blobBody: 'a;b\r\n1;2',
        })
      )
      globalThis.fetch = mockFetch as unknown as typeof fetch

      const exp = useSavExport()
      const result = await exp.downloadExport({ format: 'csv', filters: defaultFilters() })
      expect(result.status).toBe('downloaded')
      expect(exp.downloading.value).toBe(false)
      const url = String((mockFetch.mock.calls[0] as unknown[])[0])
      expect(url.startsWith('/api/reports/export-csv?')).toBe(true)
      expect(url).toContain('format=csv')
    })

    it('200 JSON warning SWITCH_TO_XLSX → status="switch_suggested" + row_count', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        makeResponse({
          status: 200,
          contentType: 'application/json',
          json: { warning: 'SWITCH_TO_XLSX', row_count: 8342, message: 'too big' },
        })
      ) as unknown as typeof fetch
      const exp = useSavExport()
      const result = await exp.downloadExport({ format: 'csv', filters: defaultFilters() })
      expect(result.status).toBe('switch_suggested')
      expect(result.row_count).toBe(8342)
    })

    it('400 EXPORT_TOO_LARGE → status="error" + message FR', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        makeResponse({
          status: 400,
          contentType: 'application/json',
          json: {
            error: {
              code: 'VALIDATION_FAILED',
              details: { code: 'EXPORT_TOO_LARGE', row_count: 60000 },
            },
          },
        })
      ) as unknown as typeof fetch
      const exp = useSavExport()
      const result = await exp.downloadExport({ format: 'xlsx', filters: defaultFilters() })
      expect(result.status).toBe('error')
      expect(result.message).toContain('volumineux')
      expect(result.row_count).toBe(60000)
      expect(exp.error.value).toContain('volumineux')
    })

    it('400 INVALID_FILTERS → status="error" + message FR', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        makeResponse({
          status: 400,
          contentType: 'application/json',
          json: { error: { code: 'VALIDATION_FAILED', details: { code: 'INVALID_FILTERS' } } },
        })
      ) as unknown as typeof fetch
      const exp = useSavExport()
      const result = await exp.downloadExport({ format: 'csv', filters: defaultFilters() })
      expect(result.status).toBe('error')
      expect(result.message).toContain('Filtres invalides')
    })

    it('500 → status="error" + message générique', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        makeResponse({
          status: 500,
          contentType: 'application/json',
          json: { error: { code: 'SERVER_ERROR', details: { code: 'QUERY_FAILED' } } },
        })
      ) as unknown as typeof fetch
      const exp = useSavExport()
      const result = await exp.downloadExport({ format: 'csv', filters: defaultFilters() })
      expect(result.status).toBe('error')
    })

    it('erreur réseau (rejet fetch) → status="error" + message NETWORK', async () => {
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new TypeError('NetworkError')) as unknown as typeof fetch
      const exp = useSavExport()
      const result = await exp.downloadExport({ format: 'csv', filters: defaultFilters() })
      expect(result.status).toBe('error')
      expect(result.message).toContain('réseau')
    })

    it("downloading=true pendant l'appel, false après", async () => {
      let resolveFetch: (v: Response) => void
      const promise = new Promise<Response>((r) => {
        resolveFetch = r
      })
      globalThis.fetch = vi.fn().mockReturnValue(promise) as unknown as typeof fetch
      const exp = useSavExport()
      const pending = exp.downloadExport({ format: 'csv', filters: defaultFilters() })
      // micro-tick pour que `downloading.value = true` soit observé
      await Promise.resolve()
      expect(exp.downloading.value).toBe(true)
      resolveFetch!(
        makeResponse({
          status: 200,
          contentType: 'text/csv',
          blobBody: 'x',
        })
      )
      await pending
      expect(exp.downloading.value).toBe(false)
    })

    it('appel concurrent : le 2e abort le 1er', async () => {
      const captured: AbortSignal[] = []
      globalThis.fetch = vi.fn().mockImplementation((_url, init: RequestInit) => {
        captured.push(init.signal!)
        // Le 1er appel ne se résout jamais ; le 2e se résout normalement
        if (captured.length === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => {
              const err = new Error('aborted')
              err.name = 'AbortError'
              reject(err)
            })
          })
        }
        return Promise.resolve(
          makeResponse({ status: 200, contentType: 'text/csv', blobBody: 'x' })
        )
      }) as unknown as typeof fetch

      const exp = useSavExport()
      const first = exp.downloadExport({ format: 'csv', filters: defaultFilters() })
      const second = exp.downloadExport({ format: 'csv', filters: defaultFilters() })

      const [r1, r2] = await Promise.all([first, second])
      expect(captured[0]!.aborted).toBe(true)
      expect(r1.status).toBe('error') // aborted
      expect(r2.status).toBe('downloaded')
    })
  })
})
