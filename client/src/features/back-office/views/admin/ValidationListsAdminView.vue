<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useAdminCrud } from '../../composables/useAdminCrud'

/**
 * Story 7-3c AC #1/2/3 — Écran admin listes de validation.
 *
 * CRUD entrées validation_lists groupées par list_code (D-7 enum strict V1
 * sav_cause/bon_type/unit) : liste groupée + création + désactivation soft
 * (D-8 via PATCH is_active=false). i18n FR-only V1 (D-12).
 *
 * Note response shape : `GET /api/admin/validation-lists` retourne
 * `{ data: { lists: Record<list_code, Entry[]> } }` (groupé côté handler),
 * différent du contrat générique `useAdminCrud.list()` qui attend
 * `{ data: { items, total } }`. On fetch directement la liste, et on
 * délègue create/update à `crud.create()` / `crud.update()` pour
 * mutualiser auth + error handling.
 *
 * Sélecteurs data-test (smoke spec) :
 *   validation-list-create-{list-code,value,value-es,submit}
 *   validation-list-deactivate-{id}, validation-list-deactivate-confirm
 */

type ValidationListCode = 'sav_cause' | 'bon_type' | 'unit'

interface ValidationListEntry {
  id: number
  list_code: ValidationListCode
  value: string
  value_es: string | null
  sort_order: number
  is_active: boolean
  // Schema `validation_lists` n'a pas de colonnes timestamp (cf. snapshot
  // W113). Optionnels pour rétrocompat tests / fixtures qui les incluent.
  created_at?: string
  updated_at?: string
}
interface ValidationListCreate {
  list_code: ValidationListCode
  value: string
  value_es?: string | null
  sort_order?: number
  is_active?: boolean
}
interface ValidationListUpdate {
  value_es?: string | null
  sort_order?: number
  is_active?: boolean
}

const SECTION_LABELS: Record<ValidationListCode, string> = {
  sav_cause: 'Causes SAV',
  bon_type: 'Types de bon',
  unit: 'Unités',
}

const crud = useAdminCrud<ValidationListEntry, ValidationListCreate, ValidationListUpdate>(
  'validation-lists'
)

const lists = ref<Record<ValidationListCode, ValidationListEntry[]>>({
  sav_cause: [],
  bon_type: [],
  unit: [],
})
const loading = ref(false)
const error = ref<string | null>(null)
const toast = ref<{ kind: 'success' | 'error'; message: string } | null>(null)
const pendingDeactivateId = ref<number | null>(null)

const form = ref({
  list_code: 'sav_cause' as ValidationListCode,
  value: '',
  value_es: '',
  sort_order: 100,
})

/**
 * Hardening W-7-3c-2 — mode édition row-inline (AC #3 PARTIAL → FULL).
 * Une seule row éditable à la fois (`editingId`). L'admin peut modifier
 * `value_es` + `sort_order` sans modal (cohérent simplicité 7-3a/7-3b).
 * `value` et `list_code` restent immutables (D-8 — non éditables UI).
 */
const editingId = ref<number | null>(null)
const editForm = ref({
  value_es: '',
  sort_order: 100,
})

function showToast(kind: 'success' | 'error', message: string): void {
  toast.value = { kind, message }
  window.setTimeout(() => {
    toast.value = null
  }, 4000)
}

/**
 * D-9 refetch-on-mount pattern (documenté pour héritage stories aval).
 * Volumétrie cible ~40 entrées max — pas de pagination, pas de cache TTL.
 */
async function refresh(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const res = await fetch('/api/admin/validation-lists', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
    const body = (await res.json().catch(() => ({}))) as {
      data?: { lists?: Record<string, ValidationListEntry[]> }
      error?: { message?: string }
    }
    if (!res.ok) {
      error.value = body.error?.message ?? 'Erreur de chargement'
      showToast('error', error.value)
      return
    }
    const next: Record<ValidationListCode, ValidationListEntry[]> = {
      sav_cause: [],
      bon_type: [],
      unit: [],
    }
    const incoming = body.data?.lists ?? {}
    for (const code of ['sav_cause', 'bon_type', 'unit'] as ValidationListCode[]) {
      next[code] = Array.isArray(incoming[code]) ? incoming[code]! : []
    }
    lists.value = next
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erreur réseau'
    showToast('error', error.value)
  } finally {
    loading.value = false
  }
}

