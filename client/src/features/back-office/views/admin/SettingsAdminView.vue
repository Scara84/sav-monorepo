<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { LocationQueryValue } from 'vue-router'
import {
  useAdminSettings,
  type SettingHistoryItem,
  type ThresholdAlertValue,
} from '../../composables/useAdminSettings'

/**
 * Story 5.5 AC #8 — Admin settings versionnés (V1 onglet « Seuils »).
 *
 * Onglet « Seuils » expose le formulaire d'édition de la clé
 * `threshold_alert` consommée par le cron `threshold-alerts.ts` (cron
 * dispatcher 1×/jour à 03:00 UTC). L'admin peut modifier le seuil, la
 * fenêtre, et la dédup ; les nouvelles valeurs sont appliquées au
 * prochain tour de cron (jusqu'à 24 h).
 *
 * Route : `/admin/settings?tab=thresholds`. La structure tabbed est
 * extensible — Story 7.4 ajoutera d'autres onglets (TVA, remise
 * responsable, dossier OneDrive, etc.).
 */

type TabId = 'thresholds'

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [{ id: 'thresholds', label: 'Seuils' }]

const route = useRoute()
const router = useRouter()
const settings = useAdminSettings()

const activeTab = ref<TabId>('thresholds')

const form = ref<ThresholdAlertValue & { notes: string }>({
  count: 5,
  days: 7,
  dedup_hours: 24,
  notes: '',
})

// CR patch U6 : ne pas laisser l'utilisateur soumettre les valeurs par
// défaut affichées avant que `loadCurrent` ait réhydraté les valeurs
// réellement actives. Le bouton est désactivé tant que `formHydrated`
// est false.
const formHydrated = ref(false)

const toast = ref<{ kind: 'success' | 'error'; message: string } | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null

function showToast(kind: 'success' | 'error', message: string): void {
  if (toastTimer !== null) clearTimeout(toastTimer)
  toast.value = { kind, message }
  toastTimer = setTimeout(() => {
    toast.value = null
    toastTimer = null
  }, 4000)
}

// CR patch U5 : clear le timer du toast au démontage pour éviter une
// mutation reactive sur composant détruit (Vue 3 tolère mais sloppy).
onBeforeUnmount(() => {
  if (toastTimer !== null) {
    clearTimeout(toastTimer)
    toastTimer = null
  }
})

function hydrateFromTab(): void {
  const raw = route.query['tab']
  const t = Array.isArray(raw) ? raw[0] : raw
  if (typeof t === 'string' && TABS.some((tab) => tab.id === t)) {
    activeTab.value = t as TabId
  }
}

// CR patch U3 : préserver TOUTES les entrées de query string (y compris
// null `?foo` et arrays) lors d'un switch d'onglet. Vue Router type
// `LocationQueryValue` couvre string | null ; on conserve tel quel.
function selectTab(id: TabId): void {
  activeTab.value = id
  const nextQuery: Record<string, LocationQueryValue | LocationQueryValue[]> = {}
  for (const [k, val] of Object.entries(route.query)) {
    if (k === 'tab') continue
    nextQuery[k] = val as LocationQueryValue | LocationQueryValue[]
  }
  nextQuery['tab'] = id
  void router.replace({ query: nextQuery })
}

async function refresh(): Promise<void> {
  try {
    await settings.loadCurrent('threshold_alert')
    if (settings.current.value !== null) {
      const v = settings.current.value.value
      form.value = {
        count: v.count,
        days: v.days,
        dedup_hours: v.dedup_hours,
        notes: '',
      }
    }
    formHydrated.value = true
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return
    showToast('error', settings.loadError.value ?? 'Lecture impossible.')
  }
}

// CR patch U8 : valide cliennt-side que les 3 numbers sont des entiers
// dans les bornes Zod du serveur. Le bouton est désactivé si invalide,
// `onSubmit` court-circuite par sécurité (clavier admin scriptable).
const formIsValid = computed(() => {
  const { count, days, dedup_hours } = form.value
  return (
    Number.isInteger(count) &&
    count >= 1 &&
    count <= 100 &&
    Number.isInteger(days) &&
    days >= 1 &&
    days <= 365 &&
    Number.isInteger(dedup_hours) &&
    dedup_hours >= 1 &&
    dedup_hours <= 168
  )
})

