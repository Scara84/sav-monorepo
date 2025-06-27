<template>
  <div>
    <HeroSection />
    <div class="sav-form-wrapper min-h-screen flex items-center justify-center" style="background: var(--bg-white);">
      <div class="sav-form bg-white p-8 rounded-lg shadow-md w-full max-w-md">
        <h2 class="text-2xl font-bold mb-6 text-center" style="color: var(--main-orange); font-family: var(--font-main);">Demande de Service Après-Vente</h2>
        <form @submit.prevent="submitForm">
        <div class="mb-4">
          <label for="invoiceReference" style="font-family: var(--font-main); color: var(--text-dark);">Référence de la facture (14 caractères):</label>
          <input
            type="text"
            id="invoiceReference"
            v-model="invoiceReference"
            required
            maxlength="14"
            style="width:100%;padding:0.75em 1em;border:2px solid var(--main-orange);border-radius:var(--border-radius);font-family:var(--font-main);color:var(--text-dark);font-size:1em;outline:none;transition:border-color 0.2s;"
            @focus="e => e.target.style.borderColor = '#c6711d'"
            @blur="e => e.target.style.borderColor = 'var(--main-orange)'"
          />
        </div>
        <div class="mb-4">
          <label for="email" style="font-family: var(--font-main); color: var(--text-dark);">Adresse e-mail:</label>
          <input
            type="email"
            id="email"
            v-model="email"
            required
            style="width:100%;padding:0.75em 1em;border:2px solid var(--main-orange);border-radius:var(--border-radius);font-family:var(--font-main);color:var(--text-dark);font-size:1em;outline:none;transition:border-color 0.2s;"
            @focus="e => e.target.style.borderColor = '#c6711d'"
            @blur="e => e.target.style.borderColor = 'var(--main-orange)'"
          />
        </div>
        <button type="submit" class="btn-main" style="width:100%;font-size:1.1em;">Faire une demande de SAV</button>
      </form>
    </div>
  </div>
  </div>
</template>

<script>
import axios from 'axios';

export default {
  data() {
    return {
      invoiceReference: '',
      email: ''
    }
  },
  methods: {
    async submitForm() {
      if (this.invoiceReference.length === 14) {
        const transformedReference = this.invoiceReference.slice(2, -2);
        try {
          const response = await axios.post(import.meta.env.VITE_WEBHOOK_URL, {
            transformedReference,
            email: this.email
          });

          console.log('Webhook Response:', response.data);

          if (response.status === 200) {
            this.$router.push({
              name: 'InvoiceDetails',
              query: {
                transformedReference,
                email: this.email,
                webhookResponse: JSON.stringify(response.data)
              }
            });
          }
        } catch (error) {
          console.error('Error details:', error.response || error);
          if (error.response && error.response.status === 400) {
            alert(error.response.data.message);
          } else {
            alert('Une erreur est survenue lors de la requête au webhook.');
          }
        }
      } else {
        alert('La référence de la facture doit comporter 14 caractères.');
      }
    }
  }
}
</script>

<style>
/* Add your styles here */
</style>
