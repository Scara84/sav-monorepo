<template>
  <section class="member-sav-summary border rounded p-4 bg-white" data-testid="sav-summary">
    <div class="flex items-baseline justify-between gap-4">
      <h3 class="text-xl font-semibold">SAV {{ detail.reference }}</h3>
      <span class="text-sm">
        <span :title="statusLabel(detail.status)">{{ statusIcon(detail.status) }}</span>
        <span class="ml-1">{{ statusLabel(detail.status) }}</span>
      </span>
    </div>
    <p class="mt-2 text-sm text-gray-600">
      Reçu le {{ formatDate(detail.receivedAt) }}
      <span v-if="detail.totalAmountCents != null" class="ml-3">
        · Montant : <strong>{{ formatEur(detail.totalAmountCents) }}</strong>
      </span>
    </p>
  </section>
</template>

<script setup lang="ts">
import { statusIcon, statusLabel } from '@/shared/utils/sav-status-icons'
import type { MemberSavDetail } from '../composables/useMemberSavDetail'

defineProps<{ detail: MemberSavDetail }>()

function formatEur(cents: number): string {
  if (!Number.isFinite(cents)) return '—'
  return (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })
}
function formatDate(iso: string): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    })
  } catch {
    return iso
  }
}
</script>
