<template>
  <div class="min-h-screen flex items-center justify-center bg-gray-100">
    <div class="bg-white p-8 rounded-lg shadow-md w-full max-w-md text-center">
      <h1 class="text-2xl font-bold text-green-600 mb-4">Demande SAV envoyée avec succès !</h1>
      <p class="text-gray-700 mb-6">Votre demande a bien été prise en compte et sera traitée dans les plus brefs délais.</p>
      <router-link to="/" class="mt-8 block w-full bg-blue-500 text-white py-2 rounded-lg hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 text-center">
        Retour à l'accueil
      </router-link>
    </div>
  </div>
</template>

<script>
export default {
  name: 'SavConfirmation',
}
</script>
