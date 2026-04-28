<template>
  <div>
    <HeroSection class="sticky-header" />
    <div
      class="sav-form-wrapper min-h-screen flex items-center justify-center bg-[color:var(--bg-white)]"
    >
      <div class="sav-form bg-white p-8 rounded-lg shadow-md w-full max-w-md">
        <h2 class="text-2xl font-extrabold mb-6 text-center text-[color:var(--main-orange)]">
          Demande de Service Après-Vente
        </h2>
        <form @submit.prevent="submitForm" class="space-y-4">
          <div>
            <label
              for="invoiceNumber"
              class="block font-bold text-[color:var(--text-dark)] text-[1.08em] mb-1"
            >
              Numéro de facture (format <strong>F-AAAA-NNNNN</strong>) :
            </label>
            <p class="text-sm text-gray-500 italic mb-2 ml-0.5">
              Vous trouverez le numéro de facture en haut à droite de votre PDF Pennylane (ex.
              <strong>F-2025-37039</strong>).
            </p>
            <input
              type="text"
              id="invoiceNumber"
              v-model="invoiceNumber"
              required
              maxlength="32"
              placeholder="Ex : F-2025-37039"
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

          <button type="submit" class="btn-main w-full text-[1.1em]">
            Faire une demande de SAV
          </button>
        </form>
      </div>
    </div>
  </div>
</template>

<script>
import { useApiClient } from '../composables/useApiClient.js'

const apiClient = useApiClient()

export default {
  data() {
    return {
      invoiceNumber: '',
      email: '',
    }
  },
  methods: {
    async submitForm() {
      const invoiceNumber = (this.invoiceNumber || '').trim().toUpperCase()
      // Story 5.7 — input direct = numéro Pennylane F-YYYY-NNNNN (UX cutover Make).
      if (!/^F-\d{4}-\d{1,8}$/.test(invoiceNumber)) {
        alert('Le numéro de facture doit avoir le format F-AAAA-NNNNN.')
        return
      }
      try {
        const invoiceData = await apiClient.submitInvoiceLookupWebhook({
          invoiceNumber,
          email: this.email,
        })

        console.log('Lookup response:', invoiceData)

        this.$router.push({
          name: 'InvoiceDetails',
          query: {
            invoiceNumber,
            email: this.email,
            webhookResponse: JSON.stringify(invoiceData),
          },
        })
      } catch (error) {
        console.error('Error details:', error.response || error)
        if (error.response) {
          const status = error.response.status
          if (status === 404) {
            alert('Référence facture incorrecte.')
            return
          }
          if (status === 400) {
            const msg = error.response.data?.error?.message || 'Email incorrect.'
            alert(msg)
            return
          }
          if (status === 429) {
            alert('Trop de tentatives, merci de réessayer dans quelques instants.')
            return
          }
        }
        alert('Une erreur est survenue lors de la recherche de votre facture.')
      }
    },
  },
}
</script>

<style>
.sticky-header {
  position: sticky;
  top: 0;
  z-index: 100;
  background: var(--bg-white, #fff);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
}
</style>
