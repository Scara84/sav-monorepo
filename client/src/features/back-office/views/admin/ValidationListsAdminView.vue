<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
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
      data?: { lists?: Record<ValidationListCode, ValidationListEntry[]> }
      error?: { message?: string }
    }
    if (!res.ok) {
      error.value = body?.error?.message ?? 'Erreur de chargement'
      toast.value = null
      return
    }
    const incoming = body?.data?.lists
    if (
      !incoming ||
      !Array.isArray(incoming.sav_cause) ||
      !Array.isArray(incoming.bon_type) ||
      !Array.isArray(incoming.unit)
    ) {
      throw new Error('Réponse de liste invalide. Réessayez la lecture.')
    }
    lists.value = incoming
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Erreur réseau'
    toast.value = null
  } finally {
    loading.value = false
  }
}

async function onCreateSubmit(e?: Event): Promise<void> {
  // Hardening W-7-3c-1 : on prevent default systématiquement. Un seul
  // handler attaché au form via `@submit.prevent` (le bouton submit a
  // été nettoyé de son `@click` doublon).
  if (e !== undefined) e.preventDefault()
  toast.value = null
  const value = form.value.value.trim()
  if (value.length === 0) {
    showToast('error', 'La valeur française est requise.')
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
    form.value = {
      list_code: form.value.list_code,
      value: '',
      value_es: '',
      sort_order: 100,
    }
    await refresh()
    if (!error.value) showToast('success', 'Entrée créée.')
  } catch (e) {
    showToast('error', crud.error.value ?? (e instanceof Error ? e.message : 'Erreur création'))
  }
}

