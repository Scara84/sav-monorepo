<template>
  <main class="magic-link-landing min-h-screen flex items-center justify-center bg-[#faf7f1] p-4 text-[#33281d]">
    <div class="max-w-md w-full rounded-2xl border border-[#ded5c8] bg-white p-6 sm:p-8" role="status" :aria-busy="state === 'loading'">
      <template v-if="state === 'loading'">
        <div class="loader" aria-hidden="true" />
        <p class="mt-4 text-lg font-semibold">Connexion en cours…</p>
      </template>
      <template v-else-if="state === 'error'">
        <h1 class="text-2xl font-bold text-[#33281d] mb-4">
          Lien expiré ou déjà utilisé
        </h1>
        <p class="mb-6">
          Un lien de connexion ne fonctionne qu’une fois. Demandez-en un nouveau pour accéder à votre espace.
        </p>
        <RouterLink
          :to="newLinkTarget"
          data-test="cta-new-link"
          class="inline-block px-6 py-3 rounded-3xl bg-[#e88a23] text-[#33281d] font-semibold hover:bg-[#efa044] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#33281d]"
        >
          Demander un nouveau lien
        </RouterLink>
      </template>
    </div>
  </main>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { safeMemberRedirect } from '@/shared/utils/member-redirect.js'

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
const requestedRedirect = safeMemberRedirect(
  readQueryParam(route.query['redirect'] as string | string[] | undefined)
)
const newLinkTarget = {
  path: '/',
  query: { reason: 'session_expired', redirect: requestedRedirect },
}

function readQueryParam(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return undefined
}

function readTokenFromHash(): string | undefined {
  if (typeof window === 'undefined') return undefined
  const hash = window.location.hash
  if (!hash || hash.length < 2) return undefined
  const params = new URLSearchParams(hash.slice(1))
  const t = params.get('token')
  return t && t.length > 0 ? t : undefined
}

function retryChangedLink() {
  if (readTokenFromHash()) {
    window.location.reload()
  }
}

onUnmounted(() => window.removeEventListener('hashchange', retryChangedLink))

onMounted(async () => {
  window.addEventListener('hashchange', retryChangedLink)
  // Performance NFR-P6 — mark dès le mount pour mesurer landing → list.
  if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
    try {
      performance.mark('magic-link-clicked')
    } catch {
      /* ignore */
    }
  }

  // Token is in URL fragment (`#token=...`) — fragments never travel in Referer
  // headers, preventing third-party scripts loaded on this page from leaking it.
  // Backend contract: api/auth/magic-link/issue.ts:buildMagicUrl.
  const token = readTokenFromHash()

  if (!token) {
    state.value = 'error'
    return
  }

  // Strip token from history so it cannot be replayed via back-button.
  if (typeof window !== 'undefined' && window.history?.replaceState) {
    try {
      const { pathname, search } = window.location
      window.history.replaceState(null, '', pathname + search)
    } catch {
      /* ignore */
    }
  }

  try {
    const res = await fetch('/api/auth/magic-link/verify', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        redirect: requestedRedirect,
      }),
    })

    if (!res.ok) {
      state.value = 'error'
      return
    }

    const body = (await res.json()) as { redirect?: string; user?: unknown }
    // Anti open-redirect : on suit le redirect retourné par le serveur (déjà
    // validé par safeRedirect côté verify endpoint), pas celui de la query.
    const target = safeMemberRedirect(body.redirect)
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
  border-top-color: #e88a23;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .loader { animation: none; }
}
</style>
