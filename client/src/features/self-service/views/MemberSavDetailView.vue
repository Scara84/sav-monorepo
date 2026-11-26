<template>
  <section class="member-sav-detail" data-testid="member-sav-detail">
    <RouterLink :to="{ name: 'member-sav-list' }" class="detail-back">
      &larr; Retour à mes SAV
    </RouterLink>

    <div
      v-if="loading && savIdNum !== null"
      data-testid="loading-state"
      aria-busy="true"
      class="py-8 text-center"
    >
      <span
        class="inline-block w-8 h-8 border-4 border-gray-200 border-t-orange-500 rounded-full animate-spin"
      />
      <p class="mt-2 text-sm text-gray-600">Chargement…</p>
    </div>

    <div
      v-else-if="error === 'not_found' || savIdNum === null"
      data-testid="error-404"
      role="alert"
      class="mt-4 p-4 bg-red-50 border border-red-200 rounded text-red-700"
    >
      <p>SAV introuvable.</p>
      <button
        type="button"
        v-if="savIdNum !== null"
        data-testid="retry-button"
        class="mt-2 px-3 py-1 border rounded hover:bg-white"
        @click="onRetry"
      >
        Réessayer
      </button>
    </div>

    <div
      v-else-if="error"
      data-testid="error-generic"
      role="alert"
      class="mt-4 p-4 bg-red-50 border border-red-200 rounded text-red-700"
    >
      <p>Une erreur est survenue. Merci de réessayer.</p>
      <button
        type="button"
        data-testid="retry-button"
        class="mt-2 px-3 py-1 border rounded hover:bg-white"
        @click="onRetry"
      >
        Réessayer
      </button>
    </div>

    <div v-else-if="data" :key="data.id" class="detail-grid">
      <!-- Story 6.5 AC #9 — badge groupe UI quand un manager consulte un SAV
           d'un AUTRE adhérent de son groupe. Le serveur expose `member`
           uniquement dans ce cas → présence du champ = condition suffisante. -->
      <div
        v-if="data.member"
        data-testid="group-sav-badge"
        class="border rounded p-3 bg-blue-50 text-sm text-blue-800 flex items-center gap-2"
      >
        <span aria-hidden="true">👥</span>
        <span>SAV de votre groupe — {{ memberFullName }}</span>
      </div>

      <MemberSavSummary :detail="data" />

      <!-- Story 6.4 AC #1 — bouton télécharger bon SAV (PDF avoir) -->
      <div
        v-if="data.creditNote && data.creditNote.hasPdf"
        class="credit-status border rounded p-3 bg-green-50 flex flex-wrap gap-3 items-center justify-between"
      >
        <span class="text-sm text-green-800">Bon SAV (avoir) N° {{ data.creditNote.number }}</span>
        <a
          v-if="!data.member"
          data-testid="download-credit-note-pdf"
          :href="`/api/credit-notes/${data.creditNote.number}/pdf`"
          target="_blank"
          rel="noopener noreferrer"
          class="detail-action"
          >Télécharger bon SAV</a
        >
      </div>
      <div
        v-else-if="data.creditNote && !data.creditNote.hasPdf"
        :data-testid="'credit-note-pdf-pending'"
        class="border rounded p-3 bg-yellow-50 text-sm text-yellow-800"
      >
        Avoir N° {{ data.creditNote.number }} · PDF indisponible.
      </div>

      <MemberSavStatusHistory :detail="data" />
      <MemberSavLines :lines="data.lines" />
      <MemberSavFilesList
        :files="data.files"
        :sav-reference="data.reference"
        @uploaded="onUploaded"
        @verify="onUploaded"
      />
      <MemberSavCommentsThread
        v-model="commentDraft"
        :comments="data.comments"
        @submit="onCommentSubmit"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { useMemberSavDetail } from '../composables/useMemberSavDetail'
import MemberSavSummary from '../components/MemberSavSummary.vue'
import MemberSavLines from '../components/MemberSavLines.vue'
import MemberSavFilesList from '../components/MemberSavFilesList.vue'
import MemberSavCommentsThread from '../components/MemberSavCommentsThread.vue'
import MemberSavStatusHistory from '../components/MemberSavStatusHistory.vue'

/**
 * Story 6.3 — détail SAV self-service.
 *
 * Compose les 5 sous-composants AC #15. Charge via composable
 * useMemberSavDetail(savId), gère error 404/generic + retry.
 *
 * Pipeline upload : MemberSavFilesList émet `uploaded` → re-fetch détail.
 * Pipeline comment : MemberSavCommentsThread émet `submit(body, done)` →
 *   composable optimistic addComment + done(ok, reason).
 */

const route = useRoute()
const commentDraft = ref('')
const { data, loading, error, load, addComment, refreshAfterUpload, reset } = useMemberSavDetail()

// H-11 AC #2 (b) — cleanup polling quand l'adhérent navigue ailleurs
onBeforeUnmount(() => reset())

// Story 6.5 AC #9 — nom court de l'adhérent propriétaire pour le badge groupe.
const memberFullName = computed<string>(() => {
  const m = data.value?.member
  if (!m) return ''
  const fn = m.firstName?.trim() ?? ''
  const ln = m.lastName?.trim() ?? ''
  if (fn && ln) return `${fn} ${ln}`
  return ln || fn || 'Adhérent'
})

const savIdNum = computed<number | null>(() => {
  const raw = route.params['id']
  const candidate = Array.isArray(raw) ? raw[0] : raw
  const n = Number(candidate)
  return Number.isInteger(n) && n > 0 ? n : null
})

async function onRetry(): Promise<void> {
  if (savIdNum.value !== null) await load(savIdNum.value)
}

async function onUploaded(): Promise<void> {
  await refreshAfterUpload()
}

// eslint-disable-next-line no-unused-vars -- noms documentaires dans signature callback `done`
function onCommentSubmit(body: string, done: (ok: boolean, reason?: string) => void): void {
  void addComment(body).then((res) => {
    if (res.ok) done(true)
    else done(false, res.reason)
  })
}

watch(
  savIdNum,
  (next) => {
    commentDraft.value = ''
    if (next === null) reset()
    else void load(next)
  },
  { immediate: true }
)
</script>

<style scoped>
.member-sav-detail {
  padding: clamp(1rem, 3vw, 2rem);
  color: #29261f;
  background: #fffaf1;
  border-radius: 1rem;
  overflow-wrap: anywhere;
}
.detail-back {
  display: inline-block;
  padding-block: 0.5rem;
  color: #73400c;
  text-decoration: underline;
}
.detail-grid {
  display: grid;
  gap: 1rem;
  margin-top: 1rem;
}
.detail-grid > * {
  min-width: 0;
}
.detail-grid > section {
  background: #fffefa;
  border: 1px solid #ded4c5;
  border-radius: 0.8rem;
  padding: 1rem;
}
.detail-grid > .member-sav-summary {
  border-top: 4px solid #e88a23;
}
.detail-action,
.member-sav-detail :deep(button:not(:disabled)) {
  background: #e88a23;
  color: #29261f;
  font-weight: 600;
  padding: 0.55rem 0.9rem;
  border-radius: 0.5rem;
}
.member-sav-detail :deep(:focus-visible) {
  outline: 3px solid #854500;
  outline-offset: 3px;
}
@media (min-width: 800px) {
  .detail-grid {
    grid-template-columns: minmax(0, 2fr) minmax(13rem, 1fr);
    align-items: start;
  }
  .detail-grid > * {
    grid-column: 1;
  }
  .detail-grid > .member-sav-status-history {
    grid-column: 2;
    grid-row: 1 / span 6;
  }
}
</style>
