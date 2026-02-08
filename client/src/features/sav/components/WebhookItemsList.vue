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

    <!-- Encart d'aide process SAV -->
    <div class="mb-4 p-4 bg-blue-50 border-l-4 border-blue-400 text-blue-900 rounded">
      <strong>Comment faire une réclamation&nbsp;?</strong><br />
      Pour chaque produit concerné, cliquez sur <b>«&nbsp;Signaler un problème&nbsp;»</b>,
      remplissez le formulaire puis cliquez sur le bouton
      <b>«&nbsp;Valider la réclamation&nbsp;»</b> pour enregistrer votre demande. Une fois toutes
      vos réclamations saisies et validées, cliquez sur le bouton
      <b>«&nbsp;Valider toutes les réclamations&nbsp;»</b> en bas de la page pour envoyer votre
      demande SAV.
    </div>
    <ul class="space-y-6">
      <li
        v-for="(item, index) in items"
        :key="index"
        class="bg-white p-4 rounded-lg shadow"
      >
        <!-- Nom du produit sur toute la largeur -->
        <h3 class="text-xl mb-4">
          {{ item.label }}
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
            <span class="text-gray-900">{{
              formatValue('amount', item.amount / item.quantity)
            }}</span>
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
            class="btn-main min-w-[200px] text-base"
            :class="{ 'btn-main--danger': getSavForm(index).showForm }"
          >
            {{ getSavForm(index).showForm ? 'Annuler la réclamation' : 'Signaler un problème' }}
          </button>
        </div>

        <!-- Formulaire SAV -->
        <div
          v-if="getSavForm(index).showForm"
          class="mt-4 p-4 bg-gray-50 rounded-2xl"
        >
          <form
            class="space-y-4"
            :class="{ 'opacity-75': getSavForm(index).filled }"
            @submit.prevent="validateItemForm(index)"
          >
            <div class="grid grid-cols-3 gap-4">
              <div>
                <label class="block text-[color:var(--text-dark)] font-semibold text-base">
                  Quantité
                </label>
                <input
                  type="number"
                  step="0.01"
                  v-model="getSavForm(index).quantity"
                  :disabled="getSavForm(index).filled"
                  class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 disabled:bg-gray-100"
                  :class="{ 'border-red-500': getSavForm(index).errors.quantity }"
                  required
                />
                <p v-if="getSavForm(index).errors.quantity" class="mt-1 text-sm text-red-600">
                  {{ getSavForm(index).errors.quantity }}
                </p>
              </div>
              <div>
                <label class="block text-[color:var(--text-dark)] font-semibold text-base">Unité</label>
                <select
                  v-model="getSavForm(index).unit"
                  :disabled="getSavForm(index).filled"
                  class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 disabled:bg-gray-100"
                  :class="{ 'border-red-500': getSavForm(index).errors.unit }"
                  required
                >
                  <option value="">Choisir une unité</option>
                  <option value="piece">Pièce</option>
                  <option value="kg">kg</option>
                  <option value="g">g</option>
                </select>
                <p v-if="getSavForm(index).errors.unit" class="mt-1 text-sm text-red-600">
                  {{ getSavForm(index).errors.unit }}
                </p>
              </div>
              <div>
                <label class="block text-[color:var(--text-dark)] font-semibold text-base">Motif</label>
                <select
                  v-model="getSavForm(index).reason"
                  :disabled="getSavForm(index).filled"
                  class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 disabled:bg-gray-100"
                  :class="{ 'border-red-500': getSavForm(index).errors.reason }"
                  required
                >
                  <option value="">Choisir un motif</option>
                  <option value="abime">Abimé</option>
                  <option value="manquant">Manquant</option>
                  <option value="autre">Autre</option>
                </select>
                <p v-if="getSavForm(index).errors.reason" class="mt-1 text-sm text-red-600">
                  {{ getSavForm(index).errors.reason }}
                </p>
              </div>
            </div>

            <!-- Champ commentaire optionnel -->
            <div class="mt-4">
              <label class="block text-[color:var(--text-dark)] font-semibold text-base">
                Commentaire
                <span class="text-xs text-gray-500">(optionnel)</span>
              </label>
              <textarea
                v-model="getSavForm(index).comment"
                :disabled="getSavForm(index).filled"
                rows="3"
                class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 disabled:bg-gray-100"
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
              <label class="block text-[color:var(--text-dark)] font-semibold text-base mb-2">
                Photos
                <span class="text-xs text-gray-500"
                  >({{ getSavForm(index).reason === 'abime' ? 'obligatoire' : 'optionnel' }} -
                  formats acceptés: JPEG, PNG, GIF, WebP, SVG, HEIC - max 10Mo par image)</span
                >
              </label>

              <!-- Zone de drag & drop visuellement améliorée -->
              <div
                :class="[
                  'upload-drop-zone',
                  { 'upload-drop-zone-active': getSavForm(index).isDragging },
                  { 'upload-drop-zone-disabled': getSavForm(index).filled },
                ]"
                @click="!getSavForm(index).filled && $refs['fileInput' + index][0].click()"
                @dragover.prevent="
                  !getSavForm(index).filled && (getSavForm(index).isDragging = true)
                "
                @dragleave.prevent="getSavForm(index).isDragging = false"
                @drop.prevent="handleDrop($event, index)"
              >
                <input
                  :ref="'fileInput' + index"
                  type="file"
                  multiple
                  accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml,image/heic,image/heif"
                  @change="handleImageUpload($event, index)"
                  :disabled="getSavForm(index).filled"
                  class="hidden"
                />

                <div class="flex flex-col items-center justify-center py-8 px-4">
                  <!-- Icône d'upload -->
                  <svg
                    class="w-12 h-12 mb-3 text-gray-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                    ></path>
                  </svg>

                  <!-- Texte principal -->
                  <p class="mb-2 text-sm text-gray-700">
                    <span class="font-semibold">Cliquez pour sélectionner</span> ou glissez-déposez
                  </p>

                  <!-- Texte secondaire -->
                  <p class="text-xs text-gray-500">JPEG, PNG, GIF, WebP, SVG, HEIC (max 10Mo)</p>
                </div>
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
                    @click="removeImage(index, imageIndex)"
                    class="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center hover:bg-red-600"
                    type="button"
                  >
                    ×
                  </button>
                </div>
              </div>
              <p v-if="getSavForm(index).errors.images" class="mt-1 text-sm text-red-600">
                {{ getSavForm(index).errors.images }}
              </p>
            </div>

            <div class="flex justify-end space-x-2">
              <template v-if="!getSavForm(index).filled">
                <button
                  type="button"
                  @click="validateItemForm(index)"
                  class="px-4 py-2 text-sm font-medium text-white bg-orange-600 rounded-md hover:bg-orange-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-orange-500"
                  :disabled="getSavForm(index).loading"
                >
                  <span v-if="getSavForm(index).loading">Envoi...</span>
                  <span v-else>Valider la réclamation</span>
                </button>
              </template>
              <template v-else>
                <button
                  type="button"
                  @click="editItemForm(index)"
                  class="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                >
                  Modifier la réclamation
                </button>
              </template>
            </div>
          </form>
        </div>
      </li>
    </ul>
    <p v-if="items.length === 0" class="text-gray-500 text-center py-4">Aucun élément à afficher</p>

    <!-- Bouton de validation global -->
    <div v-if="hasUnfinishedForms" class="mt-4 p-4 bg-yellow-50 border-l-4 border-yellow-400">
      <p class="text-sm text-yellow-700">
        Veuillez finaliser ou annuler toutes les demandes en cours avant de valider l'ensemble des
        demandes.
      </p>
    </div>
    <div v-if="hasFilledForms" class="mt-6 flex justify-center">
      <button
        @click="submitAllForms"
        class="px-6 py-3 text-base font-medium text-white bg-green-600 rounded-md hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500"
        :disabled="globalLoading"
      >
        <span v-if="globalLoading">Envoi...</span>
        <span v-else>Valider toutes les réclamations</span>
      </button>
    </div>
  </div>
