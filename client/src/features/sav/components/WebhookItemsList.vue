<template>
  <div class="webhook-items">
    <!-- Snackbar notification bottom-right -->
    <transition name="fade">
      <div
        v-if="toastMessage"
        :class="[
          'fixed right-6 bottom-6 z-50 flex items-center gap-3 px-5 py-3 rounded shadow-lg min-w-[240px]',
          toastType === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white',
        ]"
      >
        <span v-if="toastType === 'success'" class="inline-block"
          ><svg
            xmlns="http://www.w3.org/2000/svg"
            class="h-6 w-6"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M5 13l4 4L19 7"
            /></svg
        ></span>
        <span v-else class="inline-block"
          ><svg
            xmlns="http://www.w3.org/2000/svg"
            class="h-6 w-6"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M12 8v4m0 4h.01M21 12A9 9 0 11 3 12a9 9 0 0118 0z"
            /></svg
        ></span>
        <span>{{ toastMessage }}</span>
      </div>
    </transition>
    <!-- Modal d'upload avec overlay (Teleport vers body pour garantir le positionnement) -->
    <Teleport to="body">
      <transition name="modal-fade">
        <div v-if="uploadModalVisible" class="upload-modal-overlay">
          <div class="upload-modal-content" @click.stop>
            <!-- État: Upload en cours -->
            <div v-if="uploadStatus === 'uploading'" class="text-center">
              <div class="mb-6">
                <svg
                  class="animate-spin h-16 w-16 text-blue-600 mx-auto"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    class="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    stroke-width="4"
                  ></circle>
                  <path
                    class="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  ></path>
                </svg>
              </div>
              <h3 class="text-2xl font-bold text-gray-900 mb-2">Envoi en cours...</h3>
              <p class="text-gray-600 mb-6">
                Veuillez patienter pendant l'envoi de vos réclamations
              </p>

              <!-- Barre de progression -->
              <div class="mb-4">
                <div class="flex items-center justify-between mb-2">
                  <span class="text-sm font-medium text-gray-700">Progression</span>
                  <span class="text-sm font-bold text-blue-600"
                    >{{ uploadedFiles }}/{{ totalFiles }} fichiers</span
                  >
                </div>
                <div class="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
                  <div
                    class="bg-gradient-to-r from-blue-500 to-indigo-600 h-3 rounded-full transition-all duration-500 ease-out flex items-center justify-end pr-2"
                    :style="{
                      width: totalFiles > 0 ? (uploadedFiles / totalFiles) * 100 + '%' : '0%',
                    }"
                  >
                    <span
                      v-if="uploadedFiles > 0 && totalFiles > 0"
                      class="text-[10px] font-bold text-white"
                      >{{ Math.round((uploadedFiles / totalFiles) * 100) }}%</span
                    >
                  </div>
                </div>
              </div>

              <!-- Fichier actuel -->
              <div class="bg-blue-50 rounded-lg p-3 mt-4">
                <p class="text-xs text-gray-500 mb-1">Fichier en cours</p>
                <p class="text-sm text-gray-900 font-semibold truncate">
                  {{ currentUploadFile || 'Préparation...' }}
                </p>
              </div>
            </div>

            <!-- État: Succès -->
            <div v-else-if="uploadStatus === 'success'" class="text-center">
              <div class="mb-6">
                <div
                  class="mx-auto w-16 h-16 bg-green-100 rounded-full flex items-center justify-center"
                >
                  <svg
                    class="w-10 h-10 text-green-600"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M5 13l4 4L19 7"
                    ></path>
                  </svg>
                </div>
              </div>
              <h3 class="text-2xl font-bold text-gray-900 mb-2">Envoi réussi !</h3>
              <p class="text-gray-600 mb-6">
                Toutes vos réclamations ont été envoyées avec succès.
              </p>
              <button
                @click="closeUploadModal"
                class="w-full px-6 py-3 text-base font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 transition-colors"
              >
                Fermer
              </button>
            </div>

            <!-- État: Erreur -->
            <div v-else-if="uploadStatus === 'error'" class="text-center">
              <div class="mb-6">
                <div
                  class="mx-auto w-16 h-16 bg-red-100 rounded-full flex items-center justify-center"
                >
                  <svg
                    class="w-10 h-10 text-red-600"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M6 18L18 6M6 6l12 12"
                    ></path>
                  </svg>
                </div>
              </div>
              <h3 class="text-2xl font-bold text-gray-900 mb-2">Erreur d'envoi</h3>
              <p class="text-gray-600 mb-2">
                Une erreur est survenue lors de l'envoi de vos réclamations.
              </p>
              <p
                v-if="uploadErrorMessage"
                class="text-sm text-red-600 mb-6 bg-red-50 p-3 rounded-lg"
              >
                {{ uploadErrorMessage }}
              </p>
              <button
                @click="closeUploadModal"
                class="w-full px-6 py-3 text-base font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 transition-colors"
              >
                Fermer
              </button>
            </div>
          </div>
        </div>
      </transition>
    </Teleport>

    <h2 class="section-title">Articles de la facture</h2>
    <ul class="space-y-6" :inert="globalLoading">
      <li v-for="(item, index) in items" :key="keyAt(index)" class="line-card">
        <!-- Nom du produit sur toute la largeur -->
        <h3 class="text-xl mb-4 text-slate-900">
          {{ item.label || item.product_name }}
        </h3>

        <!-- Autres propriétés alignées sur une ligne -->
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div class="flex flex-col">
            <span class="text-sm font-medium text-gray-500">Quantité</span>
            <span class="text-gray-900">{{ formatValue('quantity', item.quantity) }}</span>
          </div>
          <div class="flex flex-col">
            <span class="text-sm font-medium text-gray-500">Unité</span>
            <span class="text-gray-900">{{ formatValue('unit', item.unit) }}</span>
          </div>
          <div class="flex flex-col">
            <span class="text-sm font-medium text-gray-500">Prix Unitaire</span>
            <span class="text-gray-900">{{ unitPrice(item) }}</span>
          </div>
          <div class="flex flex-col">
            <span class="text-sm font-medium text-gray-500">Prix Total</span>
            <span class="text-gray-900">{{ formatValue('amount', item.amount) }}</span>
          </div>
        </div>

        <!-- Bouton pour afficher le formulaire SAV -->
        <div class="mt-4">
          <button
            @click="toggleSavForm(index)"
            v-if="!getSavForm(index).filled"
            :id="`signal-${index}`"
            class="btn-main sav-primary line-action"
            :class="{ 'btn-main--danger': getSavForm(index).showForm }"
          >
            {{ getSavForm(index).showForm ? 'Annuler la réclamation' : 'Signaler un problème' }}
          </button>
        </div>

        <p
          v-if="getSavForm(index).filled && getSavForm(index).showForm"
          class="text-sm font-semibold"
        >
          Ajoutée à votre demande — pas encore envoyée
        </p>

        <!-- Formulaire SAV -->
        <div
          v-if="getSavForm(index).showForm && !getSavForm(index).filled"
          class="mt-4 p-4 bg-gray-50 rounded-2xl"
        >
          <form
            novalidate
            class="space-y-4"
            :class="{ 'opacity-75': getSavForm(index).filled }"
            @submit.prevent="validateItemForm(index)"
          >
            <div class="grid gap-4 sm:grid-cols-3">
              <div>
                <label
                  :for="`quantity-${index}`"
                  class="block text-[color:var(--text-dark)] font-semibold text-base"
                >
                  Quantité
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  max="9999.99"
                  inputmode="decimal"
                  :data-test="`sav-form-quantity-${index}`"
                  placeholder="ex: 1.5"
                  :id="`quantity-${index}`"
                  :aria-invalid="!!getSavForm(index).errors.quantity"
                  :aria-describedby="
                    getSavForm(index).errors.quantity ? `error-quantity-${index}` : undefined
                  "
                  v-model="getSavForm(index).quantity"
                  :disabled="getSavForm(index).filled"
                  class="sav-field mt-1"
                  :class="{ 'border-red-500': getSavForm(index).errors.quantity }"
                  required
                />
                <p
                  :id="`error-quantity-${index}`"
                  v-if="getSavForm(index).errors.quantity"
                  class="mt-1 text-sm text-red-600"
                >
                  {{ getSavForm(index).errors.quantity }}
                </p>
              </div>
              <div>
                <label
                  :for="`unit-${index}`"
                  class="block text-[color:var(--text-dark)] font-semibold text-base"
                  >Unité</label
                >
                <select
                  :id="`unit-${index}`"
                  :aria-invalid="!!getSavForm(index).errors.unit"
                  :aria-describedby="
                    getSavForm(index).errors.unit ? `error-unit-${index}` : undefined
                  "
                  v-model="getSavForm(index).unit"
                  :disabled="getSavForm(index).filled"
                  class="sav-field mt-1"
                  :class="{ 'border-red-500': getSavForm(index).errors.unit }"
                  required
                >
                  <option value="">Choisir une unité</option>
                  <option value="piece">Pièce</option>
                  <option value="kg">kg</option>
                  <option value="g">g</option>
                </select>
                <p
                  :id="`error-unit-${index}`"
                  v-if="getSavForm(index).errors.unit"
                  class="mt-1 text-sm text-red-600"
                >
                  {{ getSavForm(index).errors.unit }}
                </p>
              </div>
              <div>
                <label
                  :for="`reason-${index}`"
                  class="block text-[color:var(--text-dark)] font-semibold text-base"
                  >Motif</label
                >
                <select
                  :id="`reason-${index}`"
                  :aria-invalid="!!getSavForm(index).errors.reason"
                  :aria-describedby="
                    getSavForm(index).errors.reason ? `error-reason-${index}` : undefined
                  "
                  v-model="getSavForm(index).reason"
                  :disabled="getSavForm(index).filled"
                  class="sav-field mt-1"
                  :class="{ 'border-red-500': getSavForm(index).errors.reason }"
                  required
                >
                  <option value="">Choisir un motif</option>
                  <option value="abime">Abîmé</option>
                  <option value="manquant">Manquant</option>
                  <option value="autre">Autre</option>
                </select>
                <p
                  :id="`error-reason-${index}`"
                  v-if="getSavForm(index).errors.reason"
                  class="mt-1 text-sm text-red-600"
                >
                  {{ getSavForm(index).errors.reason }}
                </p>
              </div>
            </div>

            <!-- Champ commentaire optionnel -->
            <div class="mt-4">
              <label
                :for="`comment-${index}`"
                class="block text-[color:var(--text-dark)] font-semibold text-base"
              >
                Commentaire
                <span class="text-xs text-gray-500">(optionnel)</span>
              </label>
              <textarea
                :id="`comment-${index}`"
                v-model="getSavForm(index).comment"
                :disabled="getSavForm(index).filled"
                rows="3"
                class="sav-field mt-1"
                placeholder="Ajoutez un commentaire si nécessaire..."
              ></textarea>
            </div>

            <!-- Champ d'upload d'images pour les motifs "abimé", "manquant" et "autre" -->
            <div
              v-if="
                getSavForm(index).reason === 'abime' ||
                getSavForm(index).reason === 'manquant' ||
                getSavForm(index).reason === 'autre'
              "
              class="mt-4"
            >
              <label
                :for="`images-${index}`"
                class="block text-[color:var(--text-dark)] font-semibold text-base mb-2"
              >
                Photos
                <span class="text-xs text-gray-500"
                  >({{ getSavForm(index).reason === 'abime' ? 'obligatoire' : 'optionnel' }} -
                  formats acceptés: JPEG, PNG, GIF, WebP, SVG, HEIC - max {{ maxFileSizeMb }}Mo par
                  image)</span
                >
              </label>

              <!-- Zone de drag & drop visuellement améliorée -->
              <div
                :class="[
                  'upload-drop-zone',
                  { 'upload-drop-zone-active': getSavForm(index).isDragging },
                  { 'upload-drop-zone-disabled': getSavForm(index).filled },
                ]"
                @dragover.prevent="
                  !getSavForm(index).filled && (getSavForm(index).isDragging = true)
                "
                @dragleave.prevent="getSavForm(index).isDragging = false"
                @drop.prevent="handleDrop($event, index)"
              >
                <input
                  :id="`images-${index}`"
                  :aria-invalid="!!getSavForm(index).errors.images"
                  :aria-describedby="
                    getSavForm(index).errors.images ? `error-images-${index}` : undefined
                  "
                  type="file"
                  multiple
                  accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml,image/heic,image/heif"
                  @change="handleImageUpload($event, index)"
                  :disabled="getSavForm(index).filled"
                  class="sav-field cursor-pointer"
                />

                <p class="p-2 text-sm">Vous pouvez aussi déposer vos photos ici.</p>
              </div>
              <!-- Prévisualisation des images -->
              <div
                v-if="getSavForm(index).images && getSavForm(index).images.length > 0"
                class="mt-4 grid grid-cols-3 gap-4"
              >
                <div
                  v-for="(image, imageIndex) in getSavForm(index).images"
                  :key="imageIndex"
                  class="relative"
                >
                  <!-- Afficher l'image si le format est supporté par le navigateur -->
                  <img
                    v-if="image.type !== 'image/heic' && image.type !== 'image/heif'"
                    :src="image.preview"
                    loading="lazy"
                    class="h-24 w-24 object-cover rounded-lg"
                    alt="Aperçu"
                  />
                  <!-- Afficher un placeholder pour les formats HEIC/HEIF -->
                  <div
                    v-else
                    class="h-24 w-24 bg-gray-100 rounded-lg flex flex-col items-center justify-center text-center p-2 border-2 border-gray-300"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      class="h-8 w-8 text-gray-400 mb-1"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                      />
                    </svg>
                    <span class="text-xs text-gray-500 font-medium">Aperçu non disponible</span>
                    <span class="text-xs text-gray-400 mt-1">{{
                      image.name?.split('.').pop()?.toUpperCase() || 'HEIC'
                    }}</span>
                  </div>
                  <button
                    v-if="!getSavForm(index).filled"
                    :aria-label="`Retirer la photo ${image.name || imageIndex + 1}`"
                    @click="removeImage(index, imageIndex)"
                    class="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center hover:bg-red-600"
                    type="button"
                  >
                    ×
                  </button>
                </div>
              </div>
              <p
                :id="`error-images-${index}`"
                v-if="getSavForm(index).errors.images"
                class="mt-1 text-sm text-red-600"
              >
                {{ getSavForm(index).errors.images }}
              </p>
            </div>

            <div class="flex justify-end space-x-2">
              <button type="submit" class="sav-primary line-action">
                Ajouter à ma demande SAV
              </button>
            </div>
          </form>
        </div>
      </li>
    </ul>
    <p v-if="items.length === 0" class="text-gray-500 text-center py-4">Aucun élément à afficher</p>

    <section
      v-if="hasFilledForms"
      class="mt-8"
      :inert="globalLoading"
      aria-labelledby="summary-title"
    >
      <h2 id="summary-title" class="section-title">Relire ma demande</h2>
      <ul class="space-y-3">
        <li v-for="{ item, form, index } in getFilledForms()" :key="keyAt(index)" class="line-card">
          <h3 class="text-lg text-gray-900">{{ item.label || item.product_name }}</h3>
          <p>
            {{ reasons[form.reason] }} · {{ form.quantity }}
            {{ form.unit === 'piece' ? (form.quantity > 1 ? 'pièces' : 'pièce') : form.unit }}
          </p>
          <p v-if="form.comment">{{ form.comment }}</p>
          <p v-if="form.images.length">
            {{ form.images.map((image) => image.name || image.file?.name).join(', ') }}
          </p>
          <div class="flex flex-wrap gap-4 mt-3">
            <button :id="`edit-${index}`" class="secondary" @click="editItemForm(index)">
              Modifier
            </button>
            <button class="secondary" @click="removeLine(index)">Retirer</button>
          </div>
        </li>
      </ul>
    </section>
    <!-- Action d'envoi finale, persistante pendant le défilement -->
    <div
      v-if="hasFilledForms || hasUnfinishedForms"
      class="sticky bottom-0 z-30 mt-6 rounded-xl border border-orange-200 bg-white p-4 shadow-xl"
      data-test="sav-submit-bar"
    >
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p v-if="filledFormsCount > 0" class="font-semibold text-gray-900">
            {{ filledFormsCount }}
            {{ filledFormsCount === 1 ? 'réclamation ajoutée' : 'réclamations ajoutées' }}
          </p>
          <p v-else class="font-semibold text-gray-900">Réclamation en cours de saisie</p>
          <p v-if="hasUnfinishedForms" class="text-sm text-amber-700" role="alert">
            Finalisez ou annulez la ligne en cours avant l’envoi.
          </p>
          <p v-else class="text-sm text-gray-600">Votre demande n’est pas encore envoyée.</p>
        </div>
        <button
          type="button"
          @click="submitAllForms"
          class="sav-primary line-action disabled:opacity-60"
          :disabled="globalLoading || hasUnfinishedForms || !hasFilledForms"
        >
          <span v-if="globalLoading">Envoi...</span>
          <span v-else>
            Envoyer ma demande SAV ({{ filledFormsCount }}
            {{ filledFormsCount === 1 ? 'réclamation' : 'réclamations' }})
          </span>
        </button>
      </div>
    </div>
  </div>
