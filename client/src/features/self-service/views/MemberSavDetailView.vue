<template>
  <section class="member-sav-detail" data-testid="member-sav-detail">
    <RouterLink :to="{ name: 'member-sav-list' }" class="text-sm text-gray-600 hover:underline">
      &larr; Retour à mes SAV
    </RouterLink>

    <div v-if="loading" data-testid="loading-state" aria-busy="true" class="py-8 text-center">
      <span
        class="inline-block w-8 h-8 border-4 border-gray-200 border-t-orange-500 rounded-full animate-spin"
      />
      <p class="mt-2 text-sm text-gray-600">Chargement…</p>
    </div>

    <div
      v-else-if="error === 'not_found'"
      data-testid="error-404"
      role="alert"
      class="mt-4 p-4 bg-red-50 border border-red-200 rounded text-red-700"
    >
      <p>SAV introuvable.</p>
      <button
        type="button"
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

    <div v-else-if="data" class="mt-4 space-y-4">
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
        class="border rounded p-3 bg-green-50 flex items-center justify-between"
      >
        <span class="text-sm text-green-800"
          >Bon SAV (avoir) disponible — N° {{ data.creditNote.number }}</span
        >
        <a
          :data-testid="'download-credit-note-pdf'"
          :href="`/api/credit-notes/${data.creditNote.number}/pdf`"
          target="_blank"
          rel="noopener noreferrer"
          class="ml-3 px-3 py-1 bg-[color:var(--main-orange,#f97316)] text-white rounded hover:opacity-90 text-sm"
          >Télécharger bon SAV</a
        >
      </div>
      <div
        v-else-if="data.creditNote && !data.creditNote.hasPdf"
        :data-testid="'credit-note-pdf-pending'"
        class="border rounded p-3 bg-yellow-50 text-sm text-yellow-800"
      >
        PDF en cours de génération (l'avoir N° {{ data.creditNote.number }} sera disponible dans
        quelques instants).
      </div>

      <MemberSavStatusHistory :detail="data" />
      <MemberSavLines :lines="data.lines" />
      <MemberSavFilesList
        :files="data.files"
        :sav-reference="data.reference"
        @uploaded="onUploaded"
      />
      <MemberSavCommentsThread :comments="data.comments" @submit="onCommentSubmit" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
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
const { data, loading, error, load, addComment, refreshAfterUpload } = useMemberSavDetail()

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

onMounted(() => {
  if (savIdNum.value !== null) void load(savIdNum.value)
})

// React to route param changes (deep-link nav between two SAVs).
watch(savIdNum, (next) => {
  if (next !== null) void load(next)
})
</script>
