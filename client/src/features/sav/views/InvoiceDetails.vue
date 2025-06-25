<template>
  <div class="min-h-screen flex items-center justify-center bg-gray-100">
    <div class="bg-white p-8 rounded-lg shadow-md w-full max-w-4xl">
      <h1 class="text-2xl font-bold mb-6 text-center">Détail de la facture</h1>
      <div class="mb-4 p-4 bg-gray-100 rounded-lg">
        <h2 class="text-lg font-semibold mb-2 text-gray-800">Informations Facture</h2>
        <p class="text-gray-700"><span class="font-medium">Client:</span> {{ customerName }}</p>
        <p class="text-gray-700"><span class="font-medium">N° Facture:</span> {{ invoiceNumber }}</p>
        <p class="text-gray-700"><span class="font-medium">ID Client:</span> {{ customerId }}</p>
        <p class="text-gray-700"><span class="font-medium">Adresse e-mail:</span> {{ email }}</p>
        <p class="text-gray-700"><span class="font-medium">Statut:</span> <span :class="paidStatus ? 'text-green-600 font-semibold' : 'text-red-600 font-semibold'">{{ paidStatus ? 'Payée' : 'Non Payée' }}</span></p>
        <p v-if="specialMention" class="text-gray-700 mt-1"><span class="font-medium">Mention Spéciale:</span> {{ specialMention }}</p>
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
      <router-link to="/" class="w-full bg-blue-500 text-white py-2 rounded-lg hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 text-center block">Retour</router-link>
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
      transformedReference: '',
      email: '',
      invoiceItems: [],
      parsingError: null,
      invoiceNumber: null,
      customerId: null,
      paidStatus: false,
      customerName: '',
      specialMention: '',
      facture: {}
    }
  },
  computed: {
    invoiceInfo() {
      return {
        invoiceNumber: this.invoiceNumber,
        customerId: this.customerId,
        customerName: this.customerName,
        email: this.email,
        paidStatus: this.paidStatus,
        specialMention: this.specialMention
      };
    }
  },
  watch: {
    invoiceInfo: {
      handler(newVal) {
        this.facture = newVal;
      },
      immediate: true,
      deep: true
    }
  },
  methods: {
    handleSavSubmission() {
      console.log('Demande SAV soumise avec succès.');
      this.$router.push({ name: 'SavConfirmation' });
    }
  },
  created() {
    // Retrieve the response string from the query parameters
    const webhookResponseString = this.$route.query.webhookResponse;
    console.log('Webhook Response String:', webhookResponseString);

    if (webhookResponseString) {
      try {
        // Directly parse the response string as it contains the invoice object
        const invoiceData = JSON.parse(webhookResponseString);
        console.log('Parsed Response:', invoiceData);

        // --- Assign invoice details ---
        this.invoiceNumber = invoiceData.invoice_number || 'N/A'; 
        this.customerId = invoiceData.customer?.source_id || 'N/A'; 
        this.paidStatus = invoiceData.paid || false;
        this.customerName = invoiceData.customer?.name || 'N/A';
        this.specialMention = invoiceData.special_mention || ''; // Empty if not present
        console.log('InvoiceDetails.vue:56 Assigned Details - Invoice:', this.invoiceNumber, 'Customer ID:', this.customerId, 'Paid:', this.paidStatus, 'Name:', this.customerName);
        // --- End Assign invoice details ---

        // Check if line_items exist in the parsed data
        if (invoiceData && invoiceData.line_items) {
          // Filter out specific items based on label
          const filteredItems = invoiceData.line_items.filter(item => 
            !item.label.includes('Participation préparation commande') && 
            !item.label.includes('Remise commande précédente') &&
            !item.label.includes('Remise responsable') &&
            !item.label.includes('Remise préparation commande')
          );
          this.invoiceItems = filteredItems; // Assign filtered items
          console.log('InvoiceDetails.vue:57 Assigned filtered invoiceItems:', this.invoiceItems);
        } else {
          console.error('InvoiceDetails.vue:59 line_items not found in the parsed response:', invoiceData);
          this.invoiceItems = []; // Assign empty array if not found
          this.parsingError = 'Les articles de la facture n\'ont pas pu être chargés.';
        }
      } catch (error) {
        console.error('Error parsing webhook response:', error, 'Raw response:', webhookResponseString);
        this.invoiceItems = []; // Assign empty array on error
        // Optionally: display an error message to the user
        this.parsingError = 'Erreur lors de la récupération des détails de la facture.';
        this.invoiceNumber = 'Erreur'; 
        this.customerId = 'Erreur';    
        this.paidStatus = false;
        this.customerName = 'Erreur';
        this.specialMention = '';
      }
    } else {
      console.warn('No webhook response found in query parameters.');
      this.invoiceItems = [];
      this.parsingError = 'Aucune donnée de facture reçue.';
      this.invoiceNumber = 'N/A';
      this.customerId = 'N/A';
      this.paidStatus = false;
      this.customerName = 'N/A';
      this.specialMention = '';
    }

    this.transformedReference = this.$route.query.transformedReference || ''
    this.email = this.$route.query.email || ''
  }
}
</script>

<style>
/* Add your styles here */
</style>