</template>

<script>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useSavForms } from '../composables/useSavForms.js'
import { useImageUpload } from '../composables/useImageUpload.js'
import { useApiClient } from '../composables/useApiClient.js'
import { buildSavHtmlTable } from '../lib/buildSavHtmlTable.js'
import { buildCaptureItemPrices } from '../lib/buildCaptureItemPrices.js'
import { extractProductCode } from '../lib/extractProductCode.js'

export default {
  name: 'WebhookItemsList',
  props: {
    items: {
      type: Array,
      required: true,
      default: () => [],
    },
    facture: {
      type: Object,
      required: true,
    },
  },
  setup(props, { emit }) {
    const {
      keyAt,
      getSavForm,
      hasFilledForms,
      filledFormsCount,
      hasUnfinishedForms,
      hasDirtyForms,
      toggleSavForm,
      deleteItemForm,
      validateItemForm: validateSavItemForm,
      editItemForm: editSavItemForm,
      getFilledForms,
    } = useSavForms(() => props.items)
    const {
      handleImageUpload: handleImageUploadBase,
      handleDrop: handleDropBase,
      removeImage: removeImageBase,
      maxFileSizeMb,
    } = useImageUpload()
    const {
      uploadToBackend: uploadToBackendApi,
      getFolderShareLink,
      submitSavWebhook,
    } = useApiClient()
    const toastMessage = ref('')

    // États pour les progress bars
    const currentUploadFile = ref('')
    const totalFiles = ref(0)
    const uploadedFiles = ref(0)
    const toastType = ref('success')
    const globalLoading = ref(false)
    const submissionSucceeded = ref(false)
    const hasPendingSubmission = computed(
      () => (filledFormsCount.value > 0 || hasDirtyForms.value) && !submissionSucceeded.value
    )

    watch(filledFormsCount, (count) => {
      if (count > 0) submissionSucceeded.value = false
    })

    const handleBeforeUnload = (event) => {
      if (!hasPendingSubmission.value) return
      event.preventDefault()
      event.returnValue = ''
    }

    const confirmLeave = () => {
      if (!hasPendingSubmission.value) return true
      return window.confirm(
        'Votre demande SAV n’a pas encore été envoyée. Voulez-vous vraiment quitter cette page ?'
      )
    }

    onMounted(() => window.addEventListener('beforeunload', handleBeforeUnload))
    onBeforeUnmount(() => window.removeEventListener('beforeunload', handleBeforeUnload))

    // États pour le modal d'upload
    const uploadModalVisible = ref(false)
    const uploadStatus = ref('uploading') // 'uploading' | 'success' | 'error'
    const uploadErrorMessage = ref('')

    const showToast = (msg, type = 'success') => {
      toastMessage.value = msg
      toastType.value = type
      setTimeout(() => {
        toastMessage.value = ''
      }, 2500)
    }

    const closeUploadModal = () => {
      uploadModalVisible.value = false
      uploadStatus.value = 'uploading'
      uploadErrorMessage.value = ''
    }

    // Bloquer le scroll du body quand le modal est ouvert
    watch(uploadModalVisible, (isVisible) => {
      if (isVisible) {
        // Scroll en haut de la page pour que le modal soit visible
        window.scrollTo({ top: 0, behavior: 'smooth' })
        // Bloquer le scroll
        document.body.style.overflow = 'hidden'
        document.body.style.position = 'fixed'
        document.body.style.width = '100%'
        document.body.style.top = '0'
      } else {
        // Débloquer le scroll
        document.body.style.overflow = ''
        document.body.style.position = ''
        document.body.style.width = ''
        document.body.style.top = ''
      }
    })

    const focusField = async (field, index) => {
      await nextTick()
      document.getElementById(`${field}-${index}`)?.focus()
    }
    const validateItemForm = async (index) => {
      await validateSavItemForm(index, showToast)
      const form = getSavForm(index)
      const field = Object.keys(form.errors).find((key) => form.errors[key])
      await focusField(field || 'edit', index)
    }
    const editItemForm = (index) => {
      if (globalLoading.value) return
      editSavItemForm(index, showToast)
      return focusField('quantity', index)
    }
    const removeLine = (index) => {
      if (globalLoading.value) return
      deleteItemForm(index)
      return focusField('signal', index)
    }
    const unitPrice = (item) => {
      if (String(item.unit_amount ?? item.amount ?? '').trim() === '') return '—'
      const cents = buildCaptureItemPrices(item).unitPriceTtcCents
      return cents == null ? '—' : formatValue('amount', cents / 100)
    }
    const getSpecialMention = () =>
      props.facture?.special_mention || props.facture?.specialMention || ''

    const formatValue = (key, value) => {
      if (key === 'amount') {
        if (value == null || String(value).trim() === '' || !Number.isFinite(Number(value)))
          return '—'
        return new Intl.NumberFormat('fr-FR', {
          style: 'currency',
          currency: 'EUR',
        }).format(value)
      }
      if (key === 'vat_rate') {
        return `${value}%`
      }
      if (key === 'quantity' && typeof value === 'number') {
        return value.toLocaleString('fr-FR')
      }
      return value
    }

    const handleImageUpload = (event, index) => {
      const form = getSavForm(index)
      handleImageUploadBase(event, form, {
        specialMention: getSpecialMention(),
        showToast,
      })
    }

    const handleDrop = (event, index) => {
      const form = getSavForm(index)
      handleDropBase(event, form, {
        specialMention: getSpecialMention(),
        showToast,
      })
    }

    const removeImage = (formIndex, imageIndex) => {
      const form = getSavForm(formIndex)
      removeImageBase(form, imageIndex)
    }

    // Fonction pour uploader des fichiers sur le backend avec progress
    async function uploadToBackend(file, savDossier, isBase64 = false, onProgress = null) {
      try {
        return await uploadToBackendApi(file, savDossier, {
          isBase64,
          onProgress,
        })
      } catch (error) {
        console.error(
          `Erreur lors de l'upload du fichier ${isBase64 ? file.filename : file.name}:`,
          error
        )
        throw error
      }
    }

    const submitAllForms = async () => {
      if (globalLoading.value) return
      globalLoading.value = true

      // Ouvrir le modal immédiatement
      uploadModalVisible.value = true
      uploadStatus.value = 'uploading'
      uploadErrorMessage.value = ''

      try {
        // Vérifier s'il existe des demandes en cours non validées
        if (hasUnfinishedForms.value) {
          uploadStatus.value = 'error'
          uploadErrorMessage.value =
            'Veuillez finaliser ou annuler toutes les demandes en cours avant de valider'
          globalLoading.value = false
          return
        }

        const invoiceLines = [...props.items]
        const filledForms = getFilledForms()

        if (filledForms.length === 0) {
          uploadStatus.value = 'error'
          uploadErrorMessage.value = 'Aucune réclamation validée à soumettre'
          globalLoading.value = false
          return
        }

        // Story 5.7 patch P14 — refuser le submit si le numéro de facture
        // est absent : sans `invoice.ref`, les emails portent un sujet
        // « Demande SAV Facture (facture inconnue) » embarrassant. La
        // facture devrait toujours être présente côté UI (chargement avant
        // d'arriver à l'écran), un manque ici signale un bug amont.
        if (!props.facture?.invoice_number) {
          uploadStatus.value = 'error'
          uploadErrorMessage.value =
            'Numéro de facture manquant — impossible de soumettre la demande'
          globalLoading.value = false
          return
        }

        // Créer un nom de dossier unique pour cette demande de SAV
        const specialMention = props.facture?.special_mention || ''
        const sanitizedSpecialMention =
          specialMention.replace(/[^a-zA-Z0-9_]/g, '_') || 'SANS_MENTION'

        const now = new Date()
        const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`
        const savDossier = `SAV_${sanitizedSpecialMention}_${timestamp}`

        // ÉTAPE 1 : Upload des images via le backend (authentification silencieuse)
        const uploadStartTime = Date.now()

        // Collecter tous les fichiers à uploader
        const allFiles = []
        const fileMapping = new Map()

        for (const { form } of filledForms) {
          if (form.images && form.images.length > 0) {
            for (let imgObj of form.images) {
              if (imgObj.file && (!imgObj.uploadedUrl || !imgObj.itemId)) {
                allFiles.push(imgObj.file)
                fileMapping.set(imgObj.file, imgObj)
              }
            }
          }
        }

        totalFiles.value = allFiles.length
        uploadedFiles.value = 0

        // Upload en parallèle via le backend
        let uploadErrors = []
        const uploadPromises = allFiles.map(async (file) => {
          const imgObj = fileMapping.get(file)
          imgObj.uploadError = false // AC#2 M1 — reset au début de chaque tentative (idempotent retry)
          try {
            currentUploadFile.value = file.name
            // V1.6 AC#9 : uploadToBackend retourne { webUrl, itemId } (pas string)
            const uploadResult = await uploadToBackend(file, savDossier)
            imgObj.uploadedUrl = uploadResult.webUrl
            imgObj.itemId = uploadResult.itemId
            imgObj.uploadError = false // AC#2 M1 — reset explicite sur success (defense-in-depth)
            uploadedFiles.value++
          } catch (e) {
            imgObj.uploadError = true
            uploadErrors.push({ fileName: file.name, error: e.message || 'Erreur inconnue' })
            console.error(`Erreur upload ${file.name}:`, e)
          }
        })

        await Promise.all(uploadPromises)

        // Délai minimum de 1.5 secondes pour que l'utilisateur voie la progress bar
        const uploadDuration = Date.now() - uploadStartTime
        const minDisplayTime = 1500
        if (uploadDuration < minDisplayTime) {
          await new Promise((resolve) => setTimeout(resolve, minDisplayTime - uploadDuration))
        }

        // Vérifier si des uploads ont échoué
        if (uploadErrors.length > 0) {
          uploadStatus.value = 'error'
          const errorDetails = uploadErrors.map((e) => e.fileName).join(', ')
          uploadErrorMessage.value = `Échec de l'upload de ${uploadErrors.length} fichier(s): ${errorDetails}`
          globalLoading.value = false
          return
        }

        // Story 5.7 — htmlTable conservé en metadata (rétrocompat amont
        // builder Vue), le serveur utilise les templates natifs.
        const htmlTable = buildSavHtmlTable(filledForms, invoiceLines)

        // ÉTAPE 3 : Obtenir le lien de partage pour le dossier global
        const folderShareLink = await getFolderShareLink(savDossier)

        // ÉTAPE 4 : Envoi au backend `/api/webhooks/capture` (Story 5.7).
        // Le payload doit matcher `captureWebhookSchema` (cf. AC #4 + AC #7) :
        // { customer, invoice, items, files, metadata }.
        const captureCustomer = {
          email: props.facture?.customer?.emails?.[0] || props.facture?.customer?.email || '',
          ...(props.facture?.customer?.first_name
            ? { firstName: props.facture.customer.first_name }
            : {}),
          ...(props.facture?.customer?.last_name
            ? { lastName: props.facture.customer.last_name }
            : {}),
          ...(props.facture?.customer?.phone ? { phone: props.facture.customer.phone } : {}),
          ...(props.facture?.customer?.name ? { fullName: props.facture.customer.name } : {}),
          // Pennylane v2 : `customer.id` est le numeric internal ID.
          ...(props.facture?.customer?.id !== undefined && props.facture?.customer?.id !== null
            ? { pennylaneCustomerId: String(props.facture.customer.id) }
            : {}),
          ...(props.facture?.customer?.external_reference !== undefined &&
          props.facture?.customer?.external_reference !== null
            ? { externalCustomerId: String(props.facture.customer.external_reference) }
            : {}),
        }
        const captureInvoice = props.facture?.invoice_number
          ? {
              ref: String(props.facture.invoice_number),
              ...(props.facture.special_mention
                ? { specialMention: String(props.facture.special_mention) }
                : {}),
              ...(props.facture.label ? { label: String(props.facture.label) } : {}),
            }
          : undefined
        const captureItems = filledForms.map(({ form, item: factureItem }) => {
          const productName = factureItem.label || factureItem.product_name || 'Article inconnu'
          // Story V1.12 AC#1 — priorité INCHANGÉE :
          //   product_id (Pennylane) > code (Pennylane) > extractProductCode(label) > slice(0,32) (fallback)
          // L'helper applique le pattern catalogue Fruitstock ^([0-9]{3,5}(?:-[A-Z0-9]{1,6})?)\s
          // et garantit un fallback slice(0,32) non-vide quand aucun code n'est détecté.
          const productCode = factureItem.product_id
            ? String(factureItem.product_id)
            : factureItem.code || extractProductCode(productName)
          const item = {
            productCode,
            productName,
            qtyRequested: Number(form.quantity) || 0,
            unit: form.unit || 'piece',
          }
          const cause = [form.reason, form.comment]
            .filter((v) => v && String(v).trim().length > 0)
            .join(' — ')
          if (cause) item.cause = cause

          // Story 4.7 — Inject Pennylane invoice line prices into the capture payload.
          // buildCaptureItemPrices extracts the 5 price fields from the Pennylane line
          // already in component state. See lib/buildCaptureItemPrices.js for the full
          // mapping rationale (unit_amount → unitPriceTtcCents, vat_rate → vatRateBp, etc.)
          Object.assign(item, buildCaptureItemPrices(factureItem))

          return item
        })
        const captureFiles = []
        for (const { form } of filledForms) {
          if (form.images && form.images.length > 0) {
            for (const img of form.images) {
              if (img.uploadedUrl && img.itemId && img.file) {
                captureFiles.push({
                  // V1.6 AC#9 : utilise img.itemId (Graph opaque ID) — jamais URL parsing
                  onedriveItemId: img.itemId,
                  webUrl: img.uploadedUrl,
                  originalFilename: img.file.name,
                  sanitizedFilename: img.file.name,
                  sizeBytes: img.file.size,
                  mimeType: img.file.type || 'application/octet-stream',
                })
              }
            }
          }
        }
        await submitSavWebhook({
          customer: captureCustomer,
          ...(captureInvoice ? { invoice: captureInvoice } : {}),
          items: captureItems,
          files: captureFiles,
          metadata: { dossierSavUrl: folderShareLink, htmlTable },
        })

        filledForms.forEach(({ form }) => {
          form.showForm = false
        })

        // Succès
        submissionSucceeded.value = true
        uploadStatus.value = 'success'
        emit('sav-submitted')
      } catch (error) {
        uploadStatus.value = 'error'
        uploadErrorMessage.value = error.message || "Erreur lors de l'envoi des réclamations"
        console.error("Erreur lors de l'envoi:", error)
      } finally {
        globalLoading.value = false
        currentUploadFile.value = ''
        totalFiles.value = 0
        uploadedFiles.value = 0
      }
    }

    return {
      hasFilledForms,
      filledFormsCount,
      hasUnfinishedForms,
      hasPendingSubmission,
      keyAt,
      getSavForm,
      formatValue,
      unitPrice,
      getFilledForms,
      removeLine,
      reasons: { abime: 'Abîmé', manquant: 'Manquant', autre: 'Autre' },
      currentUploadFile,
      totalFiles,
      uploadedFiles,
      toggleSavForm,
      validateItemForm,
      editItemForm,
      handleImageUpload,
      handleDrop,
      removeImage,
      submitAllForms,
      toastMessage,
      toastType,
      globalLoading,
      submissionSucceeded,
      handleBeforeUnload,
      confirmLeave,
      showToast,
      uploadModalVisible,
      uploadStatus,
      uploadErrorMessage,
      closeUploadModal,
      maxFileSizeMb,
    }
  },
}
</script>

