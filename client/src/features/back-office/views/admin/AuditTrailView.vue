<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useAdminAuditTrail, type AuditTrailFilters } from '../../composables/useAdminAuditTrail'
import AuditDiffPanel from '../../components/AuditDiffPanel.vue'

/**
 * Story 7-5 — Admin Audit Trail (D-1 → D-7).
 *
 * Filtres : entity_type whitelist, actor regex, from/to dates, action.
 * Pagination : cursor-based « Charger plus ».
 * Diff : panel collapsible D-5 inline (state per-row `expandedDiff[id]`).
 */

const ENTITY_TYPES = [
  'sav',
  'sav_line',
  'sav_file',
  'sav_comment',
  'credit_note',
  'email_outbox',
  'erp_push',
  'rgpd_export',
  'operator',
  'operators',
  'setting',
  'settings',
  'member',
  'members',
  'group',
  'groups',
  'validation_list',
  'validation_lists',
  'product',
  'products',
] as const

const audit = useAdminAuditTrail()

const filters = reactive<AuditTrailFilters>({
  limit: 50,
})

const expandedDiff = ref<Record<number, boolean>>({})

function toggleDiff(id: number): void {
  expandedDiff.value[id] = !expandedDiff.value[id]
}

async function applyFilters(): Promise<void> {
  expandedDiff.value = {}
  await audit.fetchEntries({ ...filters })
}

async function loadMore(): Promise<void> {
  await audit.loadMore({ ...filters })
}

function formatDateTime(iso: string): string {
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

onMounted(async () => {
  await audit.fetchEntries({ limit: 50 })
})
</script>

<template>
  <main class="audit-trail-view">
    <header class="header">
      <h1>Journal d'audit</h1>
      <p class="subtitle">
        Trace des actions (création / mise à jour / rotation / retry) — immutable 3 ans.
      </p>
    </header>

    <form class="filters" @submit.prevent="applyFilters">
      <div class="field">
        <label for="filter-entity-type">Entité</label>
        <select id="filter-entity-type" v-model="filters.entity_type" data-filter-entity-type>
          <option :value="undefined">— Toutes —</option>
          <option v-for="t in ENTITY_TYPES" :key="t" :value="t">{{ t }}</option>
        </select>
      </div>
      <div class="field">
        <label for="filter-actor">Acteur</label>
        <input
          id="filter-actor"
          v-model="filters.actor"
          type="text"
          placeholder="operator:42, member:7, system:cron"
          data-filter-actor
        />
      </div>
      <div class="field">
        <label for="filter-from">Du</label>
        <input id="filter-from" v-model="filters.from" type="date" data-filter-from />
      </div>
      <div class="field">
        <label for="filter-to">Au (inclus)</label>
        <input id="filter-to" v-model="filters.to" type="date" data-filter-to />
      </div>
      <div class="field">
        <label for="filter-action">Action</label>
        <input
          id="filter-action"
          v-model="filters.action"
          type="text"
          maxlength="50"
          placeholder="created, rotated, retry_manual…"
        />
      </div>
      <div class="actions">
        <button type="submit" class="btn primary" :disabled="audit.loading.value">
          {{ audit.loading.value ? 'Chargement…' : 'Filtrer' }}
        </button>
      </div>
    </form>

    <p v-if="audit.error.value" class="error">{{ audit.error.value }}</p>

    <table class="entries-table" aria-label="Entrées audit_trail">
      <thead>
        <tr>
          <th scope="col">Date</th>
          <th scope="col">Entité</th>
          <th scope="col">Action</th>
          <th scope="col">Acteur</th>
          <th scope="col">Diff</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="entry in audit.entries.value" :key="entry.id">
          <tr>
            <td>{{ formatDateTime(entry.created_at) }}</td>
            <td>
              <code>{{ entry.entity_type }}</code>
              <span class="muted">#{{ entry.entity_id }}</span>
            </td>
            <td>{{ entry.action }}</td>
            <td>
              <span class="actor-badge">{{ audit.formatActor(entry) }}</span>
            </td>
            <td>
              <button
                type="button"
                class="btn ghost small"
                :data-diff-toggle="entry.id"
                @click="toggleDiff(entry.id)"
              >
                {{ expandedDiff[entry.id] ? 'Masquer diff' : 'Voir diff' }}
              </button>
            </td>
          </tr>
          <tr v-if="expandedDiff[entry.id]" class="diff-row">
            <td colspan="5">
              <AuditDiffPanel :diff="entry.diff" :entry-id="entry.id" />
              <p v-if="entry.notes" class="notes"><strong>Note :</strong> {{ entry.notes }}</p>
            </td>
          </tr>
        </template>
        <tr v-if="audit.entries.value.length === 0 && !audit.loading.value">
          <td colspan="5" class="muted center">Aucune entrée correspondant aux filtres.</td>
        </tr>
      </tbody>
    </table>

    <div v-if="audit.nextCursor.value !== null" class="load-more">
      <button type="button" class="btn ghost" :disabled="audit.loading.value" @click="loadMore">
        Charger plus
      </button>
    </div>
  </main>
</template>

<style scoped>
.audit-trail-view {
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
.filters {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 0.75rem;
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
.field input,
.field select {
  padding: 0.4rem 0.6rem;
  font-size: 0.9rem;
  border: 1px solid #ccc;
  border-radius: 3px;
}
.actions {
  align-self: end;
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
.btn.ghost {
  background: #fff;
  border: 1px solid #ccc;
  color: #555;
}
.btn.small {
  padding: 0.3rem 0.7rem;
  font-size: 0.8rem;
}
.entries-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.entries-table th,
.entries-table td {
  text-align: left;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid #f0f0f0;
}
.entries-table th {
  background: #fafafa;
  font-weight: 600;
}
.actor-badge {
  font-family: monospace;
  font-size: 0.85rem;
  background: #f0f4f8;
  padding: 1px 6px;
  border-radius: 3px;
}
.diff-row td {
  background: #fffdf7;
  border-bottom: 2px solid #f5e6c8;
}
.notes {
  margin-top: 0.5rem;
  font-size: 0.85rem;
  color: #555;
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
.load-more {
  margin-top: 1rem;
  text-align: center;
}
</style>
