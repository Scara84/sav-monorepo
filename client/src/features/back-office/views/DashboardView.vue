<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useDashboard, type DelayBasis } from '../composables/useDashboard'
import DashboardCostTimelineCard from '../components/DashboardCostTimelineCard.vue'
import DashboardTopProductsCard from '../components/DashboardTopProductsCard.vue'
import DashboardDelayDistributionCard from '../components/DashboardDelayDistributionCard.vue'
import DashboardTopReasonsSuppliersCard from '../components/DashboardTopReasonsSuppliersCard.vue'

/**
 * Story 5.3 AC #8 — Dashboard pilotage Fruitstock.
 *
 * 4 cards (2×2 desktop, 1×4 mobile via grid responsive). Premier dashboard
 * consolidé V1 — pilotage direction (FR52-FR55).
 *
 * Loading strategy : `loadAll()` au mount déclenche les 4 fetch en parallèle.
 * Chaque card affiche skeleton pendant son fetch (state isolated dans
 * `useDashboard.loadingByKey`) et son erreur en isolation si elle échoue
 * (P5 — refresh isolé d'une card affiche skeleton « Chargement », pas
 * placeholder « Pas de données »).
 *
 * Range cost-timeline : 6/12/24 mois sélectionnable (défaut 12). Refresh
 * uniquement la card concernée (`refreshCostTimeline`).
 *
 * P11 — basis delay-distribution :
 *   - default 'received' (cohort, V1 historique)
 *   - persistance localStorage 'dashboard.delay.basis'
 */

const DELAY_BASIS_LS_KEY = 'dashboard.delay.basis'

function readDelayBasis(): DelayBasis {
  try {
    const v = localStorage.getItem(DELAY_BASIS_LS_KEY)
    if (v === 'received' || v === 'closed') return v
  } catch {
    /* localStorage indisponible (SSR, mode privé) → default */
  }
  return 'received'
}

function writeDelayBasis(value: DelayBasis): void {
  try {
    localStorage.setItem(DELAY_BASIS_LS_KEY, value)
  } catch {
    /* ignore */
  }
}

const dash = useDashboard()
const windowMonths = ref(12)
const windowDays = ref(90)
const delayBasis = ref<DelayBasis>(readDelayBasis())

onMounted(() => {
  void dash.loadAll({ windowMonths: windowMonths.value, windowDays: windowDays.value })
  // loadAll utilise le default 'received' côté composable. Si l'utilisateur
  // avait persisté 'closed', on relance la card concernée avec le bon basis.
  if (delayBasis.value !== 'received') {
    void dash.refreshDelayDistribution(windowDays.value, delayBasis.value)
  }
})

function onChangeWindowMonths(m: number): void {
  windowMonths.value = m
  void dash.refreshCostTimeline(m)
}

function onChangeDelayBasis(next: DelayBasis): void {
  delayBasis.value = next
  writeDelayBasis(next)
  void dash.refreshDelayDistribution(windowDays.value, next)
}
</script>

<template>
  <div class="dashboard">
    <header class="dashboard-header">
      <h1>Tableau de bord — Pilotage</h1>
      <button
        type="button"
        class="refresh-btn"
        :disabled="dash.loading.value"
        @click="dash.loadAll({ windowMonths, windowDays })"
        aria-label="Actualiser toutes les cartes"
      >
        ↻ {{ dash.loading.value ? 'Chargement…' : 'Actualiser' }}
      </button>
    </header>

    <div class="grid">
      <DashboardCostTimelineCard
        :data="dash.costTimeline.value"
        :loading="dash.loadingByKey.value.costTimeline"
        :error="dash.errors.value.costTimeline"
        :window-months="windowMonths"
        @change-window="onChangeWindowMonths"
      />
      <DashboardTopProductsCard
        :data="dash.topProducts.value"
        :loading="dash.loadingByKey.value.topProducts"
        :error="dash.errors.value.topProducts"
      />
      <DashboardDelayDistributionCard
        :data="dash.delayDistribution.value"
        :loading="dash.loadingByKey.value.delayDistribution"
        :error="dash.errors.value.delayDistribution"
        :basis="delayBasis"
        @update:basis="onChangeDelayBasis"
      />
      <DashboardTopReasonsSuppliersCard
        :data="dash.topReasonsSuppliers.value"
        :loading="dash.loadingByKey.value.topReasonsSuppliers"
        :error="dash.errors.value.topReasonsSuppliers"
      />
    </div>
  </div>
</template>

<style scoped>
.dashboard {
  padding: 1.5rem;
  max-width: 1400px;
  margin: 0 auto;
}
.dashboard-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.25rem;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.dashboard-header h1 {
  margin: 0;
  font-size: 1.4rem;
}
.refresh-btn {
  padding: 0.4rem 0.9rem;
  background: white;
  border: 1px solid #ccc;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.9rem;
}
.refresh-btn:hover:not(:disabled) {
  background: #f5f5f5;
}
.refresh-btn:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1rem;
}
@media (max-width: 900px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
