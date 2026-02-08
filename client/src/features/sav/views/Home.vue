<template>
  <div>
    <HeroSection class="sticky-header" />
    <div class="sav-form-wrapper min-h-screen flex items-center justify-center bg-[color:var(--bg-white)]">
      <div class="sav-form bg-white p-8 rounded-lg shadow-md w-full max-w-md">
        <h2 class="text-2xl font-extrabold mb-6 text-center text-[color:var(--main-orange)]">
          Demande de Service Après-Vente
        </h2>
        <form @submit.prevent="submitForm" class="space-y-4">
          <div>
            <label
              for="invoiceReference"
              class="block font-bold text-[color:var(--text-dark)] text-[1.08em] mb-1"
            >
              Référence de la facture (14 caractères):
            </label>
            <p class="text-sm text-gray-500 italic mb-2 ml-0.5">
              Vous trouverez la référence de facture en bas à gauche de votre facture. Elle est composée
              de 14 caractères au format <strong>PLXXXXXXXXXXZZ</strong>.
            </p>
            <input
              type="text"
              id="invoiceReference"
              v-model="invoiceReference"
              required
              maxlength="14"
              placeholder="Ex : PL1234567890ZZ"
              class="w-full px-4 py-3 border-2 border-[color:var(--main-orange)] rounded-3xl text-[color:var(--text-dark)] outline-none transition focus:border-[#c6711d] focus:ring-2 focus:ring-[#c6711d] focus:ring-offset-0"
            />
          </div>

          <div>
            <label
              for="email"
              class="block font-bold text-[color:var(--text-dark)] text-[1.08em] mb-1"
            >
              Adresse e-mail :
            </label>
            <p class="text-sm text-gray-500 italic mb-2 ml-0.5">
              Il s’agit de l’adresse mail indiquée sur votre facture.
            </p>
            <input
              type="email"
              id="email"
              v-model="email"
              required
              placeholder="Ex : monadresse@email.com"
              class="w-full px-4 py-3 border-2 border-[color:var(--main-orange)] rounded-3xl text-[color:var(--text-dark)] outline-none transition focus:border-[#c6711d] focus:ring-2 focus:ring-[#c6711d] focus:ring-offset-0"
            />
          </div>

          <button type="submit" class="btn-main w-full text-[1.1em]">Faire une demande de SAV</button>
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
