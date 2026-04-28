<script setup lang="ts">
import { ref, onMounted, watch, computed } from 'vue'
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
// CR Story 5.6 P1 — toast warning pour parité avec `ExportSupplierModal`
// (AC #6 / AC #9). Sans ce feedback, l'opérateur travaille avec une liste
// statique sans le savoir si /config-list est down (ex. token expiré).
const toastMessage = ref<string | null>(null)
// CR Story 5.6 P3 — flag pour suppression de la première fire du watcher
// `supplier` pendant le setup initial (hydrateFromQuery + loadConfigList).
// Sans cela, watcher fire un `load(null)` concurrent qui est abortée par
// l'`await load(null)` explicite ligne suivante.
let suppressNextSupplierWatch = false

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
    suppressNextSupplierWatch = true
    supplier.value = ''
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
    throw e
  }
}

async function onNext(): Promise<void> {
  if (nextCursor.value === null) return
  cursorStack.value.push(nextCursor.value)
  await load(nextCursor.value)
}

async function onPrev(): Promise<void> {
  if (cursorStack.value.length === 0) return
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

const isEmpty = computed(() => !exp.fetchingHistory.value && items.value.length === 0)

onMounted(async () => {
  // CR Story 5.6 P3 — ordre rigoureux pour éviter race watcher-vs-load :
  //  1. hydrateFromQuery → set supplier (peut déclencher watcher en
  //     microtâche, on bloque via suppressNextSupplierWatch).
  //  2. loadConfigList → peut révoquer la sélection si supplier inconnu
  //     (P4) ; pose aussi suppressNextSupplierWatch.
  //  3. load(null) explicite → unique requête historique.
  suppressNextSupplierWatch = true
  hydrateFromQuery()
  cursorStack.value = []
  await loadConfigList()
  await load(null)
  // Reset le flag (au cas où aucune mutation supplier n'a eu lieu — le
  // watcher reprend son comportement normal au prochain changement
  // utilisateur).
  suppressNextSupplierWatch = false
})

watch(supplier, async (v) => {
  if (suppressNextSupplierWatch) {
    suppressNextSupplierWatch = false
    return
  }
  // W45 (CR Story 5.2) — merger avec la query existante au lieu d'écraser :
  // un deep-link portant d'autres params (tracking, debug, etc.) reste
  // intact lors d'un changement de filtre.
  const nextQuery: Record<string, string | (string | null)[]> = {}
  for (const [k, val] of Object.entries(route.query)) {
    if (k === 'supplier') continue
    if (typeof val === 'string') nextQuery[k] = val
    else if (Array.isArray(val)) nextQuery[k] = val
  }
  if (v) nextQuery['supplier'] = v
  void router.replace({ query: nextQuery })
  cursorStack.value = []
  await load(null)
})
</script>

<template>
  <main class="export-history-view">
    <header class="header">
      <button type="button" class="back" @click="goBack">← Retour</button>
      <h1>Historique des exports fournisseurs</h1>
    </header>

    <p v-if="toastMessage" class="export-history-view__toast" role="status">{{ toastMessage }}</p>

    <section class="filters">
      <label>
        <span>Fournisseur</span>
        <select v-model="supplier" aria-label="Filtrer par fournisseur">
          <option value="">Tous</option>
          <option v-for="s in supplierOptions" :key="s.code" :value="s.code">
            {{ s.label }}
          </option>
        </select>
      </label>
    </section>

    <p v-if="exp.historyError.value" class="error" role="alert">{{ exp.historyError.value }}</p>

    <template v-if="exp.fetchingHistory.value && items.length === 0">
      <div class="skeleton" aria-busy="true">Chargement…</div>
    </template>

    <template v-else-if="isEmpty">
      <p class="empty">Aucun export pour ces critères.</p>
    </template>

    <template v-else>
      <table class="history-table" role="table" aria-label="Historique des exports">
        <thead>
          <tr>
            <th scope="col">Généré le</th>
            <th scope="col">Fournisseur</th>
            <th scope="col">Période</th>
            <th scope="col">Fichier</th>
            <th scope="col">Lignes</th>
            <th scope="col">Total</th>
            <th scope="col">Opérateur</th>
            <th scope="col">Téléchargement</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in items" :key="item.id">
            <td>{{ formatDate(item.created_at) }}</td>
            <td>{{ item.supplier_code }}</td>
            <td>{{ formatDate(item.period_from) }} → {{ formatDate(item.period_to) }}</td>
            <td class="ellipsis">{{ item.file_name }}</td>
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

      <footer class="pagination">
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
    </template>
  </main>
</template>

<style scoped>
.export-history-view {
  padding: 1rem;
  max-width: 1400px;
  margin: 0 auto;
}
.header {
  display: flex;
  align-items: center;
  gap: 1rem;
}
.back {
  background: none;
  border: 1px solid #ccc;
  padding: 0.35rem 0.8rem;
  border-radius: 4px;
  cursor: pointer;
}
.filters {
  margin: 1rem 0;
}
.filters label {
  display: inline-flex;
  flex-direction: column;
  font-size: 0.875rem;
}
.filters select {
  padding: 0.4rem;
  border: 1px solid #ccc;
  border-radius: 4px;
}
.history-table {
  width: 100%;
  border-collapse: collapse;
  background: white;
}
.history-table th,
.history-table td {
  padding: 0.5rem;
  text-align: left;
  border-bottom: 1px solid #eee;
  font-size: 0.875rem;
}
.ellipsis {
  max-width: 300px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.empty {
  color: #666;
  margin-top: 1rem;
}
.error {
  color: #b00020;
}
.muted {
  color: #888;
}
.pagination {
  display: flex;
  gap: 0.75rem;
  margin-top: 1rem;
}
.pagination button {
  padding: 0.4rem 0.9rem;
  border: 1px solid #ccc;
  background: white;
  border-radius: 4px;
  cursor: pointer;
}
.pagination button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
