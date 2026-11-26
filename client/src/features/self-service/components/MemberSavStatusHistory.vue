<template>
  <section
    class="member-sav-status-history border rounded p-4 bg-white"
    data-testid="sav-status-history"
  >
    <h2 class="text-lg font-semibold mb-3">Suivi du dossier</h2>
    <ol class="space-y-2 text-sm">
      <li v-for="(step, idx) in steps" :key="idx" class="border-l-2 border-amber-600 pl-3 py-1">
        <span class="block font-medium">{{ step.label }}</span>
        <time :datetime="step.at" class="text-sm text-gray-600">{{ formatDate(step.at) }}</time>
      </li>
    </ol>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { MemberSavDetail } from '../composables/useMemberSavDetail'

const props = defineProps<{ detail: MemberSavDetail }>()

interface Step {
  label: string
  at: string
}

const steps = computed<Step[]>(() => {
  const list: Step[] = []
  list.push({ label: 'Reçu', at: props.detail.receivedAt })
  if (props.detail.takenAt) list.push({ label: 'Pris en charge', at: props.detail.takenAt })
  if (props.detail.validatedAt) list.push({ label: 'Validé', at: props.detail.validatedAt })
  if (props.detail.closedAt) list.push({ label: 'Clôturé', at: props.detail.closedAt })
  if (props.detail.cancelledAt) list.push({ label: 'Annulé', at: props.detail.cancelledAt })
  return list
})

function formatDate(iso: string | null): string {
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
</script>
