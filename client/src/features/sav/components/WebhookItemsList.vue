<template>
  <div class="webhook-items">
    <ul class="space-y-6">
      <li v-for="(item, index) in items" :key="index" class="bg-white p-4 rounded-lg shadow">
        <!-- Nom du produit sur toute la largeur -->
        <h3 class="text-lg font-medium text-gray-900 mb-4">{{ item.label }}</h3>
        
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
            <span class="text-sm font-medium text-gray-500">TVA</span>
            <span class="text-gray-900">{{ formatValue('vat_rate', item.vat_rate) }}</span>
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
            class="px-4 py-2 text-sm font-medium text-white rounded-md focus:outline-none focus:ring-2 focus:ring-offset-2"
            :class="getSavForm(index).showForm ? 'bg-red-600 hover:bg-red-700 focus:ring-red-500' : 'bg-blue-600 hover:bg-blue-700 focus:ring-blue-500'"
          >
            {{ getSavForm(index).showForm ? 'Annuler la demande' : 'Faire une demande SAV' }}
          </button>
        </div>

        <!-- Formulaire SAV -->
        <div v-if="getSavForm(index).showForm" class="mt-4 p-4 bg-gray-50 rounded-md">
          <form class="space-y-4" :class="{ 'opacity-75': getSavForm(index).filled }" @submit.prevent="validateItemForm(index)">
            <div class="grid grid-cols-3 gap-4">
              <div>
                <label class="block text-sm font-medium text-gray-700">Quantité</label>
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
                <label class="block text-sm font-medium text-gray-700">Unité</label>
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
                <label class="block text-sm font-medium text-gray-700">Motif</label>
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
              <label class="block text-sm font-medium text-gray-700">
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
              <label class="block text-sm font-medium text-gray-700 mb-2">
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
                  class="px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-md hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500"
                >
                  Valider
                </button>
              </template>
              <template v-else>
                <button
                  type="button"
                  @click="editItemForm(index)"
                  class="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                >
                  Modifier
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
      >
        Valider toutes les demandes SAV
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

    const validateItemForm = (index) => {
      const form = savForms.value[index];
      
      // Vérification des champs requis
      if (!form.quantity || !form.reason) {
        console.error('Veuillez remplir tous les champs requis');
        return;
      }

      // Si la raison est "abime", vérifier qu'au moins une image est uploadée
      if (form.reason === 'abime' && (!form.images || form.images.length === 0)) {
        console.error('Veuillez ajouter au moins une photo du produit abîmé');
        return;
      }

      // Marquer le formulaire comme rempli et le griser
      form.filled = true;
      form.showForm = true;  // Garder le formulaire visible mais grisé
    };

    const editItemForm = (index) => {
      const savForm = getSavForm(index);
      savForm.filled = false;
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

    // Fonction pour uploader des fichiers sur le backend et obtenir un lien de partage
    async function uploadToBackend(file, isBase64 = false) {
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
      
      try {
        const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000';
        const response = await axios.post(`${apiUrl}/api/upload-onedrive`, formData, {
          headers: {
            'Content-Type': 'multipart/form-data'
          }
        });
        
        // Retourner l'URL de partage si disponible, sinon l'URL directe
        return response.data.file.shareLink || response.data.file.url;
        
      } catch (error) {
        console.error('Erreur lors de l\'upload du fichier:', error);
        throw new Error(`Échec de l'upload du fichier: ${error.response?.data?.error || error.message}`);
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
      const data = forms.map(({ form, index }) => {
        const item = items[index] || {};
        const { code, name } = splitProductLabel(item.label);
        return {
          'PRENOM NOM': props.facture.customerName || '',
          'CODE ARTICLE': code,
          'DESIGNATION': name,
          'QTE': form.quantity || '',
          'UNITE': form.unit || '',
          'CAUSE': form.reason === 'abime' ? 'ABIME' :
                  form.reason === 'manquant' ? 'MANQUANT' :
                  form.reason === 'autre' ? 'AUTRE' : '',
          'AVOIR %': '', // Colonne à remplir manuellement
          'COMMENTAIRE': form.comment || ''
        };
      });

      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(data);

      // Ajuster la largeur des colonnes
      const colWidths = [
        { wch: 20 }, // PRENOM NOM
        { wch: 15 }, // CODE ARTICLE
        { wch: 50 }, // DESIGNATION
        { wch: 10 }, // QTE
        { wch: 10 }, // UNITE
        { wch: 15 }, // CAUSE
        { wch: 10 }, // AVOIR %
        { wch: 40 }  // COMMENTAIRE
      ];
      ws['!cols'] = colWidths;

      XLSX.utils.book_append_sheet(wb, ws, 'SAV');
      
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
      try {
        // Vérifier s'il existe des demandes en cours non validées
        if (hasUnfinishedForms.value) {
          console.error('Veuillez finaliser ou annuler toutes les demandes en cours avant de valider');
          return;
        }

        const filledForms = Object.entries(savForms.value)
          .filter(([_, form]) => form.filled && form.showForm)
          .map(([index, form]) => ({ form, index: parseInt(index) }));
        
        if (filledForms.length === 0) {
          console.error('Aucune demande SAV validée à soumettre');
          return;
        }

        // Étape 1 : Upload des images sur le backend
        for (const { form } of filledForms) {
          if (form.images && form.images.length > 0) {
            for (let imgObj of form.images) {
              if (imgObj.file && !imgObj.uploadedUrl) {
                try {
                  const uploadedUrl = await uploadToBackend(imgObj.file);
                  imgObj.uploadedUrl = uploadedUrl;
                } catch (e) {
                  console.error('Erreur upload backend:', e);
                  imgObj.uploadError = true;
                }
              }
            }
          }
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
        const excelFile = {
          content: excelBase64,
          filename: `SAV_${props.facture.specialMention || 'export'}_${new Date().toISOString().split('T')[0]}.xlsx`
        };

        // Upload du fichier Excel sur OneDrive
        const excelUrl = await uploadToBackend(excelFile, true);

        // Envoi au webhook avec le lien du fichier Excel
        await axios.post(import.meta.env.VITE_WEBHOOK_URL_DATA_SAV, {
          htmlTable,
          forms: payload,
          facture: props.facture,
          excelFileUrl: excelUrl
        });
        filledForms.forEach(({ form }) => {
          form.showForm = false;
        });
        emit('sav-submitted', payload);
      } catch (error) {
        console.error('Erreur lors de l\'envoi des données:', error);
        throw error;
      }
    };

    return {
      savForms,
      hasFilledForms,
      hasUnfinishedForms,
      getSavForm,
      formatKey,
      formatValue,
      filteredItemProperties,
      toggleSavForm,
      validateItemForm,
      editItemForm,
      deleteItemForm,
      handleImageUpload,
      removeImage,
      submitAllForms
    };
  }
}
</script>

<style scoped>
.webhook-items {
  @apply w-full;
}
</style>
