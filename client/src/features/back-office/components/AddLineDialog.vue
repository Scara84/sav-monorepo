<script setup lang="ts">
import { nextTick, ref, useTemplateRef, watch } from 'vue'

/**
 * Story 3.6b AC #7 — modal ajout ligne SAV.
 *
 * V1 simple : input libre `productCodeSnapshot` / `productNameSnapshot`
 * (pas d'autocomplete catalogue — carry-over V1.1 quand l'endpoint
 * `/api/admin/products/search` sera dispo Epic 7).
 *
 * Validation inline basique (pas de Zod ici — le serveur est la source de vérité,
 * on fait juste un pré-check pour éviter un round-trip évident).
 */

interface Props {
  open: boolean
  saving?: boolean
}

interface CreateLineBody {
  productCodeSnapshot: string
  productNameSnapshot: string
  qtyRequested: number
  unitRequested: 'kg' | 'piece' | 'liter'
  unitPriceHtCents?: number
  vatRateBpSnapshot?: number
  creditCoefficient?: number
}

const props = withDefaults(defineProps<Props>(), { saving: false })
const emit = defineEmits<{
  create: [body: CreateLineBody]
  cancel: []
}>()

const form = ref({
  productCodeSnapshot: '',
  productNameSnapshot: '',
  qtyRequested: '' as string | number,
  unitRequested: 'kg' as 'kg' | 'piece' | 'liter',
  unitPriceEuros: '' as string | number,
  vatRatePercent: '' as string | number,
  creditCoefficient: '' as string | number,
})

const errors = ref<Record<string, string>>({})
const firstInput = useTemplateRef<HTMLInputElement>('firstInputRef')

function resetForm(): void {
  form.value = {
    productCodeSnapshot: '',
    productNameSnapshot: '',
    qtyRequested: '',
    unitRequested: 'kg',
    unitPriceEuros: '',
    vatRatePercent: '',
    creditCoefficient: '',
  }
  errors.value = {}
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      resetForm()
      void nextTick(() => firstInput.value?.focus())
    }
  }
)

function onEscape(): void {
  if (!props.saving) emit('cancel')
}

function validate(): boolean {
  const e: Record<string, string> = {}
  if (!form.value.productCodeSnapshot.trim()) e['productCodeSnapshot'] = 'Code produit requis'
  else if (form.value.productCodeSnapshot.length > 64)
    e['productCodeSnapshot'] = 'Max 64 caractères'
  if (!form.value.productNameSnapshot.trim()) e['productNameSnapshot'] = 'Nom produit requis'
  else if (form.value.productNameSnapshot.length > 200)
    e['productNameSnapshot'] = 'Max 200 caractères'
  const qty = Number(form.value.qtyRequested)
  if (!Number.isFinite(qty) || qty <= 0) e['qtyRequested'] = 'Quantité positive requise'
  else if (qty > 99999) e['qtyRequested'] = 'Quantité trop grande'
  if (form.value.unitPriceEuros !== '') {
    const euros = Number(form.value.unitPriceEuros)
    if (!Number.isFinite(euros) || euros < 0) e['unitPriceEuros'] = 'Prix ≥ 0 requis'
  }
  if (form.value.vatRatePercent !== '') {
    const pct = Number(form.value.vatRatePercent)
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) e['vatRatePercent'] = 'Taux 0-100 %'
  }
  if (form.value.creditCoefficient !== '') {
    const c = Number(form.value.creditCoefficient)
    if (!Number.isFinite(c) || c < 0 || c > 1) e['creditCoefficient'] = 'Coefficient 0-1'
  }
  errors.value = e
  return Object.keys(e).length === 0
}

function submit(): void {
  if (!validate()) return
  const body: CreateLineBody = {
    productCodeSnapshot: form.value.productCodeSnapshot.trim(),
    productNameSnapshot: form.value.productNameSnapshot.trim(),
    qtyRequested: Number(form.value.qtyRequested),
    unitRequested: form.value.unitRequested,
  }
  if (form.value.unitPriceEuros !== '') {
    body.unitPriceHtCents = Math.round(Number(form.value.unitPriceEuros) * 100)
  }
  if (form.value.vatRatePercent !== '') {
    body.vatRateBpSnapshot = Math.round(Number(form.value.vatRatePercent) * 100)
  }
  if (form.value.creditCoefficient !== '') {
    body.creditCoefficient = Number(form.value.creditCoefficient)
  }
  emit('create', body)
}
</script>

