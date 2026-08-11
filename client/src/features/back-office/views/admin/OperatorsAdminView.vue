<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useAdminCrud } from '../../composables/useAdminCrud'
import { useCurrentUser } from '../../../../shared/composables/useCurrentUser'

/**
 * Story 7-3a AC #1/2/3/5 — Écran admin opérateurs.
 *
 * CRUD opérateurs : liste paginée + recherche + création + désactivation
 * (soft-delete via PATCH is_active=false). i18n FR-only V1 (D-12).
 *
 * Sélecteurs data-test (pour smoke spec) :
 *   operator-create-email, operator-create-display-name, operator-create-role,
 *   operator-create-submit, operator-deactivate-{id}, operator-deactivate-confirm.
 */

interface Operator {
  id: number
  email: string
  display_name: string
  role: 'admin' | 'sav-operator'
  is_active: boolean
  azure_oid: string | null
  created_at: string
}
interface OperatorCreate {
  email: string
  display_name: string
  role: 'admin' | 'sav-operator'
  azure_oid?: string | null
}
interface OperatorUpdate {
  is_active?: boolean
  role?: 'admin' | 'sav-operator'
  display_name?: string
  azure_oid?: string | null
}

const crud = useAdminCrud<Operator, OperatorCreate, OperatorUpdate>('operators')
const { user: currentUser } = useCurrentUser()

const form = ref<OperatorCreate>({
  email: '',
  display_name: '',
  role: 'sav-operator',
  azure_oid: null,
})

const search = ref('')
const roleFilter = ref<'' | 'admin' | 'sav-operator'>('')
const toast = ref<{ kind: 'success' | 'error'; message: string } | null>(null)
const pendingDeactivateId = ref<number | null>(null)
const passwordTarget = ref<Operator | null>(null)
const password = ref('')
const passwordConfirmation = ref('')
const passwordError = ref<string | null>(null)
const passwordSubmitting = ref(false)
const passwordDialogRef = ref<HTMLElement | null>(null)
const passwordInputRef = ref<HTMLInputElement | null>(null)
let passwordTrigger: HTMLElement | null = null
let passwordAbortController: AbortController | null = null
let passwordTimeout: number | null = null
const PASSWORD_REQUEST_TIMEOUT_MS = 15_000

function showToast(kind: 'success' | 'error', message: string): void {
  toast.value = { kind, message }
  window.setTimeout(() => {
    toast.value = null
  }, 4000)
}

async function refresh(): Promise<void> {
  const params: Record<string, unknown> = { limit: 50 }
  if (search.value.trim().length > 0) params['q'] = search.value.trim()
  if (roleFilter.value !== '') params['role'] = roleFilter.value
  try {
    await crud.list(params)
  } catch (e) {
    showToast('error', crud.error.value ?? (e instanceof Error ? e.message : 'Erreur'))
  }
}

