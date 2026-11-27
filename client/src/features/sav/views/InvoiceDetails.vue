<template>
  <div class="min-h-screen bg-stone-50 py-6 sm:py-12">
    <div class="mx-auto bg-white p-4 sm:p-8 rounded-xl border w-full max-w-4xl">
      <h1 class="text-3xl text-gray-900 mb-2">Choisir un article à déclarer</h1>
      <p v-if="invoiceNumber" class="font-mono font-semibold mb-3">Facture {{ invoiceNumber }}</p>
      <details v-if="invoiceNumber" class="mb-5 border-b border-stone-200">
        <summary class="cursor-pointer py-3 font-semibold">Détails de la facture</summary>
        <dl class="grid gap-2 pb-4 sm:grid-cols-2">
          <div><dt>Client</dt><dd>{{ customerName }}</dd></div>
          <div><dt>Identifiant client</dt><dd>{{ customerId }}</dd></div>
          <div><dt>Adresse e-mail</dt><dd class="break-words">{{ email }}</dd></div>
          <div><dt>Statut</dt><dd>{{ paidStatus ? 'Payée' : 'Non payée' }}</dd></div>
          <div v-if="specialMention"><dt>Mention spéciale</dt><dd>{{ specialMention }}</dd></div>
        </dl>
      </details>

      <!-- Display Parsing Error -->
      <div
        v-if="parsingError"
        class="p-4 mb-4 text-sm text-red-800 rounded-lg bg-red-50 dark:bg-gray-800 dark:text-red-400"
        role="alert"
      >
        {{ parsingError }}
      </div>

      <div v-if="!parsingError" class="mb-4">
        <WebhookItemsList
          ref="savItemsList"
          :items="invoiceItems"
          :facture="facture"
          @sav-submitted="handleSavSubmission"
        />
      </div>
      <router-link to="/" class="sav-field text-center mt-8">Retour à la recherche</router-link>
    </div>
  </div>
</template>

<script>
import WebhookItemsList from '../components/WebhookItemsList.vue'

export default {
  components: {
    WebhookItemsList,
  },
  data() {
    return {
      // Data for display in this component
      transformedReference: '',
      email: '',
      invoiceItems: [],
      parsingError: null,
      invoiceNumber: null,
      customerId: null,
      paidStatus: false,
      customerName: '',
      specialMention: '',
      // Full invoice data object to pass to child component
      facture: {},
    }
  },
  methods: {
    handleSavSubmission({ savId, reference }) {
      this.$router.push({
        name: 'SavConfirmation',
        state: { savReceived: true, savId, savReference: reference || null },
      })
    },
    confirmSavLeave() {
      return this.$refs.savItemsList?.confirmLeave?.() ?? true
    },
  },
  beforeRouteLeave() {
    return this.confirmSavLeave()
  },
  beforeRouteUpdate() {
    return this.confirmSavLeave()
  },
  created() {
    const webhookResponseString = this.$route.query.webhookResponse

    if (webhookResponseString) {
      try {
        const invoiceData = JSON.parse(webhookResponseString)

        if (typeof invoiceData?.invoice_number !== 'string' || !invoiceData.invoice_number.trim()) {
          this.parsingError = 'La facture reçue ne contient pas de numéro. Relancez la recherche.'
          return
        }

        // Pass the full invoice object to the child component
        this.facture = invoiceData

        // Assign details for display in this component's template
        this.invoiceNumber = invoiceData.invoice_number
        // `external_reference` porte l'ID client métier Fruitstock.
        // `id` reste l'identifiant interne Pennylane et n'est qu'un fallback technique.
        this.customerId =
          invoiceData.customer?.external_reference ||
          invoiceData.customer?.source_id ||
          invoiceData.customer?.id ||
          'N/A'
        this.paidStatus = invoiceData.paid || false
        this.customerName = invoiceData.customer?.name || 'N/A'
        this.specialMention = invoiceData.special_mention || ''
        this.email = this.$route.query.email || invoiceData.customer?.emails?.[0] || ''

        if (invoiceData && invoiceData.line_items) {
          const excludedLabels = [
            'Participation préparation commande',
            'Remise commande précédente',
            'Remise responsable',
            'Remise préparation commande',
          ]
          this.invoiceItems = invoiceData.line_items.filter((item) => {
            const label = item?.label || item?.product_name
            return label && !excludedLabels.some((excluded) => label.includes(excluded))
          })
        } else {
          console.error('line_items not found in the parsed response:', invoiceData)
          this.invoiceItems = []
          this.parsingError = "Les articles de la facture n'ont pas pu être chargés."
        }
      } catch (error) {
        console.error(
          'Error parsing webhook response:',
          error,
          'Raw response:',
          webhookResponseString
        )
        this.parsingError = 'Erreur lors de la récupération des détails de la facture.'
      }
    } else {
      console.warn('No webhook response found in query parameters.')
      this.parsingError = 'Aucune donnée de facture reçue.'
    }

    // Story 5.7 — `invoiceNumber` est désormais le numéro Pennylane complet
    // (`F-YYYY-NNNNN`). On garde `transformedReference` pour compat des
    // descendants qui le consomment encore (refacto progressif).
    this.transformedReference =
      this.$route.query.invoiceNumber || this.$route.query.transformedReference || ''
  },
}
</script>

<style>
/**** Styles additionnels pour InvoiceDetails ****/
</style>
