<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { useAdminCrud } from '../../composables/useAdminCrud'

/**
 * Story 7-3b AC #1/2/3/5 — Écran admin catalogue produits.
 *
 * CRUD produits : liste paginée + recherche + création (D-2 + D-5) +
 * soft-delete via DELETE (`UPDATE products SET deleted_at=now()` côté
 * handler). i18n FR-only V1 (D-12).
 *
 * Sélecteurs data-test (smoke spec) :
 *   product-create-{code,name-fr,default-unit,origin,submit}
 *   product-delete-{id}, product-delete-confirm
 */

interface TierPrice {
  tier: number
  price_ht_cents: number
}
interface Product {
  id: number
  code: string
  name_fr: string
  name_en: string | null
  name_es: string | null
  vat_rate_bp: number
  default_unit: 'kg' | 'piece' | 'liter'
  piece_weight_grams: number | null
  tier_prices: TierPrice[]
  supplier_code: string | null
  origin: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}
interface ProductCreate {
  code: string
  name_fr: string
  name_en?: string | null
  name_es?: string | null
  vat_rate_bp?: number
  default_unit: 'kg' | 'piece' | 'liter'
  piece_weight_grams?: number | null
  tier_prices: TierPrice[]
  supplier_code?: string | null
  origin?: string | null
}
interface ProductUpdate {
  name_fr?: string
  name_en?: string | null
  name_es?: string | null
  vat_rate_bp?: number
  default_unit?: 'kg' | 'piece' | 'liter'
  piece_weight_grams?: number | null
  tier_prices?: TierPrice[]
  supplier_code?: string | null
  origin?: string | null
  deleted_at?: string | null
}

const crud = useAdminCrud<Product, ProductCreate, ProductUpdate>('products')

const form = ref({
  code: '',
  name_fr: '',
  default_unit: 'kg' as 'kg' | 'piece' | 'liter',
  origin: '',
  vat_rate_bp: 550,
  supplier_code: '',
  first_tier_price_cents: 0,
  piece_weight_grams: null as number | null,
})

const search = ref('')
const supplierFilter = ref('')
const unitFilter = ref<'' | 'kg' | 'piece' | 'liter'>('')
const showDeleted = ref(false)
const toast = ref<{ kind: 'success' | 'error'; message: string } | null>(null)
const pendingDeleteId = ref<number | null>(null)

function showToast(kind: 'success' | 'error', message: string): void {
  toast.value = { kind, message }
}

const readError = ref('')

async function refresh(): Promise<boolean> {
  readError.value = ''
  const params: Record<string, unknown> = { limit: 50 }
  if (search.value.trim().length > 0) params['q'] = search.value.trim()
  if (supplierFilter.value.trim().length > 0) params['supplier_code'] = supplierFilter.value.trim()
  if (unitFilter.value !== '') params['default_unit'] = unitFilter.value
  if (showDeleted.value) params['is_deleted'] = 'true'
  try {
    return await crud.list(params)
  } catch (e) {
    readError.value = crud.error.value ?? (e instanceof Error ? e.message : 'Erreur de lecture.')
    toast.value = null
    return false
  }
}

async function onCreateSubmit(e?: Event): Promise<void> {
  if (e !== undefined) e.preventDefault()
  toast.value = null
  if (!/^[A-Z0-9_-]{1,64}$/.test(form.value.code.trim().toUpperCase())) {
    showToast('error', 'Code produit requis. Utilisez des lettres, chiffres, tirets ou tirets bas.')
    return
  }
  if (!form.value.name_fr.trim()) {
    showToast('error', 'Nom français requis.')
    return
  }
  try {
    const payload: ProductCreate = {
      code: form.value.code.trim().toUpperCase(),
      name_fr: form.value.name_fr.trim(),
      default_unit: form.value.default_unit,
      vat_rate_bp: form.value.vat_rate_bp,
      tier_prices: [{ tier: 1, price_ht_cents: form.value.first_tier_price_cents }],
    }
    if (form.value.default_unit === 'piece')
      payload.piece_weight_grams = form.value.piece_weight_grams
    const origin = form.value.origin.trim().toUpperCase()
    if (origin.length > 0) payload.origin = origin
    const supplier = form.value.supplier_code.trim()
    if (supplier.length > 0) payload.supplier_code = supplier
    await crud.create(payload)
    form.value = {
      code: '',
      name_fr: '',
      default_unit: 'kg',
      origin: '',
      vat_rate_bp: 550,
      supplier_code: '',
      first_tier_price_cents: 0,
      piece_weight_grams: null,
    }
    if (await refresh()) showToast('success', 'Produit créé.')
  } catch (e) {
    showToast('error', crud.error.value ?? (e instanceof Error ? e.message : 'Erreur création'))
  }
}

const editingId = ref<number | null>(null)
const editedName = ref('')

