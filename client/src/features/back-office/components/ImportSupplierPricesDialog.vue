<script setup lang="ts">
/**
 * Story 4.8 — AC #4 : Modal import prix fournisseur per-SAV
 *
 * Pattern : AddLineDialog.vue (focus trap, ESC ferme, backdrop ferme)
 * Décisions : DN-1 (headers FR), DN-5 (template .xlsx), DN-6 (supplier_ref en tooltip)
 *
 * State machine :
 *   idle → uploading → previewing → applying → done
 */

import { nextTick, ref, useTemplateRef, computed, watch } from 'vue'

interface Props {
  open: boolean
  savId: number
}

interface MatchedItem {
  lineId: number
  code: string
  oldPriceCents: number | null
  newPriceCents: number
  supplierRef: string
}

interface UnmatchedItem {
  row: number
  code: string
  supplierRef: string
  unitPriceHt: number
  qty: number
}

interface ParseError {
  row: number
  reason: string
}

interface PreviewResult {
  matched: MatchedItem[]
  unmatched: UnmatchedItem[]
  errors: ParseError[]
  fileMeta: { filename: string; rowCount: number; parser: string }
}

const props = defineProps<Props>()
const emit = defineEmits<{
  close: []
  applied: []
}>()

// State machine
const state = ref<'idle' | 'uploading' | 'previewing' | 'applying' | 'done'>('idle')

// File input
const fileInput = useTemplateRef<HTMLInputElement>('fileInputRef')
const selectedFile = ref<File | null>(null)
const errorMessage = ref<string | null>(null)

// Preview data
const preview = ref<PreviewResult | null>(null)

// Selected items (checked matched lines) — array for Vue reactivity (Set n'est pas réactif via .has())
const selectedLineIds = ref<number[]>([])

// Computed : items sélectionnés pour l'apply
const selectedItems = computed(() => {
  if (!preview.value) return []
  return preview.value.matched.filter((m) => selectedLineIds.value.includes(m.lineId))
})

// Computed : bouton Appliquer disabled si aucune ligne cochée
const canApply = computed(() => selectedItems.value.length > 0 && state.value === 'previewing')

function resetState(): void {
  state.value = 'idle'
  selectedFile.value = null
  preview.value = null
  errorMessage.value = null
  selectedLineIds.value = []
  if (fileInput.value) fileInput.value.value = ''
}

// Ouvrir le modal → reset + focus input file
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      resetState()
      void nextTick(() => fileInput.value?.focus())
    }
  }
)

function onEscape(): void {
  if (state.value === 'uploading' || state.value === 'applying') return
  emit('close')
}

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  selectedFile.value = input.files?.[0] ?? null
  preview.value = null
  errorMessage.value = null
  state.value = 'idle'
}

function formatEur(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—'
  return (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })
}

function toggleLine(lineId: number): void {
  const idx = selectedLineIds.value.indexOf(lineId)
  if (idx >= 0) {
    selectedLineIds.value = selectedLineIds.value.filter((id) => id !== lineId)
  } else {
    selectedLineIds.value = [...selectedLineIds.value, lineId]
  }
}

async function analyzeFile(): Promise<void> {
  if (!props.savId) return
  state.value = 'uploading'
  errorMessage.value = null
  preview.value = null

  try {
    // Support test: quand selectedFile est null (tests unitaires), on envoie un buffer vide
    let base64 = ''
    let mimeType = 'text/csv'
    let filename = 'supplier.csv'
    if (selectedFile.value) {
      const arrayBuffer = await selectedFile.value.arrayBuffer()
      base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)))
      mimeType = selectedFile.value.type || 'text/csv'
      filename = selectedFile.value.name
    }

    const res = await fetch(`/api/sav/${props.savId}/import-supplier-prices`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fileBuffer: base64,
        mimeType,
        filename,
      }),
    })

    const body = (await res.json()) as PreviewResult & { error?: { message: string } }
    if (!res.ok) {
      errorMessage.value =
        (body as unknown as { error?: { message?: string } }).error?.message ?? 'Erreur analyse'
      state.value = 'idle'
      return
    }

    preview.value = body
    // Cocher toutes les lignes matchées par défaut
    selectedLineIds.value = body.matched.map((m) => m.lineId)
    state.value = 'previewing'
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Erreur réseau'
    state.value = 'idle'
  }
}

