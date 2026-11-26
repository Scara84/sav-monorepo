<template>
  <section class="member-sav-list">
    <header class="list-heading">
      <h2>{{ activeTab === 'group' ? 'Demandes de mon groupe' : 'Mes demandes de SAV' }}</h2>
      <label
        >Statut
        <select v-model="filter" data-test="status-filter" @change="onFilterChange">
          <option value="all">Tous</option>
          <option value="open">Ouverts</option>
          <option value="closed">Fermés</option>
        </select>
      </label>
    </header>

    <div
      v-if="isGroupManager"
      data-test="member-sav-tabs"
      role="tablist"
      aria-label="Demandes à consulter"
      class="scope-tabs"
      @keydown="onTabKey"
    >
      <button
        v-for="tab in ['self', 'group'] as const"
        :key="tab"
        :id="`sav-tab-${tab}`"
        type="button"
        role="tab"
        :data-test="`tab-${tab}`"
        :aria-selected="activeTab === tab"
        :tabindex="activeTab === tab ? 0 : -1"
        aria-controls="sav-results"
        @click="onTabClick(tab)"
      >
        {{ tab === 'self' ? 'Mes SAV' : 'Mon groupe' }}
        <span v-if="(tab === 'self' ? selfCount : groupCount) !== null"
          >({{ tab === 'self' ? selfCount : groupCount }})</span
        >
      </button>
    </div>

    <div
      id="sav-results"
      :role="isGroupManager ? 'tabpanel' : undefined"
      :aria-labelledby="isGroupManager ? `sav-tab-${activeTab}` : undefined"
    >
      <form
        v-if="isGroupManager && activeTab === 'group'"
        class="group-search"
        @submit.prevent="onSearchSubmit"
      >
        <label
          >Nom de l’adhérent
          <input
            v-model="groupQ"
            type="search"
            data-test="group-search"
            maxlength="100"
            placeholder="Ex. Martin"
          />
        </label>
        <button type="submit" data-test="group-search-submit">Rechercher</button>
      </form>

      <p v-if="loading" role="status" data-test="loading" aria-busy="true" class="state">
        <progress aria-label="Chargement des demandes"></progress> Chargement…
      </p>
      <p v-else-if="error" role="alert" class="state">{{ error }}</p>
      <p v-else-if="!visibleRows.length" role="status" class="state">
        <template v-if="activeTab === 'group'"
          >Aucun SAV dans votre groupe pour cette recherche.</template
        >
        <template v-else-if="filter !== 'all'"
          >Aucune demande ne correspond au statut sélectionné parmi les dossiers chargés.</template
        >
        <template v-else>Vous n'avez pas encore de SAV.</template>
      </p>
      <table v-else>
        <thead>
          <tr>
            <th v-if="activeTab === 'group'" scope="col">Adhérent</th>
            <th scope="col">Référence</th>
            <th scope="col">Reçu le</th>
            <th scope="col">Statut</th>
            <th scope="col">Total</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in visibleRows"
            :key="row.id"
            data-test="member-sav-row"
            @click="goToDetail(row.id)"
          >
            <td v-if="activeTab === 'group'" data-label="Adhérent">{{ memberShortName(row) }}</td>
            <td data-label="Référence">
              <RouterLink :to="{ name: 'member-sav-detail', params: { id: row.id } }" @click.stop>{{
                row.reference
              }}</RouterLink>
            </td>
            <td data-label="Reçu le">{{ formatDate(row.receivedAt) }}</td>
            <td data-label="Statut">
              <span class="status"
                ><span aria-hidden="true">{{ statusIcon(row.status) }}</span>
                {{ statusLabel(row.status) }}</span
              >
            </td>
            <td data-label="Total">{{ formatEur(row.totalAmountCents) }}</td>
          </tr>
        </tbody>
      </table>
      <button
        v-if="meta?.cursor"
        type="button"
        class="load-more"
        data-test="load-more"
        :disabled="loading"
        @click="onLoadMore"
      >
        Charger plus
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
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

// Story 6.5 — deux instances du composable, une par scope. On bascule entre
// elles via `activeTab`. Évite un re-fetch full sur switch (cache léger).
const selfList = useMemberSavList('self')
const groupList = useMemberSavList('group')
const selfCount = computed(() => selfList.meta.value?.count ?? null)
const groupCount = computed(() => groupList.meta.value?.count ?? null)

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
  // H-08 AC#3 — sur l'onglet group, le filtre statut doit être appliqué côté
  // serveur (cohérence pagination cursor + filtre q server-side).
  // Sur l'onglet self, V1 reste client-side via `visibleRows` (data déjà chargée,
  // pas de pagination cursor active).
  if (activeTab.value === 'group') {
    void groupList.load({ statusFilter: filter.value, q: groupQ.value })
  } else {
    groupList.reset()
  }
}

