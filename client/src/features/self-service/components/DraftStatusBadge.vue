<script setup lang="ts">
import { computed, type Ref } from 'vue'

/**
 * Badge d'état de la sauvegarde brouillon (Story 2.3 AC #9).
 *
 * Lit les refs exposées par `useDraftAutoSave` et affiche :
 *   - "Enregistrement..." pendant l'appel PUT
 *   - "Enregistré il y a X s" quand `lastSavedAt` est posé
 *   - "Erreur de sauvegarde — Réessayer" (bouton) quand `error` est posé
 *
 * Accessibilité : `aria-live="polite"` pour notifier discrètement les lecteurs
 * d'écran des transitions d'état. Contrastes textuels ≥ 4,5:1 (WCAG AA).
 */

interface Props {
  lastSavedAt: Ref<Date | null>
  isSaving: Ref<boolean>
  error: Ref<string | null>
  onRetry?: () => void | Promise<void>
}
const props = defineProps<Props>()

const label = computed(() => {
  if (props.isSaving.value) return 'Enregistrement…'
  if (props.error.value) return 'Erreur de sauvegarde'
  if (props.lastSavedAt.value) {
    const diffSec = Math.max(0, Math.round((Date.now() - props.lastSavedAt.value.getTime()) / 1000))
    if (diffSec < 5) return 'Enregistré'
    if (diffSec < 60) return `Enregistré il y a ${diffSec} s`
    const diffMin = Math.round(diffSec / 60)
    return `Enregistré il y a ${diffMin} min`
  }
  return ''
})

const colorClass = computed(() => {
  if (props.error.value) return 'text-red-700'
  if (props.isSaving.value) return 'text-slate-600'
  if (props.lastSavedAt.value) return 'text-emerald-700'
  return 'text-slate-500'
})
</script>

<template>
  <div
    aria-live="polite"
    class="flex items-center gap-2 text-sm"
    :class="colorClass"
    data-testid="draft-status-badge"
  >
    <span v-if="label">{{ label }}</span>
    <button
      v-if="props.error.value && props.onRetry"
      type="button"
      class="underline hover:no-underline focus:outline-none focus:ring-2 focus:ring-red-500"
      @click="props.onRetry"
    >
      Réessayer
    </button>
  </div>
</template>
