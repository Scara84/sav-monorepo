import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useOneDriveUpload } from '@features/self-service/composables/useOneDriveUpload'

/**
 * Story 3.7b — PATTERN-B — useOneDriveUpload savId mode (NEW) + non-regression
 *
 * NR-01: savId + savReference simultanément → erreur explicite (XOR guard)
 * NR-02: savId mode — upload-session body contient { savId } (pas savReference)
 * NR-03: savId mode — uploadSessionId retourné par session passé dans complete body
 * NR-04: savReference mode (Story 2.4) non-regression — existing behavior intact
 *
 * NON-REGRESSION GUARANTEE:
 * - useOneDriveUpload.spec.ts (Story 2.4) must remain green (3 tests)
 * - These tests add the savId mode without breaking backward compat
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeFile(name: string, sizeBytes: number, type = 'image/jpeg'): File {
  const bytes = new Uint8Array(sizeBytes)
  return new File([bytes], name, { type })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useOneDriveUpload — savId mode (Story 3.7b PATTERN-B)', () => {
  it('NR-01: savId + savReference simultanément → erreur explicite XOR guard', () => {
    expect(() => {
      useOneDriveUpload({
        savId: 1,
        savReference: 'SAV-2026-00001',
        sessionEndpoint: '/api/admin/sav-files/upload-session',
        completeEndpoint: '/api/admin/sav-files/upload-complete',
      } as Parameters<typeof useOneDriveUpload>[0])
    }).toThrow()
    // Error message should mention XOR / mutual exclusion
  })

  it('NR-01b: savId + draftAttachmentIdFor simultanément → erreur explicite XOR guard', () => {
    expect(() => {
      useOneDriveUpload({
        savId: 1,
        draftAttachmentIdFor: () => 'aaa',
        sessionEndpoint: '/api/admin/sav-files/upload-session',
        completeEndpoint: '/api/admin/sav-files/upload-complete',
      } as Parameters<typeof useOneDriveUpload>[0])
    }).toThrow()
  })

  it('NR-02: savId mode — upload-session body contient { savId } pas { savReference }', async () => {
    const capturedSessionBody: Record<string, unknown>[] = []
    const UPLOAD_SESSION_ID = 'test-session-uuid-42'

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/upload-session') && init?.method === 'POST') {
        const body = JSON.parse((init.body as string) ?? '{}') as Record<string, unknown>
        capturedSessionBody.push(body)
        return jsonResponse(200, {
          data: {
            uploadUrl: 'https://graph/upload-xxx',
            sanitizedFilename: 'photo.jpg',
            storagePath: 'SAV_Images/SAV-2026-00001/operator-adds/photo.jpg',
            uploadSessionId: UPLOAD_SESSION_ID,
          },
        })
      }
      if (url === 'https://graph/upload-xxx' && init?.method === 'PUT') {
        return jsonResponse(201, { id: 'gfx-item-999', webUrl: 'https://example.com/999' })
      }
      if (url.endsWith('/upload-complete') && init?.method === 'POST') {
        return jsonResponse(201, {
          data: { savFileId: 42, createdAt: '2026-05-06T10:00:00Z', source: 'operator-add' },
        })
      }
      return new Response(null, { status: 500 })
    })

    const { uploadFile } = useOneDriveUpload({
      savId: 1,
      sessionEndpoint: '/api/admin/sav-files/upload-session',
      completeEndpoint: '/api/admin/sav-files/upload-complete',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const file = makeFile('photo.jpg', 1000)
    const promise = uploadFile(file)
    await vi.runAllTimersAsync()
    await promise

    expect(capturedSessionBody).toHaveLength(1)
    // Body must contain savId
    expect(capturedSessionBody[0]?.['savId']).toBe(1)
    // Body must NOT contain savReference (savId mode)
    expect(capturedSessionBody[0]?.['savReference']).toBeUndefined()
  })

  it('NR-03: savId mode — uploadSessionId passé dans body upload-complete', async () => {
    const UPLOAD_SESSION_ID = 'sess-test-pass-through-uuid'
    const capturedCompleteBody: Record<string, unknown>[] = []

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/upload-session') && init?.method === 'POST') {
        return jsonResponse(200, {
          data: {
            uploadUrl: 'https://graph/upload-yyy',
            sanitizedFilename: 'doc.pdf',
            storagePath: 'SAV_Images/SAV-2026-00001/operator-adds/doc.pdf',
            uploadSessionId: UPLOAD_SESSION_ID,
          },
        })
      }
      if (url === 'https://graph/upload-yyy' && init?.method === 'PUT') {
        return jsonResponse(201, { id: 'gfx-item-pdf', webUrl: 'https://example.com/doc.pdf' })
      }
      if (url.endsWith('/upload-complete') && init?.method === 'POST') {
        const body = JSON.parse((init.body as string) ?? '{}') as Record<string, unknown>
        capturedCompleteBody.push(body)
        return jsonResponse(201, {
          data: { savFileId: 43, createdAt: '2026-05-06T10:00:00Z', source: 'operator-add' },
        })
      }
      return new Response(null, { status: 500 })
    })

    const { uploadFile } = useOneDriveUpload({
      savId: 1,
      sessionEndpoint: '/api/admin/sav-files/upload-session',
      completeEndpoint: '/api/admin/sav-files/upload-complete',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const file = makeFile('doc.pdf', 500, 'application/pdf')
    const promise = uploadFile(file)
    await vi.runAllTimersAsync()
    await promise

    expect(capturedCompleteBody).toHaveLength(1)
    // uploadSessionId must be passed through from session response to complete body
    expect(capturedCompleteBody[0]?.['uploadSessionId']).toBe(UPLOAD_SESSION_ID)
    expect(capturedCompleteBody[0]?.['savId']).toBe(1)
  })

  it('NR-04: savReference mode non-regression — body contient savReference (pas savId)', async () => {
    const capturedSessionBody: Record<string, unknown>[] = []
    const capturedCompleteBody: Record<string, unknown>[] = []

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/upload-session') && init?.method === 'POST') {
        const body = JSON.parse((init.body as string) ?? '{}') as Record<string, unknown>
        capturedSessionBody.push(body)
        return jsonResponse(200, {
          data: {
            uploadUrl: 'https://graph/upload-ref',
            sanitizedFilename: 'photo.jpg',
            storagePath: 'SAV_Images/SAV-2026-00001/photo.jpg',
            // No uploadSessionId in self-service mode — backward compat
          },
        })
      }
      if (url === 'https://graph/upload-ref' && init?.method === 'PUT') {
        return jsonResponse(201, {
          id: 'gfx-item-ref',
          webUrl: 'https://example.com/ref.jpg',
        })
      }
      if (url.endsWith('/upload-complete') && init?.method === 'POST') {
        const body = JSON.parse((init.body as string) ?? '{}') as Record<string, unknown>
        capturedCompleteBody.push(body)
        return jsonResponse(200, {
          data: { savFileId: 44, createdAt: '2026-05-06T10:00:00Z' },
        })
      }
      return new Response(null, { status: 500 })
    })

    const { uploadFile } = useOneDriveUpload({
      savReference: 'SAV-2026-00001',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const file = makeFile('photo.jpg', 1000)
    const promise = uploadFile(file)
    await vi.runAllTimersAsync()
    const state = await promise

    expect(state.status).toBe('done')
    // Session body must contain savReference
    expect(capturedSessionBody[0]?.['savReference']).toBe('SAV-2026-00001')
    expect(capturedSessionBody[0]?.['savId']).toBeUndefined()
    // Complete body must NOT contain uploadSessionId (self-service mode — backward compat)
    expect(capturedCompleteBody[0]?.['uploadSessionId']).toBeUndefined()
    expect(capturedCompleteBody[0]?.['savReference']).toBe('SAV-2026-00001')
  })
})
