<script setup lang="ts">
import { onMounted, watch, computed, nextTick, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDebounceFn } from '@vueuse/core'
import { useSavList } from '../composables/useSavList'
import { useSavExport, type ExportFormat } from '../composables/useSavExport'
import ExportSupplierModal from '../components/ExportSupplierModal.vue'

/**
 * Story 3.3 — Vue liste SAV back-office.
 *
 * - Filtres visuels (chips statut + champs texte + date-range + tag + facture).
 * - Recherche debounce 300 ms.
 * - Pagination cursor forward-only.
 * - URL state sync (filtres ↔ route.query, cursor hors URL).
 * - Accessibilité WCAG AA (focus visible, aria-live, role=alert, clavier).
 */

const STATUS_OPTIONS = [
  { key: 'draft', label: 'Brouillon', color: 'violet' },
  { key: 'received', label: 'Reçu', color: 'blue' },
  { key: 'in_progress', label: 'En cours', color: 'amber' },
  { key: 'validated', label: 'Validé', color: 'green' },
  { key: 'closed', label: 'Clos', color: 'gray' },
  { key: 'cancelled', label: 'Annulé', color: 'red' },
] as const

const STATUS_COLOR_CLASSES: Record<string, string> = {
  draft: 'bg-violet-100 text-violet-800 border-violet-300',
  received: 'bg-blue-100 text-blue-800 border-blue-300',
  in_progress: 'bg-amber-100 text-amber-800 border-amber-300',
  validated: 'bg-green-100 text-green-800 border-green-300',
  closed: 'bg-gray-100 text-gray-800 border-gray-300',
  cancelled: 'bg-red-100 text-red-800 border-red-300',
}

const route = useRoute()
const router = useRouter()
const list = useSavList()

// F28 (CR Epic 3) : whitelist statuts acceptés à l'hydratation URL.
// Un bookmark avec `?status=foo` ne doit pas crasher le premier fetch avec
// 400 VALIDATION_FAILED — on filtre silencieusement les valeurs inconnues.
const VALID_STATUSES = new Set([
  'draft',
  'received',
  'in_progress',
  'validated',
  'closed',
  'cancelled',
])

// F29 (CR Epic 3) : accepte `from`/`to` au format `YYYY-MM-DD` (natif HTML
// `<input type="date">`) OU ISO datetime complet. Autre → ignoré silencieusement.
const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z)?$/

// --- Initialisation depuis URL ---
function hydrateFiltersFromRoute(): void {
  const q = route.query
  const f = list.filters
  const statusRaw = q['status']
  const statusCandidates = Array.isArray(statusRaw)
    ? statusRaw.map(String)
    : typeof statusRaw === 'string' && statusRaw.length > 0
      ? [statusRaw]
      : []
  f.status = statusCandidates.filter((s) => VALID_STATUSES.has(s))
  f.q = typeof q['q'] === 'string' ? q['q'] : ''
  f.from = typeof q['from'] === 'string' && DATE_RE.test(q['from']) ? q['from'] : ''
  f.to = typeof q['to'] === 'string' && DATE_RE.test(q['to']) ? q['to'] : ''
  f.invoiceRef = typeof q['invoiceRef'] === 'string' ? q['invoiceRef'] : ''
  f.assignedTo = typeof q['assignedTo'] === 'string' ? q['assignedTo'] : ''
  f.tag = typeof q['tag'] === 'string' ? q['tag'] : ''
}

// --- Sync filtres → URL (replace, pas push, pour ne pas flooder l'historique) ---
const syncUrl = useDebounceFn(() => {
  const q: Record<string, string | string[]> = {}
  const f = list.filters
  if (f.status.length > 0) q['status'] = f.status.length === 1 ? f.status[0]! : f.status
  if (f.q.trim()) q['q'] = f.q.trim()
  if (f.from) q['from'] = f.from
  if (f.to) q['to'] = f.to
  if (f.invoiceRef.trim()) q['invoiceRef'] = f.invoiceRef.trim()
  if (f.assignedTo) q['assignedTo'] = f.assignedTo
  if (f.tag.trim()) q['tag'] = f.tag.trim()
  void router.replace({ query: q })
}, 300)

