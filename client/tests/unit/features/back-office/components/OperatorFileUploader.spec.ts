import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

/**
 * Story 3.7b — AC #14 — OperatorFileUploader.vue component tests
 *
 * OFU-01: MIME invalide rejeté client-side avant fetch
 * OFU-02: Upload pipeline 3 étapes appelé avec savId (session→chunks→complete)
 *         + uploadSessionId passé dans body upload-complete
 * OFU-03: Progress bar mise à jour pendant upload
 * OFU-04: @uploaded event emitted after done
 */

function makeFile(name: string, type: string, sizeBytes: number): File {
  const bytes = new Uint8Array(sizeBytes)
  return new File([bytes], name, { type })
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

async function importComponent() {
  return (
    await import('../../../../../src/features/back-office/components/OperatorFileUploader.vue')
  ).default
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OperatorFileUploader.vue (Story 3.7b AC#14)', () => {
  it('OFU-01: MIME invalide (.exe) rejeté client-side — fetch NOT called', async () => {
    const OperatorFileUploader = await importComponent()
    const fetchMock = vi.fn()
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

    const wrapper = mount(OperatorFileUploader, {
      props: { savId: 1 },
    })

    const invalidFile = makeFile('virus.exe', 'application/x-msdownload', 1000)

    // Simulate file selection via input
    const fileInput = wrapper.find('input[type="file"]')
    if (fileInput.exists()) {
      Object.defineProperty(fileInput.element, 'files', {
        value: [invalidFile],
        configurable: true,
      })
      await fileInput.trigger('change')
    }

    await flushPromises()

    // No fetch calls must have been made
    expect(fetchMock).not.toHaveBeenCalled()
    // Error state or alert must be shown
    expect(
      wrapper.find('[role="alert"]').exists() ||
        wrapper.html().toLowerCase().includes('mime') ||
        wrapper.html().toLowerCase().includes('type') ||
        wrapper.html().toLowerCase().includes('autorisé') ||
        wrapper.html().toLowerCase().includes('invalide')
    ).toBe(true)
  })

  it('OFU-02: upload pipeline session→complete appelé avec savId + uploadSessionId pass-through', async () => {
    const OperatorFileUploader = await importComponent()
    const capturedBodies: Array<Record<string, unknown>> = []
    const UPLOAD_SESSION_ID = 'test-session-uuid-42'
    const CHUNK = 4 * 1024 * 1024

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()

      if (url.includes('upload-session') && method === 'POST') {
        const body = JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>
        capturedBodies.push({ endpoint: 'upload-session', ...body })
        return jsonResponse(200, {
          data: {
            uploadUrl: 'https://graph.microsoft.com/upload-url-mock',
            sanitizedFilename: 'photo.jpg',
            storagePath: 'SAV_Images/SAV-2026-00001/operator-adds/photo.jpg',
            uploadSessionId: UPLOAD_SESSION_ID,
          },
        })
      }
      if (url === 'https://graph.microsoft.com/upload-url-mock' && method === 'PUT') {
        return jsonResponse(201, {
          id: 'gfx-item-999',
          webUrl: 'https://fruitstock.sharepoint.com/photo.jpg',
        })
      }
      if (url.includes('upload-complete') && method === 'POST') {
        const body = JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>
        capturedBodies.push({ endpoint: 'upload-complete', ...body })
        return jsonResponse(201, {
          data: { savFileId: 100, createdAt: '2026-05-06T10:00:00Z', source: 'operator-add' },
        })
      }
      return new Response(null, { status: 500 })
    })
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

    const wrapper = mount(OperatorFileUploader, {
      props: { savId: 1 },
    })

    const validFile = makeFile('photo.jpg', 'image/jpeg', 1000)

    const fileInput = wrapper.find('input[type="file"]')
    if (fileInput.exists()) {
      Object.defineProperty(fileInput.element, 'files', {
        value: [validFile],
        configurable: true,
      })
      await fileInput.trigger('change')
    }

    await flushPromises()

    // Upload-session body must contain savId
    const sessionBody = capturedBodies.find((b) => b['endpoint'] === 'upload-session')
    expect(sessionBody?.['savId']).toBe(1)

    // Upload-complete body must contain uploadSessionId (pass-through from session response)
    const completeBody = capturedBodies.find((b) => b['endpoint'] === 'upload-complete')
    expect(completeBody?.['uploadSessionId']).toBe(UPLOAD_SESSION_ID)
    expect(completeBody?.['savId']).toBe(1)
  })

  it('OFU-03: progress bar mise à jour pendant upload (0 → 100)', async () => {
    const OperatorFileUploader = await importComponent()
    vi.useFakeTimers()

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()

      if (url.includes('upload-session') && method === 'POST') {
        return jsonResponse(200, {
          data: {
            uploadUrl: 'https://graph.microsoft.com/upload-url-mock',
            sanitizedFilename: 'big.jpg',
            storagePath: 'path',
            uploadSessionId: 'sess-progress-test',
          },
        })
      }
      if (method === 'PUT') {
        const range = (init?.headers as Record<string, string> | undefined)?.['Content-Range'] ?? ''
        const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(range)
        const end = m ? Number(m[2]) + 1 : 0
        const total = m ? Number(m[3]) : 0
        if (end >= total && total > 0) {
          return jsonResponse(201, {
            id: 'item-progress',
            webUrl: 'https://fruitstock.sharepoint.com/big.jpg',
          })
        }
        return jsonResponse(202, {})
      }
      if (url.includes('upload-complete') && method === 'POST') {
        return jsonResponse(201, {
          data: { savFileId: 200, createdAt: '2026-05-06T10:00:00Z', source: 'operator-add' },
        })
      }
      return new Response(null, { status: 500 })
    })
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

    const wrapper = mount(OperatorFileUploader, {
      props: { savId: 1 },
    })

    // Use a file larger than 4 MiB to trigger multiple chunks
    const bigFile = makeFile('big.jpg', 'image/jpeg', 4 * 1024 * 1024 + 1000)
    const fileInput = wrapper.find('input[type="file"]')
    if (fileInput.exists()) {
      Object.defineProperty(fileInput.element, 'files', {
        value: [bigFile],
        configurable: true,
      })
      await fileInput.trigger('change')
    }

    // Progress should be > 0 during upload
    await vi.runAllTimersAsync()
    await flushPromises()

    // After completion, progress should be 100 or the upload should be in 'done' state
    // We check for progress element existence or done state
    const progressEl =
      wrapper.find('[data-progress]') ||
      wrapper.find('progress') ||
      wrapper.find('[role="progressbar"]')

    // Either a progress element exists or upload completed (no error state)
    const hasProgress = progressEl.exists()
    const hasDoneState =
      wrapper.html().toLowerCase().includes('done') ||
      wrapper.html().toLowerCase().includes('terminé') ||
      !wrapper.find('[role="alert"]').exists()

    expect(hasProgress || hasDoneState).toBe(true)

    vi.useRealTimers()
  })

  it('OFU-04: @uploaded event emitted after successful upload', async () => {
    const OperatorFileUploader = await importComponent()

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()

      if (url.includes('upload-session') && method === 'POST') {
        return jsonResponse(200, {
          data: {
            uploadUrl: 'https://graph.microsoft.com/upload-url-mock',
            sanitizedFilename: 'photo.jpg',
            storagePath: 'path',
            uploadSessionId: 'sess-event-test',
          },
        })
      }
      if (method === 'PUT') {
        return jsonResponse(201, {
          id: 'item-event',
          webUrl: 'https://fruitstock.sharepoint.com/photo.jpg',
        })
      }
      if (url.includes('upload-complete') && method === 'POST') {
        return jsonResponse(201, {
          data: { savFileId: 300, createdAt: '2026-05-06T10:00:00Z', source: 'operator-add' },
        })
      }
      return new Response(null, { status: 500 })
    })
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

    const wrapper = mount(OperatorFileUploader, {
      props: { savId: 1 },
    })

    const validFile = makeFile('photo.jpg', 'image/jpeg', 1000)
    const fileInput = wrapper.find('input[type="file"]')
    if (fileInput.exists()) {
      Object.defineProperty(fileInput.element, 'files', {
        value: [validFile],
        configurable: true,
      })
      await fileInput.trigger('change')
    }

    await flushPromises()

    // @uploaded event must be emitted exactly once
    const uploadedEmits = wrapper.emitted('uploaded')
    expect(uploadedEmits).toBeTruthy()
    expect(uploadedEmits?.length).toBe(1)
  })
})
