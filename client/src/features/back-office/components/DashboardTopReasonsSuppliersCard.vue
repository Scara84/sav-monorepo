<script setup lang="ts">
import { ref } from 'vue'
import type { TopReasonsSuppliersData } from '../composables/useDashboard'

/**
 * Story 5.3 AC #8.4 — card Top motifs + Top fournisseurs (2 colonnes).
 */

defineProps<{
  data: TopReasonsSuppliersData | null
  loading: boolean
  error: string | null
}>()

const emit = defineEmits<{ refresh: [] }>()

function formatEuros(cents: number): string {
  return (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })
}
const heading = ref<HTMLHeadingElement | null>(null)

function retry(): void {
  heading.value?.focus()
  emit('refresh')
}
</script>

<template>
  <section class="card" aria-labelledby="reasons-suppliers-heading">
    <header class="card-header">
      <h2 ref="heading" tabindex="-1" id="reasons-suppliers-heading">
        Top motifs &amp; fournisseurs
      </h2>
      <span class="window">{{ data?.window_days ?? 90 }} derniers jours</span>
    </header>

    <div v-if="loading" class="skeleton" role="status">Chargement…</div>
    <div v-else-if="error" class="error">
      <span role="alert">{{ error }}</span>
      <button type="button" class="card-refresh" @click="retry">Réessayer</button>
    </div>
    <div v-else-if="!data" class="placeholder">Pas de données sur la période.</div>
    <div v-else class="two-col">
      <div>
        <h4>Motifs</h4>
        <ol v-if="data.reasons.length > 0">
          <li v-for="r in data.reasons" :key="r.motif">
            <span class="label">{{ r.motif }}</span>
            <span class="num">{{ r.count }}</span>
            <span class="amount">{{ formatEuros(r.total_cents) }}</span>
          </li>
        </ol>
        <p v-else class="empty">Aucun motif sur la période.</p>
      </div>
      <div>
        <h4>Fournisseurs</h4>
        <ol v-if="data.suppliers.length > 0">
          <li v-for="s in data.suppliers" :key="s.supplier_code">
            <span class="label code">{{ s.supplier_code }}</span>
            <span class="num">{{ s.sav_count }}</span>
            <span class="amount">{{ formatEuros(s.total_cents) }}</span>
          </li>
        </ol>
        <p v-else class="empty">Aucun fournisseur sur la période.</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.card {
  background: white;
  min-width: 0;
  border: 1px solid #dce2e2;
  border-radius: 12px;
  padding: 1rem 1.25rem;
}
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.75rem;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.card-header h2 {
  margin: 0;
  font-size: 1rem;
}
.window {
  font-size: 0.8rem;
  color: #666;
}
.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.5rem;
}
@media (max-width: 600px) {
  .two-col {
    grid-template-columns: 1fr;
  }
}
.two-col h4 {
  margin: 0 0 0.5rem;
  font-size: 0.9rem;
  color: #555;
}
.two-col ol {
  list-style: decimal inside;
  padding: 0;
  margin: 0;
  font-size: 0.9rem;
}
.two-col li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 0.5rem;
  padding: 0.3rem 0;
  border-bottom: 1px solid #f5f5f5;
}
.two-col .label {
  overflow-wrap: anywhere;
}
.two-col .label.code {
  font-family: monospace;
}
.two-col .num {
  font-variant-numeric: tabular-nums;
  color: #666;
}
.two-col .amount {
  font-variant-numeric: tabular-nums;
  text-align: right;
  min-width: 5rem;
}
.empty {
  font-size: 0.85rem;
  color: #52636b;
  margin: 0;
}
.skeleton,
.placeholder {
  height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #52636b;
}
.error {
  color: #a23737;
  padding: 1rem;
}
</style>
