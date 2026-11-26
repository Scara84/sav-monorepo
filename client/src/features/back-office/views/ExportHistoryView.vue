<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  useSupplierExport,
  FALLBACK_SUPPLIERS,
  type ExportHistoryItem,
  type SupplierConfigEntry,
} from '../composables/useSupplierExport'

/**
 * Story 5.2 / 5.6 — Vue dédiée historique des exports fournisseurs.
 *
 * Pagination cursor-based (pattern Story 3.3 SavListView). Filtre
 * `?supplier=` en query string. Route protégée par
 * `meta.requiresAuth='operator'` + roles ['admin','sav-operator']
 * (cf. `src/router/index.js`).
 *
 * Story 5.6 — la liste des fournisseurs disponibles est chargée
 * dynamiquement via `useSupplierExport.fetchConfigList()` ; fallback
 * hardcodé en cas d'échec API. CR P1 — toast warning ajouté pour
 * parité avec `ExportSupplierModal` (sinon échec config-list silencieux).
 * CR P6 — `FALLBACK_SUPPLIERS` factorisé dans `useSupplierExport.ts`.
 */

const PAGE_SIZE = 20

const route = useRoute()
const router = useRouter()
const exp = useSupplierExport()

const supplier = ref<string>('')
const supplierOptions = ref<SupplierConfigEntry[]>([])
const items = ref<ExportHistoryItem[]>([])
const nextCursor = ref<string | null>(null)
const cursorStack = ref<Array<string | null>>([])
const toastMessage = ref<string | null>(null)
const initialized = ref(false)
const supplierLabel = computed(
  () =>
    supplierOptions.value.find((option) => option.code === supplier.value)?.label ??
    'Tous les fournisseurs'
)

async function loadConfigList(): Promise<void> {
  try {
    const list = await exp.fetchConfigList()
    supplierOptions.value = list.suppliers.length > 0 ? list.suppliers : FALLBACK_SUPPLIERS
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      // CR Story 5.6 P18 — defensive fallback (idem modal).
      if (supplierOptions.value.length === 0) supplierOptions.value = FALLBACK_SUPPLIERS
      return
    }
    supplierOptions.value = FALLBACK_SUPPLIERS
    // CR Story 5.6 P1 — feedback explicite (parité modal).
    toastMessage.value = 'Impossible de charger la liste — valeurs par défaut.'
  }
  // CR Story 5.6 P4 — révoquer une sélection deep-link `?supplier=TOTO`
  // qui ne correspond à aucun fournisseur connu (option fantôme dans le
  // select + filtre serveur sur code invalide → 0 résultats trompeurs).
  if (supplier.value && !supplierOptions.value.some((s) => s.code === supplier.value)) {
    supplier.value = ''
    updateQuery()
    toastMessage.value = `Filtre fournisseur « ${route.query['supplier']} » inconnu — réinitialisé.`
  }
}

function hydrateFromQuery(): void {
  const s = route.query['supplier']
  supplier.value = typeof s === 'string' ? s : ''
}

async function load(cursor: string | null = null): Promise<void> {
  const params: { supplier?: string; limit?: number; cursor?: string } = { limit: PAGE_SIZE }
  if (supplier.value) params.supplier = supplier.value
  if (cursor !== null) params.cursor = cursor
  try {
    const page = await exp.fetchHistory(params)
    items.value = page.items
    nextCursor.value = page.next_cursor
  } catch (e) {
    // W46 — un AbortError signifie qu'un nouveau load() a été déclenché
    // (changement filtre / pagination rapide) : silently ignore, le fetch
    // suivant produira l'état affiché.
    if (e instanceof Error && e.name === 'AbortError') return
    items.value = []
    nextCursor.value = null
  }
}

async function onNext(): Promise<void> {
  if (exp.fetchingHistory.value || nextCursor.value === null) return
  cursorStack.value.push(nextCursor.value)
  await load(nextCursor.value)
}

