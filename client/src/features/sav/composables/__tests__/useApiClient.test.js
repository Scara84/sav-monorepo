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
  /* global globalThis */
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

    it('upload image : appelle /api/upload-session puis PUT Graph, retourne { webUrl, itemId }', async () => {
      const mockFile = new File(['content'], 'test.jpg', { type: 'image/jpeg' })
      axios.post.mockResolvedValue(uploadSessionResponse)
      setNextXhrResponse({
        status: 201,
        response: {
          id: '01ABCDEFGHIJKLMNOPQRSTUVWXYZ1234',
          webUrl: 'https://mock-share.local/test.jpg',
        },
      })

      const result = await apiClient.uploadToBackend(mockFile, 'SAV_TEST_123')

      // V1.6 AC#9 : retourne un objet { webUrl, itemId }, pas une string
      expect(result).toEqual({
        webUrl: 'https://mock-share.local/test.jpg',
        itemId: '01ABCDEFGHIJKLMNOPQRSTUVWXYZ1234',
      })
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
        response: {
          id: '01EXCELBASE64GRAPHID0000000000001',
          webUrl: 'https://mock-share.local/test.xlsx',
        },
      })

      const result = await apiClient.uploadToBackend(mockFile, 'SAV_TEST_123', {
        isBase64: true,
      })

      // V1.6 AC#9 : retourne un objet { webUrl, itemId }
      expect(result).toEqual({
        webUrl: 'https://mock-share.local/test.xlsx',
        itemId: '01EXCELBASE64GRAPHID0000000000001',
      })
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
            this.response = {
              id: '01RETRYOKGRAPHID0000000000000001',
              webUrl: 'https://mock-share.local/retry-ok.jpg',
            }
            this.onload?.()
          }
        })
      }

      const result = await apiClient.uploadToBackend(mockFile, 'SAV_X')
      // V1.6 AC#9 : retourne un objet { webUrl, itemId }
      expect(result).toEqual({
        webUrl: 'https://mock-share.local/retry-ok.jpg',
        itemId: '01RETRYOKGRAPHID0000000000000001',
      })
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
        response: {
          id: '01PROGRESSTESTGRAPHID00000000001',
          webUrl: 'https://mock-share.local/x.jpg',
        },
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
        response: {
          id: '01PARALLELGRAPHID000000000000001',
          webUrl: 'https://mock-share.local/file.jpg',
        },
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
        response: {
          id: '01PARTIALFAILGRAPHID000000000001',
          webUrl: 'https://mock-share.local/file1.jpg',
        },
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

  describe('submitSavWebhook (Story 5.7 cutover capture-token)', () => {
    it('GET submit-token puis POST /api/webhooks/capture avec X-Capture-Token', async () => {
      const payload = {
        customer: { email: 'a@b.c' },
        invoice: { ref: 'F-2025-37039' },
        items: [{ productCode: 'X', productName: 'P', qtyRequested: 1, unit: 'piece' }],
        files: [],
        metadata: {},
      }
      axios.get = vi
        .fn()
        .mockResolvedValue({ data: { data: { token: 'JWT.TOKEN', expiresIn: 300 } } })
      axios.post.mockResolvedValue({ data: { data: { savId: 99 } } })

      const result = await apiClient.submitSavWebhook(payload)

      expect(axios.get).toHaveBeenCalledWith('/api/self-service/submit-token')
      expect(axios.post).toHaveBeenCalledTimes(1)
      const [url, body, config] = axios.post.mock.calls[0]
      expect(url).toBe('/api/webhooks/capture')
      expect(body).toEqual(payload)
      expect(config.headers['X-Capture-Token']).toBe('JWT.TOKEN')
      expect(config.headers['Content-Type']).toBe('application/json')
      expect(result).toEqual({ data: { savId: 99 } })
    })

    it('échoue si le token est manquant dans la réponse (non-retried 4xx)', async () => {
      // Le 4xx propage sans retry — pour ce test on simule le rejet direct.
      const err = new Error('not found')
      err.response = { status: 404 }
      axios.get = vi.fn().mockRejectedValue(err)
      await expect(apiClient.submitSavWebhook({})).rejects.toThrow(/not found/)
    })
  })

  describe('submitInvoiceLookupWebhook (Story 5.7 cutover Pennylane v2)', () => {
    it('GET /api/invoices/lookup?invoiceNumber=...&email=... + unwrap { invoice }', async () => {
      axios.get = vi.fn().mockResolvedValue({
        data: { invoice: { invoice_number: 'F-2025-37039', customer: { id: 1833 } } },
      })

      const result = await apiClient.submitInvoiceLookupWebhook({
        invoiceNumber: 'F-2025-37039',
        email: 'user@example.com',
      })

      expect(axios.get).toHaveBeenCalledTimes(1)
      const [url] = axios.get.mock.calls[0]
      expect(url).toBe('/api/invoices/lookup?invoiceNumber=F-2025-37039&email=user%40example.com')
      // Shape conservée pour InvoiceDetails.vue : bare invoice (unwrap).
      expect(result).toEqual({ invoice_number: 'F-2025-37039', customer: { id: 1833 } })
    })

    it('throw si invoiceNumber manquant', async () => {
      await expect(apiClient.submitInvoiceLookupWebhook({ email: 'a@b.c' })).rejects.toThrow(
        /invoiceNumber/
      )
    })

    it('ne retry pas sur erreur 4xx (email mismatch / format invalide)', async () => {
      const error = new Error('Email incorrect')
      error.response = { status: 400 }
      axios.get = vi.fn().mockRejectedValue(error)
      await expect(
        apiClient.submitInvoiceLookupWebhook({ invoiceNumber: 'F-2025-37039', email: 'a@b.c' })
      ).rejects.toThrow('Email incorrect')
      expect(axios.get).toHaveBeenCalledTimes(1)
    })
  })

  // ---------------------------------------------------------------------------
  // Story V1.6 — AC #9 (CRITIQUE BLOQUANT) : fix SPA pipeline upload
  //
  // Root cause confirmé Step 1.5 : WebhookItemsList.vue:830 produisait
  // `onedriveItemId: img.uploadedUrl.split('?')[0]?.split('/').pop()` (URL parsing
  // → filename URL-encodé, PAS un Graph item ID) au lieu de `driveItem.id` Graph.
  //
  // Fix attendu (Step 3) :
  //   - `uploadToBackend` doit retourner { webUrl, itemId } (pas juste webUrl string)
  //   - `WebhookItemsList.vue` doit stocker `img.itemId = driveItem.itemId` et
  //     utiliser `img.itemId` pour onedriveItemId dans captureFiles payload.
  //
  // Regex Graph ID valide (Microsoft opaque IDs) :
  //   ^(01[A-Z0-9]{30,}|b![A-Za-z0-9_-]+)$
  //
  // Ces tests sont RED-PHASE : ils échouent tant que le fix Step 3 n'est pas livré.
  // ---------------------------------------------------------------------------

  describe('V1.6 AC#9 — uploadToBackend retourne { webUrl, itemId } (Graph ID)', () => {
    const uploadSessionResponse = {
      data: {
        success: true,
        uploadUrl: 'https://mock-graph.local/upload/xyz',
        storagePath: 'SAV_Images/SAV_TEST/test.jpg',
        expiresAt: '2026-04-17T20:00:00Z',
      },
    }

    /**
     * Test 1 (AC#9) — upload-complete handler stocke response.id Graph (pas le filename).
     *
     * Le payload `captureFiles[].onedriveItemId` DOIT être le Graph item ID opaque
     * (ex: `01ABCDEFGH...`) retourné dans `driveItem.id` de la réponse PUT Graph,
     * PAS le dernier segment de l'URL (ex: `505_25S25_30_6_IMG_4889.JPG`).
     *
     * Assertion : uploadToBackend retourne un objet { webUrl, itemId } où
     * `itemId` matche le pattern Graph ID `^(01[A-Z0-9]{30,}|b![A-Za-z0-9_-]+)$`.
     */
    it('V1.6-T1: uploadToBackend retourne { webUrl, itemId } — itemId matche pattern Graph ID', async () => {
      const GRAPH_ITEM_ID = '01ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
      const mockFile = new File(['content'], '505_25S25_30_6_IMG_4889.JPG', { type: 'image/jpeg' })
      axios.post.mockResolvedValue(uploadSessionResponse)
      setNextXhrResponse({
        status: 201,
        response: {
          id: GRAPH_ITEM_ID,
          webUrl:
            'https://fruitstocksav.sharepoint.com/SAV_Images/SAV_19/505_25S25_30_6_IMG_4889.JPG',
        },
      })

      const result = await apiClient.uploadToBackend(mockFile, 'SAV_2026_00019')

      // Must return an object, not a plain string
      expect(result).toBeTypeOf('object')
      expect(result).not.toBeNull()

      // webUrl must be the SharePoint URL
      expect(result.webUrl).toBe(
        'https://fruitstocksav.sharepoint.com/SAV_Images/SAV_19/505_25S25_30_6_IMG_4889.JPG'
      )

      // itemId MUST be the Graph item ID — not the filename, not a URL segment
      expect(result.itemId).toBeDefined()
      const GRAPH_ID_REGEX = /^(01[A-Z0-9]{30,}|b![A-Za-z0-9_-]+)$/
      expect(result.itemId).toMatch(GRAPH_ID_REGEX)

      // Defense: itemId must NOT be the filename (the old bug path)
      expect(result.itemId).not.toBe('505_25S25_30_6_IMG_4889.JPG')
      // Defense: itemId must NOT contain a dot extension (old bug: filename URL-encodé)
      expect(result.itemId).not.toMatch(/\.[a-zA-Z]{2,5}$/)
    })

    /**
     * Test 2 (AC#9) — defense-in-depth : si Graph response.id absent ou invalide → throw.
     *
     * Le cas legacy (Make webhook) et les éventuelles réponses Graph atypiques ne doivent
     * PAS produire un fallback silencieux sur filename. Le caller DOIT recevoir une erreur
     * explicite pour que l'upload échoue proprement (message d'erreur visible user) plutôt
     * que de créer une donnée invalide en base.
     *
     * Cas testés :
     *   (a) response.id absent (`undefined`)
     *   (b) response.id est un filename (ne matche pas le pattern Graph ID)
     */
    it('V1.6-T2a: uploadToBackend throw si Graph response.id absent (pas de fallback silencieux)', async () => {
      const mockFile = new File(['c'], 'test.jpg', { type: 'image/jpeg' })
      axios.post.mockResolvedValue(uploadSessionResponse)
      setNextXhrResponse({
        status: 201,
        response: {
          // id absent — seul webUrl présent
          webUrl: 'https://fruitstocksav.sharepoint.com/SAV_Images/SAV_19/test.jpg',
        },
      })

      // MUST throw — no silent fallback to filename
      await expect(apiClient.uploadToBackend(mockFile, 'SAV_TEST')).rejects.toThrow(
        /itemId|Graph.*id|id.*manquant/i
      )
    })

    it('V1.6-T2b: uploadToBackend throw si Graph response.id invalide (filename, pas un Graph ID)', async () => {
      const mockFile = new File(['c'], '505_25S25_30_6_IMG_4889.JPG', { type: 'image/jpeg' })
      axios.post.mockResolvedValue(uploadSessionResponse)
      setNextXhrResponse({
        status: 201,
        response: {
          // id looks like a filename — not a valid Graph opaque ID
          id: '505_25S25_30_6_IMG_4889.JPG',
          webUrl:
            'https://fruitstocksav.sharepoint.com/SAV_Images/SAV_19/505_25S25_30_6_IMG_4889.JPG',
        },
      })

      // MUST throw — filename masquerading as Graph ID is not acceptable
      await expect(apiClient.uploadToBackend(mockFile, 'SAV_TEST')).rejects.toThrow(
        /itemId|Graph.*id|id.*invalide/i
      )
    })

    /**
     * Test 3 (AC#9) — régression payload capture : onedriveItemId valide pour les images.
     *
     * Simule le path complet : Graph retourne un vrai ID → buildCaptureFiles doit
     * produire un payload où chaque fichier a `onedriveItemId` valide (pattern Graph).
     *
     * Ce test valide le contrat end-to-end entre uploadToBackend et le payload
     * envoyé au webhook capture (sans tester WebhookItemsList.vue directement,
     * qui est un SFC complexe).
     */
    it('V1.6-T3: payload captureFiles.onedriveItemId contient le Graph ID valide (pas le filename)', async () => {
      const GRAPH_ITEM_ID_1 = '01ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
      const GRAPH_ITEM_ID_2 = '01BCDEFGHIJKLMNOPQRSTUVWXYZ01234567890'
      const files = [
        { file: new File(['img1'], 'IMG_001.JPG', { type: 'image/jpeg' }), isBase64: false },
        { file: new File(['img2'], 'IMG_002.JPG', { type: 'image/jpeg' }), isBase64: false },
      ]

      // Mock axios pour chaque upload-session
      axios.post.mockResolvedValue(uploadSessionResponse)

      // Mock XHR pour le 1er PUT
      setNextXhrResponse({
        status: 201,
        response: {
          id: GRAPH_ITEM_ID_1,
          webUrl: 'https://fruitstocksav.sharepoint.com/SAV_Images/SAV_19/IMG_001.JPG',
        },
      })

      const result1 = await apiClient.uploadToBackend(files[0].file, 'SAV_2026_00019')

      // Mock XHR pour le 2e PUT
      setNextXhrResponse({
        status: 201,
        response: {
          id: GRAPH_ITEM_ID_2,
          webUrl: 'https://fruitstocksav.sharepoint.com/SAV_Images/SAV_19/IMG_002.JPG',
        },
      })

      const result2 = await apiClient.uploadToBackend(files[1].file, 'SAV_2026_00019')

      // Simulate what WebhookItemsList.vue does: build captureFiles from results
      const GRAPH_ID_REGEX = /^(01[A-Z0-9]{30,}|b![A-Za-z0-9_-]+)$/
      const captureFiles = [
        {
          onedriveItemId: result1.itemId,
          webUrl: result1.webUrl,
          originalFilename: files[0].file.name,
        },
        {
          onedriveItemId: result2.itemId,
          webUrl: result2.webUrl,
          originalFilename: files[1].file.name,
        },
      ]

      // Both onedriveItemId fields MUST match Graph ID pattern
      for (const f of captureFiles) {
        expect(f.onedriveItemId).toMatch(GRAPH_ID_REGEX)
        // Must NOT be the filename
        expect(f.onedriveItemId).not.toMatch(/\.[a-zA-Z]{2,5}$/)
        // Must NOT be a URL segment (contains slash or percent-encoded chars common in filenames)
        expect(f.onedriveItemId).not.toContain('/')
        expect(f.onedriveItemId).not.toContain('%')
      }
    })
  })
})
