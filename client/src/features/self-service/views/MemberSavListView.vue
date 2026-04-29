<template>
  <section class="member-sav-list">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-2xl font-bold">Mes demandes de SAV</h2>
      <label class="text-sm">
        Filtre :
        <select
          v-model="filter"
          data-test="status-filter"
          class="ml-2 border rounded px-2 py-1"
          @change="onFilterChange"
        >
          <option value="all">Tous</option>
          <option value="open">Ouverts</option>
          <option value="closed">Fermés</option>
        </select>
      </label>
    </div>

    <!-- Story 6.5 AC #1 / #8 — onglets « Mes SAV » / « Mon groupe »
         conditionnel sur isGroupManager. Member normal → pas de tabs. -->
    <div
      v-if="isGroupManager"
      data-test="member-sav-tabs"
      class="flex border-b mb-4"
      role="tablist"
    >
      <button
        type="button"
        role="tab"
        :aria-selected="activeTab === 'self'"
        data-test="tab-self"
        class="px-4 py-2 -mb-px border-b-2 text-sm font-medium"
        :class="
          activeTab === 'self'
            ? 'border-[color:var(--main-orange,#f97316)] text-[color:var(--main-orange,#f97316)]'
            : 'border-transparent text-gray-600 hover:text-gray-800'
        "
        @click="onTabClick('self')"
      >
        Mes SAV<span v-if="selfCount !== null" class="ml-1 text-gray-500">({{ selfCount }})</span>
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="activeTab === 'group'"
        data-test="tab-group"
        class="px-4 py-2 -mb-px border-b-2 text-sm font-medium"
        :class="
          activeTab === 'group'
            ? 'border-[color:var(--main-orange,#f97316)] text-[color:var(--main-orange,#f97316)]'
            : 'border-transparent text-gray-600 hover:text-gray-800'
        "
        @click="onTabClick('group')"
      >
        Mon groupe<span v-if="groupCount !== null" class="ml-1 text-gray-500"
          >({{ groupCount }})</span
        >
      </button>
    </div>

    <!-- Filtre `q` (last_name) sur l'onglet groupe uniquement. -->
    <div v-if="isGroupManager && activeTab === 'group'" class="mb-3 flex items-center gap-3">
      <label class="text-sm">
        Recherche par nom :
        <input
          v-model="groupQ"
          type="text"
          data-test="group-search"
          maxlength="100"
          class="ml-2 border rounded px-2 py-1"
          placeholder="ex. Martin"
          @keyup.enter="onSearchSubmit"
        />
      </label>
      <button
        type="button"
        data-test="group-search-submit"
        class="px-3 py-1 border rounded hover:bg-gray-50 text-sm"
        @click="onSearchSubmit"
      >
        Filtrer
      </button>
    </div>

    <div v-if="loading" data-test="loading" aria-busy="true" class="py-8 text-center">
      <span
        class="inline-block w-8 h-8 border-4 border-gray-200 border-t-[color:var(--main-orange,#f97316)] rounded-full animate-spin"
      />
      <p class="mt-2 text-sm text-gray-600">Chargement…</p>
    </div>

    <div
      v-else-if="error"
      role="alert"
      class="p-4 bg-red-50 border border-red-200 rounded text-red-700"
    >
      Une erreur est survenue. Merci de réessayer.
    </div>

    <div v-else-if="visibleRows.length === 0" class="p-8 text-center text-gray-600">
      <span v-if="activeTab === 'group'">Aucun SAV dans votre groupe pour cette recherche.</span>
      <span v-else>Vous n'avez pas encore de SAV.</span>
    </div>

    <div v-else>
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="border-b text-sm text-gray-600">
            <th v-if="activeTab === 'group'" class="py-2 px-2">Adhérent</th>
            <th class="py-2 px-2">Référence</th>
            <th class="py-2 px-2">Reçu le</th>
            <th class="py-2 px-2">Statut</th>
            <th class="py-2 px-2 text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in visibleRows"
            :key="row.id"
            data-test="member-sav-row"
            class="border-b cursor-pointer hover:bg-gray-50"
            @click="goToDetail(row.id)"
          >
            <td v-if="activeTab === 'group'" class="py-2 px-2 text-sm">
              {{ memberShortName(row) }}
            </td>
            <td class="py-2 px-2 font-medium">{{ row.reference }}</td>
            <td class="py-2 px-2">{{ formatDate(row.receivedAt) }}</td>
            <td class="py-2 px-2">
              <span :title="statusLabel(row.status)">{{ statusIcon(row.status) }}</span>
              <span class="ml-2">{{ statusLabel(row.status) }}</span>
            </td>
            <td class="py-2 px-2 text-right">{{ formatEur(row.totalAmountCents) }}</td>
          </tr>
        </tbody>
      </table>

      <div v-if="meta && meta.cursor" class="mt-4 text-center">
        <button
          data-test="load-more"
          class="px-4 py-2 border rounded hover:bg-gray-50"
          :disabled="loading"
          @click="onLoadMore"
        >
          Charger plus
        </button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  statusIcon,
  statusLabel,
  isOpenStatus,
  isClosedStatus,
} from '@/shared/utils/sav-status-icons'
import {
  useMemberSavList,
  type MemberSavListItem,
  type MemberSavScope,
} from '../composables/useMemberSavList'

