<script setup lang="ts">
import { computed, ref } from 'vue'
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
  refresh: []
  'change-window': [months: number]
}>()

const periods = computed(() => props.data?.periods ?? [])
const hasCurrent = computed(() => periods.value.some((p) => p.has_data))
const hasN1 = computed(() => periods.value.some((p) => p.n1_has_data))
const periodLabel = computed(() => {
  const first = periods.value[0]?.period
  const last = periods.value.at(-1)?.period
  return first === last ? first : `${first} → ${last}`
})

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
        label: 'Période sélectionnée',
        data: periods.map((p) => (p.has_data ? p.total_cents / 100 : null)),
        borderColor: '#854510',
        backgroundColor: 'rgba(232, 138, 35, 0.15)',
        tension: 0.2,
        fill: false,
      },
      {
        label: 'N-1',
        data: periods.map((p) => (p.n1_has_data ? p.n1_total_cents / 100 : null)),
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
const heading = ref<HTMLHeadingElement | null>(null)

function retry(): void {
  heading.value?.focus()
  emit('refresh')
}
</script>

<template>
  <section class="card" aria-labelledby="cost-timeline-heading">
    <header class="card-header">
      <h2 ref="heading" tabindex="-1" id="cost-timeline-heading">Coût SAV mensuel</h2>
      <div class="window-selector" role="group" aria-label="Fenêtre de temps">
        <button
          v-for="m in [6, 12, 24]"
          :key="m"
          type="button"
          :aria-pressed="windowMonths === m"
          :class="{ active: windowMonths === m }"
          @click="emit('change-window', m)"
        >
          {{ m }} mois
        </button>
      </div>
    </header>

    <div v-if="loading" class="skeleton" role="status">Chargement…</div>
    <div v-else-if="error" class="error">
      <span role="alert">{{ error }}</span>
      <button type="button" class="card-refresh" @click="retry">Réessayer</button>
    </div>
    <div v-else-if="!data || data.periods.length === 0" class="placeholder">
      Pas de données sur la période.
    </div>
    <div v-else class="card-body">
      <p class="period">{{ periodLabel }}</p>
      <p v-if="!hasCurrent" class="empty">Pas de données sur la période.</p>
      <div class="totals">
        <div v-if="hasCurrent">
          <span class="label">Total de la période</span>
          <strong>{{ formatEuros(totalCurrent) }} TTC</strong>
        </div>
        <div v-if="hasN1"><span class="label">N-1</span>{{ formatEuros(totalN1) }} TTC</div>
        <div v-if="hasCurrent && deltaPct !== null" :class="['delta', deltaDirection]">
          {{ deltaSign(deltaPct, deltaDirection) }}{{ formatDeltaPct(deltaPct) }} % vs N-1
        </div>
      </div>
      <div v-if="hasCurrent || hasN1" class="chart-wrap">
        <Line :data="chartData" :options="chartOptions" />
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
  background: #854510;
  color: white;
  border-color: #854510;
}
.period {
  font-size: 0.88rem;
  color: #52636b;
}
.totals {
  flex-wrap: wrap;
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
  font-size: clamp(1.4rem, 3vw, 2rem);
}
.delta.up {
  color: #a23737;
}
.delta.down {
  color: #276531;
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
  color: #52636b;
}
.error {
  color: #a23737;
  padding: 1rem;
}
</style>
