import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useOneDriveUpload } from '@features/self-service/composables/useOneDriveUpload'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeFile(name: string, sizeBytes: number): File {
  const bytes = new Uint8Array(sizeBytes)
  return new File([bytes], name, { type: 'image/jpeg' })
}

describe('useOneDriveUpload', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('upload nominal : session → N chunks 4 MiB → complete', async () => {
    const CHUNK = 4 * 1024 * 1024
    const FILE_SIZE = CHUNK * 2 + 1000 // 2 chunks + reste
    const calls: Array<{ url: string; method: string; range?: string }> = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      const range = (init?.headers as Record<string, string> | undefined)?.['Content-Range']
      if (range !== undefined) calls.push({ url, method, range })
      else calls.push({ url, method })

      if (url.endsWith('/upload-session') && method === 'POST') {
        return jsonResponse(200, {
          data: {
            uploadUrl: 'https://graph/upload-xxx',
            sanitizedFilename: 'photo.jpg',
            storagePath: 'SAV_Images/drafts/42/t/photo.jpg',
          },
        })
      }
      if (url === 'https://graph/upload-xxx' && method === 'PUT') {
        // Derniers octets = status 201 + body final ; sinon 202 "accepted".
        const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(range ?? '')
        const end = m ? Number(m[2]) + 1 : 0
        const total = m ? Number(m[3]) : 0
        if (end >= total) {
          return jsonResponse(201, { id: 'gfx-item-999', webUrl: 'https://example.com/999' })
        }
        return jsonResponse(202, {})
      }
      if (url.endsWith('/upload-complete') && method === 'POST') {
        return jsonResponse(200, {
          data: { savFileId: 42, createdAt: '2026-04-21T10:00:00Z' },
        })
      }
      return new Response(null, { status: 500 })
    })

    const { uploadFile, uploads } = useOneDriveUpload({
      savReference: 'SAV-2026-00001',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const file = makeFile('photo.jpg', FILE_SIZE)
    const promise = uploadFile(file)
    await vi.runAllTimersAsync()
    const state = await promise

    expect(state.status).toBe('done')
    expect(state.percent).toBe(100)
    expect(state.result?.savFileId).toBe(42)
    expect(state.result?.webUrl).toBe('https://example.com/999')
    expect(uploads.value).toHaveLength(1)
    // 1 POST session + 3 PUT chunks + 1 POST complete = 5 calls
    expect(calls).toHaveLength(5)
    expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/self-service/upload-session' })
    expect(calls[1]?.range).toMatch(/^bytes 0-4194303\/8389608$/)
    expect(calls[4]).toMatchObject({ method: 'POST', url: '/api/self-service/upload-complete' })
  })

  it('retry 2 fois sur 503 avant succès final', async () => {
    const chunkResponses = [
      new Response(null, { status: 503 }), // tentative 1 KO
      new Response(null, { status: 503 }), // tentative 2 KO
      jsonResponse(201, { id: 'ok-item', webUrl: 'https://example.com/ok' }), // tentative 3 OK
    ]
    let chunkIdx = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/upload-session')) {
        return jsonResponse(200, {
          data: { uploadUrl: 'https://graph/xxx', sanitizedFilename: 'p.jpg', storagePath: 'x' },
        })
      }
      if (init?.method === 'PUT') {
        return chunkResponses[chunkIdx++] ?? new Response(null, { status: 500 })
      }
      if (url.endsWith('/upload-complete')) {
        return jsonResponse(200, {
          data: { draftAttachmentId: 'aaa', createdAt: '2026-04-21T10:00:00Z' },
        })
      }
      return new Response(null, { status: 500 })
    })

    const { uploadFile } = useOneDriveUpload({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      draftAttachmentIdFor: () => 'aaa',
    })
    const file = makeFile('p.jpg', 1000)
    const promise = uploadFile(file)
    await vi.runAllTimersAsync()
    const state = await promise

    expect(state.status).toBe('done')
    expect(chunkIdx).toBe(3) // 2 retries + 1 succès
  })

  it('400 sur complete → état error', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/upload-session')) {
        return jsonResponse(200, {
          data: { uploadUrl: 'https://graph/xxx', sanitizedFilename: 'p.jpg', storagePath: 'x' },
        })
      }
      if (init?.method === 'PUT') {
        return jsonResponse(201, { id: 'gfx', webUrl: 'https://example.com/x' })
      }
      if (url.endsWith('/upload-complete')) {
        return new Response(null, { status: 400 })
      }
      return new Response(null, { status: 500 })
    })

    const { uploadFile } = useOneDriveUpload({
      savReference: 'SAV-2026-00001',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const promise = uploadFile(makeFile('p.jpg', 1000))
    await vi.runAllTimersAsync()
    const state = await promise
    expect(state.status).toBe('error')
    expect(state.error).toMatch(/complete 400/)
  })
})