/**
 * Story 6.2 AC #4-6 — liste self-service des SAV de l'adhérent.
 * Story 6.5 AC #1, #8 — onglets « Mes SAV » / « Mon groupe » conditionnel
 *   sur `isGroupManager`. Member normal → pas de tabs (régression Story 6.2).
 *
 * - GET /api/self-service/sav (cookie session) — scope=self|group
 * - tri par received_at DESC (le serveur le fait déjà)
 * - pagination cursor : bouton "Charger plus" si meta.cursor non-null
 * - filtre statut <select> client-side (Tous / Ouverts / Fermés)
 * - filtre q (last_name) côté serveur sur l'onglet groupe (re-fetch sur submit)
 * - empty state, error state, loading state
 * - clic ligne → router.push('/monespace/sav/:id')
 */

const router = useRouter()

const isGroupManager = ref<boolean | null>(null)
const activeTab = ref<MemberSavScope>('self')
const filter = ref<'all' | 'open' | 'closed'>('all')
const groupQ = ref<string>('')
const selfCount = ref<number | null>(null)
const groupCount = ref<number | null>(null)

// Story 6.5 — deux instances du composable, une par scope. On bascule entre
// elles via `activeTab`. Évite un re-fetch full sur switch (cache léger).
const selfList = useMemberSavList('self')
const groupList = useMemberSavList('group')

const data = computed(() =>
  activeTab.value === 'group' ? groupList.data.value : selfList.data.value
)
const meta = computed(() =>
  activeTab.value === 'group' ? groupList.meta.value : selfList.meta.value
)
const loading = computed(() =>
  activeTab.value === 'group' ? groupList.loading.value : selfList.loading.value
)
const error = computed(() =>
  activeTab.value === 'group' ? groupList.error.value : selfList.error.value
)

const visibleRows = computed(() => {
  const rows = data.value ?? []
  if (filter.value === 'open') return rows.filter((r) => isOpenStatus(r.status))
  if (filter.value === 'closed') return rows.filter((r) => isClosedStatus(r.status))
  return rows
})

function memberShortName(row: MemberSavListItem): string {
  if (!row.member) return '—'
  const fn = row.member.firstName?.trim() ?? ''
  const ln = row.member.lastName?.trim() ?? ''
  if (fn && ln) return `${fn} ${ln}`
  return ln || fn || '—'
}

function formatEur(cents: number): string {
  if (!Number.isFinite(cents)) return '—'
  return (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })
}

function formatDate(iso: string): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    })
  } catch {
    return iso
  }
}

function goToDetail(id: number): void {
  void router.push({ name: 'member-sav-detail', params: { id } })
}

function onFilterChange(): void {
  // V1 : filtre statut client-side uniquement (pas de re-fetch).
}

function onTabClick(tab: MemberSavScope): void {
  activeTab.value = tab
  // CR P4 (2026-04-29) — abort tout fetch inflight de l'onglet abandonné
  // pour éviter les races (le composable abort() est idempotent).
  if (tab === 'group') {
    selfList.abort()
    // Lazy-load groupList la première fois qu'on ouvre l'onglet.
    if (groupList.meta.value === null && !groupList.loading.value) {
      void groupList.load({ statusFilter: 'all' })
    }
  } else {
    groupList.abort()
    // CR W6.5-7 (2026-04-29) — reset `groupQ` quand on quitte l'onglet group
    // pour éviter qu'il persiste cross-tab et confuse l'UX au retour.
    groupQ.value = ''
  }
}

function onSearchSubmit(): void {
  // CR P5 (2026-04-29) — utilise le composable q-aware au lieu d'un fetch direct.
  // Le composable abort le précédent et préserve `q` pour les loadMore suivants.
  void groupList.load({ statusFilter: filter.value, q: groupQ.value })
}

function onLoadMore(): void {
  if (activeTab.value === 'group') void groupList.loadMore()
  else void selfList.loadMore()
}

// Synchronise le compteur `groupCount` à chaque changement de `groupList.meta`.
watch(
  () => groupList.meta.value,
  (m) => {
    if (m) groupCount.value = m.count
  }
)
watch(
  () => selfList.meta.value,
  (m) => {
    if (m) selfCount.value = m.count
  }
)

async function loadMe(): Promise<void> {
  try {
    const res = await fetch('/api/auth/me', {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) {
      isGroupManager.value = false
      return
    }
    const body = (await res.json()) as { user?: { isGroupManager?: boolean } }
    isGroupManager.value = body.user?.isGroupManager === true
  } catch {
    isGroupManager.value = false
  }
}

onMounted(async () => {
  // Performance NFR-P6 — measure landing → first list paint.
  await Promise.all([loadMe(), selfList.load({ statusFilter: 'all' })])

  if (typeof performance !== 'undefined' && typeof performance.measure === 'function') {
    try {
      performance.measure('magic-link-to-list', 'magic-link-clicked')
    } catch {
      /* mark may not exist (direct nav, refresh) — silent */
    }
  }

  // Si manager : pré-fetch group count en arrière-plan (1 seul appel léger,
  // les watch ci-dessus mettent à jour selfCount/groupCount automatiquement).
  if (isGroupManager.value === true) {
    await groupList.load({ statusFilter: 'all' })
  }
})
</script>