<template>
  <div
    v-if="props.open"
    class="dialog-backdrop"
    role="dialog"
    aria-modal="true"
    aria-labelledby="add-line-title"
    @click.self="onEscape"
    @keydown.esc="onEscape"
    data-testid="add-line-dialog"
  >
    <div class="dialog-content" tabindex="-1">
      <h3 id="add-line-title">Ajouter une ligne</h3>

      <form @submit.prevent="submit">
        <div class="field">
          <label for="add-line-code">Code produit *</label>
          <input
            id="add-line-code"
            ref="firstInputRef"
            v-model="form.productCodeSnapshot"
            type="text"
            maxlength="64"
            required
            :aria-invalid="!!errors.productCodeSnapshot"
            :aria-describedby="errors.productCodeSnapshot ? 'err-code' : undefined"
          />
          <span v-if="errors.productCodeSnapshot" id="err-code" class="error" role="alert">
            {{ errors.productCodeSnapshot }}
          </span>
        </div>

        <div class="field">
          <label for="add-line-name">Nom produit *</label>
          <input
            id="add-line-name"
            v-model="form.productNameSnapshot"
            type="text"
            maxlength="200"
            required
            :aria-invalid="!!errors.productNameSnapshot"
            :aria-describedby="errors.productNameSnapshot ? 'err-name' : undefined"
          />
          <span v-if="errors.productNameSnapshot" id="err-name" class="error" role="alert">
            {{ errors.productNameSnapshot }}
          </span>
        </div>

        <div class="field-row">
          <div class="field">
            <label for="add-line-qty">Quantité demandée *</label>
            <input
              id="add-line-qty"
              v-model="form.qtyRequested"
              type="number"
              min="0.001"
              max="99999"
              step="0.001"
              required
              :aria-invalid="!!errors.qtyRequested"
              :aria-describedby="errors.qtyRequested ? 'err-qty' : undefined"
            />
            <span v-if="errors.qtyRequested" id="err-qty" class="error" role="alert">
              {{ errors.qtyRequested }}
            </span>
          </div>

          <div class="field">
            <label for="add-line-unit">Unité *</label>
            <select id="add-line-unit" v-model="form.unitRequested">
              <option value="kg">kg</option>
              <option value="piece">pièce</option>
              <option value="liter">litre</option>
            </select>
          </div>
        </div>

        <div class="field-row">
          <div class="field">
            <label for="add-line-price">PU HT (€)</label>
            <input
              id="add-line-price"
              v-model="form.unitPriceEuros"
              type="number"
              min="0"
              max="999999.99"
              step="0.01"
              :aria-invalid="!!errors.unitPriceEuros"
              :aria-describedby="errors.unitPriceEuros ? 'err-price' : undefined"
            />
            <span v-if="errors.unitPriceEuros" id="err-price" class="error" role="alert">
              {{ errors.unitPriceEuros }}
            </span>
          </div>

          <div class="field">
            <label for="add-line-vat">Taux TVA (%)</label>
            <input
              id="add-line-vat"
              v-model="form.vatRatePercent"
              type="number"
              min="0"
              max="100"
              step="0.01"
              :aria-invalid="!!errors.vatRatePercent"
              :aria-describedby="errors.vatRatePercent ? 'err-vat' : undefined"
            />
            <span v-if="errors.vatRatePercent" id="err-vat" class="error" role="alert">
              {{ errors.vatRatePercent }}
            </span>
          </div>

          <div class="field">
            <label for="add-line-coef">Coefficient avoir (0-1)</label>
            <input
              id="add-line-coef"
              v-model="form.creditCoefficient"
              type="number"
              min="0"
              max="1"
              step="0.01"
              placeholder="défaut 1"
              :aria-invalid="!!errors.creditCoefficient"
              :aria-describedby="errors.creditCoefficient ? 'err-coef' : undefined"
            />
            <span v-if="errors.creditCoefficient" id="err-coef" class="error" role="alert">
              {{ errors.creditCoefficient }}
            </span>
          </div>
        </div>

        <div class="dialog-actions">
          <button type="button" :disabled="props.saving" @click="onEscape">Annuler</button>
          <button type="submit" :disabled="props.saving" data-testid="add-line-submit">
            {{ props.saving ? 'Ajout…' : 'Ajouter' }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.dialog-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.dialog-content {
  background: white;
  border-radius: 8px;
  padding: 1.5rem;
  width: min(560px, 92vw);
  max-height: 92vh;
  overflow-y: auto;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
}
.dialog-content h3 {
  margin: 0 0 1rem;
  font-size: 1.125rem;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-bottom: 0.75rem;
  flex: 1;
}
.field label {
  font-size: 0.8125rem;
  color: #374151;
  font-weight: 500;
}
.field input,
.field select {
  padding: 0.375rem 0.5rem;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  font: inherit;
}
.field input[aria-invalid='true'] {
  border-color: #c00;
}
.field input:focus-visible,
.field select:focus-visible {
  outline: 2px solid #0066cc;
  outline-offset: 1px;
}
.field-row {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.error {
  color: #991b1b;
  font-size: 0.75rem;
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 1rem;
}
.dialog-actions button {
  padding: 0.5rem 1rem;
  border-radius: 4px;
  border: 1px solid #d1d5db;
  background: white;
  cursor: pointer;
  font: inherit;
}
.dialog-actions button[type='submit'] {
  background: #0066cc;
  color: white;
  border-color: #0066cc;
}
.dialog-actions button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
