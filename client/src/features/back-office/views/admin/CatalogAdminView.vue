<script setup lang="ts">
import { onMounted, ref } from 'vue'
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
})

const search = ref('')
const supplierFilter = ref('')
const unitFilter = ref<'' | 'kg' | 'piece' | 'liter'>('')
const showDeleted = ref(false)
const toast = ref<{ kind: 'success' | 'error'; message: string } | null>(null)
const pendingDeleteId = ref<number | null>(null)

function showToast(kind: 'success' | 'error', message: string): void {
  toast.value = { kind, message }
  window.setTimeout(() => {
    toast.value = null
  }, 4000)
}

async function refresh(): Promise<void> {
  const params: Record<string, unknown> = { limit: 50 }
  if (search.value.trim().length > 0) params['q'] = search.value.trim()
  if (supplierFilter.value.trim().length > 0) params['supplier_code'] = supplierFilter.value.trim()
  if (unitFilter.value !== '') params['default_unit'] = unitFilter.value
  if (showDeleted.value) params['is_deleted'] = 'true'
  try {
    await crud.list(params)
  } catch (e) {
    showToast('error', crud.error.value ?? (e instanceof Error ? e.message : 'Erreur'))
  }
}

async function onCreateSubmit(e?: Event): Promise<void> {
  if (e !== undefined) e.preventDefault()
  if (form.value.code.trim() === '' || form.value.name_fr.trim() === '') {
    showToast('error', 'Code et nom requis.')
    return
  }
  try {
    const payload: ProductCreate = {
      code: form.value.code.trim().toUpperCase(),
      name_fr: form.value.name_fr.trim(),
      default_unit: form.value.default_unit,
      vat_rate_bp: form.value.vat_rate_bp,
      tier_prices: [{ tier: 1, price_ht_cents: Math.max(0, form.value.first_tier_price_cents) }],
    }
    const origin = form.value.origin.trim().toUpperCase()
    if (origin.length > 0) payload.origin = origin
    const supplier = form.value.supplier_code.trim()
    if (supplier.length > 0) payload.supplier_code = supplier
    await crud.create(payload)
    showToast('success', 'Produit créé.')
    form.value = {
      code: '',
      name_fr: '',
      default_unit: 'kg',
      origin: '',
      vat_rate_bp: 550,
      supplier_code: '',
      first_tier_price_cents: 0,
    }
    await refresh()
  } catch (e) {
    showToast('error', crud.error.value ?? (e instanceof Error ? e.message : 'Erreur création'))
  }
}

function askDelete(id: number): void {
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
    showToast('success', 'Produit archivé.')
    await refresh()
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
      <p class="subtitle">Gestion des produits SAV (CRUD avec validation Zod stricte).</p>
    </header>

    <section class="create-panel" aria-labelledby="create-title">
      <h2 id="create-title">Nouveau produit</h2>
      <form class="create-form" @submit="onCreateSubmit">
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
          <label for="prod-create-name">Nom (FR)</label>
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
        <div class="field">
          <label for="prod-create-origin">Origine (ISO)</label>
          <input
            id="prod-create-origin"
            v-model="form.origin"
            data-test="product-create-origin"
            type="text"
            maxlength="2"
            placeholder="ES"
          />
        </div>
        <div class="field">
          <label for="prod-create-vat">TVA (bp)</label>
          <input
            id="prod-create-vat"
            v-model.number="form.vat_rate_bp"
            type="number"
            min="0"
            max="10000"
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
          <label for="prod-create-tier1">Tier 1 (cents HT)</label>
          <input
            id="prod-create-tier1"
            v-model.number="form.first_tier_price_cents"
            type="number"
            min="0"
            max="99999999"
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
            @click="onCreateSubmit"
          >
            Créer le produit
          </button>
        </div>
      </form>
    </section>

    <section class="filters">
      <div class="field">
        <label for="prod-search">Recherche</label>
        <input
          id="prod-search"
          v-model="search"
          type="search"
          placeholder="Code, nom"
          @change="refresh"
        />
      </div>
      <div class="field">
        <label for="prod-supplier">Fournisseur</label>
        <input id="prod-supplier" v-model="supplierFilter" type="text" @change="refresh" />
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
      <p v-if="crud.loading.value" class="status">Chargement…</p>
      <p v-else-if="crud.items.value.length === 0" class="status muted">Aucun produit.</p>
      <table v-else class="products-table" aria-label="Liste des produits">
        <thead>
          <tr>
            <th scope="col">Code</th>
            <th scope="col">Nom</th>
            <th scope="col">Unité</th>
            <th scope="col">TVA</th>
            <th scope="col">Tier</th>
            <th scope="col">Fournisseur</th>
            <th scope="col">Origine</th>
            <th scope="col">Maj</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="prod in crud.items.value"
            :key="prod.id"
            :class="{ deleted: prod.deleted_at !== null }"
          >
            <td>{{ prod.code }}</td>
            <td>{{ prod.name_fr }}</td>
            <td>
              <span class="badge unit">{{ prod.default_unit }}</span>
            </td>
            <td class="muted">{{ formatVat(prod.vat_rate_bp) }}</td>
            <td class="muted">{{ formatTier(prod.tier_prices) }}</td>
            <td class="muted">{{ prod.supplier_code ?? '—' }}</td>
            <td>
              <span v-if="prod.origin !== null" class="badge origin">{{ prod.origin }}</span>
              <span v-else class="muted">—</span>
            </td>
            <td>{{ formatDate(prod.updated_at) }}</td>
            <td class="actions-cell">
              <button
                v-if="prod.deleted_at === null"
                type="button"
                :data-test="`product-delete-${prod.id}`"
                class="btn small"
                :disabled="crud.loading.value"
                @click="askDelete(prod.id)"
              >
                Archiver
              </button>
              <span v-else class="badge deleted">Archivé</span>
            </td>
          </tr>
        </tbody>
      </table>
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
      <div v-if="toast !== null" :class="['toast', toast.kind]" role="status" aria-live="polite">
        {{ toast.message }}
      </div>
    </transition>
  </main>
</template>

<style scoped>
.catalog-admin-view {
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
.checkbox-label {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-weight: 500;
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
  align-items: end;
}
.filters .field {
  min-width: 180px;
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
.products-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
.products-table th,
.products-table td {
  text-align: left;
  padding: 0.6rem 0.75rem;
  border-bottom: 1px solid #f0f0f0;
}
.products-table th {
  background: #fafafa;
  font-weight: 600;
}
.products-table tr.deleted td {
  opacity: 0.55;
}
.actions-cell {
  white-space: nowrap;
}
.badge {
  display: inline-block;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  font-size: 0.8rem;
  background: #eee;
  color: #333;
}
.badge.unit {
  background: #e3f2fd;
  color: #1565c0;
}
.badge.origin {
  background: #f3e5f5;
  color: #6a1b9a;
  font-family: monospace;
}
.badge.deleted {
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
