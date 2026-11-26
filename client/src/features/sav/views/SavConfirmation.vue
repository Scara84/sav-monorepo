<template>
  <main v-if="received" class="min-h-screen bg-stone-50 px-4 py-12">
    <section class="mx-auto max-w-lg rounded-xl border bg-white p-6 sm:p-8">
      <h1 ref="title" tabindex="-1" class="text-3xl text-gray-900">
        Votre demande SAV a été reçue
      </h1>
      <p>Un opérateur examinera votre déclaration et les pièces fournies.</p>
      <p v-if="reference" class="mt-4 break-words">
        <strong>Référence du dossier</strong> {{ reference }}
      </p>
      <router-link to="/" class="sav-primary mt-6 text-center">Retour à l’accueil</router-link>
    </section>
  </main>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const received = window.history.state?.savReceived === true
const reference = window.history.state?.savReference
const title = ref(null)

onMounted(() => {
  if (received) title.value?.focus()
  else router.replace({ name: 'Home' })
})
</script>