// Flag pour supprimer le premier tir du watcher (sinon double-fetch :
// hydrate URL → watcher fire → debounced fetch + onMounted fetch immédiat).
let ignoreFirstWatch = true

onMounted(() => {
  hydrateFiltersFromRoute()
  void list.fetchList({ resetCursor: true })
})

watch(
  () => ({ ...list.filters, status: [...list.filters.status] }),
  () => {
    if (ignoreFirstWatch) {
      ignoreFirstWatch = false
      return
    }
    syncUrl()
    void list.fetchDebounced()
  },
  { deep: true }
)

// --- Handlers UI ---
function toggleStatus(s: string): void {
  const f = list.filters
  const idx = f.status.indexOf(s)
  if (idx >= 0) f.status.splice(idx, 1)
  else f.status.push(s)
}

function onRowActivate(id: number): void {
  void router.push({ name: 'admin-sav-detail', params: { id } })
}

// F26 (CR Epic 3) : ne navigue pas si l'utilisateur sélectionne du texte
// dans une cellule (drag de selection → mouseup ≠ click intentionnel).
// On laisse aussi passer les clics sur contrôles interactifs enfants.
function onRowClick(e: MouseEvent, id: number): void {
  if (typeof window !== 'undefined') {
    const selection = window.getSelection()
    if (selection && selection.toString().length > 0) return
  }
  const target = e.target as HTMLElement | null
  if (target && target.closest('a, button, input, select, textarea')) return
  onRowActivate(id)
}

function onRowKeydown(e: KeyboardEvent, id: number): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    onRowActivate(id)
  }
}

async function goNextPage(): Promise<void> {
  const scrollBefore = window.scrollY
  await list.nextPage() // attend le fetch + re-render ; évite le scroll-restore qui race la peinture
  await nextTick()
  window.scrollTo({ top: scrollBefore })
}

function formatEur(cents: number): string {
  if (!Number.isFinite(cents)) return '—'
  return (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })
}

