<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import {
  useAdminErpQueue,
  type ErpPushItem,
  type ErpQueueFilters,
} from '../../composables/useAdminErpQueue'

/**
 * Story 7-5 — Admin ERP Queue (D-10 feature-flag).
 *
 * Mode (a) : table erp_push_queue absente → banner placeholder.
 * Mode (b) : table provisionnée → table pushes + bouton Retenter (D-8 + D-9).
 */

const erp = useAdminErpQueue()

const filters = reactive<ErpQueueFilters>({
  status: 'failed',
  limit: 50,
})

const statusLabels = { failed: 'Échec', pending: 'En attente', success: 'Succès', all: 'Tous' }
const appliedStatus = ref<keyof typeof statusLabels>('failed')
const retrying = ref<Record<number, boolean>>({})
const toast = ref<{ kind: 'success' | 'error'; message: string } | null>(null)
const busy = computed(() => erp.loading.value || Object.values(retrying.value).some(Boolean))

async function applyFilters(): Promise<void> {
  if (busy.value) return
  const status = filters.status ?? 'all'
  await erp.fetchPushes({ ...filters, status })
  if (!erp.error.value) appliedStatus.value = status
}

async function onRetry(push: ErpPushItem): Promise<void> {
  if (busy.value || push.status !== 'failed') return
  retrying.value[push.id] = true
  try {
    await erp.retryPush(push.id, { removeFromList: appliedStatus.value === 'failed' })
    toast.value = { kind: 'success', message: `Synchronisation n° ${push.id} replanifiée.` }
  } catch {
    toast.value = { kind: 'error', message: erp.retryError.value ?? 'Relance impossible.' }
  } finally {
    retrying.value[push.id] = false
  }
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

/**
 * D-10 privacy : le `last_error` peut contenir des indices sur des champs
 * sensibles (`signature`, `idempotency_key`, `payload`). On les neutralise
 * dans l'affichage UI pour éviter toute fuite involontaire (le admin peut
 * accéder au champ raw via debug DB si besoin).
 */
const SENSITIVE_KEYWORDS = /(signature|idempotency_key|payload)/gi
function truncateError(s: string | null): string {
  if (s === null) return '—'
  const masked = s.replace(SENSITIVE_KEYWORDS, '***')
  return masked.length > 100 ? masked.slice(0, 100) + '…' : masked
}

onMounted(applyFilters)
</script>

<template>
  <main class="erp-queue-view">
    <header class="header">
      <h1>File ERP</h1>
    </header>
    <div class="erp-layout">
      <form class="filters" @submit.prevent="applyFilters">
        <div class="field">
          <label for="filter-status">Statut</label>
          <select class="sav-field" id="filter-status" v-model="filters.status">
            <option value="failed">Échec</option>
            <option value="pending">En attente</option>
            <option value="success">Succès</option>
            <option value="all">Tous</option>
          </select>
        </div>
        <div class="actions">
          <button type="submit" class="sav-primary" :disabled="busy">
            {{ erp.loading.value ? 'Chargement…' : 'Filtrer' }}
          </button>
        </div>
      </form>

      <section class="results" aria-labelledby="queue-title">
        <h2 id="queue-title">Synchronisations ERP</h2>
        <p v-if="erp.loading.value" role="status">Lecture de la file…</p>
        <p v-else-if="erp.error.value" class="error" role="alert">
          Lecture impossible. {{ erp.error.value }}
        </p>
        <div v-else-if="!erp.featureAvailable.value" class="banner-placeholder" role="status">
          <h3>File ERP non provisionnée</h3>
          <p>La file de synchronisation ERP n’est pas encore installée.</p>
        </div>
        <template v-else>
          <p class="filter-summary" role="status">
            Filtre appliqué · {{ statusLabels[appliedStatus] }}
          </p>
          <p v-if="!erp.pushes.value.length" role="status">
            Aucune synchronisation pour ce filtre.
          </p>
          <div
            v-else
            class="table-scroll"
            tabindex="0"
            role="region"
            aria-label="Parcourir les synchronisations ERP"
          >
            <table class="pushes-table" aria-label="Synchronisations ERP">
              <thead>
                <tr>
                  <th scope="col">SAV</th>
                  <th scope="col">Statut</th>
                  <th scope="col">Tentatives</th>
                  <th scope="col">Dernier essai</th>
                  <th scope="col">Erreur</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="push in erp.pushes.value" :key="push.id">
                  <td>
                    <div>{{ push.sav_reference ?? `SAV #${push.sav_id}` }}</div>
                    <div class="muted">push #{{ push.id }}</div>
                  </td>
                  <td>
                    <span :class="['status-badge', `status-${push.status}`]">
                      {{ statusLabels[push.status] }}
                    </span>
                  </td>
                  <td>{{ push.attempts }}</td>
                  <td>{{ formatDateTime(push.last_attempt_at) }}</td>
                  <td>{{ truncateError(push.last_error) }}</td>
                  <td>
                    <button
                      v-if="push.status === 'failed'"
                      type="button"
                      class="sav-primary"
                      :data-retry-push="push.id"
                      :disabled="busy"
                      @click="onRetry(push)"
                    >
                      {{ retrying[push.id] ? 'Relance…' : 'Retenter' }}
                    </button>
                    <span v-else class="muted">—</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </section>
    </div>

    <div v-if="toast" :class="['toast', toast.kind]">
      <span role="status">{{ toast.message }}</span>
      <button type="button" aria-label="Fermer le message de relance" @click="toast = null">
        Fermer
      </button>
    </div>
  </main>
</template>

<style scoped>
.erp-queue-view {
  max-width: 82rem;
  margin: auto;
  padding: clamp(1rem, 3vw, 2rem);
  color: var(--text-dark);
}
.header h1 {
  color: var(--text-dark);
  font-size: clamp(1.55rem, 3vw, 2.2rem);
}
.erp-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(12rem, 16rem);
  align-items: start;
  gap: 1rem;
}
.filters,
.results {
  min-width: 0;
  padding: 1rem;
  border: 1px solid #e7ddd0;
  border-radius: 1rem;
  background: white;
}
.filters {
  grid-column: 2;
  grid-row: 1;
  display: grid;
  gap: 0.75rem;
  background: #fff8ef;
}
.field {
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
  margin: 0 0 0.5rem;
}
.filter-summary,
.muted {
  color: #625950;
}
.filter-summary {
  margin-bottom: 1rem;
}
.table-scroll {
  overflow-x: auto;
}
.pushes-table {
  width: 100%;
  min-width: 44rem;
  border-collapse: collapse;
  font-size: 0.875rem;
}
.pushes-table th,
.pushes-table td {
  padding: 0.65rem;
  border-bottom: 1px solid #e7ddd0;
  text-align: left;
  overflow-wrap: anywhere;
}
.pushes-table th {
  background: #fff8ef;
}
.status-badge {
  display: inline-block;
  border-radius: 1rem;
  padding: 0.25rem 0.6rem;
  font-weight: 600;
}
.status-failed,
.error {
  background: #fff0ee;
  color: #90251b;
}
.status-pending,
.banner-placeholder {
  background: #fff3dc;
  color: #714611;
}
.banner-placeholder,
.toast {
  border-radius: 0.625rem;
  padding: 0.8rem 1rem;
}
.banner-placeholder h3 {
  color: inherit;
}
.status-success,
.toast.success {
  background: #e8f5e9;
  color: #235d30;
}
.toast {
  position: fixed;
  inset: auto 1rem max(1rem, env(safe-area-inset-bottom)) auto;
  z-index: 100;
  display: flex;
  align-items: center;
  gap: 1rem;
  max-width: calc(100vw - 2rem);
  overflow-wrap: anywhere;
  border: 1px solid currentColor;
}
.toast button {
  text-decoration: underline;
}
:focus-visible {
  outline: 3px solid #80400b;
  outline-offset: 2px;
}
button:disabled {
  opacity: 0.55;
}
@media (max-width: 48rem) {
  .erp-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .filters,
  .results {
    grid-column: auto;
    grid-row: auto;
  }
}
</style>
