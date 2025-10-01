<template>
  <div class="webhook-items">
    <!-- Snackbar notification bottom-right -->
    <transition name="fade">
      <div v-if="toastMessage" :class="['fixed right-6 bottom-6 z-50 flex items-center gap-3 px-5 py-3 rounded shadow-lg min-w-[240px]',
        toastType === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white']">
        <span v-if="toastType === 'success'" class="inline-block"><svg xmlns='http://www.w3.org/2000/svg' class='h-6 w-6' fill='none' viewBox='0 0 24 24' stroke='currentColor'><path stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M5 13l4 4L19 7' /></svg></span>
        <span v-else class="inline-block"><svg xmlns='http://www.w3.org/2000/svg' class='h-6 w-6' fill='none' viewBox='0 0 24 24' stroke='currentColor'><path stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M12 8v4m0 4h.01M21 12A9 9 0 11 3 12a9 9 0 0118 0z' /></svg></span>
        <span>{{ toastMessage }}</span>
      </div>
    </transition>
    <!-- Progress bar pour les uploads (AMÉLIORÉ - Plus visible) -->
    <transition name="fade">
      <div v-if="isUploading" class="mb-6 p-6 bg-gradient-to-r from-blue-50 to-indigo-50 border-2 border-blue-300 rounded-xl shadow-lg">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2">
            <svg class="animate-spin h-5 w-5 text-blue-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <span class="text-base font-bold text-blue-800">📤 Upload en cours...</span>
          </div>
          <span class="text-base font-bold text-blue-700 bg-white px-3 py-1 rounded-full">{{ uploadedFiles }}/{{ totalFiles }} fichiers</span>
        </div>
        <div class="w-full bg-gray-300 rounded-full h-4 mb-3 overflow-hidden shadow-inner">
          <div class="bg-gradient-to-r from-blue-500 to-indigo-600 h-4 rounded-full transition-all duration-500 ease-out flex items-center justify-end pr-2" 
               :style="{ width: (uploadedFiles / totalFiles * 100) + '%' }">
            <span v-if="uploadedFiles > 0" class="text-xs font-bold text-white">{{ Math.round(uploadedFiles / totalFiles * 100) }}%</span>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-sm font-medium text-gray-700">📁 Fichier actuel:</span>
          <p class="text-sm text-gray-900 font-semibold truncate flex-1">{{ currentUploadFile }}</p>
        </div>
      </div>
    </transition>
    
    <!-- Encart d'aide process SAV -->
    <div class="mb-4 p-4 bg-blue-50 border-l-4 border-blue-400 text-blue-900 rounded">
      <strong>Comment faire une réclamation&nbsp;?</strong><br>
      Pour chaque produit concerné, cliquez sur <b>«&nbsp;Signaler un problème&nbsp;»</b>, remplissez le formulaire puis cliquez sur le bouton <b>«&nbsp;Valider la réclamation&nbsp;»</b> pour enregistrer votre demande. Une fois toutes vos réclamations saisies et validées, cliquez sur le bouton <b>«&nbsp;Valider toutes les réclamations&nbsp;»</b> en bas de la page pour envoyer votre demande SAV.
    </div>
    <ul class="space-y-6">
      <li v-for="(item, index) in items" :key="index" class="bg-white p-4 rounded-lg shadow" style="font-family:var(--font-main);margin-bottom:1.5em;">
        <!-- Nom du produit sur toute la largeur -->
        <h3 style="font-size:1.2em;font-family:var(--font-main);color:var(--main-orange);font-weight:700;margin-bottom:1em;">{{ item.label }}</h3>
        
        <!-- Autres propriétés alignées sur une ligne -->
        <div class="grid grid-cols-5 gap-4">
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
            <span class="text-gray-900">{{ formatValue('amount', item.amount / item.quantity) }}</span>
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
            class="btn-main"
            :style="getSavForm(index).showForm ? 'background:#e23a3a;' : ''"
            style="margin-top:1em;font-size:1em;min-width:200px;">
            {{ getSavForm(index).showForm ? 'Annuler la réclamation' : 'Signaler un problème' }}
          </button>
        </div>

        <!-- Formulaire SAV -->
        <div v-if="getSavForm(index).showForm" class="mt-4 p-4" style="background:#f6f6f6;border-radius:16px;">
          <form class="space-y-4" :class="{ 'opacity-75': getSavForm(index).filled }" @submit.prevent="validateItemForm(index)">
            <div class="grid grid-cols-3 gap-4">
              <div>
                <label style="font-family:var(--font-main);color:var(--text-dark);font-weight:600;font-size:1em;">Quantité</label>
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
                <label style="font-family:var(--font-main);color:var(--text-dark);font-weight:600;font-size:1em;">Unité</label>
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
                <label style="font-family:var(--font-main);color:var(--text-dark);font-weight:600;font-size:1em;">Motif</label>
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
              <label style="font-family:var(--font-main);color:var(--text-dark);font-weight:600;font-size:1em;">
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

            <!-- Champ d'upload d'images pour le motif "abimé" -->
            <div v-if="getSavForm(index).reason === 'abime'" class="mt-4">
              <label style="font-family:var(--font-main);color:var(--text-dark);font-weight:600;font-size:1em;margin-bottom:0.5em;">
                Photos du produit abimé
                <span class="text-xs text-gray-500">(formats acceptés: jpg, png - max 5Mo par image)</span>
              </label>
              <input
                type="file"
                multiple
                accept="image/jpeg,image/png"
                @change="handleImageUpload($event, index)"
                :disabled="getSavForm(index).filled"
                class="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
              />
              <!-- Prévisualisation des images -->
              <div v-if="getSavForm(index).images && getSavForm(index).images.length > 0" 
                   class="mt-4 grid grid-cols-3 gap-4">
                <div v-for="(image, imageIndex) in getSavForm(index).images" 
                     :key="imageIndex" 
                     class="relative">
                  <img :src="image.preview" 
                       loading="lazy"
                       class="h-24 w-24 object-cover rounded-lg" 
                       alt="Aperçu" />
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
    <p v-if="items.length === 0" class="text-gray-500 text-center py-4">
      Aucun élément à afficher
    </p>
    
    <!-- Bouton de validation global -->
    <div v-if="hasUnfinishedForms" class="mt-4 p-4 bg-yellow-50 border-l-4 border-yellow-400">
      <p class="text-sm text-yellow-700">
        Veuillez finaliser ou annuler toutes les demandes en cours avant de valider l'ensemble des demandes.
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
import { ref, reactive, computed, onMounted } from 'vue';
import axios from 'axios';
import { supabase } from '../lib/supabase';
import * as XLSX from 'xlsx';