async function onCreateSubmit(e?: Event): Promise<void> {
  if (e !== undefined) e.preventDefault()
  if (form.value.email.trim() === '' || form.value.display_name.trim() === '') {
    showToast('error', 'Email et nom requis.')
    return
  }
  try {
    const payload: OperatorCreate = {
      email: form.value.email.trim().toLowerCase(),
      display_name: form.value.display_name.trim(),
      role: form.value.role,
    }
    // Hardening W-7-3a-4 (CR E4) : trim avant envoi pour éviter qu'un
    // copy-paste avec espaces fasse échouer la regex UUID côté Zod.
    const oid = form.value.azure_oid
    if (oid !== null && oid !== undefined) {
      const trimmedOid = oid.trim()
      if (trimmedOid !== '') {
        payload.azure_oid = trimmedOid
      }
    }
    await crud.create(payload)
    showToast('success', 'Opérateur créé.')
    form.value = { email: '', display_name: '', role: 'sav-operator', azure_oid: null }
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
  pendingDeactivateId.value = null
  try {
    await crud.update(id, { is_active: false })
    showToast('success', 'Opérateur désactivé.')
    await refresh()
  } catch (e) {
    showToast(
      'error',
      crud.error.value ?? (e instanceof Error ? e.message : 'Erreur désactivation')
    )
  }
}

async function reactivate(id: number): Promise<void> {
  try {
    await crud.update(id, { is_active: true })
    showToast('success', 'Opérateur réactivé.')
    await refresh()
  } catch (e) {
    showToast('error', crud.error.value ?? (e instanceof Error ? e.message : 'Erreur réactivation'))
  }
}

function clearPasswordForm(): void {
  password.value = ''
  passwordConfirmation.value = ''
  passwordError.value = null
}

async function openPasswordDialog(operator: Operator, event: MouseEvent): Promise<void> {
  clearPasswordForm()
  passwordTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  passwordTarget.value = operator
  await nextTick()
  passwordInputRef.value?.focus()
}

function clearPasswordTimeout(): void {
  if (passwordTimeout !== null) window.clearTimeout(passwordTimeout)
  passwordTimeout = null
}

function restorePasswordTriggerFocus(): void {
  const trigger = passwordTrigger
  passwordTrigger = null
  void nextTick(() => trigger?.focus())
}

function closePasswordDialog(): void {
  passwordAbortController?.abort()
  passwordAbortController = null
  clearPasswordTimeout()
  passwordSubmitting.value = false
  passwordTarget.value = null
  clearPasswordForm()
  restorePasswordTriggerFocus()
}

function onPasswordDialogKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    closePasswordDialog()
    return
  }
  if (event.key !== 'Tab') return
  const dialog = passwordDialogRef.value
  if (!dialog) return
  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)')
  )
  if (focusable.length === 0) return
  const first = focusable[0]!
  const last = focusable[focusable.length - 1]!
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

async function submitPassword(): Promise<void> {
  const target = passwordTarget.value
  if (target === null || passwordSubmitting.value) return
  passwordError.value = null
  if (password.value.length < 12 || password.value.length > 128 || password.value.trim() === '') {
    passwordError.value = 'Le mot de passe doit contenir entre 12 et 128 caractères.'
    return
  }
  if (password.value !== passwordConfirmation.value) {
    passwordError.value = 'Les mots de passe ne correspondent pas.'
    return
  }

  const controller = new AbortController()
  let timedOut = false
  passwordAbortController = controller
  passwordSubmitting.value = true
  const timeoutId = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, PASSWORD_REQUEST_TIMEOUT_MS)
  passwordTimeout = timeoutId
  try {
    const response = await fetch(`/api/admin/operators/${target.id}/password`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password.value }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error('password_update_failed')
    if (passwordAbortController !== controller) return
    passwordTarget.value = null
    clearPasswordForm()
    restorePasswordTriggerFocus()
    showToast('success', 'Mot de passe mis à jour.')
  } catch {
    if (passwordAbortController === controller && passwordTarget.value === target) {
      clearPasswordForm()
      passwordError.value = timedOut
        ? 'La requête a expiré. Le résultat est incertain : vérifiez avant de réessayer.'
        : 'La mise à jour du mot de passe a échoué.'
      await nextTick()
      passwordInputRef.value?.focus()
    }
  } finally {
    if (passwordAbortController === controller) {
      passwordAbortController = null
      if (passwordTimeout === timeoutId) clearPasswordTimeout()
      passwordSubmitting.value = false
    }
  }
}

function shortOid(oid: string | null): string {
  if (oid === null || oid.length === 0) return '—'
  return oid.slice(0, 8)
}

function formatDate(iso: string | null | undefined): string {
  // Hardening W-7-3a-3 (CR E6) : guarder NaN. `new Date('garbage')` ne
  // throw pas — il retourne `Invalid Date` dont `.getTime()` === NaN, et
  // `toLocaleDateString` rend la string "Invalid Date" qui est moche en UI.
  if (iso === null || iso === undefined || iso === '') return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  try {
    return d.toLocaleDateString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    })
  } catch {
    return '—'
  }
}

onMounted(() => {
  void refresh()
})

onBeforeUnmount(() => {
  passwordAbortController?.abort()
  clearPasswordTimeout()
  clearPasswordForm()
})
</script>

