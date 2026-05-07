<script setup lang="ts">
/**
 * Story 3.7b — AC #6.3 — DuplicateButton.vue
 *
 * Props : { savId: number }
 *
 * Clic → confirm dialog → POST /api/sav/:id/duplicate → router.push('/admin/sav/'+newSavId)
 * Erreur 5xx → toast role="alert", dialog reste ouvert.
 * Escape ferme le dialog.
 * Focus trap : bouton confirmer focus par défaut à l'ouverture.
 */

import { ref, nextTick } from 'vue'
import { useRouter } from 'vue-router'

const props = defineProps<{
  savId: number
}>()

const router = useRouter()

const dialogOpen = ref(false)
const errorMessage = ref<string | null>(null)
const loading = ref(false)

async function openDialog(): Promise<void> {
  errorMessage.value = null
  dialogOpen.value = true
  // Focus the confirm button
  await nextTick()
  const confirmBtn = document.querySelector('[data-confirm]') as HTMLButtonElement | null
  confirmBtn?.focus()
}

function closeDialog(): void {
  dialogOpen.value = false
  errorMessage.value = null
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    closeDialog()
  }
}

async function confirmDuplicate(): Promise<void> {
  if (loading.value) return
  loading.value = true
  errorMessage.value = null

  try {
    const res = await fetch(`/api/sav/${props.savId}/duplicate`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
    })

    if (!res.ok) {
      errorMessage.value = `Erreur lors de la duplication (${res.status}).`
      return
    }

    const body = (await res.json()) as { data: { newSavId: number; newReference: string } }
    dialogOpen.value = false
    void router.push(`/admin/sav/${body.data.newSavId}`)
  } catch {
    errorMessage.value = 'Erreur réseau — réessayez.'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <span @keydown="onKeydown">
    <!-- Trigger button -->
    <button type="button" class="btn-duplicate" @click="openDialog">Dupliquer</button>

    <!-- Confirm dialog -->
    <div v-if="dialogOpen" class="dialog-overlay" @click.self="closeDialog">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="duplicate-dialog-title"
        class="dialog-box"
      >
        <h2 id="duplicate-dialog-title">Dupliquer le SAV ?</h2>
        <p>Créer un brouillon à partir de ce SAV ? Les fichiers ne seront pas copiés.</p>

        <!-- Error alert -->
        <div v-if="errorMessage" class="dialog-error" role="alert">
          {{ errorMessage }}
        </div>

        <div class="dialog-actions">
          <button
            type="button"
            data-confirm
            class="btn-confirm"
            :disabled="loading"
            @click="confirmDuplicate"
          >
            {{ loading ? 'Duplication…' : 'Créer le brouillon' }}
          </button>
          <button type="button" class="btn-cancel" @click="closeDialog">Annuler</button>
        </div>
      </div>
    </div>
  </span>
</template>

<style scoped>
.btn-duplicate {
  padding: 0.25rem 0.75rem;
  border: 1px solid #ccc;
  border-radius: 4px;
  background: white;
  cursor: pointer;
  font-size: 0.875rem;
}
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.dialog-box {
  background: white;
  padding: 1.5rem;
  border-radius: 8px;
  max-width: 400px;
  width: 90%;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
}
.dialog-box h2 {
  margin: 0 0 0.5rem;
  font-size: 1.125rem;
}
.dialog-error {
  color: #991b1b;
  font-size: 0.875rem;
  margin: 0.5rem 0;
  padding: 0.5rem;
  background: #fee2e2;
  border-radius: 4px;
}
.dialog-actions {
  display: flex;
  gap: 0.75rem;
  margin-top: 1rem;
  justify-content: flex-end;
}
.btn-confirm {
  padding: 0.5rem 1rem;
  background: #0066cc;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.875rem;
}
.btn-confirm:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.btn-cancel {
  padding: 0.5rem 1rem;
  background: white;
  border: 1px solid #ccc;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.875rem;
}
</style>