function formatDate(iso: string | null): string {
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

// --- Chips de filtres actifs ---
interface ActiveChip {
  key: string
  label: string
  clear: () => void
}
const activeChips = computed<ActiveChip[]>(() => {
  const f = list.filters
  const chips: ActiveChip[] = []
  for (const s of f.status) {
    const opt = STATUS_OPTIONS.find((o) => o.key === s)
    chips.push({
      key: `status:${s}`,
      label: `Statut : ${opt?.label ?? s}`,
      clear: () => {
        const idx = f.status.indexOf(s)
        if (idx >= 0) f.status.splice(idx, 1)
      },
    })
  }
  if (f.q.trim()) chips.push({ key: 'q', label: `Recherche : "${f.q}"`, clear: () => (f.q = '') })
  if (f.from)
    chips.push({ key: 'from', label: `Reçu depuis : ${f.from}`, clear: () => (f.from = '') })
  if (f.to) chips.push({ key: 'to', label: `Reçu jusqu'au : ${f.to}`, clear: () => (f.to = '') })
  if (f.invoiceRef.trim())
    chips.push({
      key: 'invoiceRef',
      label: `Facture : ${f.invoiceRef}`,
      clear: () => (f.invoiceRef = ''),
    })
  if (f.assignedTo)
    chips.push({
      key: 'assignedTo',
      label: `Assigné : ${f.assignedTo === 'unassigned' ? 'Non assigné' : f.assignedTo}`,
      clear: () => (f.assignedTo = ''),
    })
  if (f.tag.trim()) chips.push({ key: 'tag', label: `Tag : ${f.tag}`, clear: () => (f.tag = '') })
  return chips
})

// Pour annonce aria-live (résultats trouvés).
const ariaLiveMessage = computed(() =>
  list.loading.value
    ? 'Chargement en cours'
    : `${list.meta.value.count} résultat${list.meta.value.count > 1 ? 's' : ''} trouvé${list.meta.value.count > 1 ? 's' : ''}`
)

const showSkeleton = computed(() => list.loading.value && !list.initialLoadDone.value)
const showEmpty = computed(
  () => !list.loading.value && list.initialLoadDone.value && list.items.value.length === 0
)
const hasActiveFilters = computed(() => activeChips.value.length > 0)

function statusBadgeClass(s: string): string {
  return STATUS_COLOR_CLASSES[s] ?? 'bg-gray-100 text-gray-800 border-gray-300'
}

function statusLabel(s: string): string {
  return STATUS_OPTIONS.find((o) => o.key === s)?.label ?? s
}

function fullName(m: { firstName: string | null; lastName: string } | null): string {
  if (!m) return '—'
  return m.firstName ? `${m.firstName} ${m.lastName}` : m.lastName
}

// Story 5.2 AC #9 — Modal export fournisseur, déclenchée depuis la barre
// d'actions de la liste SAV.
const exportModalOpen = ref(false)
function openExportModal(): void {
  exportModalOpen.value = true
}
function closeExportModal(): void {
  exportModalOpen.value = false
}

// Story 5.4 AC #8/#9 — Export CSV/XLSX ad hoc des SAV filtrés.
// Bouton + menu déroulant CSV/XLSX dans la barre d'actions, à côté du bouton
// Export fournisseur (Story 5.2). Toast info/error géré in-place via
// `exportToast`. Pas de dépendance toast lib externe — mini overlay local.
const csvExport = useSavExport()
const exportMenuOpen = ref(false)
const exportToast = ref<{
  variant: 'info' | 'success' | 'error'
  message: string
  showXlsxAction?: boolean
} | null>(null)

function toggleExportMenu(): void {
  exportMenuOpen.value = !exportMenuOpen.value
}
function closeExportMenu(): void {
  exportMenuOpen.value = false
}
// P14 CR — auto-dismiss du toast success après 4s (info/error restent
// jusqu'à action user). Token capture pour ne pas dismiss un toast plus
// récent si l'utilisateur enchaîne plusieurs exports rapides.
let toastDismissToken = 0
function dismissToast(): void {
  exportToast.value = null
  toastDismissToken++
}
async function runExport(format: ExportFormat): Promise<void> {
  exportMenuOpen.value = false
  exportToast.value = null
  toastDismissToken++
  const result = await csvExport.downloadExport({
    format,
    filters: { ...list.filters, status: [...list.filters.status] },
  })
  if (result.status === 'downloaded') {
    exportToast.value = { variant: 'success', message: 'Export téléchargé.' }
    const token = ++toastDismissToken
    setTimeout(() => {
      if (toastDismissToken === token && exportToast.value?.variant === 'success') {
        exportToast.value = null
      }
    }, 4000)
  } else if (result.status === 'switch_suggested') {
    exportToast.value = {
      variant: 'info',
      message: `Plus de 5 000 lignes (${result.row_count ?? '?'}). L'export XLSX est recommandé.`,
      showXlsxAction: true,
    }
  } else if (result.status === 'empty') {
    // P13 CR — signal explicite « 0 ligne » au lieu d'un faux succès.
    exportToast.value = {
      variant: 'info',
      message: result.message ?? 'Aucun SAV ne correspond aux filtres sélectionnés.',
    }
  } else if (result.status === 'aborted') {
    // P7 CR — annulation user volontaire : pas de toast.
    return
  } else if (result.status === 'error') {
    exportToast.value = {
      variant: 'error',
      message: result.message ?? 'Erreur inattendue',
    }
  }
}
</script>

<template>
  <main class="sav-list-view" aria-labelledby="sav-list-title">
    <header class="header">
      <h1 id="sav-list-title">SAV — Liste</h1>
      <div class="header-actions">
        <p class="count">{{ list.meta.value.count }} résultats</p>
        <button type="button" class="btn-export" @click="openExportModal">
          Export fournisseur
        </button>
        <!-- Story 5.4 AC #8 — Bouton « Exporter » avec menu CSV/XLSX. -->
        <div class="export-csv-wrapper">
          <button
            type="button"
            class="btn-export"
            data-testid="btn-export-csv"
            :aria-expanded="exportMenuOpen"
            aria-haspopup="menu"
            :disabled="csvExport.downloading.value"
            @click="toggleExportMenu"
          >
            {{ csvExport.downloading.value ? 'Export en cours…' : 'Exporter' }}
          </button>
          <ul v-if="exportMenuOpen" class="export-menu" role="menu" @mouseleave="closeExportMenu">
            <li role="none">
              <button
                type="button"
                role="menuitem"
                data-testid="btn-export-csv-format"
                @click="runExport('csv')"
              >
                CSV
              </button>
            </li>
            <li role="none">
              <button
                type="button"
                role="menuitem"
                data-testid="btn-export-xlsx-format"
                @click="runExport('xlsx')"
              >
                XLSX
              </button>
            </li>
          </ul>
        </div>
      </div>
    </header>

    <!-- Toast simple, ancré sous le header (pas de dépendance externe). -->
    <div
      v-if="exportToast"
      class="export-toast"
      :class="`toast-${exportToast.variant}`"
      role="status"
      aria-live="polite"
      data-testid="export-toast"
    >
      <span>{{ exportToast.message }}</span>
      <button
        v-if="exportToast.showXlsxAction"
        type="button"
        class="btn-link"
        data-testid="btn-toast-xlsx"
        @click="runExport('xlsx')"
      >
        Générer XLSX
      </button>
      <button type="button" class="btn-link" aria-label="Fermer" @click="dismissToast">×</button>
    </div>

    <ExportSupplierModal :open="exportModalOpen" @close="closeExportModal" />

    <!-- zone off-screen pour annonces lecteur d'écran -->
    <div class="sr-only" aria-live="polite" role="status">{{ ariaLiveMessage }}</div>

    <section class="filters" aria-label="Filtres">
      <label class="search">
        <span class="sr-only">Rechercher dans les SAV</span>
        <input
          type="search"
          v-model="list.filters.q"
          aria-label="Rechercher dans les SAV"
          placeholder="Référence, facture, client, tag..."
          :aria-busy="list.loading.value"
        />
      </label>

      <fieldset class="status-chips">
        <legend class="sr-only">Filtrer par statut</legend>
        <button
          v-for="opt in STATUS_OPTIONS"
          :key="opt.key"
          type="button"
          :class="[
            'chip',
            statusBadgeClass(opt.key),
            { active: list.filters.status.includes(opt.key) },
          ]"
          :aria-pressed="list.filters.status.includes(opt.key)"
          @click="toggleStatus(opt.key)"
        >
          {{ opt.label }}
        </button>
      </fieldset>

      <label class="date-from">
        <span>Reçu du</span>
        <input type="date" v-model="list.filters.from" aria-label="Date de réception minimum" />
      </label>

      <label class="date-to">
        <span>Reçu au</span>
        <input type="date" v-model="list.filters.to" aria-label="Date de réception maximum" />
      </label>

      <label class="assignee">
        <span>Assigné à</span>
        <select v-model="list.filters.assignedTo" aria-label="Filtrer par opérateur assigné">
          <option value="">Tous</option>
          <option value="unassigned">Non assigné</option>
        </select>
      </label>

      <label class="tag">
        <span>Tag</span>
        <input type="text" v-model="list.filters.tag" maxlength="64" aria-label="Filtrer par tag" />
      </label>

      <label class="invoice">
        <span>Facture</span>
        <input
          type="text"
          v-model="list.filters.invoiceRef"
          maxlength="64"
          aria-label="Filtrer par référence facture"
        />
      </label>
    </section>

    <section v-if="hasActiveFilters" class="active-filters" aria-label="Filtres actifs">
      <button
        v-for="chip in activeChips"
        :key="chip.key"
        type="button"
        class="active-chip"
        @click="chip.clear()"
      >
        {{ chip.label }} <span aria-hidden="true">×</span>
      </button>
      <button type="button" class="clear-all" @click="list.clearFilters()">
        Effacer tous les filtres
      </button>
    </section>

    <p v-if="list.error.value" class="error" role="alert">
      {{ list.error.value }}
      <button type="button" @click="list.fetchList({ resetCursor: true })">Réessayer</button>
    </p>

    <template v-if="showSkeleton">
      <div class="skeleton" aria-busy="true" aria-label="Chargement">
        <div v-for="n in 5" :key="n" class="skeleton-row" />
      </div>
    </template>

    <template v-else-if="showEmpty">
      <div class="empty" role="status">
        <p v-if="hasActiveFilters">Aucun SAV ne correspond à vos filtres.</p>
        <p v-else>Aucun SAV enregistré pour l'instant.</p>
        <button v-if="hasActiveFilters" type="button" @click="list.clearFilters()">
          Effacer les filtres
        </button>
      </div>
    </template>

    <template v-else>
      <table class="sav-table" role="table" aria-label="Liste des SAV">
        <thead>
          <tr>
            <th scope="col">Référence</th>
            <th scope="col">Statut</th>
            <th scope="col">Adhérent</th>
            <th scope="col">Groupe</th>
            <th scope="col">Facture</th>
            <th scope="col">Reçu le</th>
            <th scope="col">Assigné à</th>
            <th scope="col">Montant</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in list.items.value"
            :key="row.id"
            tabindex="0"
            role="button"
            :aria-label="`Ouvrir le SAV ${row.reference}`"
            class="sav-row"
            @click="onRowClick($event, row.id)"
            @keydown="onRowKeydown($event, row.id)"
          >
            <td>{{ row.reference }}</td>
            <td>
              <span :class="['status-badge', statusBadgeClass(row.status)]">
                {{ statusLabel(row.status) }}
              </span>
            </td>
            <td>{{ fullName(row.member) }}</td>
            <td>{{ row.group?.name ?? '—' }}</td>
            <td>{{ row.invoiceRef || '—' }}</td>
            <td>{{ formatDate(row.receivedAt) }}</td>
            <td>{{ row.assignee?.displayName ?? '—' }}</td>
            <td>{{ formatEur(row.totalAmountCents) }}</td>
          </tr>
        </tbody>
      </table>

      <footer class="pagination">
        <button type="button" disabled aria-label="Page précédente (non disponible V1)">
          Page précédente
        </button>
        <button type="button" :disabled="list.meta.value.cursor === null" @click="goNextPage">
          Page suivante
        </button>
      </footer>
    </template>
  </main>
