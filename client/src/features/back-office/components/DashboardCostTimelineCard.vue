<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  Chart as ChartJS,
  Title,
  Tooltip,
  Legend,
  LineElement,
  PointElement,
  CategoryScale,
  LinearScale,
} from 'chart.js'
import type { ChartOptions, TooltipItem } from 'chart.js'
import { Line } from 'vue-chartjs'
import type { CostTimelineData } from '../composables/useDashboard'

/**
 * Story 5.3 AC #8.1 — card Coût SAV mensuel + comparatif N-1.
 *
 * Range selector : 6/12/24 mois (défaut 12 — synchronisé via prop).
 * Header : total année courante + delta % vs N-1.
 */

ChartJS.register(Title, Tooltip, Legend, LineElement, PointElement, CategoryScale, LinearScale)

const props = defineProps<{
  data: CostTimelineData | null
  loading: boolean
  error: string | null
  windowMonths: number
}>()

const emit = defineEmits<{
  'change-window': [months: number]
}>()

const localWindow = ref(props.windowMonths)
watch(
  () => props.windowMonths,
  (v) => {
    localWindow.value = v
  }
)

function setWindow(m: number): void {
  localWindow.value = m
  emit('change-window', m)
}

const totalCurrent = computed(() => {
  if (!props.data) return 0
  return props.data.periods.reduce((acc, p) => acc + p.total_cents, 0)
})
const totalN1 = computed(() => {
  if (!props.data) return 0
  return props.data.periods.reduce((acc, p) => acc + p.n1_total_cents, 0)
})
const deltaPct = computed<number | null>(() => {
  if (totalN1.value === 0) return null
  return ((totalCurrent.value - totalN1.value) / totalN1.value) * 100
})

// P10 : seuil epsilon pour la classification "up" / "down" — un delta de
// -0,001 % était formatté `-0.0 %` avec la classe `down` (vert), ce qui
// est trompeur. En dessous de 0,05 %, on considère le delta neutre.
const EPSILON_PCT = 0.05
const deltaDirection = computed<'neutral' | 'up' | 'down'>(() => {
  const v = deltaPct.value
  if (v === null || Math.abs(v) < EPSILON_PCT) return 'neutral'
  return v > 0 ? 'up' : 'down'
})
function formatDeltaPct(v: number): string {
  // Math.abs évite l'affichage `-0.0` quand v ∈ ]-0.05, 0[ (capté par
  // direction='neutral' → signe '' ci-dessous).
  const abs = Math.abs(v)
  return abs.toFixed(1)
}
function deltaSign(v: number, dir: 'neutral' | 'up' | 'down'): string {
  if (dir === 'neutral') return ''
  return v > 0 ? '+' : '−' // U+2212, plus large que '-' typographiquement
}

function formatEuros(cents: number): string {
  return (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })
}

const chartData = computed(() => {
  const periods = props.data?.periods ?? []
  return {
    labels: periods.map((p) => p.period),
    datasets: [
      {
        label: 'Année courante',
        data: periods.map((p) => p.total_cents / 100),
        borderColor: '#0066cc',
        backgroundColor: 'rgba(0, 102, 204, 0.15)',
        tension: 0.2,
        fill: false,
      },
      {
        label: 'N-1',
        data: periods.map((p) => p.n1_total_cents / 100),
        borderColor: '#999',
        backgroundColor: 'rgba(150, 150, 150, 0.15)',
        borderDash: [5, 5],
        tension: 0.2,
        fill: false,
      },
    ],
  }
})

const chartOptions: ChartOptions<'line'> = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { position: 'bottom' },
    tooltip: {
      callbacks: {
        label: (ctx: TooltipItem<'line'>): string => {
          const label = ctx.dataset.label ?? ''
          const y = (ctx.parsed as { y: number }).y
          return `${label} : ${y.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })}`
        },
      },
    },
  },
  scales: {
    y: {
      ticks: {
        callback: (v: number | string): string =>
          Number(v).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' }),
      },
    },
  },
}
</script>

<template>
  <section class="card" aria-labelledby="cost-timeline-heading">
    <header class="card-header">
      <h3 id="cost-timeline-heading">Coût SAV mensuel</h3>
      <div class="window-selector" role="radiogroup" aria-label="Fenêtre de temps">
        <button
          v-for="m in [6, 12, 24]"
          :key="m"
          type="button"
          role="radio"
          :aria-checked="localWindow === m"
          :class="{ active: localWindow === m }"
          @click="setWindow(m)"
        >
          {{ m }} mois
        </button>
      </div>
    </header>

    <div v-if="loading && !data" class="skeleton" aria-hidden="true">Chargement…</div>
    <div v-else-if="error" class="error" role="alert">{{ error }}</div>
    <div v-else-if="!data || data.periods.length === 0" class="placeholder">
      Pas de données sur la période.
    </div>
    <div v-else class="card-body">
      <div class="totals">
        <div>
          <span class="label">Total année courante</span>
          <strong>{{ formatEuros(totalCurrent) }}</strong>
        </div>
        <div v-if="deltaPct !== null" :class="['delta', deltaDirection]">
          {{ deltaSign(deltaPct, deltaDirection) }}{{ formatDeltaPct(deltaPct) }} % vs N-1
        </div>
        <div v-else class="delta">N-1 : —</div>
      </div>
      <div class="chart-wrap">
        <Line :data="chartData" :options="chartOptions" />
      </div>
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
.window-selector {
  display: flex;
  gap: 0.25rem;
}
.window-selector button {
  padding: 0.25rem 0.6rem;
  border: 1px solid #ddd;
  background: white;
  cursor: pointer;
  border-radius: 4px;
  font-size: 0.85rem;
}
.window-selector button.active {
  background: #0066cc;
  color: white;
  border-color: #0066cc;
}
.totals {
  display: flex;
  gap: 1rem;
  align-items: baseline;
  margin-bottom: 0.75rem;
}
.totals .label {
  font-size: 0.8rem;
  color: #666;
  display: block;
}
.totals strong {
  font-size: 1.25rem;
}
.delta.up {
  color: #c24747;
}
.delta.down {
  color: #2c8a3a;
}
.delta.neutral {
  color: #666;
}
.chart-wrap {
  position: relative;
  height: 240px;
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
