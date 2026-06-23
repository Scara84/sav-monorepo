<template>
  <section
    class="member-sav-comments-thread border rounded p-4 bg-white"
    data-testid="sav-comments-thread"
  >
    <h3 class="text-lg font-semibold mb-3">Commentaires</h3>

    <form class="mb-4 space-y-2" data-testid="comment-form" @submit.prevent="onSubmit">
      <textarea
        v-model="bodyInput"
        data-testid="comment-body-input"
        class="w-full border rounded px-2 py-1 text-sm"
        rows="3"
        placeholder="Posez une question ou ajoutez une précision…"
        :maxlength="2000"
        :disabled="submitting"
        aria-label="Texte du commentaire"
      />
      <div class="flex items-center justify-between">
        <span class="text-xs text-gray-500">{{ bodyInput.length }} / 2000</span>
        <button
          type="submit"
          class="text-sm px-3 py-1.5 rounded bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-50"
          data-testid="comment-submit"
          :disabled="!canSubmit"
        >
          {{ submitting ? 'Envoi…' : 'Ajouter' }}
        </button>
      </div>
      <p v-if="errorMsg" data-testid="comment-error" role="alert" class="text-sm text-red-700">
        {{ errorMsg }}
      </p>
    </form>

    <ul v-if="comments.length > 0" class="space-y-3">
      <li
        v-for="c in comments"
        :key="c.id"
        class="border-b pb-2"
        :data-testid="`comment-item-${c.id}`"
      >
        <div class="text-xs text-gray-500">
          <span data-testid="comment-author-label">{{ c.authorLabel }}</span>
          · {{ formatDate(c.createdAt) }}
        </div>
        <!-- IMPORTANT : interpolation Vue (auto-escape XSS) — JAMAIS v-html -->
        <p data-testid="comment-body" class="text-sm whitespace-pre-wrap mt-1">{{ c.body }}</p>
      </li>
    </ul>
    <p v-else class="text-sm text-gray-500">Aucun commentaire pour l'instant.</p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { MemberSavComment } from '../composables/useMemberSavDetail'

const props = defineProps<{ comments: MemberSavComment[] }>()
const emit = defineEmits<{
  // eslint-disable-next-line no-unused-vars -- noms documentaires dans signature type
  submit: [body: string, done: (ok: boolean, reason?: string) => void]
}>()

const bodyInput = ref('')
const submitting = ref(false)
const errorMsg = ref<string | null>(null)

const canSubmit = computed(() => {
  if (submitting.value) return false
  const t = bodyInput.value.trim()
  return t.length > 0 && t.length <= 2000
})

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function onSubmit(): void {
  errorMsg.value = null
  const trimmed = bodyInput.value.trim()
  if (trimmed.length === 0) {
    errorMsg.value = 'Le commentaire ne peut pas être vide.'
    return
  }
  if (trimmed.length > 2000) {
    errorMsg.value = 'Le commentaire dépasse 2000 caractères.'
    return
  }
  submitting.value = true
  emit('submit', trimmed, (ok, reason) => {
    submitting.value = false
    if (ok) {
      bodyInput.value = ''
    } else {
      errorMsg.value = labelFromReason(reason)
    }
  })
}

function labelFromReason(reason?: string): string {
  switch (reason) {
    case 'rate_limited':
      return 'Trop de commentaires. Merci de patienter.'
    case 'validation_failed':
      return 'Commentaire invalide.'
    case 'not_found':
      return 'SAV introuvable.'
    case 'network_error':
      return 'Connexion impossible. Réessayez.'
    default:
      return "Erreur lors de l'envoi du commentaire."
  }
}

// Force props to be referenced (template-driven scenario covers it).
void props
</script>
