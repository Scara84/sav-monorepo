<template>
  <section class="member-sav-lines border rounded p-4 bg-white" data-testid="sav-lines">
    <h3 class="text-lg font-semibold mb-3">Articles concernés</h3>
    <p v-if="lines.length === 0" class="text-sm text-gray-500">Aucun article.</p>
    <table v-else class="w-full text-sm">
      <thead class="text-left text-gray-600 border-b">
        <tr>
          <th class="py-1">Article</th>
          <th class="py-1 text-right">Qté</th>
          <th class="py-1">Motif</th>
          <th class="py-1">Statut</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="line in lines" :key="line.id" class="border-b" :data-testid="`line-${line.id}`">
          <td class="py-1">{{ line.description }}</td>
          <td class="py-1 text-right">
            {{ formatQty(line.qty) }}
            <span class="text-xs text-gray-500">{{ formatUnit(line.qtyUnit) }}</span>
          </td>
          <td class="py-1">{{ line.motif ?? '—' }}</td>
          <td class="py-1">
            <span class="px-2 py-0.5 rounded text-xs" :class="statusClass(line.validationStatus)">{{
              line.validationStatusLabel
            }}</span>
            <span v-if="line.validationMessage" class="block text-xs text-gray-500 mt-1">
              {{ line.validationMessage }}
            </span>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup lang="ts">
import type { MemberSavLine } from '../composables/useMemberSavDetail'

defineProps<{ lines: MemberSavLine[] }>()

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
