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
                  <option v-for="unit in claimUnits" :key="unit.value" :value="unit.value">
                    {{ unit.label }}
                  </option>
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
      v-if="hasFilledForms || hasUnfinishedForms"
      class="mt-8"
      aria-labelledby="summary-title"
    >
      <h2 id="summary-title" class="section-title">Relire ma demande</h2>
      <ul v-if="hasFilledForms" class="space-y-3" :inert="globalLoading">
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
      <!-- Action finale du récapitulatif -->
      <div
        class="mt-4 rounded-xl border border-orange-200 bg-white p-4"
        data-test="sav-submit-bar"
      >
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div
              v-if="globalLoading"
              role="status"
              class="border-l-4 border-[var(--main-orange)] pl-3"
            >
              <strong>Envoi en cours…</strong>
              <p>
                <template v-if="totalFiles > uploadedFiles">Téléversement des photos…</template>
                <template v-else-if="uploadStatus === 'capturing'"
                  >En attente de la réception du dossier…</template
                >
                <template v-else>Préparation de la demande…</template>
              </p>
              <progress
                v-if="totalFiles > uploadedFiles"
                aria-label="Photos téléversées"
                :value="uploadedFiles"
                :max="totalFiles"
              />
            </div>
            <div
              v-else-if="uploadStatus === 'error'"
              role="alert"
              class="rounded-lg bg-red-50 p-3 text-red-900"
            >
              <strong>Envoi interrompu</strong>
              <p v-if="uploadErrorMessage">{{ uploadErrorMessage }}</p>
              <p>
                La réception de votre demande n’a pas été confirmée. Vos articles sont conservés. Vous
                pouvez les modifier ou réessayer.
              </p>
            </div>
            <p v-else-if="filledFormsCount > 0" class="font-semibold text-gray-900">
              {{ filledFormsCount }}
              {{ filledFormsCount === 1 ? 'réclamation ajoutée' : 'réclamations ajoutées' }}
            </p>
            <p v-else class="font-semibold text-gray-900">Réclamation en cours de saisie</p>
            <p v-if="hasUnfinishedForms" class="text-sm text-amber-700" role="alert">
              Finalisez ou annulez la ligne en cours avant l’envoi.
            </p>
            <p
              v-else-if="!globalLoading && uploadStatus !== 'error' && !submissionSucceeded"
              class="text-sm text-gray-600"
            >
              Votre demande n’est pas encore envoyée.
            </p>
          </div>
          <button
            type="button"
            ref="submitButton"
            @click="submitAllForms"
            class="sav-primary line-action disabled:opacity-60"
            :disabled="submissionSucceeded || globalLoading || hasUnfinishedForms || !hasFilledForms"
          >
            <span v-if="globalLoading">Envoi...</span>
            <span v-else-if="uploadStatus === 'error'">Réessayer l’envoi</span>
            <span v-else>
              Envoyer ma demande SAV ({{ filledFormsCount }}
              {{ filledFormsCount === 1 ? 'réclamation' : 'réclamations' }})
            </span>
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<script>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { claimUnits, useSavForms } from '../composables/useSavForms.js'
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

    const submitButton = ref(null)
    const uploadStatus = ref('idle')
    const uploadErrorMessage = ref('')

    watch(uploadStatus, async (status) => {
      if (status === 'error') {
        await nextTick()
        submitButton.value?.focus()
      }
    })

    const showToast = (msg, type = 'success') => {
      toastMessage.value = msg
      toastType.value = type
      setTimeout(() => {
        toastMessage.value = ''
      }, 2500)
    }

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

    let submissionFolder
    const folderFiles = new Set()
    watch([hasFilledForms, hasUnfinishedForms], ([filled, unfinished]) => {
      if (!filled && !unfinished && !globalLoading.value && !submissionSucceeded.value) {
        uploadStatus.value = 'idle'
        uploadErrorMessage.value = ''
        submissionFolder = undefined
        folderFiles.clear()
      }
    })
    const submitAllForms = async () => {
      if (globalLoading.value || submissionSucceeded.value) return
      globalLoading.value = true

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

        // Conserver les photos téléversées tant que le dossier partagé correspond au panier.
        const images = filledForms.flatMap(({ form }) => form.images)
        const selectedFiles = new Set(images.map((image) => image.file))
        const photoRemoved = [...folderFiles].some((file) => !selectedFiles.has(file))
        if (!submissionFolder || photoRemoved) {
          const mention =
            props.facture?.special_mention?.replace(/[^a-zA-Z0-9_]/g, '_') || 'SANS_MENTION'
          const date = new Date()
          const stamp =
            date.toLocaleDateString('sv-SE') +
            '_' +
            date.toTimeString().slice(0, 8).replaceAll(':', '-')
          submissionFolder = `SAV_${mention}_${stamp}_${crypto.randomUUID().slice(0, 8)}`
          if (photoRemoved) {
            for (const image of images) {
              image.uploadedUrl = ''
              image.itemId = ''
            }
          }
          folderFiles.clear()
        }
        const savDossier = submissionFolder

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
            // V1.6 AC#9 : uploadToBackend retourne { webUrl, itemId } (pas string)
            const uploadResult = await uploadToBackend(file, savDossier)
            folderFiles.add(file)
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
        uploadStatus.value = 'capturing'
        const receipt = await submitSavWebhook({
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
        emit('sav-submitted', receipt?.data?.reference)
      } catch (error) {
        uploadStatus.value = 'error'
        uploadErrorMessage.value = error.response?.status
          ? `Le service a renvoyé une erreur (HTTP ${error.response.status}).`
          : 'Le service n’a pas confirmé la réception.'
        console.error("Erreur lors de l'envoi:", error)
      } finally {
        globalLoading.value = false
        totalFiles.value = 0
        uploadedFiles.value = 0
      }
    }

    return {
      claimUnits,
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
      totalFiles,
      uploadedFiles,
      toggleSavForm,
      validateItemForm,
      editItemForm,
      handleImageUpload,
      handleDrop,
      removeImage,
      submitButton,
      submitAllForms,
      toastMessage,
      toastType,
      globalLoading,
      submissionSucceeded,
      handleBeforeUnload,
      confirmLeave,
      showToast,
      uploadStatus,
      uploadErrorMessage,
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
