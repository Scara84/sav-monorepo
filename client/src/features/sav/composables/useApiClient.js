import axios from 'axios'

/**
 * Composable pour gérer les appels API avec retry logic.
 *
 * Architecture post-Epic 1 :
 *   uploadToBackend = (A) POST /api/upload-session → { uploadUrl }
 *                   + (B) PUT uploadUrl directement sur Microsoft Graph (binaire off Vercel)
 */
export function useApiClient() {
  const getApiKey = () => {
    return import.meta.env.VITE_API_KEY || ''
  }

  /**
   * Retry avec backoff exponentiel (pas de retry sur 4xx).
   */
  const withRetry = async (fn, maxRetries = 3, baseDelay = 1000) => {
    let lastError

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn()
      } catch (error) {
        lastError = error

        if (error.response && error.response.status >= 400 && error.response.status < 500) {
          throw error
        }
        if (error.status && error.status >= 400 && error.status < 500) {
          throw error
        }

        if (attempt === maxRetries - 1) {
          throw error
        }

        const delay = baseDelay * Math.pow(2, attempt)
        console.warn(`Tentative ${attempt + 1} échouée, retry dans ${delay}ms...`, error.message)

        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }

    throw lastError
  }

  /**
   * Convertit une string base64 en Blob.
   */
  const base64ToBlob = (base64, mimeType) => {
    const byteCharacters = atob(base64)
    const byteNumbers = new Array(byteCharacters.length)
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i)
    }
    return new Blob([new Uint8Array(byteNumbers)], { type: mimeType })
  }

  /**
   * PUT binaire direct sur l'uploadUrl Microsoft Graph avec progress.
   * Retourne la DriveItem JSON (contient webUrl).
   */
  const putBlobToGraph = (uploadUrl, blob, onProgress) => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('PUT', uploadUrl)
      xhr.setRequestHeader('Content-Range', `bytes 0-${blob.size - 1}/${blob.size}`)
      xhr.responseType = 'json'

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(Math.round((e.loaded * 100) / e.total))
        }
      }
      xhr.onload = () => {
        if (xhr.status === 200 || xhr.status === 201) {
          resolve(xhr.response)
        } else {
          const err = new Error(
            `Graph PUT ${xhr.status}: ${xhr.response ? JSON.stringify(xhr.response) : 'erreur inconnue'}`
          )
          err.status = xhr.status
          reject(err)
        }
      }
      xhr.onerror = () => reject(new Error('Network error lors du PUT direct OneDrive'))
      xhr.send(blob)
    })
  }

  /**
   * Upload un fichier vers OneDrive en 2 étapes (upload-session + PUT direct Graph).
   * @param {File|{content:string,filename:string}} file
   * @param {string} savDossier
   * @param {{ isBase64?: boolean, onProgress?: (pct:number)=>void }} options
   * @returns {Promise<string>} webUrl OneDrive du fichier uploadé
   */
  const uploadToBackend = async (file, savDossier, options = {}) => {
    const { isBase64 = false, onProgress } = options

    const filename = isBase64 ? file.filename : file.name
    const mimeType = isBase64
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : file.type
    const blob = isBase64 ? base64ToBlob(file.content, mimeType) : file
    const size = blob.size

    const apiKey = getApiKey()
    const headers = { 'Content-Type': 'application/json' }
    if (apiKey) headers['X-API-Key'] = apiKey

    // Étape A : négocier une upload session
    const sessionFn = async () => {
      const response = await axios.post(
        '/api/upload-session',
        { filename, savDossier, mimeType, size },
        { headers }
      )
      if (!response.data || !response.data.success) {
        const err = new Error(response.data?.error || 'upload-session failed')
        err.response = { status: 400, data: response.data }
        throw err
      }
      return response.data
    }
    const { uploadUrl } = await withRetry(sessionFn, 3, 1000)

    // Étape B : PUT binaire direct Microsoft Graph
    const putFn = () => putBlobToGraph(uploadUrl, blob, onProgress)
    const driveItem = await withRetry(putFn, 3, 1000)

    if (!driveItem || !driveItem.webUrl) {
      throw new Error('Réponse Graph invalide : webUrl manquant dans la DriveItem')
    }
    return driveItem.webUrl
  }

  /**
   * Récupère le lien de partage d'un dossier SAV via la route Vercel serverless.
   */
  const getFolderShareLink = async (savDossier) => {
    const apiKey = getApiKey()

    const fetchFn = async () => {
      const headers = {}
      if (apiKey) headers['X-API-Key'] = apiKey

      const response = await axios.post('/api/folder-share-link', { savDossier }, { headers })

      if (!response.data || !response.data.success) {
        throw new Error(
          response.data?.error || 'Impossible de récupérer le lien de partage du dossier.'
        )
      }
      return response.data.shareLink
    }

    return await withRetry(fetchFn, 3, 1000)
  }

  /**
   * Upload tous les fichiers en parallèle avec gestion d'erreurs.
   */
  const uploadFilesParallel = async (files, savDossier) => {
    const uploadPromises = files.map(async (fileObj) => {
      const fileName = fileObj.file?.name || fileObj.filename
      try {
        const url = await uploadToBackend(fileObj.file, savDossier, {
          isBase64: fileObj.isBase64,
        })
        return { success: true, url, fileName }
      } catch (error) {
        console.error(`Erreur lors de l'upload de ${fileName}:`, error)
        return { success: false, error: error.message, fileName }
      }
    })

    const results = await Promise.allSettled(uploadPromises)

    return results.map((result) => {
      if (result.status === 'fulfilled') {
        return result.value
      }
      return { success: false, error: result.reason.message }
    })
  }

  /**
   * @deprecated Non utilisée dans le flow SAV actif (pas d'appelant dans `src/`).
   * La route `/api/submit-sav-urls` n'existe pas côté Vercel serverless.
   * Signature conservée uniquement pour respecter AC#1 de la story 1.2 ;
   * à supprimer lors d'un futur nettoyage d'API.
   */
  const submitUploadedFileUrls = async (fileUrls, savDossier, payload) => {
    const apiKey = getApiKey()

    const submitFn = async () => {
      const headers = { 'Content-Type': 'application/json' }
      if (apiKey) headers['X-API-Key'] = apiKey

      const response = await axios.post(
        '/api/submit-sav-urls',
        { savDossier, fileUrls, payload },
        { headers }
      )

      if (!response.data || !response.data.success) {
        throw new Error(response.data?.error || 'Impossible de soumettre les URLs')
      }
      return response.data
    }

    return await withRetry(submitFn, 3, 1000)
  }

  /**
   * Récupère un capture-token JWT (single-use, exp 5 min) pour authentifier
   * un POST `/api/webhooks/capture` côté browser (Story 5.7 cutover Make).
   */
  const fetchCaptureToken = async () => {
    const fetchFn = async () => {
      const response = await axios.get('/api/self-service/submit-token')
      const token = response.data?.data?.token
      if (!token) {
        throw new Error('submit-token: réponse invalide (token manquant)')
      }
      return token
    }
    return await withRetry(fetchFn, 2, 1000)
  }

  /**
   * Envoie le payload SAV à `/api/webhooks/capture` (Story 5.7 cutover Make).
   *
   * Étapes :
   *   1. GET `/api/self-service/submit-token` → récupère un capture-token JWT.
   *   2. POST `/api/webhooks/capture` avec header `X-Capture-Token: <jwt>` et
   *      body au format `captureWebhookSchema` étendu.
   *
   * Le payload reçu est déjà au format adéquat (transformation faite par le
   * caller, cf. SavView).
   *
   * Story 5.7 patch P2 — pas de retry sur ce POST : un 5xx ou un network
   * partiel après INSERT RPC pourrait dupliquer la création SAV (le serveur
   * n'a pas d'idempotency key, chaque retry refetch un nouveau token donc
   * le webhook_inbox dédoublonné par signature ne le voit pas comme un
   * doublon). Une seule tentative — l'utilisateur reçoit un message d'erreur
   * et peut re-soumettre manuellement si besoin.
   */
  const submitSavWebhook = async (payload) => {
    const token = await fetchCaptureToken()
    const response = await axios.post('/api/webhooks/capture', payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Capture-Token': token,
      },
    })
    return response.data
  }

  /**
   * Lookup facture Pennylane (Story 5.7 cutover Make scenario 1).
   *
   * GET `/api/invoices/lookup?invoiceNumber=...&email=...` (sémantique HTTP
   * idempotente — pas de body, query string courte).
   *
   * Story 5.7 patch P13 — pas de retry. L'endpoint a un rate-limit serré
   * (5/min/IP) et renvoie 503 sur Pennylane upstream timeout/5xx. Un retry
   * automatique consommerait 3/5 du budget en cas d'incident upstream et
   * tripperait un 429 sur la prochaine soumission utilisateur dans la même
   * minute. L'utilisateur retape s'il le souhaite — comportement plus lisible.
   */
  const submitInvoiceLookupWebhook = async (payload) => {
    const { invoiceNumber, email } = payload || {}
    if (!invoiceNumber || !email) {
      throw new Error('submitInvoiceLookupWebhook: invoiceNumber et email requis')
    }
    const url = `/api/invoices/lookup?invoiceNumber=${encodeURIComponent(invoiceNumber)}&email=${encodeURIComponent(email)}`
    const response = await axios.get(url)
    const data = response.data
    if (data && data.invoice && typeof data.invoice === 'object') {
      return data.invoice
    }
    return data
  }

  return {
    uploadToBackend,
    getFolderShareLink,
    uploadFilesParallel,
    submitUploadedFileUrls,
    submitSavWebhook,
    submitInvoiceLookupWebhook,
    fetchCaptureToken,
    withRetry,
  }
}
