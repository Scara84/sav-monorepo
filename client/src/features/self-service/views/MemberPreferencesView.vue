<template>
  <section class="member-preferences" data-testid="member-preferences">
    <RouterLink :to="{ name: 'member-sav-list' }" class="text-sm text-gray-600 hover:underline">
      &larr; Retour à mes SAV
    </RouterLink>

    <h2 class="text-2xl font-bold mt-2 mb-4">Préférences de notifications</h2>

    <div v-if="loading" data-testid="loading-state" aria-busy="true" class="py-8 text-center">
      <span
        class="inline-block w-8 h-8 border-4 border-gray-200 border-t-orange-500 rounded-full animate-spin"
      />
      <p class="mt-2 text-sm text-gray-600">Chargement…</p>
    </div>

    <div
      v-else-if="error === 'load'"
      data-testid="preferences-load-error"
      role="alert"
      class="mt-4 p-4 bg-red-50 border border-red-200 rounded text-red-700"
    >
      <p>Impossible de charger vos préférences.</p>
      <button
        type="button"
        data-testid="retry-button"
        class="mt-2 px-3 py-1 border rounded hover:bg-white"
        @click="onRetry"
      >
        Réessayer
      </button>
    </div>

    <form
      v-else-if="prefs"
      data-testid="preferences-form"
      class="space-y-4"
      @submit.prevent="onSubmit"
    >
      <div class="border rounded p-3 bg-white">
        <label class="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            data-testid="toggle-status-updates"
            :checked="formStatusUpdates"
            class="mt-1"
            @change="formStatusUpdates = ($event.target as HTMLInputElement).checked"
          />
          <span>
            <span class="font-medium"
              >Recevoir un email à chaque changement de statut de mes SAV</span
            >
            <span class="block text-xs text-gray-600 mt-1">
              Vous serez prévenu·e quand un de vos SAV passe en cours de traitement, validé ou
              clôturé.
            </span>
          </span>
        </label>
      </div>

      <div class="border rounded p-3 bg-white">
        <label
          class="flex items-start gap-3"
          :class="!isManager ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'"
          :title="!isManager ? 'Réservé aux responsables de groupe' : ''"
        >
          <input
            type="checkbox"
            data-testid="toggle-weekly-recap"
            :checked="formWeeklyRecap"
            :disabled="!isManager"
            class="mt-1"
            @change="formWeeklyRecap = ($event.target as HTMLInputElement).checked"
          />
          <span>
            <span class="font-medium">Recevoir un récap hebdomadaire</span>
            <span class="block text-xs text-gray-600 mt-1">
              <template v-if="!isManager">Réservé aux responsables de groupe.</template>
              <template v-else
                >Tous les vendredis, un résumé des SAV en cours pour votre groupe.</template
              >
            </span>
          </span>
        </label>
      </div>

      <div
        v-if="error === 'save'"
        data-testid="preferences-error"
        role="alert"
        class="p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm"
      >
        L'enregistrement a échoué. Merci de réessayer.
        <button
          type="button"
          data-testid="retry-button"
          class="ml-2 px-2 py-1 border rounded hover:bg-white"
          @click="onRetrySave"
        >
          Réessayer
        </button>
      </div>

      <div
        v-if="toastMsg"
        data-testid="toast-success"
        role="status"
        class="p-3 bg-green-50 border border-green-200 rounded text-green-700 text-sm"
      >
        {{ toastMsg }}
      </div>

      <button
        type="submit"
        :disabled="saving"
        class="px-4 py-2 bg-[color:var(--main-orange,#f97316)] text-white rounded hover:opacity-90 disabled:opacity-50"
      >
        {{ saving ? 'Enregistrement…' : 'Enregistrer' }}
      </button>
    </form>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useMemberPreferences } from '../composables/useMemberPreferences'

/**
 * Story 6.4 — vue préférences notifications adhérent.
 *
 * AC #6, #7, #9, #11 :
 *   - 2 toggles : status_updates (défaut true), weekly_recap (défaut false)
 *   - GET /api/self-service/preferences au mount → état initial
 *   - GET /api/auth/me → isGroupManager → conditionne weekly_recap
 *   - PATCH au submit → toast succès "Préférences enregistrées" 3s
 *   - Si erreur PATCH → bouton retry visible
 *   - Si non-manager → toggle weekly_recap disabled + tooltip "Réservé aux responsables"
 */

const { prefs, isManager, loading, saving, error, toastMsg, load, save } = useMemberPreferences()

// État local du formulaire (séparé de `prefs` pour permettre un revert / save partiel).
const formStatusUpdates = ref<boolean>(true)
const formWeeklyRecap = ref<boolean>(false)

watch(
  prefs,
  (next) => {
    if (next) {
      formStatusUpdates.value = next.status_updates
      formWeeklyRecap.value = next.weekly_recap
    }
  },
  { immediate: true }
)

async function onRetry(): Promise<void> {
  await load()
}

async function onRetrySave(): Promise<void> {
  await onSubmit()
}

async function onSubmit(): Promise<void> {
  // On envoie tous les toggles modifiés. Le serveur fait un merge JSONB, donc
  // envoyer les 2 clés est sûr (pas de risque d'écraser).
  const patch: { status_updates?: boolean; weekly_recap?: boolean } = {
    status_updates: formStatusUpdates.value,
  }
  if (isManager.value) {
    patch.weekly_recap = formWeeklyRecap.value
  }
  await save(patch)
}

onMounted(() => {
  void load()
})
</script>