async function startEdit(product: Product): Promise<void> {
  toast.value = null
  editingId.value = product.id
  editedName.value = product.name_fr
  await nextTick()
  document.getElementById('product-edit-name')?.focus()
}

async function closeEdit(id: number): Promise<void> {
  editingId.value = null
  await nextTick()
  document.getElementById(`product-edit-${id}`)?.focus()
}

async function saveEdit(id: number): Promise<void> {
  const name = editedName.value.trim()
  if (!name || name.length > 200) {
    showToast('error', 'Nom français requis (200 caractères maximum).')
    document.getElementById('product-edit-name')?.focus()
    return
  }
  toast.value = null
  try {
    await crud.update(id, { name_fr: name })
    if (await refresh()) showToast('success', 'Produit mis à jour.')
    await closeEdit(id)
  } catch (e) {
    showToast(
      'error',
      crud.error.value ?? (e instanceof Error ? e.message : 'Modification refusée.')
    )
  }
}

function askDelete(id: number): void {
  toast.value = null
  pendingDeleteId.value = id
}
function cancelDelete(): void {
  pendingDeleteId.value = null
}
async function confirmDelete(): Promise<void> {
  const id = pendingDeleteId.value
  if (id === null) return
  pendingDeleteId.value = null
  try {
    await crud.remove(id)
    if (await refresh()) showToast('success', 'Produit archivé.')
  } catch (e) {
    showToast('error', crud.error.value ?? (e instanceof Error ? e.message : 'Erreur suppression'))
  }
}

function formatTier(tiers: TierPrice[]): string {
  if (!Array.isArray(tiers) || tiers.length === 0) return '—'
  const first = tiers[0]
  if (first === undefined) return '—'
  const eur = (first.price_ht_cents / 100).toFixed(2)
  return `${first.tier}×${eur} €`
}

function formatVat(bp: number | null | undefined): string {
  if (bp === null || bp === undefined) return '—'
  return `${(bp / 100).toFixed(2)}%`
}

