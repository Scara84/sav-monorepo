<template>
  <main v-if="received" class="min-h-screen bg-stone-50 px-4 py-8">
    <section class="mx-auto max-w-lg rounded-xl border bg-white p-5 sm:p-8">
      <h1 ref="title" tabindex="-1" class="mb-2 text-3xl text-gray-900">
        Votre demande SAV a été reçue
      </h1>
      <p>Votre dossier est enregistré pour traitement par le service SAV.</p>
      <template v-if="reference">
        <label for="sav-reference" class="mt-4 block font-semibold">Référence du dossier</label>
        <input
          id="sav-reference"
          ref="referenceField"
          :value="reference"
          readonly
          class="sav-field mt-1 font-mono"
        />
        <p class="my-2">Conservez cette référence pour vos échanges avec le SAV.</p>
        <button type="button" :class="canOpen ? 'sav-field' : 'sav-primary'" @click="copyReference">
          Copier la référence
        </button>
        <p role="status" class="text-sm">{{ copyFeedback }}</p>
      </template>
      <p v-else class="mt-4">La référence du dossier est indisponible.</p>
      <RouterLink
        v-if="canOpen"
        :to="{ name: 'member-sav-detail', params: { id: savId } }"
        class="sav-primary mt-3 text-center"
        >Consulter mon dossier</RouterLink
      >
      <RouterLink to="/" class="sav-field mt-4 text-center">Retour à l’accueil</RouterLink>
    </section>
  </main>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const state = window.history.state
const received = state?.savReceived === true
const reference =
  typeof state?.savReference === 'string' && state.savReference.trim() ? state.savReference : ''
const savId = state?.savId
const title = ref(null)
const referenceField = ref(null)
const copyFeedback = ref('')
const canOpen = ref(false)
const check = new AbortController()

async function copyReference() {
  try {
    await navigator.clipboard.writeText(reference)
    copyFeedback.value = 'Référence copiée.'
  } catch {
    referenceField.value?.focus()
    referenceField.value?.select()
    copyFeedback.value = 'Copiez manuellement la référence sélectionnée.'
  }
}

onMounted(async () => {
  if (!received) {
    router.replace({ name: 'Home' })
    return
  }
  title.value?.focus()
  if (!reference || !Number.isSafeInteger(savId) || savId <= 0) return
  try {
    const response = await fetch(`/api/self-service/sav/${savId}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: check.signal,
    })
    if (!response.ok) return
    const { data } = await response.json()
    canOpen.value = data?.id === savId && data.reference === reference
  } catch {
    // La réception est acquise même si le droit de lecture reste inconnu.
  }
})

onBeforeUnmount(() => check.abort())
</script>