function askDeactivate(id: number): void {
  toast.value = null
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
    await refresh()
    if (!error.value) showToast('success', 'Entrée désactivée.')
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
async function startEdit(entry: ValidationListEntry): Promise<void> {
  toast.value = null
  editingId.value = entry.id
  editForm.value = {
    value_es: entry.value_es ?? '',
    sort_order: entry.sort_order,
  }
  await nextTick()
  document.getElementById('validation-edit-es')?.focus()
}
async function closeEdit(id: number): Promise<void> {
  editingId.value = null
  await nextTick()
  document.getElementById(`validation-edit-${id}`)?.focus()
}
async function saveEdit(id: number): Promise<void> {
  try {
    toast.value = null
    if (!Number.isInteger(editForm.value.sort_order) || editForm.value.sort_order < 0) {
      showToast('error', 'Ordre requis. Saisissez un entier positif ou nul.')
      return
    }
    const trimmedEs = editForm.value.value_es.trim()
    const patch: ValidationListUpdate = {
      // Le handler normalise `""` → null (W-7-3c-4) ; on envoie quand même
      // pour permettre à l'admin de "vider" le champ ES intentionnellement.
      value_es: trimmedEs.length === 0 ? null : trimmedEs,
      sort_order: editForm.value.sort_order,
    }
    await crud.update(id, patch)
    await refresh()
    if (!error.value) showToast('success', 'Entrée mise à jour.')
    await closeEdit(id)
  } catch (e) {
    showToast('error', crud.error.value ?? (e instanceof Error ? e.message : 'Erreur mise à jour'))
  }
}

async function onReactivate(id: number): Promise<void> {
  toast.value = null
  try {
    await crud.update(id, { is_active: true })
    await refresh()
    if (!error.value) showToast('success', 'Entrée réactivée.')
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
      <p class="subtitle">Causes SAV, types de bon et unités utilisés pendant le traitement.</p>
    </header>

    <p v-if="loading" class="status">Chargement…</p>
    <p v-else-if="error !== null" class="status error" role="alert">
      {{ error }} <button class="btn" @click="refresh">Réessayer</button>
    </p>

    <section
      v-for="code in ['sav_cause', 'bon_type', 'unit'] as ValidationListCode[]"
      :key="code"
      class="list-panel"
      :aria-labelledby="`section-${code}`"
    >
      <h2 :id="`section-${code}`">{{ SECTION_LABELS[code] }}</h2>
      <p v-if="!loading && !error && lists[code].length === 0" class="status muted">
        Aucune entrée.
      </p>
      <table
        v-else-if="lists[code].length"
        class="entries-table"
        :aria-label="SECTION_LABELS[code]"
      >
        <thead>
          <tr>
            <th scope="col">Français (FR)</th>
            <th scope="col">Espagnol (ES)</th>
            <th scope="col">Ordre</th>
            <th scope="col">Statut</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in lists[code]" :key="entry.id" :class="{ inactive: !entry.is_active }">
            <td data-label="Français">{{ entry.value }}</td>
            <td data-label="Espagnol" v-if="editingId !== entry.id" class="muted" lang="es">
              {{ entry.value_es ?? '—' }}
            </td>
            <td data-label="Espagnol" v-else>
              <input
                id="validation-edit-es"
                :disabled="crud.loading.value || loading"
                aria-label="Valeur espagnole"
                lang="es"
                v-model="editForm.value_es"
                :data-test="`validation-list-edit-value-es-${entry.id}`"
                type="text"
                maxlength="100"
                class="edit-input"
              />
            </td>
            <td data-label="Ordre" v-if="editingId !== entry.id" class="muted">
              {{ entry.sort_order }}
            </td>
            <td data-label="Ordre" v-else>
              <input
                aria-label="Ordre"
                :disabled="crud.loading.value || loading"
                v-model.number="editForm.sort_order"
                :data-test="`validation-list-edit-sort-order-${entry.id}`"
                type="number"
                min="0"
                max="9999"
                step="1"
                inputmode="numeric"
                class="edit-input"
              />
            </td>
            <td data-label="Statut">
              <span v-if="entry.is_active" class="badge active">Actif</span>
              <span v-else class="badge inactive">Inactif</span>
            </td>
            <td data-label="Actions" class="actions-cell">
              <template v-if="editingId === entry.id">
                <button
                  type="button"
                  :data-test="`validation-list-edit-save-${entry.id}`"
                  class="btn small primary"
                  :disabled="crud.loading.value || loading"
                  @click="saveEdit(entry.id)"
                >
                  Enregistrer
                </button>
                <button
                  type="button"
                  :data-test="`validation-list-edit-cancel-${entry.id}`"
                  class="btn small"
                  :disabled="crud.loading.value || loading"
                  @click="closeEdit(entry.id)"
                >
                  Annuler
                </button>
              </template>
              <template v-else>
                <button
                  v-if="entry.is_active"
                  type="button"
                  :id="`validation-edit-${entry.id}`"
                  :data-test="`validation-list-edit-${entry.id}`"
                  class="btn small"
                  :disabled="crud.loading.value || loading"
                  @click="startEdit(entry)"
                >
                  Modifier
                </button>
                <button
                  v-if="entry.is_active"
                  type="button"
                  :data-test="`validation-list-deactivate-${entry.id}`"
                  class="btn small"
                  :disabled="crud.loading.value || loading"
                  @click="askDeactivate(entry.id)"
                >
                  Désactiver
                </button>
                <button
                  v-else
                  type="button"
                  :data-test="`validation-list-reactivate-${entry.id}`"
                  class="btn small"
                  :disabled="crud.loading.value || loading"
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

    <section class="create-panel" aria-labelledby="create-title">
      <h2 id="create-title">Ajouter une valeur</h2>
      <form @invalid.capture="toast = null" class="create-form" @submit.prevent="onCreateSubmit">
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
          <label for="vl-create-value">Français (FR)</label>
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
          <label for="vl-create-value-es">Espagnol (ES)</label>
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
          <input
            id="vl-create-sort"
            v-model.number="form.sort_order"
            type="number"
            min="0"
            max="9999"
            step="1"
            inputmode="numeric"
            data-test="validation-list-create-sort-order"
          />
        </div>
        <div class="actions">
          <button
            type="submit"
            data-test="validation-list-create-submit"
            class="btn primary"
            :disabled="crud.loading.value || loading"
          >
            Ajouter
          </button>
        </div>
      </form>
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
          L'entrée ne sera plus disponible dans les listes de choix du SAV. L'historique existant
          reste inchangé.
        </p>
        <div class="dialog-actions">
          <button
            type="button"
            class="btn"
            :disabled="crud.loading.value || loading"
            @click="cancelDeactivate"
          >
            Annuler
          </button>
          <button
            type="button"
            data-test="validation-list-deactivate-confirm"
            class="btn primary"
            :disabled="crud.loading.value || loading"
            @click="confirmDeactivate"
          >
            {{ crud.loading.value ? 'Désactivation…' : 'Confirmer' }}
          </button>
        </div>
      </div>
    </div>

    <transition name="toast">
      <div
        v-if="toast !== null"
        :class="['toast', toast.kind]"
        :role="toast.kind === 'error' ? 'alert' : 'status'"
      >
        {{ toast.message }}
        <button class="dismiss" aria-label="Fermer le message" @click="toast = null">×</button>
      </div>
    </transition>
  </main>
</template>

<style scoped src="./reference-admin.css"></style>
