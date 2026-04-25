<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import {
  useSupplierExport,
  type ExportHistoryItem,
  type ExportResult,
} from '../composables/useSupplierExport'

/**
 * Story 5.2 AC #9/#10 — Modal de déclenchement export fournisseur.
 *
 * Composant Vue 3 Composition API + TypeScript. Affiche :
 *  - Select fournisseur (V1 hardcodé RUFINO ; Story 5.6 ajoute MARTINEZ via
 *    endpoint config-list côté API).
 *  - Date-range (défaut : mois précédent clos via firstDayOfPrevMonth /
 *    lastDayOfPrevMonth).
 *  - Bouton Générer (spinner pendant requête).
 *  - Zone erreur (code → message FR via `useSupplierExport.error`).
 *  - Liste historique (10 derniers, rafraîchie après succès).
 *
 * Émet `close` quand l'opérateur ferme, et `generated` quand un export
 * réussit (payload : le résultat API, utile pour tests / parent).
 */

interface Props {
  open: boolean
}
const props = defineProps<Props>()
// eslint-disable-next-line no-unused-vars
const emit = defineEmits<{
  // eslint-disable-next-line no-unused-vars
  (e: 'close'): void
  // eslint-disable-next-line no-unused-vars
  (e: 'generated', result: ExportResult): void
}>()

const SUPPLIERS = ['RUFINO'] as const
const HISTORY_LIMIT = 10

const exp = useSupplierExport()

const supplier = ref<string>(SUPPLIERS[0])
const periodFrom = ref<string>('')
const periodTo = ref<string>('')
const history = ref<ExportHistoryItem[]>([])
const historyLoading = ref(false)
const toastMessage = ref<string | null>(null)

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}
function toInputDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}
function firstDayOfPrevMonth(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
}
function lastDayOfPrevMonth(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))
}

function resetDates(): void {
  periodFrom.value = toInputDate(firstDayOfPrevMonth())
  periodTo.value = toInputDate(lastDayOfPrevMonth())
}

async function loadHistory(): Promise<void> {
  if (!supplier.value) return
  historyLoading.value = true
  try {
    const page = await exp.fetchHistory({ supplier: supplier.value, limit: HISTORY_LIMIT })
    history.value = page.items
  } catch {
    // error déjà dans exp.error
    history.value = []
  } finally {
    historyLoading.value = false
  }
}

async function onSubmit(): Promise<void> {
  // CR 5.2 P9 — re-entry guard. Un double-click avant que Vue ait re-
  // rendu le :disabled du bouton peut déclencher 2 `onSubmit` concurrents.
  if (exp.loading.value) return
  toastMessage.value = null
  if (!supplier.value) return
  const fromDate = new Date(periodFrom.value + 'T00:00:00Z')
  const toDate = new Date(periodTo.value + 'T00:00:00Z')
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return
  }
  try {
    const result = await exp.generateExport({
      supplier: supplier.value,
      period_from: fromDate,
      period_to: toDate,
    })
    toastMessage.value = `Export généré — ${result.line_count} ligne${result.line_count > 1 ? 's' : ''}, ${formatEuros(result.total_amount_cents)}`
    emit('generated', result)
    // CR 5.2 P10 — `window.open(url, '_blank', 'noopener,noreferrer')`
    // au lieu de `window.location.href = url` : évite de sortir l'opérateur
    // du SPA (sinon `loadHistory()` ne finit jamais son reload).
    // Fallback `window.location.href` si le popup est bloqué par le
    // navigateur — l'opérateur voit le téléchargement sans perdre d'état.
    if (typeof window !== 'undefined' && result.web_url) {
      const popup = window.open(result.web_url, '_blank', 'noopener,noreferrer')
      if (!popup) {
        window.location.href = result.web_url
      }
    }
    await loadHistory()
  } catch {
    // Message affiché via exp.error (binding template).
  }
}

function formatEuros(totalCentsStr: string | number): string {
  const cents = typeof totalCentsStr === 'number' ? totalCentsStr : Number(totalCentsStr)
  if (!Number.isFinite(cents)) return '—'
  return (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })
}

function formatDate(iso: string): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    })
  } catch {
    return iso
  }
}

const canSubmit = computed(
  () =>
    !exp.loading.value &&
    supplier.value.length > 0 &&
    periodFrom.value.length > 0 &&
    periodTo.value.length > 0
)

onMounted(() => {
  resetDates()
  if (props.open) void loadHistory()
})

watch(
  () => props.open,
  (v) => {
    if (v) {
      resetDates()
      toastMessage.value = null
      void loadHistory()
    }
  }
)

watch(supplier, () => {
  void loadHistory()
})

function onClose(): void {
  emit('close')
}
</script>

