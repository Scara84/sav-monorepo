<script setup lang="ts">
/**
 * Story 5.8 — Page login back-office (magic link opérateur).
 *
 * Remplace le flow MSAL utilisateur (Story 1.4). L'opérateur saisit son email,
 * reçoit un lien magic-link 15 min, puis click → cookie session 8 h + redirect /admin.
 *
 * - Anti-énumération : message neutre identique trouvé/non-trouvé.
 * - Pas de champ password, pas de bouton MSAL.
 *
 * Story H-04 (W42 + W43) :
 * - Lit ?error= (expired|consumed|invalid) depuis l'URL pour afficher un banner inline
 *   (opérateur redirigé depuis verify.ts sur un lien expiré/consommé/invalide).
 * - Propagation de ?returnTo= vers /api/auth/operator/issue?returnTo=… pour deeplinks.
 */
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

type SubmitState = 'idle' | 'submitting' | 'sent' | 'error'

const email = ref('')
const state = ref<SubmitState>('idle')
const errorMessage = ref('')
const emailInput = ref<HTMLInputElement | null>(null)

// H-04 AC#5(b) — lecture query param ?error= (stateless, PATTERN-H04-LOGIN-VIEW-QUERY-CONTEXT)
const route = useRoute()
const router = useRouter()

const errorFromQuery = computed(() => {
  const raw = route.query['error']
  const value = Array.isArray(raw) ? raw[0] : raw
  if (value === 'expired' || value === 'consumed' || value === 'invalid') return value
  return null
})

// H-04 AC#5(c) — messages contextualisés selon le code
const errorBannerMessage = computed(() => {
  switch (errorFromQuery.value) {
    case 'expired':
      return 'Ce lien de connexion a expiré (15 minutes max). Demandez-en un nouveau.'
    case 'consumed':
      return 'Ce lien a déjà été utilisé. Pour vous reconnecter, demandez un nouveau lien.'
    case 'invalid':
      return "Ce lien de connexion n'est plus valide. Demandez-en un nouveau."
    default:
      return null
  }
})

// H-04 AC#5(e) — lecture query param ?returnTo= pour propagation vers issue.ts
// Server filters; if returnTo is invalid, login still succeeds but lands on /admin fallback (story §AC#2(d)).
const returnToFromQuery = computed(() => {
  const raw = route.query['returnTo']
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value.length > 0 ? value : null
})

// H-04 AC#5(f) — focus le champ email + reset state (bouton "Redemander un lien")
function focusEmailField(): void {
  state.value = 'idle'
  errorMessage.value = ''
  emailInput.value?.focus()
}

const isValidEmail = computed(() => {
  if (!email.value) return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value)
})

const canSubmit = computed(
  () => isValidEmail.value && (state.value === 'idle' || state.value === 'error')
)