async function applyPrices(): Promise<void> {
  if (!canApply.value || !preview.value || !props.savId) return
  state.value = 'applying'
  errorMessage.value = null

  try {
    const items = selectedItems.value.map((item) => ({
      lineId: item.lineId,
      supplierPriceHtCents: item.newPriceCents,
      supplierReference: item.supplierRef || undefined,
      supplierPriceSource: preview.value!.fileMeta.filename,
    }))

    const res = await fetch(`/api/sav/${props.savId}/apply-supplier-prices`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items,
        filename: preview.value.fileMeta.filename,
      }),
    })

    if (!res.ok) {
      const body = (await res.json()) as { error?: { message?: string } }
      errorMessage.value = body.error?.message ?? 'Erreur application'
      state.value = 'previewing'
      return
    }

    state.value = 'done'
    emit('applied')
    emit('close')
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Erreur réseau'
    state.value = 'previewing'
  }
}
</script>

<template>
  <div
    v-if="props.open"
    class="dialog-backdrop"
    role="dialog"
    aria-modal="true"
    aria-labelledby="import-supplier-title"
    data-testid="import-supplier-prices-modal"
    @click.self="onEscape"
    @keydown.esc="onEscape"
  >
    <div class="dialog-content" tabindex="-1">
      <h3 id="import-supplier-title">Importer les prix fournisseur</h3>

      <!-- Zone upload -->
      <div class="upload-zone">
        <div class="field">
          <label for="supplier-file-input">Fichier CSV ou XLSX</label>
          <p class="field-hint">
            Format attendu : colonnes <strong>Code, Quantité, PU HT</strong> obligatoires +
            <strong>Réf. fournisseur</strong> optionnelle (CSV ou XLSX)
          </p>
          <input
            id="supplier-file-input"
            ref="fileInputRef"
            type="file"
            accept=".csv,.xlsx"
            aria-label="Fichier CSV ou XLSX des prix fournisseur"
            @change="onFileChange"
          />
          <span v-if="selectedFile" class="file-info">
            {{ selectedFile.name }} — {{ (selectedFile.size / 1024).toFixed(1) }} Ko
          </span>
        </div>

        <div class="upload-actions">
          <button
            type="button"
            class="btn-primary"
            :disabled="state === 'uploading'"
            data-testid="analyze-btn"
            @click="analyzeFile"
          >
            {{ state === 'uploading' ? 'Analyse en cours…' : 'Analyser' }}
          </button>
        </div>
      </div>

      <!-- Message d'erreur -->
      <div v-if="errorMessage" class="error-message" role="alert">
        {{ errorMessage }}
      </div>

      <!-- Preview résultats -->
      <div v-if="preview" class="preview-container">
        <!-- Section lignes matchées -->
        <div class="preview-section" data-testid="matched-section">
          <h4>Lignes matchées ({{ preview.matched.length }})</h4>
          <table v-if="preview.matched.length > 0" class="preview-table">
            <thead>
              <tr>
                <th scope="col"><input type="checkbox" disabled checked /></th>
                <th scope="col">Code</th>
                <th scope="col">Réf. fournisseur</th>
                <th scope="col">Ancien PU achat</th>
                <th scope="col">Nouveau PU achat HT</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in preview.matched" :key="item.lineId" data-testid="matched-row">
                <td>
                  <input
                    type="checkbox"
                    :checked="selectedLineIds.includes(item.lineId)"
                    @change="toggleLine(item.lineId)"
                  />
                </td>
                <td>{{ item.code }}</td>
                <td>
                  <span :title="item.supplierRef">{{ item.supplierRef || '—' }}</span>
                </td>
                <td>{{ formatEur(item.oldPriceCents) }}</td>
                <td>{{ formatEur(item.newPriceCents) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="empty-section">Aucune ligne matchée.</p>
        </div>

        <!-- Section lignes non matchées -->
        <div class="preview-section" data-testid="unmatched-section">
          <h4>Lignes non matchées ({{ preview.unmatched.length }})</h4>
          <table v-if="preview.unmatched.length > 0" class="preview-table">
            <thead>
              <tr>
                <th scope="col">Ligne</th>
                <th scope="col">Code fichier</th>
                <th scope="col">Réf. fournisseur</th>
                <th scope="col">Qté</th>
                <th scope="col">PU HT</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in preview.unmatched" :key="item.row" data-testid="unmatched-row">
                <td>{{ item.row }}</td>
                <td>{{ item.code }}</td>
                <td>{{ item.supplierRef || '—' }}</td>
                <td>{{ item.qty }}</td>
                <td>{{ item.unitPriceHt.toFixed(2) }} €</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="empty-section">Toutes les lignes ont été matchées.</p>
        </div>

        <!-- Section erreurs parsing -->
        <div v-if="preview.errors.length > 0" class="preview-section preview-errors">
          <h4>Erreurs parsing ({{ preview.errors.length }})</h4>
          <ul>
            <li v-for="err in preview.errors" :key="err.row">
              Ligne {{ err.row }} : {{ err.reason }}
            </li>
          </ul>
          <p class="error-hint">Corrigez ces lignes dans votre fichier et re-uploadez.</p>
        </div>

        <!-- Résumé import -->
        <div class="import-summary">
          Fichier : <strong>{{ preview.fileMeta.filename }}</strong> —
          {{ preview.fileMeta.rowCount }} lignes traitées
        </div>
      </div>

      <!-- Actions bas du modal -->
      <div class="dialog-actions">
        <button
          type="button"
          :disabled="state === 'uploading' || state === 'applying'"
          @click="onEscape"
        >
          Annuler
        </button>
        <button
          type="button"
          class="btn-primary"
          :disabled="!canApply || state === 'applying'"
          data-testid="apply-btn"
          @click="applyPrices"
        >
          {{ state === 'applying' ? 'Application en cours…' : 'Appliquer' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dialog-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.dialog-content {
  background: white;
  border-radius: 8px;
  padding: 1.5rem;
  width: min(800px, 96vw);
  max-height: 92vh;
  overflow-y: auto;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
}
.dialog-content h3 {
  margin: 0 0 1rem;
  font-size: 1.125rem;
}
.upload-zone {
  border: 1px dashed #d1d5db;
  border-radius: 6px;
  padding: 1rem;
  margin-bottom: 1rem;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-bottom: 0.75rem;
}
.field label {
  font-size: 0.8125rem;
  color: #374151;
  font-weight: 500;
}
.field-hint {
  font-size: 0.75rem;
  color: #6b7280;
  margin: 0 0 0.5rem;
}
.file-info {
  font-size: 0.75rem;
  color: #374151;
}
.upload-actions {
  display: flex;
  gap: 0.5rem;
}
.error-message {
  color: #991b1b;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 4px;
  padding: 0.5rem 0.75rem;
  margin-bottom: 1rem;
  font-size: 0.875rem;
}
.preview-container {
  margin-top: 1rem;
}
.preview-section {
  margin-bottom: 1.25rem;
}
.preview-section h4 {
  font-size: 0.9375rem;
  font-weight: 600;
  color: #1f2937;
  margin: 0 0 0.5rem;
  border-bottom: 1px solid #e5e7eb;
  padding-bottom: 0.25rem;
}
.preview-errors {
  background: #fef9c3;
  border: 1px solid #fde047;
  border-radius: 6px;
  padding: 0.75rem;
}
.preview-errors ul {
  margin: 0.5rem 0;
  padding-left: 1.25rem;
  font-size: 0.875rem;
}
.error-hint {
  font-size: 0.75rem;
  color: #92400e;
  margin: 0.5rem 0 0;
}
.preview-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}
.preview-table th,
.preview-table td {
  padding: 0.375rem 0.5rem;
  text-align: left;
  border-bottom: 1px solid #e5e7eb;
}
.preview-table th {
  font-weight: 600;
  background: #f9fafb;
  font-size: 0.8125rem;
}
.empty-section {
  color: #6b7280;
  font-size: 0.875rem;
  font-style: italic;
}
.import-summary {
  font-size: 0.8125rem;
  color: #374151;
  padding: 0.5rem;
  background: #f9fafb;
  border-radius: 4px;
  margin-top: 0.75rem;
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid #e5e7eb;
}
.dialog-actions button {
  padding: 0.5rem 1rem;
  border-radius: 4px;
  border: 1px solid #d1d5db;
  background: white;
  cursor: pointer;
  font: inherit;
}
.btn-primary {
  background: #0066cc;
  color: white;
  border-color: #0066cc;
}
.btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.dialog-actions button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
