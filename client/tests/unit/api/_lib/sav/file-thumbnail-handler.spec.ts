/**
 * Story V1.5 — AC #1, #2, #4, #5, #6.a
 * Unit tests for `file-thumbnail-handler.ts` (NEW handler, red-phase scaffold).
 *
 * Test type: UNIT (handler isolated via vi.mock)
 *
 * AC coverage:
 *   AC #1 — Happy path: 200 + image/jpeg + Cache-Control private + stream
 *   AC #2 — RBAC scopée groupe: operator standard cross-group → 403, admin bypass → 200
 *   AC #4 — Graceful degradation: Graph 503/timeout/401+retry → 503 GRAPH_UNAVAILABLE
 *   AC #5 — Security: path traversal 400, token not in response, Cache-Control private,
 *            content-length cap 5MB → 502, DoS timeout 5s
 *   AC #6.a — Integration baseline coverage: ~14 cases
 *
 * Mock strategy:
 *   - supabaseAdmin: vi.mock returning configurable db state via hoisted `db` object
 *   - graph.js (CJS): vi.mock with configurable token + forceRefreshAccessToken
 *   - globalThis.fetch: mocked per test to simulate Graph API responses
 *   - Streaming: MockResponse extended with write() + pipe() + chunks accumulation
 *
 * NOTE: This file is RED-phase. The handler `file-thumbnail-handler.ts` does not
 * exist yet — all tests will fail until the implementation is delivered in Step 2.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { signJwt } from '../../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../../api/_lib/types'

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

/**
 * Mutable DB state for supabaseAdmin mock.
 * null = no row found (→ 404)
 * object = sav_files row joined with sav.group_id
 */
const db = vi.hoisted(() => ({
  fileRow: null as Record<string, unknown> | null,
  operatorGroups: [] as Array<{ group_id: number }>,
}))

function resetDb(): void {
  db.fileRow = null
  db.operatorGroups = []
}

/**
 * Mutable Graph state.
 */
const graphState = vi.hoisted(() => ({
  token: 'test-bearer-token-abc123',
  forceRefreshToken: 'test-refreshed-token-xyz789',
  forceRefreshShouldFail: false,
  getAccessTokenShouldFail: false,
  getAccessTokenError: 'getAccessToken failed',
}))

function resetGraph(): void {
  graphState.token = 'test-bearer-token-abc123'
  graphState.forceRefreshToken = 'test-refreshed-token-xyz789'
  graphState.forceRefreshShouldFail = false
  graphState.getAccessTokenShouldFail = false
  graphState.getAccessTokenError = 'getAccessToken failed'
}

// ---------------------------------------------------------------------------
// vi.mock declarations (hoisted by Vitest)
// ---------------------------------------------------------------------------

vi.mock('../../../../../api/_lib/clients/supabase-admin', () => {
  const client = {
    from: (table: string) => {
      if (table === 'sav_files') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: db.fileRow, error: null }),
            }),
          }),
        }
      }
      if (table === 'operator_groups') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ data: db.operatorGroups, error: null }),
            }),
          }),
        }
      }
      return {}
    },
  }
  return {
    supabaseAdmin: () => client,
    __resetSupabaseAdminForTests: () => undefined,
  }
})

// Mock graph.js (CJS lazy require) — vi.mock hoists this before any import
vi.mock('../../../../../api/_lib/graph.js', () => ({
  getAccessToken: async () => {
    if (graphState.getAccessTokenShouldFail) {
      throw new Error(graphState.getAccessTokenError)
    }
    return graphState.token
  },
  forceRefreshAccessToken: async () => {
    if (graphState.forceRefreshShouldFail) {
      throw new Error('forceRefresh failed')
    }
    graphState.token = graphState.forceRefreshToken
    return graphState.forceRefreshToken
  },
  getGraphClient: () => ({}),
  __resetForTests: () => undefined,
}))

// ---------------------------------------------------------------------------
// Import handler AFTER mocks
// ---------------------------------------------------------------------------

// This import will fail RED until file-thumbnail-handler.ts is created
import { fileThumbnailHandler } from '../../../../../api/_lib/sav/file-thumbnail-handler'

// ---------------------------------------------------------------------------
// Extended MockResponse (with streaming support)
// ---------------------------------------------------------------------------