export default {
  name: 'WebhookItemsList',
  props: {
    items: {
      type: Array,
      required: true,
      default: () => []
    },
    facture: {
      type: Object,
      required: true
    }
  },
  setup(props, { emit }) {
    const savForms = ref({});
    const toastMessage = ref('');
    
    // États pour les progress bars
    const uploadProgress = ref({});
    const currentUploadFile = ref('');
    const totalFiles = ref(0);
    const uploadedFiles = ref(0);
    const isUploading = ref(false);
    const toastType = ref('success');
    const globalLoading = ref(false);

    const showToast = (msg, type = 'success') => {
      toastMessage.value = msg;
      toastType.value = type;
      setTimeout(() => {
        toastMessage.value = '';
      }, 2500);
    };

    const hasFilledForms = computed(() => {
      return Object.values(savForms.value).some(form => form.filled && form.showForm);
    });

    const hasUnfinishedForms = computed(() => {
      return Object.values(savForms.value).some(form => form.showForm && !form.filled);
    });

    const getSavForm = (index) => {
      if (!savForms.value[index]) {
        savForms.value[index] = {
          showForm: false,
          filled: false,
          quantity: '',
          unit: '',
          reason: '',
          comment: '',
          images: [],
          errors: {
            quantity: '',
            unit: '',
            reason: '',
            images: ''
          }
        };
      }
      return savForms.value[index];
    };

    const formatKey = (key) => {
      const keyMap = {
        quantity: 'Quantité',
        unit: 'Unité',
        vat_rate: 'TVA',
        amount: 'Montant'
      };
      return keyMap[key] || key;
    };

    const filteredItemProperties = (item) => {
      const { label, ...properties } = item;
      return Object.entries(properties).filter(([key]) => 
        ['quantity', 'unit', 'vat_rate', 'amount'].includes(key)
      );
    };

    const formatValue = (key, value) => {
      if (key === 'amount') {
        return new Intl.NumberFormat('fr-FR', {
          style: 'currency',
          currency: 'EUR'
        }).format(value);
      }
      if (key === 'vat_rate') {
        return `${value}%`;
      }
      if (key === 'quantity' && typeof value === 'number') {
        return value.toLocaleString('fr-FR');
      }
      return value;
    };

    const validateForm = (form) => {
      form.errors = {
        quantity: '',
        unit: '',
        reason: '',
        images: ''
      };
      
      let isValid = true;
      
      // Validation de la quantité
      if (!form.quantity) {
        form.errors.quantity = 'La quantité est requise';
        isValid = false;
      } else if (form.quantity <= 0) {
        form.errors.quantity = 'La quantité doit être supérieure à 0';
        isValid = false;
      }
      
      // Validation de l'unité
      if (!form.unit) {
        form.errors.unit = 'Veuillez sélectionner une unité';
        isValid = false;
      }
      
      // Validation du motif
      if (!form.reason) {
        form.errors.reason = 'Veuillez sélectionner un motif';
        isValid = false;
      }
      
      // Validation des images pour le motif "abimé"
      if (form.reason === 'abime' && (!form.images || form.images.length === 0)) {
        form.errors.images = 'Veuillez ajouter au moins une photo du produit abimé';
        isValid = false;
      }
      
      return isValid;
    };

    const toggleSavForm = (index) => {
      const savForm = getSavForm(index);
      if (!savForm.submitted) {
        if (savForm.showForm) {
          // Si on ferme le formulaire, on le réinitialise
          deleteItemForm(index);
        } else {
          // Si on ouvre le formulaire
          savForm.showForm = true;
        }
      }
    };

    const validateItemForm = async (index) => {
      const form = savForms.value[index];
      if (form.loading) return;
      form.loading = true;
      try {
        // Vérification des champs requis
        if (!form.quantity || !form.reason) {
          showToast('Veuillez remplir tous les champs requis', 'error');
          return;
        }
        if (form.reason === 'abime' && (!form.images || form.images.length === 0)) {
          showToast('Veuillez ajouter au moins une photo du produit abîmé', 'error');
          return;
        }
        // Marquer le formulaire comme rempli et le griser
        form.filled = true;
        form.showForm = true;  // Garder le formulaire visible mais grisé
        showToast('Réclamation enregistrée pour cette ligne', 'success');
      } finally {
        form.loading = false;
      }
    };

    const editItemForm = (index) => {
      const savForm = getSavForm(index);
      savForm.filled = false;
      showToast('Réclamation modifiable à nouveau', 'success');
    };

    const deleteItemForm = (index) => {
      const savForm = getSavForm(index);
      savForm.showForm = false;
      savForm.filled = false;
      savForm.quantity = '';
      savForm.unit = '';
      savForm.reason = '';
      savForm.comment = '';
      savForm.images = [];
      savForm.errors = {
        quantity: '',
        unit: '',
        reason: '',
        images: ''
      };
    };

    // Fonction utilitaire pour renommer le fichier avec la mention spéciale
    function renameFileWithSpecialMention(file, specialMention) {
      const ext = file.name.split('.').pop();
      const baseName = file.name.substring(0, file.name.lastIndexOf('.'));
      const newName = `${specialMention}_${baseName}.${ext}`;
      return new File([file], newName, { type: file.type });
    }

    const handleImageUpload = (event, index) => {
      const files = Array.from(event.target.files);
      const form = getSavForm(index);
      form.errors.images = '';

      // Récupérer la mention spéciale depuis la prop facture
      const specialMention = props.facture?.specialMention || '';

      // Vérification des fichiers
      const invalidFiles = files.filter(file => {
        const isValidType = ['image/jpeg', 'image/png'].includes(file.type);
        const isValidSize = file.size <= 5 * 1024 * 1024; // 5Mo
        return !isValidType || !isValidSize;
      });

      if (invalidFiles.length > 0) {
        form.errors.images = 'Certains fichiers ne sont pas valides (format jpg/png et taille max 5Mo)';
        return;
      }

      // Création des previews avec renommage
      files.forEach(file => {
        const renamedFile = specialMention
          ? renameFileWithSpecialMention(file, specialMention)
          : file;
        const reader = new FileReader();
        reader.onload = (e) => {
          form.images.push({
            file: renamedFile,
            preview: e.target.result
          });
        };
        reader.readAsDataURL(renamedFile);
      });
    };

    const removeImage = (formIndex, imageIndex) => {
      const form = getSavForm(formIndex);
      form.images.splice(imageIndex, 1);
    };

    // Fonction pour uploader des fichiers sur le backend avec progress
    async function uploadToBackend(file, savDossier, isBase64 = false, onProgress = null) {
      const formData = new FormData();
      if (isBase64) {
        // Convertir le base64 en Blob pour les fichiers Excel
        const byteCharacters = atob(file.content);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        formData.append('file', blob, file.filename);
      } else {
        // Pour les images et autres fichiers
        formData.append('file', file);
      }

      // Ajouter le nom du dossier SAV au formulaire
      if (savDossier) {
        formData.append('savDossier', savDossier);
      }
      
      try {
        const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000';
        const apiKey = import.meta.env.VITE_API_KEY;
        
        const headers = { 'Content-Type': 'multipart/form-data' };
        if (apiKey) {
          headers['X-API-Key'] = apiKey;
        }
        
        const config = { 
          headers,
          onUploadProgress: (progressEvent) => {
            if (onProgress && progressEvent.total) {
              const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
              onProgress(percentCompleted);
            }
          }
        };
        
        const response = await axios.post(`${apiUrl}/api/upload-onedrive`, formData, config);
        
        if (response.data && response.data.success) {
          return response.data.file.url; // Retourne l'URL directe du fichier
        } else {
          throw new Error(response.data.error || 'Upload failed');
        }
      } catch (error) {
        console.error(`Erreur lors de l'upload du fichier ${isBase64 ? file.filename : file.name}:`, error);
        throw error;
      }
    }

    // Fonction pour séparer le code article du nom du produit
    function splitProductLabel(label) {
      if (!label) return { code: '', name: '' };
      
      // Recherche le premier espace qui sépare le code du nom
      const firstSpaceIndex = label.indexOf(' ');
      if (firstSpaceIndex === -1) return { code: label, name: '' };
      
      // Le code est tout ce qui est avant le premier espace
      const code = label.substring(0, firstSpaceIndex);
      // Le nom est tout ce qui est après le premier espace
      const name = label.substring(firstSpaceIndex + 1);
      
      return { code, name };
    }

    // Générer le fichier Excel
    function generateExcelFile(forms, items) {
      const wb = XLSX.utils.book_new();

      const formatAddress = (addr) => {
        if (!addr || (!addr.address && !addr.city)) return 'N/A';
        const parts = [addr.address, addr.postal_code, addr.city, addr.country_alpha2].filter(Boolean);
        return parts.join(', ');
      };

      // --- Onglet 1: Réclamations SAV ---
      const headers = [
        'PRENOM NOM',
        'DESIGNATION',
        'QTE',
        'UNITE',
        'CAUSE',
        'AVOIR %',
        'COMMENTAIRE',
        'CODE ARTICLE',
        'PRIX UNIT'
      ];

      const savData = forms.map(({ form, index }) => {
        const item = items[index] || {};
        const { code, name } = splitProductLabel(item.label);
        const unitPrice = (item.amount && item.quantity) ? (item.amount / item.quantity) : undefined;
        return {
          'PRENOM NOM': props.facture.customer?.name || '',
          'DESIGNATION': name,
          'QTE': form.quantity || '',
          'UNITE': form.unit || '',
          'CAUSE': form.reason === 'abime' ? 'ABIME' :
                   form.reason === 'casse' ? 'CASSE' :
                   form.reason === 'manquant' ? 'MANQUANT' :
                   form.reason === 'erreur' ? 'ERREUR DE PREPARATION' : '',
          'AVOIR %': form.creditPercentage || '',
          'COMMENTAIRE': form.comment || '',
          'CODE ARTICLE': code,
          'PRIX UNIT': unitPrice
        };
      });

      const wsSav = XLSX.utils.json_to_sheet(savData, { header: headers });
      wsSav['!cols'] = [
        { wch: 25 }, // PRENOM NOM
        { wch: 50 }, // DESIGNATION
        { wch: 10 }, // QTE
        { wch: 10 }, // UNITE
        { wch: 20 }, // CAUSE
        { wch: 10 }, // AVOIR %
        { wch: 50 }, // COMMENTAIRE
        { wch: 15 }, // CODE ARTICLE
        { wch: 15 }  // PRIX UNIT
      ];
      XLSX.utils.book_append_sheet(wb, wsSav, 'Réclamations SAV');

      // --- Onglet 2: Informations Client ---
      const specialMention = props.facture.special_mention || '';
      let orderNumber = '';
      if (specialMention) {
        const lastIndex = specialMention.lastIndexOf('_');
        if (lastIndex !== -1) {
          orderNumber = specialMention.substring(0, lastIndex);
        } else {
          orderNumber = specialMention;
        }
      }

      const customerData = [
        { 'Propriété': 'ID Client', 'Valeur': props.facture.customer?.source_id || 'N/A' },
        { 'Propriété': 'Nom du client', 'Valeur': props.facture.customer?.name || 'N/A' },
        { 'Propriété': 'Email du client', 'Valeur': props.facture.customer?.emails?.[0] || 'N/A' },
        { 'Propriété': 'Téléphone du client', 'Valeur': props.facture.customer?.phone || 'N/A' },
        { 'Propriété': 'Adresse de livraison', 'Valeur': formatAddress(props.facture.customer?.delivery_address) },
        { 'Propriété': 'Adresse de facturation', 'Valeur': formatAddress(props.facture.customer?.billing_address) },
        { 'Propriété': 'Numéro de facture', 'Valeur': props.facture.invoice_number || 'N/A' },
        { 'Propriété': 'Date de facture', 'Valeur': props.facture.date || 'N/A' },
        { 'Propriété': 'Mention spéciale', 'Valeur': specialMention },
        { 'Propriété': 'Numéro de commande', 'Valeur': orderNumber },
      ];
      const wsCustomer = XLSX.utils.json_to_sheet(customerData, { skipHeader: true });
      wsCustomer['!cols'] = [{ wch: 30 }, { wch: 50 }];
      XLSX.utils.book_append_sheet(wb, wsCustomer, 'Infos Client');
      
      // Convertir en base64
      const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
      return excelBuffer;
    }

    // Générer le tableau HTML pour Make.com
    function buildSavHtmlTable(forms, items) {
      let html = `<table border="1" cellpadding="5" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          <th>Désignation</th>
          <th>Quantité demandée</th>
          <th>Quantité facturée</th>
          <th>Unité demandée</th>
          <th>Unité facturée</th>
          <th>Motif</th>
          <th>Commentaire</th>
          <th>Prix Unitaire</th>
          <th>Prix Total</th>
          <th>Images</th>
        </tr>`;
      forms.forEach(({ form, index }) => {
        const item = items[index] || {};
        const images = (form.images || [])
          .map(img => img.uploadedUrl ? `<a href="${img.uploadedUrl}">${img.file ? img.file.name : ''}</a>` : '')
          .join('<br>');
        html += `<tr>
          <td>${item.label || ''}</td>
          <td>${form.quantity || ''}</td>
          <td>${item.quantity || ''}</td>
          <td>${form.unit || ''}</td>
          <td>${item.unit || ''}</td>
          <td>${form.reason || ''}</td>
          <td>${form.comment || ''}</td>
          <td>${item.amount && item.quantity ? (item.amount / item.quantity).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' }) : ''}</td>
          <td>${item.amount ? item.amount.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' }) : ''}</td>
          <td>${images}</td>
        </tr>`;
      });
      html += `</table>`;
      return html;
    }

    const submitAllForms = async () => {
      if (globalLoading.value) return;
      globalLoading.value = true;
      try {
        // Vérifier s'il existe des demandes en cours non validées
        if (hasUnfinishedForms.value) {
          showToast('Veuillez finaliser ou annuler toutes les demandes en cours avant de valider', 'error');
          globalLoading.value = false;
          return;
        }

        const filledForms = Object.entries(savForms.value)
          .filter(([_, form]) => form.filled && form.showForm)
          .map(([index, form]) => ({ form, index: parseInt(index) }));
        
        if (filledForms.length === 0) {
          showToast('Aucune réclamation validée à soumettre', 'error');
          globalLoading.value = false;
          return;
        }

        // Créer un nom de dossier unique pour cette demande de SAV
        const specialMention = props.facture?.special_mention || '';
        const sanitizedSpecialMention = specialMention.replace(/[^a-zA-Z0-9_]/g, '_') || 'SANS_MENTION';

        const now = new Date();
        const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`;
        const savDossier = `SAV_${sanitizedSpecialMention}_${timestamp}`;

        // Étape 1 : Upload des images sur le backend (en parallèle)
        isUploading.value = true;
        const uploadStartTime = Date.now(); // Pour délai minimum
        
        // Collecter tous les fichiers à uploader
        const allFiles = [];
        const fileMapping = new Map(); // Pour retrouver quel imgObj correspond à quel fichier
        
        for (const { form } of filledForms) {
          if (form.images && form.images.length > 0) {
            for (let imgObj of form.images) {
              if (imgObj.file && !imgObj.uploadedUrl) {
                allFiles.push(imgObj.file);
                fileMapping.set(imgObj.file, imgObj);
              }
            }
          }
        }
        
        totalFiles.value = allFiles.length + 1; // +1 pour le fichier Excel
        uploadedFiles.value = 0;
        
        // Upload en parallèle avec progress et gestion d'erreur
        let uploadErrors = [];
        const uploadPromises = allFiles.map(async (file) => {
          const imgObj = fileMapping.get(file);
          try {
            currentUploadFile.value = file.name;
            const uploadedUrl = await uploadToBackend(file, savDossier, false, (progress) => {
              uploadProgress.value[file.name] = progress;
            });
            imgObj.uploadedUrl = uploadedUrl;
            uploadedFiles.value++;
          } catch (e) {
            imgObj.uploadError = true;
            uploadErrors.push({ fileName: file.name, error: e.message || 'Erreur inconnue' });
            console.error(`Erreur upload ${file.name}:`, e);
          }
        });
        
        await Promise.all(uploadPromises);
        
        // Délai minimum de 1.5 secondes pour que l'utilisateur voie la progress bar
        const uploadDuration = Date.now() - uploadStartTime;
        const minDisplayTime = 1500;
        if (uploadDuration < minDisplayTime) {
          await new Promise(resolve => setTimeout(resolve, minDisplayTime - uploadDuration));
        }
        
        // Vérifier si des uploads ont échoué
        if (uploadErrors.length > 0) {
          isUploading.value = false;
          globalLoading.value = false;
          const errorDetails = uploadErrors.map(e => e.fileName).join(', ');
          showToast(`❌ Échec upload de ${uploadErrors.length} fichier(s): ${errorDetails}. Veuillez réessayer.`, 'error');
          return; // ARRÊTER le processus
        }

        // Générer le tableau HTML pour Make.com
        const htmlTable = buildSavHtmlTable(filledForms, props.items);

        // Étape 2 : Préparer les payloads pour le webhook (ajouter les liens OneDrive)
        const payload = filledForms.map(({ form, index }) => {
          const images = form.images && form.images.length > 0
            ? form.images.map(img => ({
                url: img.uploadedUrl || '',
                fileName: img.file ? img.file.name : ''
              }))
            : [];
          // Récupérer l'item de facturation lié à la ligne SAV
          const factureItem = props.items[index] || {};
          return {
            ...form,
            images: images,
            itemIndex: index,
            factureInfo: {
              label: factureItem.label,
              quantityFacturee: factureItem.quantity,
              unit: factureItem.unit,
              vat_rate: factureItem.vat_rate,
              prixUnitaire: factureItem.amount && factureItem.quantity ? (factureItem.amount / factureItem.quantity) : undefined,
              prixTotal: factureItem.amount
            }
          };
        });

        // Générer le fichier Excel en base64
        const excelBase64 = generateExcelFile(filledForms, props.items);
        // Utiliser le même nom de base que le dossier pour le fichier Excel
        const excelFile = {
          content: excelBase64,
          filename: `${sanitizedSpecialMention}_${timestamp}.xlsx`
        };

        // Upload du fichier Excel sur OneDrive (le lien retourné n'est plus utilisé ici)
        currentUploadFile.value = excelFile.filename;
        await uploadToBackend(excelFile, savDossier, true, (progress) => {
          uploadProgress.value[excelFile.filename] = progress;
        });
        uploadedFiles.value++;

        // Étape 3 : Obtenir le lien de partage pour le dossier global
        const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000';
        const apiKey = import.meta.env.VITE_API_KEY;
        
        const headers = {};
        if (apiKey) {
          headers['X-API-Key'] = apiKey;
        }
        
        const response = await axios.post(`${apiUrl}/api/folder-share-link`, { savDossier }, { headers });

        if (!response.data || !response.data.success) {
          throw new Error(response.data.error || 'Impossible de récupérer le lien de partage du dossier.');
        }
        const folderShareLink = response.data.shareLink;

        // Étape 4 : Envoi au webhook avec le lien du dossier
        await axios.post(import.meta.env.VITE_WEBHOOK_URL_DATA_SAV, {
          htmlTable,
          forms: payload,
          facture: props.facture,
          dossier_sav_url: folderShareLink
        });
        filledForms.forEach(({ form }) => {
          form.showForm = false;
        });
        emit('sav-submitted');
        showToast('Toutes les réclamations ont été envoyées', 'success');
      } catch (error) {
        showToast("Erreur lors de l'envoi des réclamations", 'error');
      } finally {
        globalLoading.value = false;
        isUploading.value = false;
        uploadProgress.value = {};
        currentUploadFile.value = '';
        totalFiles.value = 0;
        uploadedFiles.value = 0;
      }
    };

    return {
      savForms,
      hasFilledForms,
      hasUnfinishedForms,
      getSavForm,
      formatKey,
      formatValue,
      isUploading,
      uploadProgress,
      currentUploadFile,
      totalFiles,
      uploadedFiles,
      filteredItemProperties,
      toggleSavForm,
      validateItemForm,
      editItemForm,
      deleteItemForm,
      handleImageUpload,
      removeImage,
      submitAllForms,
      toastMessage,
      toastType,
      globalLoading,
      showToast
    };
  }
}
</script>

<style scoped>
.webhook-items {
  @apply w-full;
}
</style>