<template>
  <main class="operators-admin-view">
    <header class="header">
      <h1>Opérateurs</h1>
      <p class="subtitle">Gestion des comptes opérateurs (admin et sav-operator).</p>
    </header>

    <section class="create-panel" aria-labelledby="create-title">
      <h2 id="create-title">Nouvel opérateur</h2>
      <form class="create-form" @submit="onCreateSubmit">
        <div class="field">
          <label for="op-create-email">Email</label>
          <input
            id="op-create-email"
            v-model="form.email"
            data-test="operator-create-email"
            type="email"
            required
            maxlength="254"
          />
        </div>
        <div class="field">
          <label for="op-create-name">Nom affiché</label>
          <input
            id="op-create-name"
            v-model="form.display_name"
            data-test="operator-create-display-name"
            type="text"
            required
            maxlength="100"
          />
        </div>
        <div class="field">
          <label for="op-create-role">Rôle</label>
          <select id="op-create-role" v-model="form.role" data-test="operator-create-role">
            <option value="sav-operator">sav-operator</option>
            <option value="admin">admin</option>
          </select>
        </div>
        <div class="field">
          <label for="op-create-oid">azure_oid (optionnel)</label>
          <input
            id="op-create-oid"
            v-model="form.azure_oid"
            type="text"
            placeholder="UUID v4 ou laisser vide"
          />
        </div>
        <div class="actions">
          <button
            type="submit"
            data-test="operator-create-submit"
            class="btn primary"
            :disabled="crud.loading.value"
            @click="onCreateSubmit"
          >
            Créer l'opérateur
          </button>
        </div>
      </form>
    </section>

    <section class="filters">
      <div class="field">
        <label for="op-search">Recherche</label>
        <input
          id="op-search"
          v-model="search"
          type="search"
          placeholder="Email ou nom"
          @change="refresh"
        />
      </div>
      <div class="field">
        <label for="op-role-filter">Rôle</label>
        <select id="op-role-filter" v-model="roleFilter" @change="refresh">
          <option value="">Tous</option>
          <option value="admin">admin</option>
          <option value="sav-operator">sav-operator</option>
        </select>
      </div>
    </section>

    <section class="list-panel">
      <p v-if="crud.loading.value" class="status">Chargement…</p>
      <p v-else-if="crud.items.value.length === 0" class="status muted">Aucun opérateur.</p>
      <table v-else class="operators-table" aria-label="Liste des opérateurs">
        <thead>
          <tr>
            <th scope="col">Email</th>
            <th scope="col">Nom</th>
            <th scope="col">Rôle</th>
            <th scope="col">Actif</th>
            <th scope="col">azure_oid</th>
            <th scope="col">Créé le</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="op in crud.items.value" :key="op.id" :class="{ inactive: !op.is_active }">
            <td>{{ op.email }}</td>
            <td>{{ op.display_name }}</td>
            <td>
              <span class="badge" :class="`role-${op.role}`">{{ op.role }}</span>
            </td>
            <td>
              <span class="badge" :class="op.is_active ? 'active' : 'inactive'">
                {{ op.is_active ? 'Actif' : 'Désactivé' }}
              </span>
            </td>
            <td class="muted">{{ shortOid(op.azure_oid) }}</td>
            <td>{{ formatDate(op.created_at) }}</td>
            <td class="actions-cell">
              <button
                v-if="currentUser && op.id !== currentUser.sub"
                type="button"
                :data-test="`operator-password-${op.id}`"
                :aria-label="`Définir le mot de passe de ${op.email}`"
                class="btn small"
                :disabled="passwordSubmitting"
                @click="openPasswordDialog(op, $event)"
              >
                Définir le mot de passe
              </button>
              <!-- Hardening W-7-3a-5 (CR E7) : disabled si une requête CRUD
                   est en cours, évite double-click → 2 PATCH simultanés. -->
              <button
                v-if="op.is_active"
                type="button"
                :data-test="`operator-deactivate-${op.id}`"
                class="btn small"
                :disabled="crud.loading.value"
                @click="askDeactivate(op.id)"
              >
                Désactiver
              </button>
              <button
                v-else
                type="button"
                :data-test="`operator-reactivate-${op.id}`"
                class="btn small"
                :disabled="crud.loading.value"
                @click="reactivate(op.id)"
              >
                Réactiver
              </button>
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
        <p>L'opérateur ne pourra plus se connecter, mais ses données restent conservées.</p>
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
            data-test="operator-deactivate-confirm"
            class="btn primary"
            :disabled="crud.loading.value"
            @click="confirmDeactivate"
          >
            {{ crud.loading.value ? 'Désactivation…' : 'Confirmer' }}
          </button>
        </div>
      </div>
    </div>

    <div
      v-if="passwordTarget !== null"
      class="dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="password-dialog-title"
      aria-describedby="password-dialog-target"
    >
      <form
        ref="passwordDialogRef"
        class="dialog password-dialog"
        novalidate
        @submit.prevent="submitPassword"
        @keydown="onPasswordDialogKeydown"
      >
        <h3 id="password-dialog-title">Définir le mot de passe</h3>
        <p id="password-dialog-target">Compte : {{ passwordTarget.email }}</p>
        <div class="field">
          <label for="operator-password">Nouveau mot de passe</label>
          <input
            id="operator-password"
            ref="passwordInputRef"
            v-model="password"
            data-test="operator-password-input"
            type="password"
            minlength="12"
            maxlength="128"
            autocomplete="new-password"
            required
            :aria-describedby="passwordError ? 'operator-password-error' : undefined"
            @input="passwordError = null"
          />
        </div>
        <div class="field">
          <label for="operator-password-confirmation">Confirmer le mot de passe</label>
          <input
            id="operator-password-confirmation"
            v-model="passwordConfirmation"
            data-test="operator-password-confirmation"
            type="password"
            minlength="12"
            maxlength="128"
            autocomplete="new-password"
            required
            :aria-describedby="passwordError ? 'operator-password-error' : undefined"
            @input="passwordError = null"
          />
        </div>
        <p v-if="passwordError" id="operator-password-error" class="form-error" role="alert">
          {{ passwordError }}
        </p>
        <div class="dialog-actions">
          <button
            type="button"
            data-test="operator-password-cancel"
            class="btn"
            @click="closePasswordDialog"
          >
            Annuler
          </button>
          <button
            type="submit"
            data-test="operator-password-submit"
            class="btn primary"
            :disabled="passwordSubmitting"
          >
            {{ passwordSubmitting ? 'Mise à jour…' : 'Définir' }}
          </button>
        </div>
      </form>
    </div>

    <transition name="toast">
      <div v-if="toast !== null" :class="['toast', toast.kind]" role="status" aria-live="polite">
        {{ toast.message }}
      </div>
    </transition>
  </main>
