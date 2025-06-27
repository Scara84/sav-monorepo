<template>
  <div class="min-h-screen flex items-center justify-center" style="background: var(--bg-white);">
    <div class="bg-white p-8 rounded-lg shadow-md w-full max-w-4xl" style="font-family: var(--font-main);">
      <h1 style="font-size:2.2em;font-family:var(--font-main);color:var(--main-orange);font-weight:800;text-align:center;margin-bottom:1.5em;">Détail de la facture</h1>
      <div class="mb-4 p-4" style="background:#f6f6f6;border-radius:16px;">
        <h2 style="font-size:1.3em;font-family:var(--font-main);color:var(--main-orange);font-weight:700;margin-bottom:0.5em;">Informations Facture</h2>
        <p style="color:var(--text-dark);margin-bottom:0.2em;"><span style="font-weight:600;">Client:</span> {{ customerName }}</p>
        <p style="color:var(--text-dark);margin-bottom:0.2em;"><span style="font-weight:600;">N° Facture:</span> {{ invoiceNumber }}</p>
        <p style="color:var(--text-dark);margin-bottom:0.2em;"><span style="font-weight:600;">ID Client:</span> {{ customerId }}</p>
        <p style="color:var(--text-dark);margin-bottom:0.2em;"><span style="font-weight:600;">Adresse e-mail:</span> {{ email }}</p>
        <p style="color:var(--text-dark);margin-bottom:0.2em;"><span style="font-weight:600;">Statut:</span> <span :style="paidStatus ? 'color:#4E944F;font-weight:700;' : 'color:#e23a3a;font-weight:700;'">{{ paidStatus ? 'Payée' : 'Non Payée' }}</span></p>
        <p v-if="specialMention" style="color:var(--text-dark);margin-top:0.4em;"><span style="font-weight:600;">Mention Spéciale:</span> {{ specialMention }}</p>
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
      <router-link to="/" class="btn-main" style="width:100%;display:block;text-align:center;font-size:1.1em;margin-top:2em;">Retour</router-link>
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
/**** Styles additionnels pour InvoiceDetails ****/
</style>