interface StreamingMockResponse {
  statusCode: number
  headers: Record<string, string | number | string[]>
  chunks: Buffer[]
  ended: boolean
  pipedFrom: unknown
  // ApiResponse interface methods
  status: (code: number) => StreamingMockResponse
  json: (data: unknown) => StreamingMockResponse
  setHeader: (name: string, value: string | number | string[]) => StreamingMockResponse
  appendHeader: (name: string, value: string | readonly string[]) => StreamingMockResponse
  end: (chunk?: string) => void
  getHeader: (name: string) => string | number | string[] | undefined
  // Node stream methods needed by handler
  write: (chunk: Buffer | string) => boolean
  jsonBody: unknown
}

function mockStreamingRes(): StreamingMockResponse {
  const res: StreamingMockResponse = {
    statusCode: 200,
    headers: {},
    chunks: [],
    ended: false,
    pipedFrom: null,
    jsonBody: undefined,
    status(code: number) {
      res.statusCode = code
      return res
    },
    json(data: unknown) {
      res.jsonBody = data
      res.ended = true
      return res
    },
    setHeader(name: string, value: string | number | string[]) {
      res.headers[name.toLowerCase()] = value
      return res
    },
    appendHeader(name: string, value: string | readonly string[]) {
      const key = name.toLowerCase()
      const prev = res.headers[key]
      const next = Array.isArray(value) ? [...value] : [value as string]
      if (prev === undefined) {
        res.headers[key] = next.length === 1 ? (next[0] as string) : next
      } else {
        const prevArr = Array.isArray(prev) ? prev : [String(prev)]
        res.headers[key] = [...prevArr, ...next]
      }
      return res
    },
    end(chunk?: string) {
      if (chunk) res.chunks.push(Buffer.from(chunk))
      res.ended = true
    },
    getHeader(name: string) {
      return res.headers[name.toLowerCase()]
    },
    write(chunk: Buffer | string) {
      res.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      return true
    },
  }
  return res
}

function mockReq(partial: { method?: string; cookie?: string; fileId?: string | number }) {
  const cookieStr = partial.cookie ?? ''
  return {
    method: partial.method ?? 'GET',
    headers: { cookie: cookieStr },
    body: {},
    cookies: {},
    query: {
      op: 'file-thumbnail',
      fileId: partial.fileId !== undefined ? String(partial.fileId) : undefined,
    } as Record<string, string | string[] | undefined>,
  }
}

function operatorCookie(
  opts: {
    role?: SessionUser['role']
    sub?: number
    type?: SessionUser['type']
  } = {}
): string {
  const payload: SessionUser = {
    sub: opts.sub ?? 42,
    type: opts.type ?? 'operator',
    role: opts.role ?? 'sav-operator',
    exp: Math.floor(Date.now() / 1000) + 3600,
  }
  return `sav_session=${signJwt(payload, SECRET)}`
}

function adminCookie(): string {
  return operatorCookie({ role: 'admin', sub: 1 })
}

// ---------------------------------------------------------------------------
// Standard image file row (group 1)
// ---------------------------------------------------------------------------

const IMAGE_FILE_ROW = {
  id: 42,
  onedrive_item_id: 'drive-item-id-abc',
  mime_type: 'image/jpeg',
  sav_id: 100,
  sav: { group_id: 1 },
}

// ---------------------------------------------------------------------------
// Graph fetch mock helpers
// ---------------------------------------------------------------------------

/** Creates a mock fetch that returns a successful image response with given bytes */
function mockFetchImageOk(imageBytes: Buffer = Buffer.from('FAKEJPEG'), contentLength?: number) {
  const headers = new Map<string, string>([
    ['content-type', 'image/jpeg'],
    ['content-length', String(contentLength ?? imageBytes.length)],
  ])

  const encoder = new TextEncoder()
  const bytes = imageBytes
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })

  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => headers.get(name.toLowerCase()) ?? null,
      },
      body: stream,
    } as unknown as Response)
  )
  void encoder
}

/** Mock fetch that returns a specific HTTP status code */
function mockFetchStatus(status: number) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (_name: string) => null,
      },
      body: null,
    } as unknown as Response)
  )
}

/** Mock fetch that rejects with AbortError (simulates timeout) */
function mockFetchAbortError() {
  const err = new Error('The operation was aborted.')
  err.name = 'AbortError'
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err))
}

/**
 * Mock fetch that returns 401 on first call, then succeeds on second call.
 * Used to test token rotation (W35 pattern).
 */
