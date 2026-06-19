<template>
  <div>
    <HeroSection class="sticky-header" />
    <div
      class="sav-form-wrapper min-h-screen flex items-center justify-center bg-[color:var(--bg-white)]"
    >
      <div class="sav-form bg-white p-8 rounded-lg shadow-md w-full max-w-md">
        <section v-if="showAccessForm" class="mb-8" data-test="member-access-form">
          <h2 class="text-2xl font-extrabold mb-3 text-center text-[color:var(--main-orange)]">
            Accéder à mon suivi SAV
          </h2>
          <p class="text-sm text-gray-600 mb-4">
            Saisissez votre adresse e-mail pour recevoir un lien de connexion sécurisé.
          </p>
          <form class="space-y-4" @submit.prevent="requestAccessLink">
            <label for="accessEmail" class="block font-bold text-[color:var(--text-dark)]">
              Adresse e-mail
            </label>
            <input
              id="accessEmail"
              v-model="accessEmail"
              type="email"
              required
              autocomplete="email"
              class="w-full px-4 py-3 border-2 border-[color:var(--main-orange)] rounded-3xl"
            />
            <button type="submit" class="btn-main w-full" :disabled="accessLinkSubmitting">
              {{ accessLinkSubmitting ? 'Envoi en cours…' : 'Recevoir mon lien de connexion' }}
            </button>
          </form>
          <p v-if="accessLinkMessage" class="mt-4" role="status" data-test="access-message">
            {{ accessLinkMessage }}
          </p>
        </section>
        <h2 class="text-2xl font-extrabold mb-6 text-center text-[color:var(--main-orange)]">
          Demande de Service Après-Vente
        </h2>
        <!-- H-10 W95 — Toast inline non-bloquant (remplace les alert() de Story 5.7). -->
        <!-- role="alert" + aria-live="assertive" : annonce immédiate pour screen readers. -->
        <div v-if="toast" role="alert" aria-live="assertive" :class="`toast toast-${toast.kind}`">
          {{ toast.message }}
          <button type="button" class="toast-dismiss" @click="dismissToast" aria-label="Fermer">
            ×
          </button>
        </div>
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
              Il s'agit de l'adresse mail indiquée sur votre facture.
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
import { safeMemberRedirect } from '@/shared/utils/member-redirect.js'

const apiClient = useApiClient()

export default {
  data() {
    return {
      invoiceNumber: '',
      email: '',
      // H-10 W95 — état toast inline (remplace les alert() bloquants).
      // null = pas de toast visible. kind: 'error' | 'success'.
      toast: null,
      // M-1 — référence au timer en vol pour clearTimeout avant re-déclenchement.
      toastTimer: null,
      accessEmail: '',
      accessLinkSubmitting: false,
      accessLinkMessage: '',
    }
  },
  methods: {
    async requestAccessLink() {
      if (this.accessLinkSubmitting) return
      this.accessLinkSubmitting = true
      this.accessLinkMessage = ''
      try {
        const response = await fetch('/api/auth/magic-link/issue', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: this.accessEmail.trim(),
            redirect: safeMemberRedirect(this.$route?.query?.redirect),
          }),
        })
        if (!response.ok) throw new Error('MAGIC_LINK_ISSUE_FAILED')
        this.accessLinkMessage =
          'Si un compte existe pour cette adresse, vous recevrez un lien de connexion.'
      } catch {
        this.accessLinkMessage =
          'Le lien ne peut pas être envoyé pour le moment. Merci de réessayer plus tard.'
      } finally {
        this.accessLinkSubmitting = false
      }
    },
    // H-10 W95 PATTERN-H10 — Toast non-bloquant avec auto-dismiss 5s.
    // Durée 5s (vs 4s ErpQueueView) : page publique, utilisateurs moins habitués.
    // M-1 — clearTimeout avant chaque nouvel appel évite le dismiss prématuré
    // par un timer précédent toujours en vol (race 2 erreurs rapprochées).
    showError(message) {
      if (this.toastTimer) clearTimeout(this.toastTimer)
      this.toast = { kind: 'error', message }
      this.toastTimer = setTimeout(() => {
        this.toast = null
        this.toastTimer = null
      }, 5000)
    },
    dismissToast() {
      if (this.toastTimer) clearTimeout(this.toastTimer)
      this.toastTimer = null
      this.toast = null
    },
    async submitForm() {
      const invoiceNumber = (this.invoiceNumber || '').trim().toUpperCase()
      // Story 5.7 — input direct = numéro Pennylane F-YYYY-NNNNN (UX cutover Make).
      if (!/^F-\d{4}-\d{1,8}$/.test(invoiceNumber)) {
        this.showError('Le numéro de facture doit avoir le format F-AAAA-NNNNN.')
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
            this.showError('Référence facture incorrecte.')
            return
          }
          if (status === 400) {
            const msg = error.response.data?.error?.message || 'Email incorrect.'
            this.showError(msg)
            return
          }
          if (status === 429) {
            this.showError('Trop de tentatives, merci de réessayer dans quelques instants.')
            return
          }
        }
        this.showError('Une erreur est survenue lors de la recherche de votre facture.')
      }
    },
  },
  computed: {
    showAccessForm() {
      return this.$route?.query?.reason === 'session_expired'
    },
  },
  // M-1 — Vue 3 Options API lifecycle hook (beforeDestroy = Vue 2 équivalent).
  // Empêche un state update (this.toast = null) sur instance déjà unmountée
  // si l'utilisateur navigue pendant qu'un timer est en vol.
  beforeUnmount() {
    if (this.toastTimer) clearTimeout(this.toastTimer)
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

<style scoped>
/* H-10 W95 — Toast inline non-bloquant. Pattern dupliqué (conforme AC #2.6 / DN-3). */
.toast {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  border-radius: 0.5rem;
  margin-bottom: 1rem;
  font-size: 0.95rem;
  font-weight: 500;
}
.toast-error {
  background: #fde8e8;
  color: #c62828;
  border: 1px solid #f5c6c6;
}
.toast-success {
  background: #e8f5e9;
  color: #2e7d32;
  border: 1px solid #c8e6c9;
}
.toast-dismiss {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 1.2rem;
  line-height: 1;
  padding: 0 0.25rem;
  color: inherit;
  opacity: 0.7;
  flex-shrink: 0;
}
.toast-dismiss:hover {
  opacity: 1;
}
</style>
