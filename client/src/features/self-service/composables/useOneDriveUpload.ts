import { ref, type Ref } from 'vue'

/**
 * Upload OneDrive côté adhérent (Story 2.4 AC #7).
 *
 * Flow 3 étapes par fichier :
 *   1. POST /api/self-service/upload-session → { uploadUrl, sanitizedFilename, ... }
 *   2. PUT chunks 4 MiB vers uploadUrl (Graph direct, contourne Vercel body-limit)
 *   3. POST /api/self-service/upload-complete → persistance sav_files|draft
 *
 * Retry : 2 tentatives par chunk (backoff 1 s, 3 s). Pas de reprise partielle V1.
 */

export type UploadStatus = 'pending' | 'uploading' | 'completing' | 'done' | 'error' | 'cancelled'

export interface UploadState {
  id: string
  filename: string
  size: number
  percent: number
  status: UploadStatus
  error?: string
  result?: {
    savFileId?: number
    draftAttachmentId?: string
    webUrl: string
  }
}

export interface UseOneDriveUploadOptions {
  /** Mode SAV membre (Story 2.4) — référence du SAV (ex: 'SAV-2026-00001') */
  savReference?: string
  /** Mode draft (Story 2.4/6.3) — retourne un draftAttachmentId pour le fichier */
  draftAttachmentIdFor?: (file: File) => string
  /**
   * Mode opérateur back-office (Story 3.7b PATTERN-B) — ID numérique du SAV.
   * XOR strict avec savReference et draftAttachmentIdFor.
   */
  savId?: number
  maxConcurrent?: number
  chunkSize?: number
  sessionEndpoint?: string
  completeEndpoint?: string
  fetchImpl?: typeof fetch
}

export interface UseOneDriveUploadReturn {
  uploads: Ref<UploadState[]>
  uploadFile: (file: File) => Promise<UploadState>
  cancelAll: () => void
}

const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024 // 4 MiB
const MAX_RETRIES = 2