<style scoped>
.section-title {
  @apply mb-4 text-2xl text-gray-900;
}
.line-card {
  @apply rounded-xl border bg-white p-4 sm:p-5;
  overflow-wrap: anywhere;
}
.line-action {
  width: auto;
  margin: 0;
  text-transform: none;
}
.secondary {
  color: #733a09;
  text-decoration: underline;
  min-height: 2.75rem;
  font-weight: 600;
}
.webhook-items :focus-visible {
  outline: 3px solid #80400b;
  outline-offset: 3px;
}
.webhook-items {
  @apply w-full;
}

.btn-main.btn-main--danger {
  background: #fff1df;
}

.btn-main.btn-main--danger:hover {
  background: #ffe2bd;
}

/* Animation pour le toast (existante) */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* Styles pour la zone de drag & drop */
.upload-drop-zone {
  @apply border-2 border-dashed border-gray-300 rounded-lg transition-all duration-200;
  background-color: #fafafa;
}

.upload-drop-zone:hover:not(.upload-drop-zone-disabled) {
  @apply border-blue-400 bg-blue-50;
}

.upload-drop-zone-active {
  @apply border-blue-500 bg-blue-100 scale-105;
  box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.1);
}

.upload-drop-zone-disabled {
  @apply opacity-50 cursor-not-allowed;
  background-color: #f3f4f6;
}
</style>