</template>

<script>
import { ref, watch } from 'vue'
import { useSavForms } from '../composables/useSavForms.js'
import { useImageUpload } from '../composables/useImageUpload.js'
import { useApiClient } from '../composables/useApiClient.js'
import { useExcelGenerator } from '../composables/useExcelGenerator.js'
import { buildSavHtmlTable } from '../lib/buildSavHtmlTable.js'

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
      getSavForm,
      hasFilledForms,
      hasUnfinishedForms,
      toggleSavForm,
      validateItemForm: validateSavItemForm,
      editItemForm: editSavItemForm,
      getFilledForms,
    } = useSavForms()
    const {
      handleImageUpload: handleImageUploadBase,
      handleDrop: handleDropBase,
      removeImage: removeImageBase,
    } = useImageUpload()
    const { uploadToBackend: uploadToBackendApi, getFolderShareLink, submitSavWebhook } =
      useApiClient()
    const { generateExcelFile } = useExcelGenerator()
    const toastMessage = ref('')

    // États pour les progress bars
    const currentUploadFile = ref('')
    const totalFiles = ref(0)
    const uploadedFiles = ref(0)
    const toastType = ref('success')
    const globalLoading = ref(false)

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

    const validateItemForm = (index) => validateSavItemForm(index, showToast)
    const editItemForm = (index) => editSavItemForm(index, showToast)
    const getSpecialMention = () =>
      props.facture?.special_mention || props.facture?.specialMention || ''

    const formatValue = (key, value) => {
      if (key === 'amount') {
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

        const filledForms = getFilledForms()

        if (filledForms.length === 0) {
          uploadStatus.value = 'error'
          uploadErrorMessage.value = 'Aucune réclamation validée à soumettre'
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
              if (imgObj.file && !imgObj.uploadedUrl) {
                allFiles.push(imgObj.file)
                fileMapping.set(imgObj.file, imgObj)
              }
            }
          }
        }

        totalFiles.value = allFiles.length + 1 // +1 pour le fichier Excel
        uploadedFiles.value = 0

        // Upload en parallèle via le backend
        let uploadErrors = []
        const uploadPromises = allFiles.map(async (file) => {
          const imgObj = fileMapping.get(file)
          try {
            currentUploadFile.value = file.name
            const uploadedUrl = await uploadToBackend(file, savDossier)
            imgObj.uploadedUrl = uploadedUrl
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

        // Générer le tableau HTML pour Make.com
        const htmlTable = buildSavHtmlTable(filledForms, props.items)

        // ÉTAPE 2 : Préparer les payloads pour le webhook
        const payload = filledForms.map(({ form, index }) => {
          const images =
            form.images && form.images.length > 0
              ? form.images.map((img) => ({
                  url: img.uploadedUrl || '',
                  fileName: img.file ? img.file.name : '',
                }))
              : []
          const factureItem = props.items[index] || {}
          return {
            ...form,
            images: images,
            itemIndex: index,
            factureInfo: {
              label: factureItem.label,
              quantityFacturee: factureItem.quantity,
              unit: factureItem.unit,
              vat_rate: factureItem.vat_rate,
              prixUnitaire:
                factureItem.amount && factureItem.quantity
                  ? factureItem.amount / factureItem.quantity
                  : undefined,
              prixTotal: factureItem.amount,
            },
          }
        })

        // ÉTAPE 3 : Upload du fichier Excel via le backend
        const excelBase64 = generateExcelFile(filledForms, props.items, props.facture)
        const excelFile = {
          content: excelBase64,
          filename: `${sanitizedSpecialMention}_${timestamp}.xlsx`,
        }

        currentUploadFile.value = excelFile.filename
        await uploadToBackend(excelFile, savDossier, true)
        uploadedFiles.value++

        // ÉTAPE 4 : Obtenir le lien de partage pour le dossier global
        const folderShareLink = await getFolderShareLink(savDossier)

        // ÉTAPE 5 : Envoi au webhook avec le lien du dossier
        await submitSavWebhook({
          htmlTable,
          forms: payload,
          facture: props.facture,
          dossier_sav_url: folderShareLink,
        })

        filledForms.forEach(({ form }) => {
          form.showForm = false
        })

        // Succès
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
      hasUnfinishedForms,
      getSavForm,
      formatValue,
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
      showToast,
      uploadModalVisible,
      uploadStatus,
      uploadErrorMessage,
      closeUploadModal,
    }
  },
}
</script>

<style scoped>
.webhook-items {
  @apply w-full;
}

.btn-main.btn-main--danger {
  background: #e23a3a;
}

.btn-main.btn-main--danger:hover {
  background: #c53030;
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
  @apply border-2 border-dashed border-gray-300 rounded-lg cursor-pointer transition-all duration-200;
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
