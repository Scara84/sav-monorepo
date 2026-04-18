import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useApiClient } from '../useApiClient.js'
import axios from 'axios'

vi.mock('axios')

/**
 * Mock minimal de XMLHttpRequest pour simuler le PUT direct Microsoft Graph.
 * Comportement configurable via setNextResponse().
 */
let nextXhrScenario = null
function setNextXhrResponse(scenario) {
  nextXhrScenario = { ...scenario }
}

class MockXHR {
  constructor() {
    this.upload = { onprogress: null }
    this.onload = null
    this.onerror = null
    this.readyState = 0
    this.status = 0
    this.response = null
    this.sent = null
  }
  open(method, url) {
    this.method = method
    this.url = url
  }
  setRequestHeader() {}
  send(body) {
    this.sent = body
    const scenario = nextXhrScenario || { status: 201, response: { webUrl: 'https://mock/web' } }
    // consume scenario (sauf si explicitement persistent)
    if (!scenario.persistent) nextXhrScenario = null

    queueMicrotask(() => {
      if (scenario.networkError) {
        this.onerror?.(new Error('Network'))
        return
      }
      if (this.upload.onprogress) {
        const size = body?.size ?? 100
        this.upload.onprogress({ lengthComputable: true, loaded: size, total: size })
      }
      this.status = scenario.status
      this.response = scenario.response ?? {}
      this.onload?.()
    })
  }
}