async function onCreateSubmit(e?: Event): Promise<void> {
  // Hardening W-7-3c-1 : on prevent default systématiquement. Un seul
  // handler attaché au form via `@submit.prevent` (le bouton submit a
  // été nettoyé de son `@click` doublon).
  if (e !== undefined) e.preventDefault()
  const value = form.value.value.trim()
  if (value.length === 0) {
    showToast('error', 'La valeur est requise.')
    return
  }
  try {
    const valueEs = form.value.value_es.trim()
    const payload: ValidationListCreate = {
      list_code: form.value.list_code,
      value,
      sort_order: form.value.sort_order,
    }
    if (valueEs.length > 0) payload.value_es = valueEs
    await crud.create(payload)
    showToast('success', 'Entrée créée.')
    form.value = {
      list_code: form.value.list_code,
      value: '',
      value_es: '',
      sort_order: 100,
    }
    await refresh()
  } catch (e) {
    showToast('error', crud.error.value ?? (e instanceof Error ? e.message : 'Erreur création'))
  }
}

function askDeactivate(id: number): void {
  pendingDeactivateId.value = id
}
function cancelDeactivate(): void {
  pendingDeactivateId.value = null
}
async function confirmDeactivate(): Promise<void> {
  const id = pendingDeactivateId.value
  if (id === null) return
  // Hardening W-7-3c-5 : reset déplacé en `finally` (pas avant l'await).
  // Garantit que la dialog reste affichée si le PATCH est in-flight et
  // se ferme dans tous les cas (succès / erreur / timeout) sans permettre
  // un re-déclenchement du même submit pendant la requête.
  try {
    // D-8 soft-delete via PATCH is_active=false (pas de DELETE physique).
    await crud.update(id, { is_active: false })
    showToast('success', 'Entrée désactivée.')
    await refresh()
  } catch (e) {
    showToast(
      'error',
      crud.error.value ?? (e instanceof Error ? e.message : 'Erreur désactivation')
    )
  } finally {
    pendingDeactivateId.value = null
  }
}

/**
 * Hardening W-7-3c-2 — édition row-inline (AC #3 PARTIAL → FULL).
 */
function startEdit(entry: ValidationListEntry): void {
  editingId.value = entry.id
  editForm.value = {
    value_es: entry.value_es ?? '',
    sort_order: entry.sort_order,
  }
}
function cancelEdit(): void {
  editingId.value = null
}
async function saveEdit(id: number): Promise<void> {
  try {
    const trimmedEs = editForm.value.value_es.trim()
    const patch: ValidationListUpdate = {
      // Le handler normalise `""` → null (W-7-3c-4) ; on envoie quand même
      // pour permettre à l'admin de "vider" le champ ES intentionnellement.
      value_es: trimmedEs.length === 0 ? null : trimmedEs,
      sort_order: editForm.value.sort_order,
    }
    await crud.update(id, patch)
    showToast('success', 'Entrée mise à jour.')
    editingId.value = null
    await refresh()
  } catch (e) {
    showToast('error', crud.error.value ?? (e instanceof Error ? e.message : 'Erreur mise à jour'))
  }
}

async function onReactivate(id: number): Promise<void> {
  try {
    await crud.update(id, { is_active: true })
    showToast('success', 'Entrée réactivée.')
    await refresh()
  } catch (e) {
    showToast('error', crud.error.value ?? (e instanceof Error ? e.message : 'Erreur réactivation'))
  }
}

onMounted(() => {
  void refresh()
})
</script>