async function handleSubmit(): Promise<void> {
  if (!canSubmit.value) return
  state.value = 'submitting'
  errorMessage.value = ''
  try {
    // H-04 AC#5(e) — propager returnTo vers l'endpoint issue si présent
    const issueUrl = returnToFromQuery.value
      ? `/api/auth/operator/issue?returnTo=${encodeURIComponent(returnToFromQuery.value)}`
      : '/api/auth/operator/issue'
    const res = await fetch(issueUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.value.trim() }),
    })
    if (res.status === 202) {
      state.value = 'sent'
      // L-2 : clear ?error= on success to prevent banner re-appearing on refresh
      // IMPORTANT: preserve ?returnTo= (useful if user clicks "Redemander un lien" again)
      if (route.query['error'] !== undefined) {
        const queryWithoutError = Object.fromEntries(
          Object.entries(route.query).filter(([k]) => k !== 'error')
        )
        void router.replace({ query: queryWithoutError })
      }
      return
    }
    if (res.status === 429) {
      state.value = 'error'
      errorMessage.value = 'Trop de tentatives. Réessayez dans une minute.'
      return
    }
    if (res.status === 400) {
      state.value = 'error'
      errorMessage.value = "Format d'email invalide."
      return
    }
    state.value = 'error'
    errorMessage.value = 'Une erreur est survenue. Réessayez plus tard.'
  } catch {
    state.value = 'error'
    errorMessage.value = 'Connexion impossible. Vérifiez votre réseau.'
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <header class="login-header">
        <h1>SAV Fruitstock</h1>
        <p class="subtitle">Back-office opérateur</p>
      </header>

      <!-- H-04 AC#5(d) — banner d'erreur inline au-dessus du form (W42) -->
      <div
        v-if="errorBannerMessage"
        class="error-banner"
        role="alert"
        aria-live="assertive"
        data-testid="login-error-banner"
      >
        <p>{{ errorBannerMessage }}</p>
        <button type="button" class="link" @click="focusEmailField">Redemander un lien</button>
      </div>

      <form v-if="state !== 'sent'" class="login-form" @submit.prevent="handleSubmit">
        <label for="login-email">Email professionnel</label>
        <input
          id="login-email"
          ref="emailInput"
          v-model="email"
          type="email"
          name="email"
          autocomplete="email"
          inputmode="email"
          required
          :disabled="state === 'submitting'"
          placeholder="prenom.nom@fruitstock.eu"
          aria-describedby="login-help"
        />
        <p id="login-help" class="help">
          Vous recevrez un lien de connexion par email. Il expire dans 15 minutes et ne peut être
          utilisé qu'une seule fois.
        </p>

        <button type="submit" :disabled="!canSubmit">
          <span v-if="state === 'submitting'">Envoi en cours…</span>
          <span v-else>Recevoir mon lien de connexion</span>
        </button>

        <p v-if="state === 'error'" role="alert" class="error">{{ errorMessage }}</p>
      </form>

      <div v-else class="login-success" role="status" aria-live="polite">
        <p>
          <strong>Vérifiez votre boîte mail.</strong>
        </p>
        <p>
          Si votre compte existe, un lien vient d'être envoyé à
          <strong>{{ email }}</strong
          >. Le lien expire dans 15 minutes.
        </p>
        <p class="muted">
          Pas reçu&nbsp;? Vérifiez vos courriers indésirables, puis
          <button type="button" class="link" @click="state = 'idle'">renvoyer un lien</button>.
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f6f4ef;
  padding: 2rem 1rem;
}
.login-card {
  background: #ffffff;
  border-radius: 12px;
  padding: 2.5rem;
  width: 100%;
  max-width: 420px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
}
.login-header {
  text-align: center;
  margin-bottom: 2rem;
}
.login-header h1 {
  margin: 0 0 0.25rem;
  font-size: 1.5rem;
  color: #ea7500;
}
.login-header .subtitle {
  margin: 0;
  font-size: 0.95rem;
  color: #6b6b6b;
}
.login-form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.login-form label {
  font-size: 0.9rem;
  font-weight: 600;
  color: #333;
}
.login-form input {
  padding: 0.65rem 0.85rem;
  font-size: 1rem;
  border: 1px solid #d4cfc4;
  border-radius: 6px;
  background: #fafafa;
}
.login-form input:focus {
  outline: 2px solid #ea7500;
  outline-offset: 1px;
  background: #ffffff;
}
.login-form .help {
  margin: 0.25rem 0 0;
  font-size: 0.85rem;
  color: #6b6b6b;
  line-height: 1.5;
}
.login-form button[type='submit'] {
  margin-top: 0.5rem;
  background: #ea7500;
  color: #ffffff;
  border: 0;
  padding: 0.75rem 1rem;
  border-radius: 8px;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
}
.login-form button[type='submit']:hover:not(:disabled) {
  background: #c66400;
}
.login-form button[type='submit']:disabled {
  background: #d4cfc4;
  cursor: not-allowed;
}
.login-form .error {
  margin: 0;
  padding: 0.6rem 0.85rem;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 6px;
  color: #991b1b;
  font-size: 0.9rem;
}
/* H-04 AC#5(d)(h) — banner d'erreur contextualisé (W42) : palette identique .error,
   WCAG AA (#991b1b sur #fef2f2), role="alert" + aria-live="assertive" */
.error-banner {
  margin-bottom: 1rem;
  padding: 0.75rem 0.85rem;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 6px;
  color: #991b1b;
  font-size: 0.9rem;
}
.error-banner p {
  margin: 0 0 0.5rem;
}
.error-banner .link {
  background: none;
  border: 0;
  padding: 0;
  color: #991b1b;
  text-decoration: underline;
  cursor: pointer;
  font: inherit;
  font-size: 0.9rem;
}
.login-success {
  text-align: center;
  line-height: 1.6;
}
.login-success p {
  margin: 0 0 0.75rem;
}
.login-success .muted {
  font-size: 0.9rem;
  color: #6b6b6b;
  margin-top: 1.25rem;
}
.login-success .link {
  background: none;
  border: 0;
  padding: 0;
  color: #ea7500;
  text-decoration: underline;
  cursor: pointer;
  font: inherit;
}
</style>