function formatDate(iso: string | null | undefined): string {
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
</script>

<template>
  <main class="catalog-admin-view">
    <header class="header">
      <h1>Catalogue produits</h1>
      <p class="subtitle">Rechercher un produit par code ou par nom français.</p>
    </header>

    <section class="filters">
      <div class="field">
        <label for="prod-search">Recherche</label>
        <input
          id="prod-search"
          v-model="search"
          type="search"
          maxlength="100"
          placeholder="Code, nom"
          @change="refresh"
        />
      </div>
      <div class="field">
        <label for="prod-supplier">Fournisseur</label>
        <input
          id="prod-supplier"
          v-model="supplierFilter"
          maxlength="32"
          type="text"
          @change="refresh"
        />
      </div>
      <div class="field">
        <label for="prod-unit">Unité</label>
        <select id="prod-unit" v-model="unitFilter" @change="refresh">
          <option value="">Toutes</option>
          <option value="kg">kg</option>
          <option value="piece">piece</option>
          <option value="liter">liter</option>
        </select>
      </div>
      <div class="field">
        <label class="checkbox-label">
          <input v-model="showDeleted" type="checkbox" @change="refresh" />
          Afficher archivés
        </label>
      </div>
    </section>

    <section class="list-panel">
      <p v-if="readError" class="status error" role="alert">
        {{ readError }} <button class="btn" @click="refresh">Réessayer</button>
      </p>
      <p v-else-if="crud.loading.value && !crud.items.value.length" class="status">Chargement…</p>
      <p v-else-if="crud.items.value.length === 0" class="status muted">Aucun produit.</p>
      <table v-if="crud.items.value.length" class="products-table" aria-label="Liste des produits">
        <thead>
          <tr>
            <th scope="col">Code</th>
            <th scope="col">Nom</th>
            <th scope="col">Unité</th>
            <th scope="col">TVA</th>
            <th scope="col">Palier</th>
            <th scope="col">Fournisseur</th>
            <th scope="col">Origine</th>
            <th scope="col">Mis à jour</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="prod in crud.items.value"
            :key="prod.id"
            :class="{ deleted: prod.deleted_at !== null }"
          >
            <td data-label="Code">{{ prod.code }}</td>
            <td data-label="Nom français">
              <input
                v-if="editingId === prod.id"
                id="product-edit-name"
                v-model="editedName"
                aria-label="Nom français"
                maxlength="200"
                class="edit-input"
                @keydown.enter.prevent="saveEdit(prod.id)"
                @keydown.esc="closeEdit(prod.id)"
                :disabled="crud.loading.value"
              />
              <template v-else>{{ prod.name_fr }}</template>
            </td>
            <td data-label="Unité">
              <span class="badge unit">{{ prod.default_unit }}</span>
            </td>
            <td data-label="TVA" class="muted">{{ formatVat(prod.vat_rate_bp) }}</td>
            <td data-label="Palier" class="muted">{{ formatTier(prod.tier_prices) }}</td>
            <td data-label="Fournisseur" class="muted">{{ prod.supplier_code ?? '—' }}</td>
            <td data-label="Origine">
              <span v-if="prod.origin !== null" class="badge origin">{{ prod.origin }}</span>
              <span v-else class="muted">—</span>
            </td>
            <td data-label="Mis à jour">{{ formatDate(prod.updated_at) }}</td>
            <td data-label="Actions" class="actions-cell">
              <template v-if="editingId === prod.id">
                <button
                  type="button"
                  class="btn small primary"
                  :disabled="crud.loading.value"
                  @click="saveEdit(prod.id)"
                >
                  Enregistrer
                </button>
                <button
                  type="button"
                  class="btn small"
                  :disabled="crud.loading.value"
                  @click="closeEdit(prod.id)"
                >
                  Annuler
                </button>
              </template>
              <button
                v-else-if="prod.deleted_at === null"
                :id="`product-edit-${prod.id}`"
                type="button"
                class="btn small"
                :disabled="crud.loading.value"
                @click="startEdit(prod)"
              >
                Modifier
              </button>
              <button
                v-if="prod.deleted_at === null && editingId !== prod.id"
                type="button"
                :data-test="`product-delete-${prod.id}`"
                class="btn small"
                :disabled="crud.loading.value"
                @click="askDelete(prod.id)"
              >
                Archiver
              </button>
              <span v-if="prod.deleted_at !== null" class="badge deleted">Archivé</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="create-panel" aria-labelledby="create-title">
      <h2 id="create-title">Nouveau produit</h2>
      <form @invalid.capture="toast = null" class="create-form" @submit="onCreateSubmit">
        <div class="field">
          <label for="prod-create-code">Code</label>
          <input
            id="prod-create-code"
            v-model="form.code"
            data-test="product-create-code"
            type="text"
            required
            maxlength="64"
            placeholder="TOM-RAP-1"
          />
        </div>
        <div class="field">
          <label for="prod-create-name">Nom français</label>
          <input
            id="prod-create-name"
            v-model="form.name_fr"
            data-test="product-create-name-fr"
            type="text"
            required
            maxlength="200"
          />
        </div>
        <div class="field">
          <label for="prod-create-unit">Unité</label>
          <select
            id="prod-create-unit"
            v-model="form.default_unit"
            data-test="product-create-default-unit"
          >
            <option value="kg">kg</option>
            <option value="piece">piece</option>
            <option value="liter">liter</option>
          </select>
        </div>
        <div v-if="form.default_unit === 'piece'" class="field">
          <label for="prod-create-weight">Poids par pièce (g)</label>
          <input
            id="prod-create-weight"
            v-model.number="form.piece_weight_grams"
            type="number"
            min="1"
            step="1"
            required
          />
        </div>
        <div class="field">
          <label for="prod-create-origin">Origine (ISO)</label>
          <input
            id="prod-create-origin"
            v-model="form.origin"
            data-test="product-create-origin"
            type="text"
            maxlength="2"
            pattern="[a-zA-Z]{2}"
            title="Origine : deux lettres du code pays"
            placeholder="ES"
          />
        </div>
        <div class="field">
          <label for="prod-create-vat">TVA (points de base)</label>
          <input
            id="prod-create-vat"
            v-model.number="form.vat_rate_bp"
            type="number"
            min="0"
            max="10000"
            required
            step="1"
          />
        </div>
        <div class="field">
          <label for="prod-create-supplier">Fournisseur</label>
          <input
            id="prod-create-supplier"
            v-model="form.supplier_code"
            type="text"
            maxlength="32"
            placeholder="rufino"
          />
        </div>
        <div class="field">
          <label for="prod-create-tier1">Palier 1 (centimes HT)</label>
          <input
            id="prod-create-tier1"
            v-model.number="form.first_tier_price_cents"
            type="number"
            min="0"
            max="10000000"
            required
            step="1"
            inputmode="numeric"
            data-test="product-create-tier1"
            placeholder="ex: 350"
          />
        </div>
        <div class="actions">
          <button
            type="submit"
            data-test="product-create-submit"
            class="btn primary"
            :disabled="crud.loading.value"
          >
            Créer le produit
          </button>
        </div>
      </form>
    </section>

    <div
      v-if="pendingDeleteId !== null"
      class="dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
    >
      <div class="dialog">
        <h3 id="confirm-title">Confirmer l'archivage</h3>
        <p>Le produit ne sera plus disponible en capture SAV, mais l'historique reste.</p>
        <div class="dialog-actions">
          <button type="button" class="btn" :disabled="crud.loading.value" @click="cancelDelete">
            Annuler
          </button>
          <button
            type="button"
            data-test="product-delete-confirm"
            class="btn primary"
            :disabled="crud.loading.value"
            @click="confirmDelete"
          >
            {{ crud.loading.value ? 'Archivage…' : 'Confirmer' }}
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