<template>
  <main class="validation-lists-admin-view">
    <header class="header">
      <h1>Listes de validation</h1>
      <p class="subtitle">Gestion des valeurs Causes SAV, Types de bon, Unités (FR + ES).</p>
    </header>

    <section class="create-panel" aria-labelledby="create-title">
      <h2 id="create-title">Ajouter une valeur</h2>
      <form class="create-form" @submit.prevent="onCreateSubmit">
        <div class="field">
          <label for="vl-create-list-code">Liste</label>
          <select
            id="vl-create-list-code"
            v-model="form.list_code"
            data-test="validation-list-create-list-code"
          >
            <option value="sav_cause">Causes SAV</option>
            <option value="bon_type">Types de bon</option>
            <option value="unit">Unités</option>
          </select>
        </div>
        <div class="field">
          <label for="vl-create-value">Valeur (FR)</label>
          <input
            id="vl-create-value"
            v-model="form.value"
            data-test="validation-list-create-value"
            type="text"
            required
            maxlength="100"
            placeholder="Périmé"
          />
        </div>
        <div class="field">
          <label for="vl-create-value-es">Valeur (ES)</label>
          <input
            id="vl-create-value-es"
            v-model="form.value_es"
            data-test="validation-list-create-value-es"
            type="text"
            maxlength="100"
            placeholder="caducado"
          />
        </div>
        <div class="field">
          <label for="vl-create-sort">Ordre</label>
          <input id="vl-create-sort" v-model.number="form.sort_order" type="number" min="0" />
        </div>
        <div class="actions">
          <button
            type="submit"
            data-test="validation-list-create-submit"
            class="btn primary"
            :disabled="crud.loading.value"
          >
            Ajouter
          </button>
        </div>
      </form>
    </section>

    <p v-if="loading" class="status">Chargement…</p>
    <p v-else-if="error !== null" class="status error">{{ error }}</p>

    <section
      v-for="code in ['sav_cause', 'bon_type', 'unit'] as ValidationListCode[]"
      :key="code"
      class="list-panel"
      :aria-labelledby="`section-${code}`"
    >
      <h2 :id="`section-${code}`">{{ SECTION_LABELS[code] }}</h2>
      <p v-if="lists[code].length === 0" class="status muted">Aucune entrée.</p>
      <table v-else class="entries-table" :aria-label="SECTION_LABELS[code]">
        <thead>
          <tr>
            <th scope="col">Valeur (FR)</th>
            <th scope="col">Valeur (ES)</th>
            <th scope="col">Ordre</th>
            <th scope="col">Statut</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in lists[code]" :key="entry.id" :class="{ inactive: !entry.is_active }">
            <td>{{ entry.value }}</td>
            <td v-if="editingId !== entry.id" class="muted">{{ entry.value_es ?? '—' }}</td>
            <td v-else>
              <input
                v-model="editForm.value_es"
                :data-test="`validation-list-edit-value-es-${entry.id}`"
                type="text"
                maxlength="100"
                class="edit-input"
              />
            </td>
            <td v-if="editingId !== entry.id" class="muted">{{ entry.sort_order }}</td>
            <td v-else>
              <input
                v-model.number="editForm.sort_order"
                :data-test="`validation-list-edit-sort-order-${entry.id}`"
                type="number"
                min="0"
                class="edit-input"
              />
            </td>
            <td>
              <span v-if="entry.is_active" class="badge active">Actif</span>
              <span v-else class="badge inactive">Inactif</span>
            </td>
            <td class="actions-cell">
              <template v-if="editingId === entry.id">
                <button
                  type="button"
                  :data-test="`validation-list-edit-save-${entry.id}`"
                  class="btn small primary"
                  :disabled="crud.loading.value"
                  @click="saveEdit(entry.id)"
                >
                  Sauver
                </button>
                <button
                  type="button"
                  :data-test="`validation-list-edit-cancel-${entry.id}`"
                  class="btn small"
                  :disabled="crud.loading.value"
                  @click="cancelEdit"
                >
                  Annuler
                </button>
              </template>
              <template v-else>
                <button
                  v-if="entry.is_active"
                  type="button"
                  :data-test="`validation-list-edit-${entry.id}`"
                  class="btn small"
                  :disabled="crud.loading.value"
                  @click="startEdit(entry)"
                >
                  Modifier
                </button>
                <button
                  v-if="entry.is_active"
                  type="button"
                  :data-test="`validation-list-deactivate-${entry.id}`"
                  class="btn small"
                  :disabled="crud.loading.value"
                  @click="askDeactivate(entry.id)"
                >
                  Désactiver
                </button>
                <button
                  v-else
                  type="button"
                  :data-test="`validation-list-reactivate-${entry.id}`"
                  class="btn small"
                  :disabled="crud.loading.value"
                  @click="onReactivate(entry.id)"
                >
                  Réactiver
                </button>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <div
      v-if="pendingDeactivateId !== null"
      class="dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
    >
      <div class="dialog">
        <h3 id="confirm-title">Confirmer la désactivation</h3>
        <p>
          L'entrée ne sera plus disponible dans les dropdowns SAV. L'historique existant reste
          inchangé.
        </p>
        <div class="dialog-actions">
          <button
            type="button"
            class="btn"
            :disabled="crud.loading.value"
            @click="cancelDeactivate"
          >
            Annuler
          </button>
          <button
            type="button"
            data-test="validation-list-deactivate-confirm"
            class="btn primary"
            :disabled="crud.loading.value"
            @click="confirmDeactivate"
          >
            {{ crud.loading.value ? 'Désactivation…' : 'Confirmer' }}
          </button>
        </div>
      </div>
    </div>

    <transition name="toast">
      <div v-if="toast !== null" :class="['toast', toast.kind]" role="status" aria-live="polite">
        {{ toast.message }}
      </div>
    </transition>
  </main>
