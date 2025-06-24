<template>
  <div class="min-h-screen flex items-center justify-center bg-gray-100">
    <div class="bg-white p-8 rounded-lg shadow-md w-full max-w-md">
      <h1 class="text-2xl font-bold mb-6 text-center">Demande de Service Après-Vente</h1>
      <form @submit.prevent="submitForm">
        <div class="mb-4">
          <label for="invoiceReference" class="block text-gray-700">Référence de la facture (14 caractères):</label>
          <input
            type="text"
            id="invoiceReference"
            v-model="invoiceReference"
            required
            maxlength="14"
            class="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div class="mb-4">
          <label for="email" class="block text-gray-700">Adresse e-mail:</label>
          <input
            type="email"
            id="email"
            v-model="email"
            required
            class="w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <button type="submit" class="w-full bg-blue-500 text-white py-2 rounded-lg hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500">Faire une demande de SAV</button>
      </form>
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
