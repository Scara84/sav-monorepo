<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { LocationQueryValue } from 'vue-router'
import {
  useAdminSettings,
  type SettingHistoryItem,
  type ThresholdAlertValue,
  type SettingActiveSummary,
  type SettingHistoryItemGeneric,
  type AdminSettingKey,
} from '../../composables/useAdminSettings'

/**
 * Story 5.5 AC #8 — Admin settings versionnés (V1 onglet « Seuils »).
 * Story 7-4 D-5 — extension : ajout onglet « Général » avec 8 clés whitelist D-1.
 *
 * Onglet « Seuils » expose le formulaire d'édition de la clé `threshold_alert`
 * consommée par le cron `threshold-alerts.ts`. L'admin peut modifier le seuil,
 * la fenêtre, et la dédup ; les nouvelles valeurs sont appliquées au prochain
 * tour de cron (jusqu'à 24 h).
 *
 * Onglet « Général » expose les 8 clés whitelist D-1 (vat_rate_default,
 * group_manager_discount, threshold_alert read-only, maintenance_mode,
 * company.* x4, onedrive.pdf_folder_root) avec rotation atomique INSERT-only
 * (D-2 trigger DB) + historique collapsible 10 dernières versions (D-6).
 *
 * Route : `/admin/settings?tab=thresholds` (Story 5.5) ou
 * `/admin/settings?tab=general` (Story 7-4).
 */

type TabId = 'thresholds' | 'general'

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'thresholds', label: 'Seuils' },
  { id: 'general', label: 'Général' },
]

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

function selectTab(id: TabId): void {
  activeTab.value = id
  const nextQuery: Record<string, LocationQueryValue | LocationQueryValue[]> = {}
  for (const [k, val] of Object.entries(route.query)) {
    if (k === 'tab') continue
    nextQuery[k] = val as LocationQueryValue | LocationQueryValue[]
  }
  nextQuery['tab'] = id
  void router.replace({ query: nextQuery })

  // Lazy-fetch onglet général à la première bascule.
  if (id === 'general' && settings.activeSettings.value.length === 0) {
    void refreshGeneralSettings()
  }
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
    const trimmedNotes = form.value.notes.trim()
    const payload: import('../../composables/useAdminSettings').UpdateThresholdPayload = {
      count: form.value.count,
      days: form.value.days,
      dedup_hours: form.value.dedup_hours,
    }
    if (trimmedNotes !== '') payload.notes = trimmedNotes
    await settings.updateThreshold(payload)
    showToast('success', 'Seuils enregistrés. Appliqués au prochain cron (jusqu’à 24 h).')
    form.value.notes = ''
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

// --- Story 7-4 onglet "Général" ---

interface GeneralRotateForm {
  // Pour bp keys.
  bp: number
  // Pour maintenance_mode.
  enabled: boolean
  message: string
  // Pour string raw.
  rawValue: string
  // Commun.
  validFrom: string
  notes: string
}

/**
 * Hardening W-7-4-3 — formatter local-time pour `<input type="datetime-local">`.
 * `Date.toISOString()` produit une string UTC, mais `datetime-local` interprète
 * sa value et son attribut `min` comme heure locale du navigateur. Sans ce
 * helper, un admin Europe/Paris (UTC+2 été) verrait un default 2h en arrière
 * et déclencherait des faux positifs 422 INVALID_VALID_FROM côté handler.
 */
function formatLocalDateTimeInput(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function buildDefaultForm(): GeneralRotateForm {
  // valid_from défaut = now + 1h (cohérent D-4 onboarding).
  // Hardening W-7-4-3 : local-time YYYY-MM-DDTHH:mm (pas UTC), cohérent
  // attribute `min` du datetime-local et avec l'UX navigateur.
  const inOneHour = new Date(Date.now() + 60 * 60 * 1000)
  return {
    bp: 0,
    enabled: false,
    message: '',
    rawValue: '',
    validFrom: formatLocalDateTimeInput(inOneHour),
    notes: '',
  }
}

const generalRotateForms = ref<Record<string, GeneralRotateForm>>({})
const expandedHistory = ref<Record<string, SettingHistoryItemGeneric[] | null>>({})

function ensureForm(key: string, initial: SettingActiveSummary): GeneralRotateForm {
  if (!generalRotateForms.value[key]) {
    const form = buildDefaultForm()
    // Hydrate avec valeur courante.
    if (typeof initial.value === 'object' && initial.value !== null) {
      const v = initial.value as Record<string, unknown>
      if (typeof v['bp'] === 'number') form.bp = v['bp']
      if (typeof v['enabled'] === 'boolean') form.enabled = v['enabled']
      if (typeof v['message'] === 'string') form.message = v['message']
    } else if (typeof initial.value === 'string') {
      form.rawValue = initial.value
    }
    generalRotateForms.value[key] = form
  }
  return generalRotateForms.value[key]!
}

async function refreshGeneralSettings(): Promise<void> {
  try {
    await settings.fetchActiveSettings()
    // Hydrate forms.
    for (const item of settings.activeSettings.value) {
      ensureForm(item.key, item)
    }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return
    showToast('error', settings.loadError.value ?? 'Lecture impossible.')
  }
}

const minValidFromAttr = computed(() => {
  // input datetime-local : min = maintenant + 1min (D-4 client-side guard).
  // Hardening W-7-4-3 : local-time formatter (pas UTC) cohérent UX navigateur.
  const t = new Date(Date.now() + 60 * 1000)
  return formatLocalDateTimeInput(t)
})

function buildValuePayload(key: string, form: GeneralRotateForm): unknown {
  if (key === 'vat_rate_default' || key === 'group_manager_discount') {
    return { bp: form.bp }
  }
  if (key === 'threshold_alert') {
    // READ-ONLY onglet général D-9 — ne devrait pas être appelé.
    return null
  }
  if (key === 'maintenance_mode') {
    const out: Record<string, unknown> = { enabled: form.enabled }
    if (form.message.trim() !== '') out['message'] = form.message
    return out
  }
  // company.* + onedrive.* → string raw.
  return form.rawValue
}

async function onRotate(key: string): Promise<void> {
  const form = generalRotateForms.value[key]
  if (!form) return
  if (key === 'threshold_alert') {
    showToast('error', 'Seuils alerte non éditables ici (utiliser onglet Seuils pour rotation).')
    return
  }
  // D-4 client-side guard : valid_from ≥ now-5min.
  const t = Date.parse(form.validFrom)
  const now = Date.now()
  if (Number.isNaN(t) || t < now - 5 * 60 * 1000) {
    showToast('error', 'Date d’effet invalide (doit être dans le futur).')
    return
  }
  // ISO format pour le handler (datetime-local n'a pas la TZ).
  const iso = new Date(form.validFrom).toISOString()
  try {
    await settings.rotateSetting(
      key as AdminSettingKey,
      buildValuePayload(key, form),
      iso,
      form.notes
    )
    showToast('success', `Clé ${key} rotatée — applique à compter du ${formatDateTime(iso)}.`)
    form.notes = ''
    await refreshGeneralSettings()
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return
    showToast('error', settings.saveError.value ?? 'Enregistrement impossible.')
  }
}

async function onToggleHistory(key: string): Promise<void> {
  if (expandedHistory.value[key] !== undefined && expandedHistory.value[key] !== null) {
    // Déjà chargé — collapse.
    expandedHistory.value[key] = null
    return
  }
  try {
    const items = await settings.fetchSettingHistory(key as AdminSettingKey, 10)
    expandedHistory.value[key] = items
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return
    showToast('error', settings.loadError.value ?? 'Lecture historique impossible.')
  }
}

function formatGeneralValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return '[object]'
    }
  }
  return String(value)
}

