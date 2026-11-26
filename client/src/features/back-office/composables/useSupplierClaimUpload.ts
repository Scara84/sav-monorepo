import { onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue'
import { z } from 'zod'

const text = z.string().nullable()
const number = z.number().nullable()
const identifier = z.union([z.string(), z.number()]).nullable()
const factureRow = z.object({
  codeFr: z.string(), designationFr: text, prixVenteClientHt: number, unite: text,
  qteCmd: number, qteFact: number, codigoEs: text, descripcionEs: text,
  kilosPiezas: text, kilosNetos: number, precio: number, importe: number, cmd: identifier,
})
const bddRow = z.object({ code: z.string(), designationEs: text, origen: text })
const warning = z.object({ row: z.number(), sheet: z.string(), fields: z.array(z.string()) })
const sheet = z.object({ skippedRows: z.number(), warnings: z.array(warning) })
const preview = z.object({
  metadata: z.object({ reference: text, albaran: identifier, fechaAlbaran: text, warnings: z.array(z.string()) }),
  factureGroupe: sheet.extend({ rows: z.array(factureRow) }),
  bdd: sheet.extend({ rows: z.array(bddRow) }),
  fileMeta: z.object({ filename: z.string(), sizeBytes: z.number(), sheetsDetected: z.array(z.string()), parser: z.string() }),
})
export type SupplierFileParseResult = z.infer<typeof preview>
export type FactureGroupeRow = z.infer<typeof factureRow>
export type BddRow = z.infer<typeof bddRow>
export type ParseWarning = z.infer<typeof warning>
export type UploadState = 'idle' | 'uploading' | 'preparing' | 'previewing' | 'error'

function importError(error: { code?: string; reason?: string } | undefined, status: number) {
  if (error?.reason === 'MISSING_SHEETS') return 'Vérifiez que le classeur contient les onglets FACTURE_GROUPE et BDD.'
  if (error?.code === 'PREPARATION_BUSY') return 'Une préparation est déjà en cours pour cette commande. Réessayez après sa fin.'
  if (status === 413) return 'Le fichier dépasse 4 Mio. Sélectionnez un classeur plus petit.'
  if (status === 429) return 'Trop de tentatives. Patientez une minute avant de réessayer.'
  if (status === 415) return 'Sélectionnez un fichier au format .xlsx.'
  if (status === 409) return 'Commande indisponible ou modifiée. Rouvrez le détail du SAV.'
  if (status === 403) return 'Accès refusé pour ce SAV.'
  return 'Impossible de lire le fichier fournisseur. Vérifiez le classeur et réessayez.'
}

export function useSupplierClaimUpload(savId: Ref<number>, order: Ref<string | null | undefined>) {
  const state = ref<UploadState>('idle')
  const parseResult = shallowRef<SupplierFileParseResult | null>(null)
  const errorMessage = ref<string | null>(null)
  let operation = 0

  function reset() {
    operation++
    state.value = 'idle'
    parseResult.value = null
    errorMessage.value = null
  }

  watch([savId, order], reset, { flush: 'sync' })
  onScopeDispose(reset)

  async function importFile(file?: File) {
    reset()
    const attempt = operation
    const id = savId.value
    const expectedOrder = order.value
    state.value = file ? 'uploading' : 'preparing'
    try {
      let body: Record<string, unknown> = { expectedOrder }
      if (file) {
        const bytes = new Uint8Array(await file.arrayBuffer())
        if (attempt !== operation) return
        let binary = ''
        for (const byte of bytes) binary += String.fromCharCode(byte)
        body = { expectedOrder, fileBuffer: btoa(binary), mimeType: file.type || 'application/octet-stream', filename: file.name }
      }
      const op = file ? 'parse-supplier-file' : 'prepare-supplier-file'
      const response = await fetch(`/api/sav?op=${op}&id=${id}`, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      const data = response.ok ? await response.json() : await response.json().catch(() => null)
      if (attempt !== operation) return
      if (!response.ok) {
        errorMessage.value = importError(data?.error, response.status)
        state.value = 'error'
        return
      }
      parseResult.value = preview.parse(data)
      state.value = 'previewing'
    } catch {
      if (attempt !== operation) return
      errorMessage.value = 'Impossible de préparer un aperçu valide du fichier fournisseur.'
      state.value = 'error'
    }
  }

  function prepare() {
    if (state.value === 'preparing' || state.value === 'uploading') return
    return importFile()
  }

  function handleFileChange(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (file) return importFile(file)
  }

  return { state, parseResult, errorMessage, handleFileChange, prepare, reset }
}