function onTabClick(tab: MemberSavScope): void {
  if (activeTab.value === tab) return
  activeTab.value = tab
  if (tab === 'group') {
    // H-08 AC#2 — lazy-load groupList la première fois qu'on ouvre l'onglet.
    // Utilise filter.value (et non 'all' hardcodé) pour aligner backend et UI.
    if (groupList.meta.value === null && !groupList.loading.value) {
      void groupList.load({ statusFilter: filter.value })
    }
  } else {
    // H-08 AC#1 — reset complet (state composable + UI) au switch vers self.
    // reset() appelle abort() en interne, puis clear data/meta/lastQ/lastStatusFilter.
    // Ainsi le retour sur l'onglet group repart d'un état propre (pas de q résiduel).
    groupList.reset()
    groupQ.value = ''
  }
}

function onTabKey(event: KeyboardEvent): void {
  let target: MemberSavScope
  if (event.key === 'Home') target = 'self'
  else if (event.key === 'End') target = 'group'
  else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    target = activeTab.value === 'self' ? 'group' : 'self'
  } else return
  event.preventDefault()
  onTabClick(target)
  document.getElementById(`sav-tab-${target}`)?.focus()
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
  // les compteurs suivent les métadonnées de chaque liste).
  if (isGroupManager.value === true && activeTab.value === 'self') {
    await groupList.load({ statusFilter: filter.value })
  }
})
</script>

<style scoped>
.member-sav-list {
  color: #302b25;
}
.list-heading,
.group-search,
.scope-tabs {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 0.75rem;
  margin-bottom: 1.25rem;
}
.list-heading {
  justify-content: space-between;
  align-items: center;
}
h2 {
  font-size: clamp(1.6rem, 4vw, 2.4rem);
  line-height: 1.15;
  font-weight: 750;
}
label {
  display: grid;
  gap: 0.25rem;
  font-size: 0.9rem;
  font-weight: 600;
}
button,
input,
select {
  color: inherit;
  background: #fff;
  border: 1px solid #978779;
  border-radius: 0.5rem;
  padding: 0.5rem 0.85rem;
  min-height: 44px;
}
button {
  font-weight: 600;
  cursor: pointer;
}
.scope-tabs {
  gap: 0.5rem;
}
[aria-selected='true'],
.group-search button {
  background: #e88a23;
  border-color: #995513;
}
table {
  width: 100%;
  background: #fff;
  border-collapse: collapse;
  text-align: left;
}
th,
td {
  padding: 0.85rem 1rem;
  border-bottom: 1px solid #e2d8cd;
}
th {
  background: #f4ecdf;
  font-size: 0.9rem;
}
td:last-child,
th:last-child {
  text-align: right;
}
tbody tr {
  cursor: pointer;
}
tbody tr:hover,
tbody tr:focus-within {
  background: #fffaef;
}
td a {
  color: #804308;
  font-weight: 700;
  text-decoration: underline;
  text-underline-offset: 0.18em;
}
.status {
  white-space: normal;
}
.state {
  padding: 1.25rem;
  background: white;
  border: 1px solid #e2d8cd;
  border-radius: 0.75rem;
}
[role='alert'] {
  color: #8d2626;
}
progress {
  width: 3rem;
  margin-right: 0.5rem;
  accent-color: #804308;
}
.load-more {
  margin-top: 1rem;
}
:focus-visible {
  outline: 3px solid #754006;
  outline-offset: 3px;
}
@media (max-width: 640px) {
  thead {
    position: absolute;
    clip-path: inset(50%);
    width: 1px;
    height: 1px;
    overflow: hidden;
  }
  table,
  tbody {
    display: block;
    background: transparent;
  }
  tbody tr {
    display: grid;
    border: 1px solid #dfd3c4;
    border-radius: 0.75rem;
    background: white;
    margin-bottom: 0.75rem;
    padding: 0.5rem 0.85rem;
  }
  td,
  td:last-child {
    display: grid;
    grid-template-columns: 5.5rem minmax(0, 1fr);
    gap: 0.5rem;
    padding: 0.45rem 0;
    border: 0;
    overflow-wrap: anywhere;
    text-align: left;
  }
  td::before {
    content: attr(data-label);
    color: #62564c;
    font-size: 0.9rem;
  }
  .group-search input {
    max-width: 100%;
  }
}
</style>