onMounted(async () => {
  hydrateFromTab()
  await refresh()
  if (activeTab.value === 'general') {
    await refreshGeneralSettings()
  }
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

    <!-- Story 7-4 onglet "Général" — 8 clés whitelist D-1 -->
    <section v-if="activeTab === 'general'" role="tabpanel" class="panel">
      <header class="panel-header">
        <h2>Paramètres versionnés (Général)</h2>
        <p class="hint">
          Chaque rotation crée une nouvelle version avec date d'effet future. L'historique intégral
          est préservé (iso-fact preservation) — les SAV/avoirs déjà émis utilisent toujours la
          valeur snapshot gelée à création.
        </p>
      </header>

      <p v-if="settings.loading.value" class="status">Chargement…</p>
      <p v-else-if="settings.activeSettings.value.length === 0" class="status muted">
        Aucune clé settings en DB (seed initial vide).
      </p>

      <div v-else class="general-list">
        <article v-for="item in settings.activeSettings.value" :key="item.key" class="setting-card">
          <header class="setting-card-header">
            <h3 class="setting-key">{{ item.key }}</h3>
            <p class="setting-current">
              <strong>Valeur actuelle :</strong>
              <code>{{ formatGeneralValue(item.value) }}</code>
              <span class="muted">
                (depuis {{ formatDateTime(item.valid_from) }} —
                {{ item.versions_count }} version<span v-if="item.versions_count > 1">s</span>)
              </span>
            </p>
          </header>

          <form
            v-if="item.key !== 'threshold_alert'"
            class="rotate-form"
            @submit.prevent="onRotate(item.key)"
          >
            <!-- bp keys -->
            <div
              v-if="item.key === 'vat_rate_default' || item.key === 'group_manager_discount'"
              class="field"
            >
              <label :for="`bp-${item.key}`">Valeur (bp — basis points, 550 = 5,5 %)</label>
              <input
                :id="`bp-${item.key}`"
                v-model.number="ensureForm(item.key, item).bp"
                type="number"
                min="0"
                max="10000"
                step="1"
                required
              />
            </div>

            <!-- maintenance_mode -->
            <div v-else-if="item.key === 'maintenance_mode'" class="field">
              <label>
                <input v-model="ensureForm(item.key, item).enabled" type="checkbox" />
                Activé (bannière maintenance affichée)
              </label>
              <input
                v-model="ensureForm(item.key, item).message"
                type="text"
                maxlength="500"
                placeholder="Message optionnel"
              />
            </div>

            <!-- string raw (company.*, onedrive.*) -->
            <div v-else class="field">
              <label :for="`raw-${item.key}`">Valeur</label>
              <input
                :id="`raw-${item.key}`"
                v-model="ensureForm(item.key, item).rawValue"
                type="text"
                maxlength="500"
                :placeholder="item.key === 'onedrive.pdf_folder_root' ? '/AvoirsPDF' : ''"
                required
              />
            </div>

            <div class="field">
              <label :for="`valid-from-${item.key}`">Date d'effet</label>
              <input
                :id="`valid-from-${item.key}`"
                v-model="ensureForm(item.key, item).validFrom"
                type="datetime-local"
                :min="minValidFromAttr"
                required
              />
              <span class="field-hint">Doit être ≥ maintenant (D-4 strict).</span>
            </div>
            <div class="field">
              <label :for="`notes-${item.key}`">Note (optionnel)</label>
              <input
                :id="`notes-${item.key}`"
                v-model="ensureForm(item.key, item).notes"
                type="text"
                maxlength="500"
                placeholder="Motivation"
              />
            </div>
            <div class="actions">
              <button type="submit" class="btn primary small" :disabled="settings.saving.value">
                Rotater
              </button>
              <button
                type="button"
                class="btn ghost small"
                :data-history-toggle="item.key"
                @click="onToggleHistory(item.key)"
              >
                Historique
              </button>
            </div>
          </form>

          <p v-else class="muted threshold-readonly">
            Lecture seule (clé éditable via onglet « Seuils »).
            <button
              type="button"
              class="btn ghost small"
              :data-history-toggle="item.key"
              @click="onToggleHistory(item.key)"
            >
              Historique
            </button>
          </p>

          <section
            v-if="expandedHistory[item.key] !== undefined && expandedHistory[item.key] !== null"
            class="history-panel"
          >
            <h4>Historique (10 dernières versions)</h4>
            <table class="history-table">
              <thead>
                <tr>
                  <th>Période</th>
                  <th>Valeur</th>
                  <th>Auteur</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="h in expandedHistory[item.key] ?? []"
                  :key="h.id"
                  :class="{ active: h.valid_to === null }"
                >
                  <td>
                    <div>{{ formatDateTime(h.valid_from) }}</div>
                    <div class="muted">
                      {{ h.valid_to === null ? 'Active' : `→ ${formatDateTime(h.valid_to)}` }}
                    </div>
                  </td>
                  <td>
                    <code>{{ formatGeneralValue(h.value) }}</code>
                  </td>
                  <td>{{ h.updated_by?.email_display_short ?? '—' }}</td>
                  <td>{{ h.notes ?? '—' }}</td>
                </tr>
              </tbody>
            </table>
          </section>
        </article>
      </div>
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
.btn.small {
  padding: 0.4rem 0.9rem;
  font-size: 0.85rem;
}
.btn.primary {
  background: #f57c00;
  color: white;
  font-weight: 600;
}
.btn.primary:hover:not(:disabled) {
  background: #e65100;
}
.btn.ghost {
  background: #fff;
  border: 1px solid #ccc;
  color: #555;
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
.general-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.setting-card {
  border: 1px solid #eee;
  border-radius: 6px;
  padding: 1rem;
  background: #fafafa;
}
.setting-card-header {
  margin-bottom: 0.75rem;
}
.setting-key {
  margin: 0 0 0.25rem 0;
  font-size: 1rem;
  font-family: monospace;
  color: #1f2937;
}
.setting-current code {
  background: #fff;
  padding: 2px 6px;
  border-radius: 3px;
  border: 1px solid #ddd;
  font-size: 0.85rem;
}
.rotate-form {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0.75rem;
}
.rotate-form .actions {
  grid-column: 1 / -1;
}
.threshold-readonly {
  margin: 0.5rem 0;
}
.history-panel {
  margin-top: 1rem;
  padding-top: 0.75rem;
  border-top: 1px solid #eee;
}
.history-panel h4 {
  margin: 0 0 0.5rem 0;
  font-size: 0.95rem;
}
@media (max-width: 720px) {
  .form,
  .rotate-form {
    grid-template-columns: 1fr;
  }
}
</style>