export function useOneDriveUpload(options: UseOneDriveUploadOptions = {}): UseOneDriveUploadReturn {
  // XOR guard PATTERN-B : savId est mutuellement exclusif avec savReference / draftAttachmentIdFor
  if (options.savId !== undefined) {
    if (options.savReference !== undefined) {
      throw new Error(
        '[useOneDriveUpload] savId et savReference sont mutuellement exclusifs (XOR strict PATTERN-B). ' +
          'Utilisez savId pour le mode opérateur back-office OU savReference pour le mode adhérent.'
      )
    }
    if (options.draftAttachmentIdFor !== undefined) {
      throw new Error(
        '[useOneDriveUpload] savId et draftAttachmentIdFor sont mutuellement exclusifs (XOR strict PATTERN-B). ' +
          'Utilisez savId pour le mode opérateur back-office OU draftAttachmentIdFor pour le mode draft.'
      )
    }
  }

  const uploads = ref<UploadState[]>([])
  const abortControllers = new Map<string, AbortController>()
  const doFetch = options.fetchImpl ?? ((...a) => fetch(...a))
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE
  const sessionEndpoint = options.sessionEndpoint ?? '/api/self-service/upload-session'
  const completeEndpoint = options.completeEndpoint ?? '/api/self-service/upload-complete'

  function newId(): string {
    return (
      'up-' +
      (globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID()
        : Math.random().toString(36).slice(2))
    )
  }

  function updateState(id: string, patch: Partial<UploadState>): void {
    const idx = uploads.value.findIndex((u) => u.id === id)
    if (idx < 0) return
    const current = uploads.value[idx]
    if (!current) return
    uploads.value[idx] = { ...current, ...patch }
  }

  async function putChunk(
    uploadUrl: string,
    chunk: Blob,
    start: number,
    end: number,
    total: number,
    signal: AbortSignal
  ): Promise<{ onedriveItemId: string; webUrl: string } | null> {
    let lastErr: Error | null = null
    const delays = [0, 1000, 3000]
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (delays[attempt] && delays[attempt]! > 0) await sleep(delays[attempt]!)
      try {
        const res = await doFetch(uploadUrl, {
          method: 'PUT',
          headers: {
            'Content-Range': `bytes ${start}-${end - 1}/${total}`,
          },
          body: chunk,
          signal,
        })
        if (res.status === 200 || res.status === 201) {
          const body = (await res.json()) as { id?: string; webUrl?: string }
          return { onedriveItemId: body.id ?? '', webUrl: body.webUrl ?? '' }
        }
        if (res.status === 202) {
          // Fragment accepté, upload incomplet — retourner null pour continuer.
          return null
        }
        lastErr = new Error(`PUT chunk ${start}-${end} → ${res.status}`)
        if (res.status >= 400 && res.status < 500 && res.status !== 408) throw lastErr
      } catch (err) {
        if (signal.aborted) throw err
        lastErr = err instanceof Error ? err : new Error(String(err))
      }
    }
    throw lastErr ?? new Error('Chunk upload failed')
  }

  async function uploadFile(file: File): Promise<UploadState> {
    const id = newId()
    const initial: UploadState = {
      id,
      filename: file.name,
      size: file.size,
      percent: 0,
      status: 'pending',
    }
    uploads.value.push(initial)

    const abort = new AbortController()
    abortControllers.set(id, abort)

    try {
      // (1) Négociation session
      updateState(id, { status: 'uploading' })

      // Body selon le mode : savId (opérateur) ou savReference/draft (adhérent)
      const sessionPayload: Record<string, unknown> = {
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
      }
      if (options.savId !== undefined) {
        sessionPayload['savId'] = options.savId
      } else {
        sessionPayload['savReference'] = options.savReference
      }

      const sessionRes = await doFetch(sessionEndpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sessionPayload),
        signal: abort.signal,
      })
      if (!sessionRes.ok) {
        throw new Error(`session ${sessionRes.status}`)
      }
      const sessionBody = (await sessionRes.json()) as {
        data: {
          uploadUrl: string
          sanitizedFilename: string
          storagePath: string
          uploadSessionId?: string
        }
      }
      const { uploadUrl, sanitizedFilename, uploadSessionId } = sessionBody.data

      // (2) PUT chunks
      let finalChunkResult: { onedriveItemId: string; webUrl: string } | null = null
      const total = file.size
      for (let offset = 0; offset < total; offset += chunkSize) {
        const end = Math.min(offset + chunkSize, total)
        const slice = file.slice(offset, end)
        const chunkResult = await putChunk(uploadUrl, slice, offset, end, total, abort.signal)
        if (chunkResult) finalChunkResult = chunkResult
        updateState(id, { percent: Math.round((end / total) * 100) })
      }
      if (!finalChunkResult) {
        throw new Error("Upload terminé mais Graph n'a pas retourné l'item final")
      }

      // (3) Notifier le backend
      updateState(id, { status: 'completing' })
      const draftAttachmentId = options.draftAttachmentIdFor?.(file)
      const completeBody: Record<string, unknown> = {
        onedriveItemId: finalChunkResult.onedriveItemId,
        webUrl: finalChunkResult.webUrl,
        originalFilename: file.name,
        sanitizedFilename,
        sizeBytes: file.size,
        mimeType: file.type || 'application/octet-stream',
      }
      if (options.savId !== undefined) {
        // Mode opérateur back-office (PATTERN-B)
        completeBody['savId'] = options.savId
        // Pass-through uploadSessionId (PATTERN-D, CR 2026-05-06)
        // Backward-compatible : si absent de la session response (self-service mode), ne pas envoyer
        if (uploadSessionId) completeBody['uploadSessionId'] = uploadSessionId
      } else if (options.savReference) {
        completeBody['savReference'] = options.savReference
      } else if (draftAttachmentId) {
        completeBody['draftAttachmentId'] = draftAttachmentId
      }

      const completeRes = await doFetch(completeEndpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(completeBody),
        signal: abort.signal,
      })
      if (!completeRes.ok) throw new Error(`complete ${completeRes.status}`)
      const completeRespBody = (await completeRes.json()) as {
        data: { savFileId?: number; draftAttachmentId?: string; createdAt: string }
      }

      const result: UploadState['result'] = { webUrl: finalChunkResult.webUrl }
      if (completeRespBody.data.savFileId !== undefined) {
        result.savFileId = completeRespBody.data.savFileId
      }
      if (completeRespBody.data.draftAttachmentId !== undefined) {
        result.draftAttachmentId = completeRespBody.data.draftAttachmentId
      }
      updateState(id, { status: 'done', percent: 100, result })

      abortControllers.delete(id)
      return uploads.value.find((u) => u.id === id)!
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError'
      updateState(id, {
        status: isAbort ? 'cancelled' : 'error',
        error: err instanceof Error ? err.message : String(err),
      })
      abortControllers.delete(id)
      return uploads.value.find((u) => u.id === id)!
    }
  }

  function cancelAll(): void {
    for (const ac of abortControllers.values()) ac.abort()
    abortControllers.clear()
  }

  return { uploads, uploadFile, cancelAll }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
