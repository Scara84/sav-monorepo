<template>
  <div class="min-h-screen flex items-center justify-center bg-[color:var(--bg-white)]">
    <div class="bg-white p-8 rounded-lg shadow-md w-full max-w-4xl">
      <h1 class="text-4xl text-center mb-6">Détail de la facture</h1>
      <div class="mb-4 p-4 bg-gray-50 rounded-2xl">
        <h2 class="text-xl font-extrabold mb-2">Informations Facture</h2>
        <p class="text-[color:var(--text-dark)] mb-1">
          <span class="font-semibold">Client:</span> {{ customerName }}
        </p>
        <p class="text-[color:var(--text-dark)] mb-1">
          <span class="font-semibold">N° Facture:</span> {{ invoiceNumber }}
        </p>
        <p class="text-[color:var(--text-dark)] mb-1">
          <span class="font-semibold">ID Client:</span> {{ customerId }}
        </p>
        <p class="text-[color:var(--text-dark)] mb-1">
          <span class="font-semibold">Adresse e-mail:</span> {{ email }}
        </p>
        <p class="text-[color:var(--text-dark)] mb-1">
          <span class="font-semibold">Statut:</span>
          <span :class="paidStatus ? 'text-[#4E944F] font-bold' : 'text-[#e23a3a] font-bold'">
            {{ paidStatus ? 'Payée' : 'Non Payée' }}
          </span>
        </p>
        <p v-if="specialMention" class="text-[color:var(--text-dark)] mt-2">
          <span class="font-semibold">Mention Spéciale:</span> {{ specialMention }}
        </p>
      </div>

      <!-- Display Parsing Error -->
      <div v-if="parsingError" class="p-4 mb-4 text-sm text-red-800 rounded-lg bg-red-50 dark:bg-gray-800 dark:text-red-400" role="alert">
        {{ parsingError }}
      </div>

      <div class="mb-4">
        <WebhookItemsList 
          :items="invoiceItems" 
          :facture="facture"
          @sav-submitted="handleSavSubmission"
        />
      </div>
      <router-link to="/" class="btn-main w-full block text-center text-[1.1em] mt-8">Retour</router-link>
    </div>
  </div>
</template>

<script>
import WebhookItemsList from '../components/WebhookItemsList.vue'

export default {
  components: {
    WebhookItemsList
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
      facture: {}
    }
  },
  methods: {
    handleSavSubmission() {
      console.log('Demande SAV soumise avec succès.');
      this.$router.push({ name: 'SavConfirmation' });
    }
  },
  created() {
    const webhookResponseString = this.$route.query.webhookResponse;

    if (webhookResponseString) {
      try {
        const invoiceData = JSON.parse(webhookResponseString);

        // Pass the full invoice object to the child component
        this.facture = invoiceData;

        // Assign details for display in this component's template
        this.invoiceNumber = invoiceData.invoice_number || 'N/A';
        this.customerId = invoiceData.customer?.source_id || 'N/A';
        this.paidStatus = invoiceData.paid || false;
        this.customerName = invoiceData.customer?.name || 'N/A';
        this.specialMention = invoiceData.special_mention || '';
        this.email = this.$route.query.email || invoiceData.customer?.emails?.[0] || '';

        if (invoiceData && invoiceData.line_items) {
          const filteredItems = invoiceData.line_items.filter(item =>
            !item.label.includes('Participation préparation commande') &&
            !item.label.includes('Remise commande précédente') &&
            !item.label.includes('Remise responsable') &&
            !item.label.includes('Remise préparation commande')
          );
          this.invoiceItems = filteredItems;
        } else {
          console.error('line_items not found in the parsed response:', invoiceData);
          this.invoiceItems = [];
          this.parsingError = 'Les articles de la facture n\'ont pas pu être chargés.';
        }
      } catch (error) {
        console.error('Error parsing webhook response:', error, 'Raw response:', webhookResponseString);
        this.parsingError = 'Erreur lors de la récupération des détails de la facture.';
      }
    } else {
      console.warn('No webhook response found in query parameters.');
      this.parsingError = 'Aucune donnée de facture reçue.';
    }

    this.transformedReference = this.$route.query.transformedReference || ''
  }
}
</script>

<style>
/**** Styles additionnels pour InvoiceDetails ****/
</style>
