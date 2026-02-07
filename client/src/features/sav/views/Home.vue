<template>
  <div>
    <HeroSection class="sticky-header" />
    <div class="sav-form-wrapper min-h-screen flex items-center justify-center" style="background: var(--bg-white);">
      <div class="sav-form bg-white p-8 rounded-lg shadow-md w-full max-w-md">
        <h2 class="text-2xl font-bold mb-6 text-center" style="color: var(--main-orange); font-family: var(--font-main);">Demande de Service Après-Vente</h2>
        <form @submit.prevent="submitForm">
        <div class="mb-4">
  <label for="invoiceReference" style="font-family: var(--font-main); color: var(--text-dark); font-weight: bold; font-size: 1.08em; display: block; margin-bottom: 0.15em;">Référence de la facture (14 caractères):</label>
  <div style="font-size:0.93em;color:#888;font-style:italic;margin-bottom:0.45em;margin-left:0.1em;">
    Vous trouverez la référence de facture en bas à gauche de votre facture. Elle est composée de 14 caractères au format <strong>PLXXXXXXXXXXZZ</strong>.
  </div>
  <input
    type="text"
    id="invoiceReference"
    v-model="invoiceReference"
    required
    maxlength="14"
    placeholder="Ex : PL1234567890ZZ"
    style="width:100%;padding:0.75em 1em;border:2px solid var(--main-orange);border-radius:var(--border-radius);font-family:var(--font-main);color:var(--text-dark);font-size:1em;outline:none;transition:border-color 0.2s;"
    @focus="e => e.target.style.borderColor = '#c6711d'"
    @blur="e => e.target.style.borderColor = 'var(--main-orange)'"
  />
</div>
        <div class="mb-4">
  <label for="email" style="font-family: var(--font-main); color: var(--text-dark); font-weight: bold; font-size: 1.08em; display: block; margin-bottom: 0.15em;">Adresse e-mail :</label>
  <div style="font-size:0.93em;color:#888;font-style:italic;margin-bottom:0.45em;margin-left:0.1em;">
    Il s’agit de l’adresse mail indiquée sur votre facture.
  </div>
  <input
    type="email"
    id="email"
    v-model="email"
    required
    placeholder="Ex : monadresse@email.com"
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
import { useApiClient } from '../composables/useApiClient.js';

const apiClient = useApiClient();

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
          const invoiceData = await apiClient.submitInvoiceLookupWebhook({
            transformedReference,
            email: this.email
          });

          console.log('Webhook Response:', invoiceData);

          this.$router.push({
            name: 'InvoiceDetails',
            query: {
              transformedReference,
              email: this.email,
              webhookResponse: JSON.stringify(invoiceData)
            }
          });
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
.sticky-header {
  position: sticky;
  top: 0;
  z-index: 100;
  background: var(--bg-white, #fff);
  box-shadow: 0 2px 8px rgba(0,0,0,0.04);
}
</style>