</template>

<style scoped>
.operators-admin-view {
  padding: 1.5rem;
  max-width: 1200px;
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
.create-panel h2 {
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
.filters {
  display: flex;
  gap: 1rem;
  margin-bottom: 1rem;
  flex-wrap: wrap;
}
.filters .field {
  min-width: 220px;
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
.operators-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.operators-table th,
.operators-table td {
  text-align: left;
  padding: 0.6rem 0.75rem;
  border-bottom: 1px solid #f0f0f0;
}
.operators-table th {
  background: #fafafa;
  font-weight: 600;
}
.operators-table tr.inactive td {
  opacity: 0.6;
}
.actions-cell {
  white-space: nowrap;
}
.actions-cell .btn + .btn {
  margin-left: 0.4rem;
}
.badge {
  display: inline-block;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  font-size: 0.8rem;
  background: #eee;
  color: #333;
}
.badge.role-admin {
  background: #e3f2fd;
  color: #1565c0;
}
.badge.role-sav-operator {
  background: #f3e5f5;
  color: #6a1b9a;
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
.password-dialog {
  width: min(480px, calc(100vw - 2rem));
}
.password-dialog .field + .field {
  margin-top: 0.75rem;
}
.form-error {
  color: #c62828;
  margin: 0.75rem 0 0;
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
