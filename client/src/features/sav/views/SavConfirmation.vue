<template>
  <div class="min-h-screen flex items-center justify-center bg-[color:var(--bg-white)]">
    <div class="bg-white p-8 rounded-lg shadow-md w-full max-w-md text-center">
      <h1 class="text-3xl mb-4">Demande SAV envoyée avec succès !</h1>
      <p class="text-[color:var(--text-dark)] mb-8 text-[1.1em]">
        Votre demande a bien été prise en compte et sera traitée dans les plus brefs délais.
      </p>
      <router-link to="/" class="btn-main w-full block text-center text-[1.1em]">Retour à l'accueil</router-link>
    </div>
  </div>
</template>

<script>
export default {
  name: 'SavConfirmation',
}
</script>