</template>

<style scoped>
.sav-list-view {
  padding: 1rem;
  max-width: 1400px;
  margin: 0 auto;
}
.header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.count {
  color: #666;
}
.header-actions {
  display: flex;
  gap: 1rem;
  align-items: center;
}
.btn-export {
  background: #f57c00;
  color: white;
  border: none;
  padding: 0.5rem 1rem;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 500;
}
.btn-export:hover {
  background: #e65100;
}
.btn-export:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
/* Story 5.4 — menu déroulant Export CSV/XLSX */
.export-csv-wrapper {
  position: relative;
}
.export-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  background: white;
  border: 1px solid #ddd;
  border-radius: 4px;
  list-style: none;
  margin: 0;
  padding: 0.25rem 0;
  min-width: 6rem;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
  z-index: 20;
}
.export-menu li {
  display: block;
}
.export-menu button {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: 0;
  padding: 0.5rem 0.75rem;
  cursor: pointer;
}
.export-menu button:hover {
  background: #f5f5f5;
}
.export-toast {
  margin: 0.5rem 1rem;
  padding: 0.5rem 0.75rem;
  border-radius: 4px;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.toast-info {
  background: #e3f2fd;
  border: 1px solid #90caf9;
}
.toast-success {
  background: #e8f5e9;
  border: 1px solid #a5d6a7;
}
.toast-error {
  background: #ffebee;
  border: 1px solid #ef9a9a;
}
.btn-link {
  background: transparent;
  border: 0;
  color: inherit;
  cursor: pointer;
  padding: 0.25rem 0.5rem;
  text-decoration: underline;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  border: 0;
}
.filters {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0.75rem;
  margin: 1rem 0;
}
.filters label {
  display: flex;
  flex-direction: column;
  font-size: 0.875rem;
}
.filters input,
.filters select {
  padding: 0.5rem;
  border: 1px solid #ccc;
  border-radius: 4px;
}
.filters input:focus-visible,
.filters select:focus-visible,
.chip:focus-visible,
.sav-row:focus-visible,
button:focus-visible {
  outline: 2px solid #0066cc;
  outline-offset: 2px;
}
.status-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  border: 0;
  padding: 0;
  grid-column: 1 / -1;
}
.chip {
  padding: 0.25rem 0.75rem;
  border: 1px solid;
  border-radius: 999px;
  cursor: pointer;
  background: transparent;
  font-size: 0.875rem;
}
.chip.active {
  font-weight: 600;
  box-shadow: inset 0 0 0 2px currentColor;
}
.bg-violet-100 {
  background: #f3e8ff;
  color: #6b21a8;
  border-color: #d8b4fe;
}
.bg-blue-100 {
  background: #dbeafe;
  color: #1e40af;
  border-color: #93c5fd;
}
.bg-amber-100 {
  background: #fef3c7;
  color: #92400e;
  border-color: #fcd34d;
}
.bg-green-100 {
  background: #dcfce7;
  color: #166534;
  border-color: #86efac;
}
.bg-gray-100 {
  background: #f3f4f6;
  color: #374151;
  border-color: #d1d5db;
}
.bg-red-100 {
  background: #fee2e2;
  color: #991b1b;
  border-color: #fca5a5;
}
.active-filters {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  align-items: center;
}
.active-chip {
  background: #eef;
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  border: 1px solid #99c;
  cursor: pointer;
}
.clear-all {
  margin-left: auto;
  background: transparent;
  border: 0;
  color: #0066cc;
  cursor: pointer;
  text-decoration: underline;
}
.error {
  background: #fee;
  padding: 0.75rem;
  border: 1px solid #c00;
  border-radius: 4px;
  color: #800;
  margin: 1rem 0;
}
.sav-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 1rem;
}
.sav-table th,
.sav-table td {
  text-align: left;
  padding: 0.75rem;
  border-bottom: 1px solid #eee;
}
.sav-row {
  cursor: pointer;
}
.sav-row:hover,
.sav-row:focus {
  background: #f5f8ff;
}
.status-badge {
  display: inline-block;
  padding: 0.125rem 0.5rem;
  border: 1px solid;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 600;
}
.pagination {
  display: flex;
  justify-content: space-between;
  padding: 1rem 0;
}
.pagination button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.skeleton {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 1rem;
}
.skeleton-row {
  height: 2.5rem;
  background: linear-gradient(90deg, #eee, #f5f5f5, #eee);
  animation: shimmer 1.5s infinite;
  border-radius: 4px;
}
@keyframes shimmer {
  0% {
    background-position: -200px 0;
  }
  100% {
    background-position: 200px 0;
  }
}
.empty {
  padding: 2rem;
  text-align: center;
  color: #666;
}
</style>
