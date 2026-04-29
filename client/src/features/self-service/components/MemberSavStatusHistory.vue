<template>
  <section
    class="member-sav-status-history border rounded p-4 bg-white"
    data-testid="sav-status-history"
  >
    <h3 class="text-lg font-semibold mb-3">Historique du statut</h3>
    <ol class="space-y-2 text-sm">
      <li v-for="(step, idx) in steps" :key="idx" class="flex items-center gap-3">
        <span class="text-xl">{{ step.icon }}</span>
        <span class="flex-1">{{ step.label }}</span>
        <span class="text-xs text-gray-500">{{ formatDate(step.at) }}</span>
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
  icon: string
  at: string
}

const steps = computed<Step[]>(() => {
  const list: Step[] = []
  list.push({ label: 'Reçu', icon: '🕓', at: props.detail.receivedAt })
  if (props.detail.takenAt)
    list.push({ label: 'Pris en charge', icon: '🔄', at: props.detail.takenAt })
  if (props.detail.validatedAt)
    list.push({ label: 'Validé', icon: '✅', at: props.detail.validatedAt })
  if (props.detail.closedAt) list.push({ label: 'Clôturé', icon: '📦', at: props.detail.closedAt })
  if (props.detail.cancelledAt)
    list.push({ label: 'Annulé', icon: '❌', at: props.detail.cancelledAt })
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