async function onPrev(): Promise<void> {
  if (exp.fetchingHistory.value || cursorStack.value.length === 0) return
  cursorStack.value.pop()
  const prev = cursorStack.value[cursorStack.value.length - 1] ?? null
  await load(prev)
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

function goBack(): void {
  void router.push({ name: 'admin-sav-list' })
}

onMounted(async () => {
  hydrateFromQuery()
  await loadConfigList()
  initialized.value = true
  await load()
})

function updateQuery(): void {
  // W45 (CR Story 5.2) — merger avec la query existante au lieu d'écraser :
  // un deep-link portant d'autres params (tracking, debug, etc.) reste
  // intact lors d'un changement de filtre.
  const nextQuery: Record<string, string | (string | null)[]> = {}
  for (const [k, val] of Object.entries(route.query)) {
    if (k === 'supplier') continue
    if (typeof val === 'string') nextQuery[k] = val
    else if (Array.isArray(val)) nextQuery[k] = val
  }
  if (supplier.value) nextQuery['supplier'] = supplier.value
  void router.replace({ query: nextQuery })
}

async function changeSupplier(): Promise<void> {
  updateQuery()
  cursorStack.value = []
  await load()
}
</script>

<template>
  <main class="export-history-view">
    <header class="header">
      <button type="button" class="back" @click="goBack">← Liste des SAV</button>
      <h1>Historique des exports fournisseurs</h1>
    </header>

    <p v-if="toastMessage" class="export-history-view__toast" role="status">{{ toastMessage }}</p>

    <div class="history-layout">
      <section class="filters">
        <label>
          <span>Fournisseur</span>
          <select
            v-model="supplier"
            class="sav-field"
            :disabled="!initialized"
            @change="changeSupplier"
            aria-label="Filtrer par fournisseur"
          >
            <option value="">Tous</option>
            <option v-for="s in supplierOptions" :key="s.code" :value="s.code">
              {{ s.label }}
            </option>
          </select>
        </label>
      </section>

      <section class="results" aria-labelledby="history-title">
        <h2 id="history-title">{{ supplierLabel }}</h2>
        <div v-if="exp.historyError.value">
          <p class="error" role="alert">{{ exp.historyError.value }}</p>
          <button type="button" @click="load(cursorStack.at(-1) ?? null)">
            Relire l’historique
          </button>
        </div>

        <template v-else-if="!initialized || exp.fetchingHistory.value">
          <div class="skeleton" aria-busy="true">Chargement…</div>
        </template>

        <template v-else-if="items.length === 0">
          <p class="empty" role="status">Aucun export pour {{ supplierLabel }}.</p>
        </template>

        <template v-else>
          <div class="table-scroll" tabindex="0" role="region" aria-label="Parcourir les exports">
            <table class="history-table" role="table" aria-label="Historique des exports">
              <thead>
                <tr>
                  <th scope="col">Fichier</th>
                  <th scope="col">Généré le</th>
                  <th scope="col">Fournisseur</th>
                  <th scope="col">Période</th>
                  <th scope="col">Lignes</th>
                  <th scope="col">Total</th>
                  <th scope="col">Opérateur</th>
                  <th scope="col">Téléchargement</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in items" :key="item.id">
                  <td class="filename">{{ item.file_name }}</td>
                  <td>{{ formatDate(item.created_at) }}</td>
                  <td>{{ item.supplier_code }}</td>
                  <td>{{ formatDate(item.period_from) }} → {{ formatDate(item.period_to) }}</td>
                  <td>{{ item.line_count }}</td>
                  <td>{{ formatEuros(item.total_amount_cents) }}</td>
                  <td>{{ item.generated_by_operator?.email_display_short ?? '—' }}</td>
                  <td>
                    <a
                      v-if="item.web_url"
                      :href="`/api/exports/supplier/${item.id}/download`"
                      target="_blank"
                      rel="noopener"
                      >Télécharger</a
                    >
                    <span v-else class="muted">indisponible</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
        <footer v-if="items.length || cursorStack.length" class="pagination">
          <button
            type="button"
            :disabled="cursorStack.length === 0 || exp.fetchingHistory.value"
            @click="onPrev"
          >
            Page précédente
          </button>
          <button
            type="button"
            :disabled="nextCursor === null || exp.fetchingHistory.value"
            @click="onNext"
          >
            Page suivante
          </button>
        </footer>
      </section>
    </div>
  </main>
</template>

<style scoped>
.export-history-view {
  max-width: 88rem;
  margin: auto;
  padding: clamp(1rem, 3vw, 2rem);
  color: var(--text-dark);
}
.header h1 {
  font-size: clamp(1.55rem, 3vw, 2.2rem);
  color: var(--text-dark);
}
.back,
a {
  color: #80400b;
  text-decoration: underline;
}
.history-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(12rem, 16rem);
  gap: 1rem;
  align-items: start;
}
.filters,
.results {
  min-width: 0;
  border: 1px solid #e7ddd0;
  border-radius: 1rem;
  padding: 1rem;
  background: white;
}
.filters {
  grid-column: 2;
  grid-row: 1;
  background: #fff8ef;
}
.filters label {
  display: grid;
  gap: 0.5rem;
  font-weight: 700;
}
.results {
  grid-column: 1;
  grid-row: 1;
}
.results h2 {
  font-size: 1.15rem;
  color: var(--text-dark);
  margin: 0 0 1rem;
}
.table-scroll {
  overflow-x: auto;
}
.history-table {
  width: 100%;
  min-width: 54rem;
  border-collapse: collapse;
  font-size: 0.875rem;
}
.history-table th,
.history-table td {
  padding: 0.65rem;
  text-align: left;
  border-bottom: 1px solid #e7ddd0;
}
.history-table th {
  background: #fff8ef;
}
.filename {
  overflow-wrap: anywhere;
  font-weight: 600;
}
.error {
  color: #90251b;
}
.muted {
  color: #625950;
}
.pagination {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-top: 1rem;
}
.pagination button {
  padding: 0.5rem 0.8rem;
  border: 1px solid #84796d;
  border-radius: 0.625rem;
}
button:disabled {
  opacity: 0.55;
}
:focus-visible {
  outline: 3px solid #80400b;
  outline-offset: 2px;
}
@media (max-width: 48rem) {
  .history-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .filters,
  .results {
    grid-column: auto;
    grid-row: auto;
  }
}
</style>