</template>

<style scoped>
.validation-lists-admin-view {
  padding: 1.5rem;
  max-width: 1280px;
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
.create-panel,
.list-panel {
  background: #fff;
  border: 1px solid #eee;
  border-radius: 6px;
  padding: 1.25rem;
  margin-bottom: 1.25rem;
}
.create-panel h2,
.list-panel h2 {
  margin: 0 0 1rem 0;
  font-size: 1.1rem;
}
.create-form {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1rem;
  align-items: end;
}
.create-form .actions {
  grid-column: 1 / -1;
  display: flex;
  justify-content: flex-end;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.field label {
  font-weight: 600;
  font-size: 0.9rem;
}
.field input,
.field select {
  padding: 0.5rem 0.75rem;
  font-size: 0.95rem;
  border: 1px solid #ccc;
  border-radius: 4px;
}
.btn {
  padding: 0.5rem 1rem;
  border-radius: 4px;
  border: 1px solid #ccc;
  background: #fff;
  cursor: pointer;
  font-size: 0.9rem;
}
.btn.small {
  padding: 0.3rem 0.6rem;
  font-size: 0.85rem;
}
.btn.primary {
  background: #f57c00;
  color: white;
  border-color: #f57c00;
  font-weight: 600;
}
.btn.primary:hover:not(:disabled) {
  background: #e65100;
}
.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.entries-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.entries-table th,
.entries-table td {
  text-align: left;
  padding: 0.6rem 0.75rem;
  border-bottom: 1px solid #f0f0f0;
}
.entries-table th {
  background: #fafafa;
  font-weight: 600;
}
.entries-table tr.inactive td {
  opacity: 0.55;
}
.actions-cell {
  white-space: nowrap;
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}
.edit-input {
  padding: 0.3rem 0.5rem;
  font-size: 0.85rem;
  border: 1px solid #ccc;
  border-radius: 3px;
  width: 100%;
  max-width: 160px;
}
.badge {
  display: inline-block;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  font-size: 0.8rem;
  background: #eee;
  color: #333;
}
.badge.active {
  background: #e8f5e9;
  color: #2e7d32;
}
.badge.inactive {
  background: #fce4ec;
  color: #c2185b;
}
.muted {
  color: #999;
}
.status {
  color: #666;
  font-style: italic;
  margin: 0.5rem 0;
}
.status.error {
  color: #c62828;
}
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.dialog {
  background: white;
  padding: 1.5rem;
  border-radius: 6px;
  max-width: 480px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
}
.dialog h3 {
  margin: 0 0 0.75rem 0;
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 1rem;
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
  .create-form {
    grid-template-columns: 1fr;
  }
}
</style>