describe('useApiClient', () => {
  let apiClient
  let originalXHR

  beforeEach(() => {
    apiClient = useApiClient()
    vi.clearAllMocks()
    originalXHR = globalThis.XMLHttpRequest
    globalThis.XMLHttpRequest = MockXHR
    nextXhrScenario = null
  })

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.XMLHttpRequest = originalXHR
    if (vi.unstubAllEnvs) {
      vi.unstubAllEnvs()
    }
  })

  describe('withRetry', () => {
    it('réussit à la première tentative', async () => {
      const mockFn = vi.fn().mockResolvedValue('success')
      const result = await apiClient.withRetry(mockFn, 3, 100)
      expect(result).toBe('success')
      expect(mockFn).toHaveBeenCalledTimes(1)
    })

    it('retry sur échec puis succès', async () => {
      const mockFn = vi
        .fn()
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce('success')
      const result = await apiClient.withRetry(mockFn, 3, 100)
      expect(result).toBe('success')
      expect(mockFn).toHaveBeenCalledTimes(2)
    })

    it('ne retry pas sur erreur 4xx (error.response.status)', async () => {
      const error = new Error('Bad Request')
      error.response = { status: 400 }
      const mockFn = vi.fn().mockRejectedValue(error)
      await expect(apiClient.withRetry(mockFn, 3, 100)).rejects.toThrow('Bad Request')
      expect(mockFn).toHaveBeenCalledTimes(1)
    })

    it('ne retry pas sur erreur 4xx XHR (error.status)', async () => {
      const error = new Error('Graph 410 Gone')
      error.status = 410
      const mockFn = vi.fn().mockRejectedValue(error)
      await expect(apiClient.withRetry(mockFn, 3, 100)).rejects.toThrow('Gone')
      expect(mockFn).toHaveBeenCalledTimes(1)
    })

    it('throw après max retries', async () => {
      const mockFn = vi.fn().mockRejectedValue(new Error('Network error'))
      await expect(apiClient.withRetry(mockFn, 3, 100)).rejects.toThrow('Network error')
      expect(mockFn).toHaveBeenCalledTimes(3)
    })

    it('utilise un backoff exponentiel', async () => {
      vi.useFakeTimers()
      const mockFn = vi
        .fn()
        .mockRejectedValueOnce(new Error('Error 1'))
        .mockRejectedValueOnce(new Error('Error 2'))
        .mockResolvedValueOnce('success')

      const promise = apiClient.withRetry(mockFn, 3, 1000)

      await vi.advanceTimersByTimeAsync(0)
      expect(mockFn).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1000)
      expect(mockFn).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(2000)
      expect(mockFn).toHaveBeenCalledTimes(3)

      const result = await promise
      expect(result).toBe('success')

      vi.useRealTimers()
    })
  })

  describe('uploadToBackend — flow 2 étapes', () => {
    const uploadSessionResponse = {
      data: {
        success: true,
        uploadUrl: 'https://mock-graph.local/upload/xyz',
        storagePath: 'SAV_Images/SAV_TEST/test.jpg',
        expiresAt: '2026-04-17T20:00:00Z',
      },
    }

    it('upload image : appelle /api/upload-session puis PUT Graph, retourne webUrl', async () => {
      const mockFile = new File(['content'], 'test.jpg', { type: 'image/jpeg' })
      axios.post.mockResolvedValue(uploadSessionResponse)
      setNextXhrResponse({
        status: 201,
        response: { id: 'mock-id', webUrl: 'https://mock-share.local/test.jpg' },
      })

      const result = await apiClient.uploadToBackend(mockFile, 'SAV_TEST_123')

      expect(result).toBe('https://mock-share.local/test.jpg')
      expect(axios.post).toHaveBeenCalledTimes(1)
      const [url, payload, config] = axios.post.mock.calls[0]
      expect(url).toBe('/api/upload-session')
      expect(payload).toEqual({
        filename: 'test.jpg',
        savDossier: 'SAV_TEST_123',
        mimeType: 'image/jpeg',
        size: mockFile.size,
      })
      expect(config.headers).toHaveProperty('Content-Type', 'application/json')
    })

    it('upload Excel base64 : convertit en Blob et envoie avec le bon MIME', async () => {
      const mockFile = {
        content: btoa('test content'),
        filename: 'test.xlsx',
      }
      axios.post.mockResolvedValue(uploadSessionResponse)
      setNextXhrResponse({
        status: 201,
        response: { id: 'x', webUrl: 'https://mock-share.local/test.xlsx' },
      })

      const result = await apiClient.uploadToBackend(mockFile, 'SAV_TEST_123', {
        isBase64: true,
      })

      expect(result).toBe('https://mock-share.local/test.xlsx')
      const [, payload] = axios.post.mock.calls[0]
      expect(payload.filename).toBe('test.xlsx')
      expect(payload.mimeType).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
      expect(payload.size).toBeGreaterThan(0)
    })

    it('propage 403 sur /api/upload-session (pas de retry)', async () => {
      const mockFile = new File(['c'], 't.jpg', { type: 'image/jpeg' })
      const error = new Error('Forbidden')
      error.response = { status: 403 }
      axios.post.mockRejectedValue(error)

      await expect(apiClient.uploadToBackend(mockFile, 'SAV_X')).rejects.toThrow('Forbidden')
      expect(axios.post).toHaveBeenCalledTimes(1)
    })

    it('retry sur network error du PUT Graph', async () => {
      const mockFile = new File(['c'], 't.jpg', { type: 'image/jpeg' })
      axios.post.mockResolvedValue(uploadSessionResponse)

      // 1er PUT : network error, 2e : succès
      let putCount = 0
      const originalSend = MockXHR.prototype.send
      MockXHR.prototype.send = function (body) {
        putCount++
        this.sent = body
        queueMicrotask(() => {
          if (putCount === 1) {
            this.onerror?.(new Error('Network'))
          } else {
            this.status = 201
            this.response = { webUrl: 'https://mock-share.local/retry-ok.jpg' }
            this.onload?.()
          }
        })
      }

      const result = await apiClient.uploadToBackend(mockFile, 'SAV_X')
      expect(result).toBe('https://mock-share.local/retry-ok.jpg')
      expect(putCount).toBe(2)

      MockXHR.prototype.send = originalSend
    })

    it('pas de retry sur erreur 4xx du PUT Graph (ex: 410 Gone session expirée)', async () => {
      const mockFile = new File(['c'], 't.jpg', { type: 'image/jpeg' })
      axios.post.mockResolvedValue(uploadSessionResponse)

      let putCount = 0
      const originalSend = MockXHR.prototype.send
      MockXHR.prototype.send = function (body) {
        putCount++
        this.sent = body
        queueMicrotask(() => {
          this.status = 410
          this.response = { error: 'Upload session expired' }
          this.onload?.()
        })
      }

      await expect(apiClient.uploadToBackend(mockFile, 'SAV_X')).rejects.toThrow(/410/)
      expect(putCount).toBe(1)

      MockXHR.prototype.send = originalSend
    })

    it('appelle onProgress avec un pourcentage', async () => {
      const mockFile = new File(['hello'], 't.jpg', { type: 'image/jpeg' })
      const onProgress = vi.fn()
      axios.post.mockResolvedValue(uploadSessionResponse)
      setNextXhrResponse({
        status: 201,
        response: { webUrl: 'https://mock-share.local/x.jpg' },
      })

      await apiClient.uploadToBackend(mockFile, 'SAV_X', { onProgress })

      expect(onProgress).toHaveBeenCalled()
      const pct = onProgress.mock.calls[0][0]
      expect(pct).toBeGreaterThanOrEqual(0)
      expect(pct).toBeLessThanOrEqual(100)
    })

    it('échoue si webUrl absent dans la DriveItem', async () => {
      const mockFile = new File(['c'], 't.jpg', { type: 'image/jpeg' })
      axios.post.mockResolvedValue(uploadSessionResponse)
      setNextXhrResponse({ status: 201, response: { id: 'no-weburl' } })

      await expect(apiClient.uploadToBackend(mockFile, 'SAV_X')).rejects.toThrow(/webUrl/)
    })
  })

  describe('uploadFilesParallel', () => {
    const sessionOk = {
      data: {
        success: true,
        uploadUrl: 'https://mock-graph.local/upload/xyz',
        storagePath: 'p',
        expiresAt: 'e',
      },
    }

    it('upload plusieurs fichiers en parallèle', async () => {
      const files = [
        { file: new File(['1'], 'test1.jpg'), isBase64: false },
        { file: new File(['2'], 'test2.jpg'), isBase64: false },
      ]
      axios.post.mockResolvedValue(sessionOk)
      setNextXhrResponse({
        status: 201,
        response: { webUrl: 'https://mock-share.local/file.jpg' },
        persistent: true,
      })

      const results = await apiClient.uploadFilesParallel(files, 'SAV_TEST_123')

      expect(results).toHaveLength(2)
      expect(results[0].success).toBe(true)
      expect(results[1].success).toBe(true)
      expect(axios.post).toHaveBeenCalledTimes(2)
    })

    it('gère les échecs partiels', async () => {
      const files = [
        { file: new File(['1'], 'test1.jpg'), isBase64: false },
        { file: new File(['2'], 'test2.jpg'), isBase64: false },
      ]

      // upload-session : 1er fichier OK, 2e fichier KO (4xx)
      axios.post.mockImplementation((url) => {
        if (url === '/api/upload-session') {
          if (axios.post.mock.calls.filter((c) => c[0] === '/api/upload-session').length === 1) {
            return Promise.resolve(sessionOk)
          }
          const err = new Error('Forbidden')
          err.response = { status: 403 }
          return Promise.reject(err)
        }
        return Promise.resolve({ data: {} })
      })
      setNextXhrResponse({
        status: 201,
        response: { webUrl: 'https://mock-share.local/file1.jpg' },
        persistent: true,
      })

      const results = await apiClient.uploadFilesParallel(files, 'SAV_TEST_123')

      expect(results).toHaveLength(2)
      expect(results.filter((r) => r.success).length).toBe(1)
      expect(results.filter((r) => !r.success).length).toBe(1)
    })
  })

  describe('getFolderShareLink', () => {
    it('appelle /api/folder-share-link (chemin relatif, pas de VITE_API_URL)', async () => {
      axios.post.mockResolvedValue({
        data: { success: true, shareLink: 'https://example.com/share/folder' },
      })

      const result = await apiClient.getFolderShareLink('SAV_TEST_123')

      expect(result).toBe('https://example.com/share/folder')
      expect(axios.post).toHaveBeenCalledTimes(1)
      const [url] = axios.post.mock.calls[0]
      expect(url).toBe('/api/folder-share-link')
    })

    it('throw si API retourne failure', async () => {
      axios.post.mockResolvedValue({
        data: { success: false, error: 'Folder not found' },
      })
      await expect(apiClient.getFolderShareLink('SAV_TEST_123')).rejects.toThrow()
    })
  })

  describe('submitSavWebhook', () => {
    it('soumet le payload au webhook', async () => {
      vi.stubEnv('VITE_WEBHOOK_URL_DATA_SAV', 'https://example.com/webhook')
      const payload = { foo: 'bar' }
      axios.post.mockResolvedValue({ data: { ok: true } })

      const result = await apiClient.submitSavWebhook(payload)

      expect(axios.post).toHaveBeenCalledWith('https://example.com/webhook', payload)
      expect(result).toEqual({ ok: true })
    })

    it('throw si env manquante', async () => {
      vi.stubEnv('VITE_WEBHOOK_URL_DATA_SAV', '')
      await expect(apiClient.submitSavWebhook({})).rejects.toThrow(
        'VITE_WEBHOOK_URL_DATA_SAV is not configured'
      )
    })
  })

  describe('submitInvoiceLookupWebhook', () => {
    it('soumet le payload invoice lookup', async () => {
      vi.stubEnv('VITE_WEBHOOK_URL', 'https://example.com/invoice-webhook')
      const payload = { transformedReference: '123', email: 'test@example.com' }
      axios.post.mockResolvedValue({ data: { invoice_number: 'F-2024-001' } })

      const result = await apiClient.submitInvoiceLookupWebhook(payload)

      expect(axios.post).toHaveBeenCalledWith('https://example.com/invoice-webhook', payload)
      expect(result).toEqual({ invoice_number: 'F-2024-001' })
    })

    it('throw si env manquante', async () => {
      vi.stubEnv('VITE_WEBHOOK_URL', '')
      await expect(
        apiClient.submitInvoiceLookupWebhook({ transformedReference: '123', email: 'a@b.c' })
      ).rejects.toThrow('VITE_WEBHOOK_URL is not configured')
    })
  })
})
