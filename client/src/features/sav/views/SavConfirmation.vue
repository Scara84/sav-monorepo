<template>
  <div class="min-h-screen flex items-center justify-center" style="background: var(--bg-white);">
    <div class="bg-white p-8 rounded-lg shadow-md w-full max-w-md text-center" style="font-family: var(--font-main);">
      <h1 style="font-size:2em;font-family:var(--font-main);color:var(--main-orange);font-weight:800;margin-bottom:1em;">Demande SAV envoyée avec succès !</h1>
      <p style="color:var(--text-dark);margin-bottom:2em;font-size:1.1em;">Votre demande a bien été prise en compte et sera traitée dans les plus brefs délais.</p>
      <router-link to="/" class="btn-main" style="width:100%;display:block;text-align:center;font-size:1.1em;">Retour à l'accueil</router-link>
    </div>
  </div>
</template>

<script>
export default {
  name: 'SavConfirmation',
}
</script>