<template>
  <div
    v-if="props.open"
    class="export-modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="export-modal-title"
  >
    <div class="export-modal__backdrop" @click="onClose" aria-hidden="true"></div>
    <div class="export-modal__dialog">
      <header class="export-modal__header">
        <h2 id="export-modal-title">Export fournisseur</h2>
        <button type="button" class="export-modal__close" @click="onClose" aria-label="Fermer">
          ×
        </button>
      </header>

      <form class="export-modal__form" @submit.prevent="onSubmit">
        <label>
          <span>Fournisseur</span>
          <select v-model="supplier" :disabled="exp.loading.value" aria-label="Fournisseur">
            <option v-for="s in SUPPLIERS" :key="s" :value="s">{{ s }}</option>
          </select>
        </label>

        <label>
          <span>Date de début</span>
          <input
            type="date"
            v-model="periodFrom"
            :disabled="exp.loading.value"
            aria-label="Date de début de période"
          />
        </label>

        <label>
          <span>Date de fin</span>
          <input
            type="date"
            v-model="periodTo"
            :disabled="exp.loading.value"
            aria-label="Date de fin de période"
          />
        </label>

        <div class="export-modal__actions">
          <button
            type="submit"
            class="btn btn-primary"
            :disabled="!canSubmit"
            :aria-busy="exp.loading.value"
          >
            <span v-if="exp.loading.value" class="spinner" aria-hidden="true"></span>
            {{ exp.loading.value ? 'Génération en cours…' : 'Générer' }}
          </button>
        </div>
      </form>

      <p v-if="exp.error.value" class="export-modal__error" role="alert">{{ exp.error.value }}</p>
      <p v-if="toastMessage" class="export-modal__toast" role="status">{{ toastMessage }}</p>

      <section class="export-modal__history" aria-label="Historique des exports">
        <h3>Historique</h3>
        <p v-if="historyLoading" class="muted">Chargement…</p>
        <p v-else-if="history.length === 0" class="muted">Aucun export pour ce fournisseur.</p>
        <ul v-else class="history-list">
          <li v-for="item in history" :key="item.id">
            <span class="hist-date">{{ formatDate(item.created_at) }}</span>
            <span class="hist-period">{{ item.period_from }} → {{ item.period_to }}</span>
            <span class="hist-count"
              >{{ item.line_count }} ligne{{ item.line_count > 1 ? 's' : '' }}</span
            >
            <span class="hist-total">{{ formatEuros(item.total_amount_cents) }}</span>
            <a
              v-if="item.web_url"
              :href="`/api/exports/supplier/${item.id}/download`"
              target="_blank"
              rel="noopener"
              >Télécharger</a
            >
            <span v-else class="muted">Fichier indisponible</span>
          </li>
        </ul>
        <router-link class="history-all" :to="{ name: 'admin-export-history' }"
          >Voir tout</router-link
        >
      </section>
    </div>
  </div>
</template>

<style scoped>
.export-modal {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.export-modal__backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
}
.export-modal__dialog {
  position: relative;
  background: white;
  padding: 1.25rem 1.5rem;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
  width: min(560px, 92vw);
  max-height: 90vh;
  overflow: auto;
}
.export-modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.5rem;
}
.export-modal__close {
  background: transparent;
  border: none;
  font-size: 1.5rem;
  cursor: pointer;
}
.export-modal__form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}
.export-modal__form label {
  display: flex;
  flex-direction: column;
  font-size: 0.875rem;
}
.export-modal__form input,
.export-modal__form select {
  padding: 0.45rem;
  border: 1px solid #ccc;
  border-radius: 4px;
}
.export-modal__actions {
  grid-column: 1 / -1;
  display: flex;
  justify-content: flex-end;
  margin-top: 0.5rem;
}
.btn-primary {
  background: #f57c00;
  color: white;
  border: none;
  padding: 0.5rem 1rem;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 500;
}
.btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.spinner {
  display: inline-block;
  width: 0.9rem;
  height: 0.9rem;
  border: 2px solid white;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-right: 0.3rem;
  vertical-align: -2px;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.export-modal__error {
  color: #b00020;
  margin-top: 0.75rem;
  font-size: 0.9rem;
}
.export-modal__toast {
  color: #1b5e20;
  margin-top: 0.75rem;
  font-size: 0.9rem;
}
.export-modal__history {
  margin-top: 1rem;
  border-top: 1px solid #eee;
  padding-top: 0.75rem;
}
.export-modal__history h3 {
  font-size: 1rem;
  margin: 0 0 0.5rem;
}
.history-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.history-list li {
  display: grid;
  grid-template-columns: 90px 1fr 70px 90px auto;
  gap: 0.5rem;
  font-size: 0.85rem;
  align-items: center;
}
.muted {
  color: #888;
  font-size: 0.85rem;
}
.history-all {
  display: inline-block;
  margin-top: 0.6rem;
  font-size: 0.85rem;
}
</style>