async function onSubmit(e: Event): Promise<void> {
  e.preventDefault()
  if (settings.saving.value || !formHydrated.value || !formIsValid.value) return
  try {
    await settings.updateThreshold({
      count: form.value.count,
      days: form.value.days,
      dedup_hours: form.value.dedup_hours,
      notes: form.value.notes.trim() === '' ? undefined : form.value.notes.trim(),
    })
    showToast('success', 'Seuils enregistrés. Appliqués au prochain cron (jusqu’à 24 h).')
    form.value.notes = ''
    // CR patch U4 : aligner sur le label "5 dernières versions" affiché.
    await settings.loadHistory('threshold_alert', 5)
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return
    showToast('error', settings.saveError.value ?? 'Enregistrement impossible.')
  }
}

const formattedHistory = computed(() =>
  settings.history.value.map((item: SettingHistoryItem) => ({
    id: item.id,
    valid_from: formatDateTime(item.valid_from),
    valid_to: item.valid_to === null ? null : formatDateTime(item.valid_to),
    isActive: item.valid_to === null,
    value: item.value,
    notes: item.notes,
    operator: item.updated_by?.email_display_short ?? null,
  }))
)

function formatDateTime(iso: string): string {
  if (!iso) return '—'
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

onMounted(async () => {
  hydrateFromTab()
  await refresh()
})
</script>

<template>
  <main class="settings-admin-view">
    <header class="header">
      <h1>Paramètres administrateur</h1>
      <p class="subtitle">Configurez les seuils et préférences globaux du back-office.</p>
    </header>

    <nav class="tabs" role="tablist" aria-label="Onglets paramètres">
      <button
        v-for="tab in TABS"
        :key="tab.id"
        type="button"
        role="tab"
        :aria-selected="activeTab === tab.id"
        :class="['tab', { active: activeTab === tab.id }]"
        @click="selectTab(tab.id)"
      >
        {{ tab.label }}
      </button>
    </nav>

    <section v-if="activeTab === 'thresholds'" role="tabpanel" class="panel">
      <header class="panel-header">
        <h2>Seuil alerte produit</h2>
        <p class="hint">
          Si un produit dépasse ce nombre de SAV sur la fenêtre indiquée, un email est envoyé aux
          opérateurs actifs au prochain tour de cron (1×/jour à 03:00 UTC). La dédup empêche l'envoi
          répété d'une même alerte pendant la fenêtre indiquée.
        </p>
      </header>

      <form class="form" @submit="onSubmit">
        <div class="field">
          <label for="threshold-count">Nombre de SAV</label>
          <input
            id="threshold-count"
            v-model.number="form.count"
            type="number"
            min="1"
            max="100"
            step="1"
            required
          />
          <span class="field-hint">Seuil à partir duquel l'alerte se déclenche (1–100).</span>
        </div>
        <div class="field">
          <label for="threshold-days">Fenêtre (jours)</label>
          <input
            id="threshold-days"
            v-model.number="form.days"
            type="number"
            min="1"
            max="365"
            step="1"
            required
          />
          <span class="field-hint">Durée glissante d'observation (1–365 jours).</span>
        </div>
        <div class="field">
          <label for="threshold-dedup">Dédup (heures)</label>
          <input
            id="threshold-dedup"
            v-model.number="form.dedup_hours"
            type="number"
            min="1"
            max="168"
            step="1"
            required
          />
          <span class="field-hint"
            >Délai minimum entre deux alertes pour le même produit (1–168 h).</span
          >
        </div>
        <div class="field full">
          <label for="threshold-notes">Note (optionnel)</label>
          <input
            id="threshold-notes"
            v-model="form.notes"
            type="text"
            maxlength="500"
            placeholder="Motivation du changement (audit)"
          />
        </div>
        <div class="actions">
          <button
            type="submit"
            class="btn primary"
            :disabled="settings.saving.value || settings.loading.value"
          >
            {{ settings.saving.value ? 'Enregistrement…' : 'Enregistrer' }}
          </button>
          <p class="apply-note">
            Les seuils sont appliqués au prochain tour de cron (jusqu'à 24 h).
          </p>
        </div>
      </form>

      <section class="history">
        <h3>Historique (5 dernières versions)</h3>
        <p v-if="settings.loading.value" class="status">Chargement…</p>
        <p v-else-if="formattedHistory.length === 0" class="status muted">
          Aucune version enregistrée.
        </p>
        <table v-else class="history-table" aria-label="Historique des seuils">
          <thead>
            <tr>
              <th scope="col">Période</th>
              <th scope="col">Seuil</th>
              <th scope="col">Fenêtre (j)</th>
              <th scope="col">Dédup (h)</th>
              <th scope="col">Auteur</th>
              <th scope="col">Note</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="item in formattedHistory.slice(0, 5)"
              :key="item.id"
              :class="{ active: item.isActive }"
            >
              <td>
                <div>{{ item.valid_from }}</div>
                <div class="muted">
                  {{ item.isActive ? 'Active' : `→ ${item.valid_to}` }}
                </div>
              </td>
              <td>{{ item.value.count }}</td>
              <td>{{ item.value.days }}</td>
              <td>{{ item.value.dedup_hours }}</td>
              <td>{{ item.operator ?? '—' }}</td>
              <td>{{ item.notes ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </section>

    <transition name="toast">
      <div v-if="toast !== null" :class="['toast', toast.kind]" role="status" aria-live="polite">
        {{ toast.message }}
      </div>
    </transition>
  </main>
</template>

<style scoped>
.settings-admin-view {
  padding: 1.5rem;
  max-width: 960px;
  margin: 0 auto;
}
.header h1 {
  margin: 0 0 0.25rem 0;
  font-size: 1.5rem;
}
.subtitle {
  margin: 0 0 1.5rem 0;
  color: #666;
  font-size: 0.95rem;
}
.tabs {
  display: flex;
  gap: 0.25rem;
  border-bottom: 1px solid #eee;
  margin-bottom: 1.5rem;
}
.tab {
  background: none;
  border: none;
  padding: 0.5rem 1rem;
  font-size: 0.95rem;
  cursor: pointer;
  color: #555;
  border-bottom: 2px solid transparent;
}
.tab:hover {
  color: #222;
}
.tab.active {
  color: #f57c00;
  border-bottom-color: #f57c00;
  font-weight: 600;
}
.panel {
  background: #fff;
  border: 1px solid #eee;
  border-radius: 6px;
  padding: 1.5rem;
}
.panel-header h2 {
  margin: 0 0 0.25rem 0;
  font-size: 1.15rem;
}
.hint {
  margin: 0 0 1rem 0;
  color: #555;
  font-size: 0.9rem;
  line-height: 1.4;
}
.form {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1rem;
  margin-bottom: 1.5rem;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.field.full {
  grid-column: 1 / -1;
}
.field label {
  font-weight: 600;
  font-size: 0.9rem;
}
.field input {
  padding: 0.5rem 0.75rem;
  font-size: 1rem;
  border: 1px solid #ccc;
  border-radius: 4px;
}
.field input:focus {
  outline: 2px solid #0066cc;
  outline-offset: 1px;
}
.field-hint {
  color: #666;
  font-size: 0.8rem;
}
.actions {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
}
.btn {
  padding: 0.55rem 1.2rem;
  border-radius: 4px;
  border: none;
  font-size: 0.95rem;
  cursor: pointer;
}
.btn.primary {
  background: #f57c00;
  color: white;
  font-weight: 600;
}
.btn.primary:hover:not(:disabled) {
  background: #e65100;
}
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.apply-note {
  margin: 0;
  color: #777;
  font-size: 0.85rem;
}
.history h3 {
  font-size: 1rem;
  margin: 0 0 0.5rem 0;
}
.history-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.history-table th,
.history-table td {
  text-align: left;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid #f0f0f0;
}
.history-table th {
  background: #fafafa;
  font-weight: 600;
}
.history-table tr.active td {
  background: #fff8e1;
}
.muted {
  color: #999;
  font-size: 0.85rem;
}
.status {
  color: #666;
  font-style: italic;
  margin: 0.5rem 0;
}
.toast {
  position: fixed;
  bottom: 1.5rem;
  right: 1.5rem;
  padding: 0.75rem 1.25rem;
  border-radius: 4px;
  color: white;
  font-size: 0.95rem;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  z-index: 999;
  max-width: 400px;
}
.toast.success {
  background: #2e7d32;
}
.toast.error {
  background: #c62828;
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
}
@media (max-width: 720px) {
  .form {
    grid-template-columns: 1fr;
  }
}
</style>