function mockFetchWith401ThenSuccess(imageBytes: Buffer = Buffer.from('REFRESHED')) {
  let callCount = 0
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(imageBytes)
      controller.close()
    },
  })

  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        return {
          ok: false,
          status: 401,
          headers: { get: () => null },
          body: null,
        }
      }
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => (name === 'content-length' ? String(imageBytes.length) : null),
        },
        body: stream,
      }
    })
  )
}

/** Mock fetch that always returns 401 (both initial + after token refresh) */
function mockFetchAlways401() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: { get: () => null },
      body: null,
    } as unknown as Response)
  )
}

// ---------------------------------------------------------------------------
// beforeEach / afterEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubEnv('SESSION_COOKIE_SECRET', SECRET)
  vi.stubEnv('SUPABASE_URL', 'http://localhost')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test')
  vi.stubEnv('MICROSOFT_DRIVE_ID', 'test-drive-id-fruitstock')
  resetDb()
  resetGraph()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fileThumbnailHandler (Story V1.5 — AC #1, #2, #4, #5, #6.a)', () => {
  // ── AC #1: Happy path ─────────────────────────────────────────────────────

  it('TH-01: 200 + Content-Type: image/jpeg + Cache-Control: private, max-age=300 + stream bytes', async () => {
    db.fileRow = IMAGE_FILE_ROW
    db.operatorGroups = [{ group_id: 1 }]
    const imageBytes = Buffer.from('FAKEJPEGBYTES')
    mockFetchImageOk(imageBytes)

    const res = mockStreamingRes()
    const handler = fileThumbnailHandler(42)
    await handler(mockReq({ cookie: operatorCookie(), fileId: 42 }), res as never)

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/jpeg')
    expect(res.headers['cache-control']).toBe('private, max-age=300')
    // Assert bytes streamed — chunks should contain the image data
    const received = Buffer.concat(res.chunks)
    expect(received.toString()).toContain('FAKEJPEG')
  })

  it('TH-02: Cache-Control MUST NOT contain "public" (cache poisoning defense)', async () => {
    db.fileRow = IMAGE_FILE_ROW
    db.operatorGroups = [{ group_id: 1 }]
    mockFetchImageOk()

    const res = mockStreamingRes()
    await fileThumbnailHandler(42)(mockReq({ cookie: operatorCookie(), fileId: 42 }), res as never)

    const cacheControl = String(res.headers['cache-control'] ?? '')
    expect(cacheControl).not.toContain('public')
    expect(cacheControl).toContain('private')
  })

  // ── AC #5: Path traversal / validation ────────────────────────────────────

  it('TH-03: 400 VALIDATION_FAILED — fileId non-numeric (path traversal attempt)', async () => {
    const res = mockStreamingRes()
    // Handler should receive null fileId (parseBigintId returns null for non-numeric)
    // The router passes fileId=null to handler; or the handler validates internally
    // Testing via a wrapper that simulates op=file-thumbnail with bad fileId
    await fileThumbnailHandler(NaN)(
      mockReq({ cookie: operatorCookie(), fileId: '../../etc' }),
      res as never
    )

    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_FAILED')
  })

  it('TH-04: 400 VALIDATION_FAILED — fileId negative integer', async () => {
    const res = mockStreamingRes()
    await fileThumbnailHandler(-1)(mockReq({ cookie: operatorCookie(), fileId: -1 }), res as never)

    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_FAILED')
  })

  it('TH-05: 400 VALIDATION_FAILED — fileId zero (not a positive integer)', async () => {
    const res = mockStreamingRes()
    await fileThumbnailHandler(0)(mockReq({ cookie: operatorCookie(), fileId: 0 }), res as never)

    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_FAILED')
  })

  // ── AC #2: RBAC ───────────────────────────────────────────────────────────

  it('TH-06: 403 FORBIDDEN — operator standard (group A) → file from group B', async () => {
    // File belongs to group 2, operator only in group 1
    db.fileRow = { ...IMAGE_FILE_ROW, sav: { group_id: 2 } }
    db.operatorGroups = [] // operator not in group 2

    const res = mockStreamingRes()
    await fileThumbnailHandler(42)(
      mockReq({ cookie: operatorCookie({ role: 'sav-operator' }), fileId: 42 }),
      res as never
    )

    expect(res.statusCode).toBe(403)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('FORBIDDEN')
    // Anti-metadata leak: no mime_type or group_id in response
    const bodyStr = JSON.stringify(body)
    expect(bodyStr).not.toContain('mime_type')
    expect(bodyStr).not.toContain('group_id')
    expect(bodyStr).not.toContain('onedrive_item_id')
  })

  it('TH-07: 200 — admin role bypasses group scoping (cross-group access OK)', async () => {
    // File belongs to group 2, admin can see it regardless
    db.fileRow = { ...IMAGE_FILE_ROW, sav: { group_id: 2 } }
    // operatorGroups is empty but admin bypass skips the check
    db.operatorGroups = []
    mockFetchImageOk()

    const res = mockStreamingRes()
    await fileThumbnailHandler(42)(mockReq({ cookie: adminCookie(), fileId: 42 }), res as never)

    expect(res.statusCode).toBe(200)
  })

  it('TH-08: 200 — admin role (group-manager with full scope) bypasses group scoping', async () => {
    // Note: SessionUser['role'] in types.ts has 'admin' | 'sav-operator' | 'member' | 'group-manager'
    // The story AC #2 mentions 'sav-operator-admin' but this role doesn't exist in types.ts.
    // The admin bypass check uses role === 'admin' per existing pattern (stories 7-3a/b/c).
    // This test verifies the admin role pattern works for cross-group access.
    db.fileRow = { ...IMAGE_FILE_ROW, sav: { group_id: 99 } }
    db.operatorGroups = []
    mockFetchImageOk()

    const res = mockStreamingRes()
    await fileThumbnailHandler(42)(mockReq({ cookie: adminCookie(), fileId: 42 }), res as never)

    expect(res.statusCode).toBe(200)
  })

  it('TH-09: 200 — operator standard group A + file group A → 200 (same group)', async () => {
    db.fileRow = { ...IMAGE_FILE_ROW, sav: { group_id: 1 } }
    db.operatorGroups = [{ group_id: 1 }]
    mockFetchImageOk()

    const res = mockStreamingRes()
    await fileThumbnailHandler(42)(
      mockReq({ cookie: operatorCookie({ role: 'sav-operator' }), fileId: 42 }),
      res as never
    )

    expect(res.statusCode).toBe(200)
  })

  // ── AC #1/AC #6.a: 404 when file not found ───────────────────────────────

  it('TH-10: 404 NOT_FOUND — fileId does not exist in DB', async () => {
    db.fileRow = null // no row

    const res = mockStreamingRes()
    await fileThumbnailHandler(99999)(
      mockReq({ cookie: operatorCookie(), fileId: 99999 }),
      res as never
    )

    expect(res.statusCode).toBe(404)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })

  // ── AC #1: non-image MIME → 400 NOT_AN_IMAGE ────────────────────────────

  it('TH-11: 400 NOT_AN_IMAGE — mime_type is application/pdf', async () => {
    db.fileRow = { ...IMAGE_FILE_ROW, mime_type: 'application/pdf' }
    db.operatorGroups = [{ group_id: 1 }]

    const res = mockStreamingRes()
    await fileThumbnailHandler(42)(mockReq({ cookie: operatorCookie(), fileId: 42 }), res as never)

    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('NOT_AN_IMAGE')
  })

  it('TH-12: 400 NOT_AN_IMAGE — mime_type is application/vnd.openxmlformats-officedocument.spreadsheetml.sheet (Excel)', async () => {
    db.fileRow = {
      ...IMAGE_FILE_ROW,
      mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }
    db.operatorGroups = [{ group_id: 1 }]

    const res = mockStreamingRes()
    await fileThumbnailHandler(42)(mockReq({ cookie: operatorCookie(), fileId: 42 }), res as never)

    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('NOT_AN_IMAGE')
  })

  // ── AC #4: Graceful degradation ───────────────────────────────────────────

  it('TH-13: 503 GRAPH_UNAVAILABLE — Graph returns 503', async () => {
    db.fileRow = IMAGE_FILE_ROW
    db.operatorGroups = [{ group_id: 1 }]
    mockFetchStatus(503)

    const res = mockStreamingRes()
    await fileThumbnailHandler(42)(mockReq({ cookie: operatorCookie(), fileId: 42 }), res as never)

    expect(res.statusCode).toBe(503)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('GRAPH_UNAVAILABLE')
  })

  it('TH-14: 503 GRAPH_UNAVAILABLE — Graph AbortError (timeout 5s)', async () => {
    db.fileRow = IMAGE_FILE_ROW
    db.operatorGroups = [{ group_id: 1 }]
    mockFetchAbortError()

    const res = mockStreamingRes()
    await fileThumbnailHandler(42)(mockReq({ cookie: operatorCookie(), fileId: 42 }), res as never)

    expect(res.statusCode).toBe(503)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('GRAPH_UNAVAILABLE')
  })

  it('TH-15: 503 GRAPH_UNAVAILABLE — Graph 401 + forceRefreshAccessToken retry → still 401 → 503', async () => {
    db.fileRow = IMAGE_FILE_ROW
    db.operatorGroups = [{ group_id: 1 }]
    // Both initial call AND retry return 401
    mockFetchAlways401()

    const res = mockStreamingRes()
    await fileThumbnailHandler(42)(mockReq({ cookie: operatorCookie(), fileId: 42 }), res as never)

    expect(res.statusCode).toBe(503)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('GRAPH_UNAVAILABLE')
    // forceRefreshAccessToken should have been called (token rotation attempted)
    // This is verified by the mock side-effect: graphState.token is updated if called
    // The test verifies behavior (503) not the internal mock interaction
  })

  it('TH-16: 200 — Graph 401 + forceRefreshAccessToken retry → 200 (token rotation success W35)', async () => {
    db.fileRow = IMAGE_FILE_ROW
    db.operatorGroups = [{ group_id: 1 }]
    const refreshedBytes = Buffer.from('REFRESHED-IMAGE-BYTES')
    mockFetchWith401ThenSuccess(refreshedBytes)

    const res = mockStreamingRes()
    await fileThumbnailHandler(42)(mockReq({ cookie: operatorCookie(), fileId: 42 }), res as never)

    expect(res.statusCode).toBe(200)
    // Token should have been refreshed
    expect(graphState.token).toBe(graphState.forceRefreshToken)
  })

  // ── AC #5: Security — token leak protection ──────────────────────────────

  it('TH-17: Token NOT in response stream — Bearer token never appears in piped bytes', async () => {
    db.fileRow = IMAGE_FILE_ROW
    db.operatorGroups = [{ group_id: 1 }]
    const imageBytes = Buffer.from('PUREJPEGDATA_NO_TOKEN_HERE')
    mockFetchImageOk(imageBytes)

    const res = mockStreamingRes()
    await fileThumbnailHandler(42)(mockReq({ cookie: operatorCookie(), fileId: 42 }), res as never)

    expect(res.statusCode).toBe(200)
    const allBody = Buffer.concat(res.chunks).toString('utf8')
    // Bearer token must NOT appear in response
    expect(allBody).not.toContain('Bearer')
    expect(allBody).not.toContain('test-bearer-token')
    // JWT prefix (eyJ = base64url header of JWT) must not appear
    expect(allBody).not.toContain('eyJ')
    // Response headers must NOT contain Authorization
    expect(res.headers['authorization']).toBeUndefined()
    expect(res.headers['www-authenticate']).toBeUndefined()
  })

  it('TH-18: Header whitelist — Content-Type, Cache-Control, X-Request-Id in response; Graph headers stripped', async () => {
    db.fileRow = IMAGE_FILE_ROW
    db.operatorGroups = [{ group_id: 1 }]
    const SENTINEL_REQUEST_ID = 'test-req-id-sentinel-18'
    mockFetchImageOk()

    const res = mockStreamingRes()
    const req = mockReq({ cookie: operatorCookie(), fileId: 42 })
    // Inject a known X-Request-Id via the request header so the handler echoes it
    ;(req as Record<string, unknown>)['headers'] = {
      ...((req as Record<string, unknown>)['headers'] as Record<string, unknown>),
      'x-request-id': SENTINEL_REQUEST_ID,
    }
    await fileThumbnailHandler(42)(req as never, res as never)

    expect(res.statusCode).toBe(200)
    // AC #1.b.7 whitelist
    expect(res.headers['content-type']).toBeDefined()
    expect(res.headers['cache-control']).toBeDefined()
    // X-Request-Id MUST be present (HARDEN-2)
    expect(res.headers['x-request-id']).toBeDefined()
    expect(res.headers['x-request-id']).toBe(SENTINEL_REQUEST_ID)
    // Forbidden headers (Graph headers must be stripped)
    expect(res.headers['x-ms-request-id']).toBeUndefined()
    expect(res.headers['x-ms-ags-diagnostic']).toBeUndefined()
    expect(res.headers['authorization']).toBeUndefined()
  })

  // ── AC #5: DoS — content-length cap 5 MB ─────────────────────────────────

  it('TH-19: 502 BAD_GATEWAY — Graph response Content-Length exceeds 5 MB cap', async () => {
    db.fileRow = IMAGE_FILE_ROW
    db.operatorGroups = [{ group_id: 1 }]
    const FIVE_MB_PLUS_ONE = 5 * 1024 * 1024 + 1
    mockFetchImageOk(Buffer.from('tiny'), FIVE_MB_PLUS_ONE)

    const res = mockStreamingRes()
    await fileThumbnailHandler(42)(mockReq({ cookie: operatorCookie(), fileId: 42 }), res as never)

    expect(res.statusCode).toBe(502)
    // No image bytes should have been streamed
    expect(Buffer.concat(res.chunks).length).toBe(0)
  })

  // ── AC #4: logging on graph unavailable ──────────────────────────────────

  it('TH-20: logger.warn emitted on GRAPH_UNAVAILABLE with fileId and status', async () => {
    db.fileRow = IMAGE_FILE_ROW
    db.operatorGroups = [{ group_id: 1 }]
    mockFetchStatus(503)

    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const res = mockStreamingRes()
    await fileThumbnailHandler(42)(mockReq({ cookie: operatorCookie(), fileId: 42 }), res as never)

    // logger.warn calls console.error internally (see logger.ts)
    const warnCall = warnSpy.mock.calls.find((call) => {
      const msg = typeof call[0] === 'string' ? call[0] : JSON.stringify(call[0])
      return msg.includes('thumbnail') || msg.includes('graph_unavailable') || msg.includes('GRAPH')
    })
    expect(warnCall).toBeDefined()
    warnSpy.mockRestore()
  })

  // ── AC #6.a: DN-5 — Content-Type forced to image/jpeg regardless of Graph response ──

  it('TH-21: Content-Type always image/jpeg even if Graph returns image/png (DN-5=A)', async () => {
    db.fileRow = IMAGE_FILE_ROW
    db.operatorGroups = [{ group_id: 1 }]

    // Graph returns image/png
    const pngBytes = Buffer.from('\x89PNG\r\n\x1a\n')
    const headers = new Map([
      ['content-type', 'image/png'],
      ['content-length', String(pngBytes.length)],
    ])
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(pngBytes)
        controller.close()
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
        body: stream,
      } as unknown as Response)
    )

    const res = mockStreamingRes()
    await fileThumbnailHandler(42)(mockReq({ cookie: operatorCookie(), fileId: 42 }), res as never)

    expect(res.statusCode).toBe(200)
    // Must be forced to image/jpeg regardless
    expect(res.headers['content-type']).toBe('image/jpeg')
  })

  // ── AC #2: warn log on cross-group attempt (DN-2=B, warn-only) ────────────

  it('TH-22: warn log emitted on cross-group 403 (DN-2=B warn-only, no audit_trail row)', async () => {
    db.fileRow = { ...IMAGE_FILE_ROW, sav: { group_id: 2 } }
    db.operatorGroups = [] // operator not in group 2 (operator sub=42, group_id=2)

    // HARDEN-4: spy on console.error (logger.warn writes there) and assert the
    // structured log record contains the correct msg + all required fields.
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const res = mockStreamingRes()
    await fileThumbnailHandler(42)(
      mockReq({ cookie: operatorCookie({ role: 'sav-operator', sub: 42 }), fileId: 42 }),
      res as never
    )

    expect(res.statusCode).toBe(403)

    // DN-2=B: logger.warn → console.error with structured JSON record
    // Assert the warn log was called with the correct message and fields.
    const warnCall = warnSpy.mock.calls.find((call) => {
      try {
        const record = JSON.parse(String(call[0]))
        return record.msg === 'sav.file.thumbnail.cross_group_blocked'
      } catch {
        return false
      }
    })
    expect(warnCall).toBeDefined()
    // Parse the record and assert all required fields are present
    const record = JSON.parse(String(warnCall![0]))
    expect(record.msg).toBe('sav.file.thumbnail.cross_group_blocked')
    expect(record.fileId).toBe(42)
    expect(record.operatorId).toBe(42) // user.sub
    expect(record.groupId).toBe(2)
    expect(record.requestId).toBeDefined()

    warnSpy.mockRestore()
  })

  // ── HARDEN-1: Runtime size cap — chunked transfer (no Content-Length) ────

  it('TH-23: runtime byte counter truncates and logs when chunked body exceeds 5 MB (no Content-Length header)', async () => {
    db.fileRow = IMAGE_FILE_ROW
    db.operatorGroups = [{ group_id: 1 }]

    // Simulate chunked response: 3 chunks of 2 MB each → total 6 MB > 5 MB cap.
    // No Content-Length header so the upfront check is skipped.
    const MB2 = new Uint8Array(2 * 1024 * 1024).fill(0xff) // 2 MB chunk
    const chunks = [MB2, MB2, MB2]
    let chunkIndex = 0

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunkIndex < chunks.length) {
          const chunk = chunks[chunkIndex++]
          if (chunk !== undefined) controller.enqueue(chunk)
        } else {
          controller.close()
        }
      },
    })

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: {
          // No Content-Length — forces runtime counter path
          get: (_name: string) => null,
        },
        body: stream,
      } as unknown as Response)
    )

    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const res = mockStreamingRes()
    await fileThumbnailHandler(42)(mockReq({ cookie: operatorCookie(), fileId: 42 }), res as never)

    // Handler must have ended the response (truncated, not 502 since headers already flushed)
    expect(res.ended).toBe(true)

    // Total bytes written must be < 6 MB (handler aborted before writing chunk 3)
    const totalWritten = res.chunks.reduce((sum, c) => sum + c.length, 0)
    expect(totalWritten).toBeLessThan(6 * 1024 * 1024)
    // Specifically: chunks 1 (2 MB) + chunk 2 (2 MB) written, chunk 3 triggers abort
    // So exactly 4 MB written (2+2), chunk 3 would push to 6 MB > 5 MB → abort before writing
    expect(totalWritten).toBe(4 * 1024 * 1024)

    // Must log sav.file.thumbnail.runtime_size_exceeded
    const sizeExceededCall = warnSpy.mock.calls.find((call) => {
      try {
        const record = JSON.parse(String(call[0]))
        return record.msg === 'sav.file.thumbnail.runtime_size_exceeded'
      } catch {
        return false
      }
    })
    expect(sizeExceededCall).toBeDefined()
    const logRecord = JSON.parse(String(sizeExceededCall![0]))
    expect(logRecord.fileId).toBe(42)
    expect(logRecord.bytesWritten).toBeGreaterThan(5 * 1024 * 1024)

    warnSpy.mockRestore()
  })

  // ── HARDEN-3: Token sanitizer — no Bearer token in error logs ─────────────

  it('TH-24: getAccessToken rejection with Bearer token in message → logger.error must NOT log raw token', async () => {
    db.fileRow = IMAGE_FILE_ROW
    db.operatorGroups = [{ group_id: 1 }]

    // Configure graph mock to throw with an error message containing Bearer token + JWT
    graphState.getAccessTokenShouldFail = true
    graphState.getAccessTokenError = 'Auth failed: Bearer eyJabc.def.ghi expired'

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const res = mockStreamingRes()
    await fileThumbnailHandler(42)(mockReq({ cookie: operatorCookie(), fileId: 42 }), res as never)

    // Should have returned 503 (token error → GRAPH_UNAVAILABLE)
    expect(res.statusCode).toBe(503)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('GRAPH_UNAVAILABLE')

    // Find the token_error log call
    const tokenErrorCall = errorSpy.mock.calls.find((call) => {
      try {
        const record = JSON.parse(String(call[0]))
        return record.msg === 'sav.file.thumbnail.token_error'
      } catch {
        return false
      }
    })
    expect(tokenErrorCall).toBeDefined()

    // The logged message must NOT contain the raw token value or JWT fragment
    const loggedStr = String(tokenErrorCall![0])
    expect(loggedStr).not.toContain('eyJabc.def.ghi')
    expect(loggedStr).not.toContain('Bearer eyJabc')
    // Must contain the sanitized placeholders instead
    expect(loggedStr).toContain('[REDACTED]')

    errorSpy.mockRestore()
  })
})
