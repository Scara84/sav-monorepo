<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
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

const retrying = ref<Record<number, boolean>>({})
const toast = ref<{ kind: 'success' | 'error'; message: string } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null

function showToast(kind: 'success' | 'error', message: string): void {
  if (toastTimer !== null) clearTimeout(toastTimer)
  toast.value = { kind, message }
  toastTimer = setTimeout(() => {
    toast.value = null
    toastTimer = null
  }, 4000)
}

async function applyFilters(): Promise<void> {
  await erp.fetchPushes({ ...filters })
}

async function onRetry(push: ErpPushItem): Promise<void> {
  retrying.value[push.id] = true
  try {
    await erp.retryPush(push.id)
    showToast('success', `Push ${push.id} replanifié — le cron le reprendra.`)
  } catch {
    showToast('error', erp.error.value ?? 'Retry impossible.')
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

onMounted(async () => {
  await erp.fetchPushes({ status: 'failed', limit: 50 })
})
</script>

<template>
  <main class="erp-queue-view">
    <header class="header">
      <h1>File ERP</h1>
      <p class="subtitle">Pushes ERP sortants — surveiller les échecs et relancer manuellement.</p>
    </header>

    <!-- D-10 mode (a) : feature-flag — table absente -->
    <div v-if="erp.featureAvailable.value === false" class="banner-placeholder" role="status">
      <h2>File ERP non provisionnée</h2>
      <p>
        La table <code>erp_push_queue</code> n'existe pas encore en base — la livraison dépend de
        <strong>Story 7-1 (migration ERP push queue)</strong>, actuellement en attente du contrat
        ERP Fruitstock. Cette vue sera fonctionnelle dès que la migration sera appliquée — aucune
        action requise de votre part.
      </p>
    </div>

    <!-- D-10 mode (b) : table présente -->
    <div v-else class="erp-mode-active">
      <form class="filters" @submit.prevent="applyFilters">
        <div class="field">
          <label for="filter-status">Statut</label>
          <select id="filter-status" v-model="filters.status">
            <option value="failed">Échec</option>
            <option value="pending">En attente</option>
            <option value="success">Succès</option>
            <option value="all">Tous</option>
          </select>
        </div>
        <div class="actions">
          <button type="submit" class="btn primary" :disabled="erp.loading.value">
            {{ erp.loading.value ? 'Chargement…' : 'Filtrer' }}
          </button>
        </div>
      </form>

      <p v-if="erp.error.value" class="error">{{ erp.error.value }}</p>

      <table class="pushes-table" aria-label="Pushes ERP">
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
                {{ push.status }}
              </span>
            </td>
            <td>{{ push.attempts }}</td>
            <td>{{ formatDateTime(push.last_attempt_at) }}</td>
            <td>{{ truncateError(push.last_error) }}</td>
            <td>
              <button
                v-if="push.status === 'failed'"
                type="button"
                class="btn primary small"
                :data-retry-push="push.id"
                :disabled="retrying[push.id] === true"
                @click="onRetry(push)"
              >
                {{ retrying[push.id] ? 'Retry…' : 'Retenter' }}
              </button>
              <span v-else class="muted">—</span>
            </td>
          </tr>
          <tr v-if="erp.pushes.value.length === 0 && !erp.loading.value">
            <td colspan="6" class="muted center">Aucun push correspondant aux filtres.</td>
          </tr>
        </tbody>
      </table>
    </div>

    <transition name="toast">
      <div v-if="toast !== null" :class="['toast', toast.kind]" role="status" aria-live="polite">
        {{ toast.message }}
      </div>
    </transition>
  </main>
</template>

<style scoped>
.erp-queue-view {
  padding: 1.5rem;
  max-width: 1200px;
  margin: 0 auto;
}
.header h1 {
  margin: 0 0 0.25rem 0;
  font-size: 1.5rem;
}
.subtitle {
  margin: 0 0 1.5rem 0;
  color: #666;
  font-size: 0.95rem;
}
.banner-placeholder {
  background: #fff8e1;
  border: 1px solid #ffd54f;
  border-radius: 6px;
  padding: 1.5rem;
  margin: 1rem 0;
}
.banner-placeholder h2 {
  margin: 0 0 0.5rem 0;
  font-size: 1.15rem;
  color: #6d4c00;
}
.banner-placeholder p {
  margin: 0;
  color: #555;
  font-size: 0.95rem;
  line-height: 1.5;
}
.banner-placeholder code {
  background: #fff;
  padding: 1px 6px;
  border-radius: 3px;
  font-family: monospace;
}
.filters {
  display: flex;
  align-items: end;
  gap: 1rem;
  margin-bottom: 1rem;
  padding: 1rem;
  background: #fafafa;
  border: 1px solid #eee;
  border-radius: 4px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.field label {
  font-size: 0.85rem;
  font-weight: 600;
  color: #555;
}
.field select {
  padding: 0.4rem 0.6rem;
  font-size: 0.9rem;
  border: 1px solid #ccc;
  border-radius: 3px;
}
.btn {
  padding: 0.5rem 1rem;
  border-radius: 3px;
  border: none;
  font-size: 0.9rem;
  cursor: pointer;
}
.btn.primary {
  background: #f57c00;
  color: white;
  font-weight: 600;
}
.btn.primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.btn.small {
  padding: 0.35rem 0.7rem;
  font-size: 0.8rem;
}
.pushes-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.pushes-table th,
.pushes-table td {
  text-align: left;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid #f0f0f0;
}
.pushes-table th {
  background: #fafafa;
  font-weight: 600;
}
.status-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 0.8rem;
  font-weight: 600;
}
.status-failed {
  background: #ffebee;
  color: #c62828;
}
.status-pending {
  background: #fff3e0;
  color: #e65100;
}
.status-success {
  background: #e8f5e9;
  color: #2e7d32;
}
.muted {
  color: #999;
  font-size: 0.85rem;
}
.center {
  text-align: center;
  font-style: italic;
}
.error {
  color: #c62828;
  background: #ffebee;
  padding: 0.5rem 0.75rem;
  border-radius: 3px;
  margin: 0.5rem 0;
}
.toast {
  position: fixed;
  bottom: 1.5rem;
  right: 1.5rem;
  padding: 0.75rem 1.25rem;
  border-radius: 4px;
  color: white;
  font-size: 0.95rem;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  z-index: 999;
  max-width: 400px;
}
.toast.success {
  background: #2e7d32;
}
.toast.error {
  background: #c62828;
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
}
</style>
