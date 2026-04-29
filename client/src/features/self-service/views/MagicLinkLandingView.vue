<template>
  <div class="magic-link-landing min-h-screen flex items-center justify-center bg-white p-4">
    <div class="max-w-md w-full text-center" role="status" :aria-busy="state === 'loading'">
      <template v-if="state === 'loading'">
        <div class="loader" aria-hidden="true" />
        <p class="mt-4 text-lg font-semibold">Connexion en cours…</p>
      </template>
      <template v-else-if="state === 'error'">
        <h1 class="text-2xl font-bold text-[color:var(--main-orange)] mb-4">
          Lien expiré ou déjà utilisé
        </h1>
        <p class="mb-6">
          Pour des raisons de sécurité, ce lien n'est plus valide. Demandez un nouveau lien depuis
          la page d'accueil.
        </p>
        <RouterLink
          to="/"
          data-test="cta-new-link"
          class="inline-block px-6 py-3 rounded-3xl bg-[color:var(--main-orange)] text-white font-semibold hover:bg-[#c6711d] transition"
        >
          Demander un nouveau lien
        </RouterLink>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'

/**
 * Story 6.2 AC #1, #2 — landing magic-link adhérent.
 *
 * Vérifie le token via POST /api/auth/magic-link/verify, pose le cookie
 * de session 24h (HttpOnly) et redirige via `router.replace` (PAS push)
 * pour ne pas laisser /monespace/auth?token=... dans l'historique.
 *
 * Privacy : aucun email/nom adhérent affiché (page accessible avant auth).
 * Erreurs LINK_EXPIRED / LINK_CONSUMED / UNAUTHENTICATED → message
 * non-PII unique + CTA retour home.
 */

const route = useRoute()
const router = useRouter()

const state = ref<'loading' | 'error'>('loading')

function readQueryParam(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return undefined
}

onMounted(async () => {
  // Performance NFR-P6 — mark dès le mount pour mesurer landing → list.
  if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
    try {
      performance.mark('magic-link-clicked')
    } catch {
      /* ignore */
    }
  }

  const token = readQueryParam(route.query['token'] as string | string[] | undefined)
  const redirectQuery = readQueryParam(route.query['redirect'] as string | string[] | undefined)

  if (!token) {
    state.value = 'error'
    return
  }

  try {
    const res = await fetch('/api/auth/magic-link/verify', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        ...(redirectQuery ? { redirect: redirectQuery } : {}),
      }),
    })

    if (!res.ok) {
      state.value = 'error'
      return
    }

    const body = (await res.json()) as { redirect?: string; user?: unknown }
    // Anti open-redirect : on suit le redirect retourné par le serveur (déjà
    // validé par safeRedirect côté verify endpoint), pas celui de la query.
    const target =
      typeof body.redirect === 'string' &&
      body.redirect.startsWith('/') &&
      !body.redirect.startsWith('//')
        ? body.redirect
        : '/monespace'
    await router.replace(target)
  } catch {
    state.value = 'error'
  }
})
</script>

<style scoped>
.loader {
  width: 48px;
  height: 48px;
  border: 4px solid #e5e7eb;
  border-top-color: var(--main-orange, #f97316);
  border-radius: 50%;
  margin: 0 auto;
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