<style>
/* Styles globaux pour le modal (non scopés car téléporté dans body) */
.upload-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  width: 100vw;
  height: 100vh;
  background: rgba(0, 0, 0, 0.75);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  z-index: 99999;
  overflow: auto;
}

.upload-modal-content {
  background: white;
  border-radius: 1rem;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
  max-width: 28rem;
  width: 100%;
  padding: 2rem;
  transform: translateZ(0);
  position: relative;
  margin: auto;
}

/* Animations pour le modal */
.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity 0.3s ease;
}

.modal-fade-enter-active .upload-modal-content,
.modal-fade-leave-active .upload-modal-content {
  transition: all 0.3s ease;
}

.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
}

.modal-fade-enter-from .upload-modal-content {
  transform: scale(0.9) translateY(-20px);
}

.modal-fade-leave-to .upload-modal-content {
  transform: scale(0.95) translateY(10px);
}

.modal-fade-enter-to .upload-modal-content,
.modal-fade-leave-from .upload-modal-content {
  transform: scale(1) translateY(0);
}

/* Fix pour mobile - garantir que le modal reste au-dessus */
@media (max-width: 640px) {
  .upload-modal-overlay {
    position: fixed !important;
    padding: 0.75rem;
  }

  .upload-modal-content {
    max-height: 90vh;
    overflow-y: auto;
  }
}
</style>
