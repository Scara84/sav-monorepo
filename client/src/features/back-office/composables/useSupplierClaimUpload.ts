/**
 * Story 8.1 — Composable useSupplierClaimUpload
 *
 * State machine : idle → uploading → previewing | error
 *
 * Responsabilités :
 *   - handleFileChange : lit le fichier sélectionné, encode en base64, appelle l'API
 *   - POST /api/sav?op=parse-supplier-file&id=:savId (JSON base64 — Q1)
 *   - Expose parseResult en état 'previewing'
 *   - Expose errorMessage en état 'error'
 *   - 0 persistance (PATTERN-PARSE-PREVIEW-NO-PERSIST)
 */

import { ref } from 'vue'
import type { ComputedRef } from 'vue'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FactureGroupeRow {
  codeFr: string
  designationFr: string | null
  prixVenteClientHt: number | null
  unite: string | null
  qteCmd: number | null
  qteFact: number | null
  codigoEs: string | null
  descripcionEs: string | null
  kilosPiezas: string | null
  kilosNetos: number | null
  precio: number | null
  importe: number | null
  cmd: string | number | null
}

export interface BddRow {
  code: string
  designationEs: string | null
  origen: string | null
}

export interface ParseWarning {
  row: number
  sheet: string
  fields: string[]
}

export interface SupplierFileParseResult {
  metadata: {
    reference: string | null
    albaran: string | number | null
    fechaAlbaran: string | null
    warnings: string[]
  }
  factureGroupe: {
    rows: FactureGroupeRow[]
    skippedRows: number
    warnings: ParseWarning[]
  }
  bdd: {
    rows: BddRow[]
    skippedRows: number
    warnings: ParseWarning[]
  }
  fileMeta: {
    filename: string
    sizeBytes: number
    sheetsDetected: string[]
    parser: string
  }
}

export type UploadState = 'idle' | 'uploading' | 'previewing' | 'error'

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

export function useSupplierClaimUpload(savId: ComputedRef<number>) {
  const state = ref<UploadState>('idle')
  const parseResult = ref<SupplierFileParseResult | null>(null)
  const errorMessage = ref<string | null>(null)

  async function handleFileChange(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return

    state.value = 'uploading'
    parseResult.value = null
    errorMessage.value = null

    try {
      // Encode en base64 (cohérence Story 4.8 import-supplier-prices — Q1)
      const arrayBuffer = await file.arrayBuffer()
      const uint8 = new Uint8Array(arrayBuffer)
      let binary = ''
      for (let i = 0; i < uint8.length; i++) {
        binary += String.fromCharCode(uint8[i]!)
      }
      const base64 = btoa(binary)

      const res = await fetch(
        `/api/sav?op=parse-supplier-file&id=${savId.value}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            fileBuffer: base64,
            mimeType: file.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            filename: file.name,
          }),
          credentials: 'include',
        }
      )

      const data = await res.json() as SupplierFileParseResult | { error?: { message?: string; code?: string } }

      if (!res.ok) {
        const errData = data as { error?: { message?: string; code?: string } }
        errorMessage.value = errData.error?.message ?? `Erreur ${res.status} — fournir un fichier .xlsx valide`
        state.value = 'error'
        return
      }

      parseResult.value = data as SupplierFileParseResult
      state.value = 'previewing'
    } catch (err) {
      errorMessage.value = err instanceof Error ? err.message : 'Erreur réseau lors de l\'import'
      state.value = 'error'
    }
  }

  function reset(): void {
    state.value = 'idle'
    parseResult.value = null
    errorMessage.value = null
  }

  return {
    state,
    parseResult,
    errorMessage,
    handleFileChange,
    reset,
  }
}
