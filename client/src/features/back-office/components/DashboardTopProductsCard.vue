<script setup lang="ts">
import type { TopProductsData } from '../composables/useDashboard'

/**
 * Story 5.3 AC #8.2 — card Top 10 produits problématiques.
 */

defineProps<{
  data: TopProductsData | null
  loading: boolean
  error: string | null
}>()

function formatEuros(cents: number): string {
  return (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })
}
</script>

<template>
  <section class="card" aria-labelledby="top-products-heading">
    <header class="card-header">
      <h3 id="top-products-heading">Top produits problématiques</h3>
      <span v-if="data" class="window">{{ data.window_days }} derniers jours</span>
    </header>

    <div v-if="loading && !data" class="skeleton" aria-hidden="true">Chargement…</div>
    <div v-else-if="error" class="error" role="alert">{{ error }}</div>
    <div v-else-if="!data || data.items.length === 0" class="placeholder">
      Pas de données sur la période.
    </div>
    <table v-else class="products-table">
      <thead>
        <tr>
          <th scope="col" class="rank">#</th>
          <th scope="col">Code</th>
          <th scope="col">Désignation</th>
          <th scope="col" class="num">Nb SAV</th>
          <th scope="col" class="num">Total</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(item, idx) in data.items" :key="item.product_id">
          <td class="rank">{{ idx + 1 }}</td>
          <td class="code">{{ item.product_code }}</td>
          <td>{{ item.name_fr }}</td>
          <td class="num">{{ item.sav_count }}</td>
          <td class="num">{{ formatEuros(item.total_cents) }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.card {
  background: white;
  border: 1px solid #eee;
  border-radius: 8px;
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
.card-header h3 {
  margin: 0;
  font-size: 1rem;
}
.window {
  font-size: 0.8rem;
  color: #666;
}
.products-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.products-table th,
.products-table td {
  padding: 0.4rem 0.5rem;
  text-align: left;
  border-bottom: 1px solid #f0f0f0;
}
.products-table th.num,
.products-table td.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.products-table .rank {
  width: 2rem;
  color: #999;
}
.products-table .code {
  font-family: monospace;
  font-size: 0.85rem;
}
.skeleton,
.placeholder {
  height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #999;
}
.error {
  color: #c24747;
  padding: 1rem;
}
</style>
