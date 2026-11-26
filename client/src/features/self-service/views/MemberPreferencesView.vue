<template>
  <section class="member-preferences" data-testid="member-preferences">
    <RouterLink :to="{ name: 'member-sav-list' }">← Retour à mes SAV</RouterLink>
    <h2>Préférences de notifications</h2>

    <p v-if="loading" role="status" data-testid="loading-state">Chargement des préférences…</p>
    <div v-else-if="error === 'load'" class="notice error" data-testid="preferences-load-error">
      <p role="alert">Impossible de charger vos préférences de notifications.</p>
      <button type="button" data-testid="retry-button" @click="load">
        Réessayer le chargement
      </button>
    </div>

    <form
      v-else-if="prefs"
      data-testid="preferences-form"
      @change="onEdit"
      @submit.prevent="onSubmit"
    >
      <h3>Notifications par e-mail</h3>
      <label class="choice">
        <span
          ><strong>Changements de statut</strong>
          <small>Recevoir un e-mail lorsque le statut de l’un de mes SAV change.</small>
        </span>
        <input
          v-model="formStatusUpdates"
          type="checkbox"
          data-testid="toggle-status-updates"
          :disabled="saving"
        />
      </label>
      <label class="choice">
        <span
          ><strong>Récapitulatif hebdomadaire</strong>
          <small>{{
            isManager
              ? 'Recevoir chaque vendredi un résumé des SAV en cours du groupe.'
              : 'Réservé aux responsables de groupe.'
          }}</small>
        </span>
        <input
          v-model="formWeeklyRecap"
          type="checkbox"
          data-testid="toggle-weekly-recap"
          :disabled="!isManager || saving"
        />
      </label>

      <p v-if="error === 'save'" class="notice error" role="alert" data-testid="preferences-error">
        L’enregistrement a échoué. Vos choix sont conservés dans ce formulaire.
      </p>
      <p v-if="toastMsg" class="notice success" role="status" data-testid="toast-success">
        {{ toastMsg }}
      </p>
      <button
        type="submit"
        :disabled="saving || !hasChanges"
        :data-testid="error === 'save' ? 'retry-button' : undefined"
      >
        {{
          saving
            ? 'Enregistrement…'
            : error === 'save'
              ? 'Réessayer l’enregistrement'
              : 'Enregistrer les préférences'
        }}
      </button>
    </form>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useMemberPreferences, type NotificationPrefs } from '../composables/useMemberPreferences'

const { prefs, isManager, loading, saving, error, toastMsg, load, save } = useMemberPreferences()
const formStatusUpdates = ref(true)
const formWeeklyRecap = ref(false)

watch(prefs, (next) => {
  if (next) {
    formStatusUpdates.value = next.status_updates
    formWeeklyRecap.value = next.weekly_recap
  }
})

const patch = computed(() => {
  const changed: Partial<NotificationPrefs> = {}
  if (prefs.value && formStatusUpdates.value !== prefs.value.status_updates) {
    changed.status_updates = formStatusUpdates.value
  }
  if (prefs.value && isManager.value && formWeeklyRecap.value !== prefs.value.weekly_recap) {
    changed.weekly_recap = formWeeklyRecap.value
  }
  return changed
})
const hasChanges = computed(() => Object.keys(patch.value).length > 0)

function onEdit() {
  toastMsg.value = null
  error.value = null
}

async function onSubmit() {
  if (hasChanges.value) await save(patch.value)
}

onMounted(load)
</script>

<style scoped>
.member-preferences {
  max-width: 48rem;
  color: #302b25;
}
a {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  color: #624315;
  text-decoration: underline;
}
h2 {
  margin: 0.5rem 0 1.25rem;
  font-size: clamp(1.6rem, 4vw, 2.1rem);
  font-weight: 750;
  line-height: 1.2;
}
form {
  padding: clamp(1rem, 3vw, 2rem);
  background: #fffdf8;
  border: 1px solid #ded4c7;
  border-radius: 0.85rem;
}
h3 {
  margin-bottom: 0.5rem;
  font-size: 1.25rem;
  font-weight: 700;
}
.choice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 0;
  border-bottom: 1px solid #ded4c7;
}
small {
  display: block;
  margin-top: 0.25rem;
  color: #594f43;
  font-size: 0.875rem;
}
input {
  flex: none;
  width: 1.25rem;
  height: 1.25rem;
  accent-color: #854a09;
}
button {
  min-height: 44px;
  margin-top: 1rem;
  padding: 0.55rem 1rem;
  border-radius: 0.5rem;
  background: #e88a23;
  color: #302315;
  font-weight: 700;
}
button:disabled {
  background: #e1d8cc;
}
:is(a, button, input):focus-visible {
  outline: 3px solid #754006;
  outline-offset: 3px;
}
.notice {
  margin-top: 1rem;
  padding: 0.75rem 1rem;
  border-radius: 0.5rem;
}
.error {
  background: #fff0e9;
  color: #792d1b;
}
.success {
  background: #edf3e8;
  color: #314b27;
}
</style>
