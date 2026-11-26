<template>
  <section class="member-sav-lines border rounded p-4 bg-white" data-testid="sav-lines">
    <h2 class="text-lg font-semibold mb-3">Articles concernés</h2>
    <p v-if="lines.length === 0" class="text-sm text-gray-500">Aucun article.</p>
    <ul v-else class="divide-y">
      <li v-for="line in lines" :key="line.id" class="py-3" :data-testid="`line-${line.id}`">
        <h3 class="font-semibold">{{ line.description }}</h3>
        <dl class="mt-2 grid gap-2 text-sm sm:grid-cols-3">
          <div>
            <dt>Quantité</dt>
            <dd>{{ formatQty(line.qty) }}{{ formatUnit(line.qtyUnit) }}</dd>
          </div>
          <div>
            <dt>Motif</dt>
            <dd>{{ reasonLabel(line.requestReason || line.motif) }}</dd>
          </div>
          <div>
            <dt>Statut</dt>
            <dd>
              <span class="rounded px-2" :class="statusClass(line.validationStatus)">{{
                line.validationStatusLabel
              }}</span>
              <span v-if="line.validationMessage" class="block">{{ line.validationMessage }}</span>
            </dd>
          </div>
        </dl>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import type { MemberSavLine } from '../composables/useMemberSavDetail'

defineProps<{ lines: MemberSavLine[] }>()

const reasons = new Map([
  ['abime', 'Abîmé'],
  ['manquant', 'Manquant'],
  ['autre', 'Autre'],
])
function reasonLabel(reason?: string | null): string {
  const value = reason?.trim()
  return value ? (reasons.get(value) ?? value) : '—'
}

function formatQty(qty: number): string {
  if (!Number.isFinite(qty)) return '—'
  return qty.toLocaleString('fr-FR', { maximumFractionDigits: 3 })
}
function formatUnit(unit: string): string {
  if (unit === 'kg') return ' kg'
  if (unit === 'piece') return ' pièce(s)'
  if (unit === 'liter') return ' L'
  if (unit === 'g') return ' g'
  return ` ${unit}`
}
function statusClass(s: string): string {
  if (s === 'ok') return 'bg-green-100 text-green-800'
  if (s === 'error') return 'bg-red-100 text-red-800'
  return 'bg-amber-100 text-amber-800'
}
</script>
