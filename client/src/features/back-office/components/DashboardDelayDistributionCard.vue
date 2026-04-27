<script setup lang="ts">
import { computed } from 'vue'
import type { DelayDistributionData, DelayBasis } from '../composables/useDashboard'

/**
 * Story 5.3 AC #8.3 — card Distribution délais p50/p90.
 *
 * Pas de gauge natif chart.js V1 — on utilise un visuel barre horizontale
 * avec marqueurs p50/p90 sur échelle 0-720h (30 jours max). Texte explicit
 * à côté pour l'accessibilité.
 *
 * Warning visuel si LOW_SAMPLE_SIZE (n_samples 1..4).
 * Placeholder si NO_DATA (n_samples = 0).
 *
 * P11 — selector `basis` (received | closed) :
 *   - 'received' (défaut) : SAV reçus pendant la période — cohort.
 *   - 'closed'            : SAV clos pendant la période — activité.
 *   La valeur courante remonte au parent via `update:basis`. La parent
 *   (DashboardView) la persiste en localStorage et la passe à l'appel
 *   `refreshDelayDistribution(days, basis)`.
 */

const props = defineProps<{
  data: DelayDistributionData | null
  loading: boolean
  error: string | null
  basis: DelayBasis
}>()

const emit = defineEmits<{
  'update:basis': [value: DelayBasis]
}>()

function setBasis(next: DelayBasis): void {
  if (next === props.basis) return
  emit('update:basis', next)
}

const SCALE_HOURS_MAX = 720 // 30 jours

function formatHours(h: number | null): string {
  if (h === null) return '—'
  if (h < 24) return `${h.toFixed(1)} h`
  const days = h / 24
  if (days < 30) return `${days.toFixed(1)} j`
  return `${(days / 7).toFixed(1)} sem.`
}

const p50Pct = computed(() => {
  if (!props.data || props.data.p50_hours === null) return 0
  return Math.min(100, (props.data.p50_hours / SCALE_HOURS_MAX) * 100)
})
const p90Pct = computed(() => {
  if (!props.data || props.data.p90_hours === null) return 0
  return Math.min(100, (props.data.p90_hours / SCALE_HOURS_MAX) * 100)
})

const showLowSample = computed(() => props.data?.warning === 'LOW_SAMPLE_SIZE')
const showNoData = computed(
  () => !props.data || props.data.warning === 'NO_DATA' || props.data.n_samples === 0
)
</script>

<template>
  <section class="card" aria-labelledby="delay-distribution-heading">
    <header class="card-header">
      <h3 id="delay-distribution-heading">Délais de traitement</h3>
      <div class="header-controls">
        <div class="basis-toggle" role="group" aria-label="Base de calcul">
          <button
            type="button"
            :class="{ active: basis === 'received' }"
            :aria-pressed="basis === 'received'"
            title="SAV reçus pendant la période (cohort)"
            @click="setBasis('received')"
          >
            Reçus
          </button>
          <button
            type="button"
            :class="{ active: basis === 'closed' }"
            :aria-pressed="basis === 'closed'"
            title="SAV clos pendant la période (activité)"
            @click="setBasis('closed')"
          >
            Clos
          </button>
        </div>
        <span v-if="data" class="window">{{ data.from }} → {{ data.to }}</span>
      </div>
    </header>

    <div v-if="loading && !data" class="skeleton" aria-hidden="true">Chargement…</div>
    <div v-else-if="error" class="error" role="alert">{{ error }}</div>
    <div v-else-if="showNoData" class="placeholder">Pas de données sur la période.</div>
    <div v-else>
      <div v-if="showLowSample" class="warning" role="status">
        ⚠ Échantillon faible ({{ data!.n_samples }} SAV) — percentiles peu fiables.
      </div>
      <div class="gauge" aria-hidden="true">
        <div class="track">
          <div class="marker p50" :style="{ left: p50Pct + '%' }" title="p50">
            <span class="dot"></span>
          </div>
          <div class="marker p90" :style="{ left: p90Pct + '%' }" title="p90">
            <span class="dot"></span>
          </div>
        </div>
        <div class="scale">
          <span>0 h</span>
          <span>15 j</span>
          <span>30 j</span>
        </div>
      </div>
      <ul class="metrics" v-if="data">
        <li>
          <span>Médiane (p50)</span>
          <strong>{{ formatHours(data.p50_hours) }}</strong>
        </li>
        <li>
          <span>p90</span>
          <strong>{{ formatHours(data.p90_hours) }}</strong>
        </li>
        <li>
          <span>Moyenne</span>
          <strong>{{ formatHours(data.avg_hours) }}</strong>
        </li>
        <li>
          <span>Échantillon</span>
          <strong>{{ data.n_samples }} SAV</strong>
        </li>
      </ul>
    </div>
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
.header-controls {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.basis-toggle {
  display: inline-flex;
  border: 1px solid #d8d8d8;
  border-radius: 6px;
  overflow: hidden;
}
.basis-toggle button {
  background: white;
  border: none;
  padding: 0.25rem 0.6rem;
  font-size: 0.8rem;
  cursor: pointer;
  color: #555;
}
.basis-toggle button + button {
  border-left: 1px solid #d8d8d8;
}
.basis-toggle button:hover:not(.active) {
  background: #f5f5f5;
}
.basis-toggle button.active {
  background: #0066cc;
  color: white;
}
.warning {
  background: #fff8e1;
  color: #8a6d00;
  padding: 0.5rem 0.75rem;
  border-radius: 4px;
  font-size: 0.85rem;
  margin-bottom: 0.75rem;
}
.gauge {
  margin: 1rem 0;
}
.track {
  position: relative;
  height: 24px;
  background: linear-gradient(to right, #e8f5e9, #fff8e1, #ffebee);
  border-radius: 12px;
}
.marker {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
}
.marker .dot {
  display: block;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid white;
}
.marker.p50 .dot {
  background: #0066cc;
}
.marker.p90 .dot {
  background: #c24747;
}
.scale {
  display: flex;
  justify-content: space-between;
  font-size: 0.75rem;
  color: #999;
  margin-top: 0.5rem;
}
.metrics {
  list-style: none;
  padding: 0;
  margin: 1rem 0 0;
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0.5rem 1rem;
}
.metrics li {
  display: flex;
  justify-content: space-between;
  font-size: 0.9rem;
}
.metrics span {
  color: #666;
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
