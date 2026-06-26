<script setup lang="ts">
/** Story H-19 — Page login back-office email + mot de passe. */
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

type SubmitState = 'idle' | 'submitting' | 'error'

const email = ref('')
const password = ref('')
const state = ref<SubmitState>('idle')
const errorMessage = ref('')
const emailInput = ref<HTMLInputElement | null>(null)

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
      return 'Votre session a expiré. Connectez-vous à nouveau.'
    case 'consumed':
      return 'Cette session de connexion n’est plus valide.'
    case 'invalid':
      return "Votre session n'est plus valide. Connectez-vous à nouveau."
    default:
      return null
  }
})

const returnToFromQuery = computed(() => {
  const raw = route.query['returnTo']
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value.length > 0 ? value : null
})

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
  () =>
    isValidEmail.value &&
    password.value.length > 0 &&
    (state.value === 'idle' || state.value === 'error')
)

async function handleSubmit(): Promise<void> {
  if (!canSubmit.value) return
  state.value = 'submitting'
  errorMessage.value = ''
  try {
    const loginUrl = returnToFromQuery.value
      ? `/api/auth/operator/login?returnTo=${encodeURIComponent(returnToFromQuery.value)}`
      : '/api/auth/operator/login'
    const res = await fetch(loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email: email.value.trim(), password: password.value }),
    })
    if (res.ok) {
      const body = (await res.json()) as { redirectTo?: string }
      await router.replace(body.redirectTo || '/admin')
      return
    }
    if (res.status === 429) {
      state.value = 'error'
      errorMessage.value = 'Trop de tentatives. Réessayez dans une minute.'
      return
    }
    if (res.status === 400) {
      state.value = 'error'
      errorMessage.value = 'Vérifiez les champs saisis.'
      return
    }
    if (res.status === 401) {
      state.value = 'error'
      errorMessage.value = 'Identifiants invalides.'
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
        <button type="button" class="link" @click="focusEmailField">Se reconnecter</button>
      </div>

      <form class="login-form" @submit.prevent="handleSubmit">
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
        />

        <label for="login-password">Mot de passe</label>
        <input
          id="login-password"
          v-model="password"
          type="password"
          name="password"
          autocomplete="current-password"
          required
          :disabled="state === 'submitting'"
        />

        <p id="login-help" class="help">
          La session reste active pendant 30 jours sur cet appareil.
        </p>

        <button type="submit" :disabled="!canSubmit">
          <span v-if="state === 'submitting'">Connexion…</span>
          <span v-else>Se connecter</span>
        </button>

        <p v-if="state === 'error'" role="alert" class="error">{{ errorMessage }}</p>
      </form>
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
