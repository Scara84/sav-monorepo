import { ref, computed } from 'vue';

/**
 * Composable pour gérer les formulaires SAV
 * Extrait la logique de gestion des formulaires de WebhookItemsList
 */
export function useSavForms() {
  const savForms = ref({});

  /**
   * Récupère ou crée un formulaire SAV pour un index donné
   */
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
        isDragging: false,
        loading: false,
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

  /**
   * Vérifie si au moins un formulaire est rempli
   */
  const hasFilledForms = computed(() => {
    return Object.values(savForms.value).some(form => form.filled && form.showForm);
  });

  /**
   * Vérifie s'il y a des formulaires non terminés
   */
  const hasUnfinishedForms = computed(() => {
    return Object.values(savForms.value).some(form => form.showForm && !form.filled);
  });

  /**
   * Valide un formulaire SAV
   */
  const validateForm = (form) => {
    form.errors = {
      quantity: '',
      unit: '',
      reason: '',
      images: ''
    };
    
    let isValid = true;
    
    // Validation de la quantité
    if (!form.quantity && form.quantity !== 0) {
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

  /**
   * Affiche/masque le formulaire SAV
   */
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

  /**
   * Valide un formulaire d'item
   */
  const validateItemForm = async (index, showToast) => {
    const form = savForms.value[index];
    if (form.loading) return;
    
    form.loading = true;
    try {
      const isValid = validateForm(form);
      if (!isValid) {
        if (form.errors.images) {
          showToast('Veuillez ajouter au moins une photo du produit abîmé', 'error');
        } else {
          showToast('Veuillez remplir tous les champs requis', 'error');
        }
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

  /**
   * Permet de modifier à nouveau un formulaire
   */
  const editItemForm = (index, showToast) => {
    const savForm = getSavForm(index);
    savForm.filled = false;
    showToast('Réclamation modifiable à nouveau', 'success');
  };

  /**
   * Supprime/réinitialise un formulaire
   */
  const deleteItemForm = (index) => {
    const savForm = getSavForm(index);
    savForm.showForm = false;
    savForm.filled = false;
    savForm.quantity = '';
    savForm.unit = '';
    savForm.reason = '';
    savForm.comment = '';
    savForm.images = [];
    savForm.isDragging = false;
    savForm.errors = {
      quantity: '',
      unit: '',
      reason: '',
      images: ''
    };
  };

  /**
   * Récupère tous les formulaires remplis
   */
  const getFilledForms = () => {
    return Object.entries(savForms.value)
      .filter(([_, form]) => form.filled && form.showForm)
      .map(([index, form]) => ({ form, index: parseInt(index) }));
  };

  return {
    savForms,
    getSavForm,
    hasFilledForms,
    hasUnfinishedForms,
    validateForm,
    toggleSavForm,
    validateItemForm,
    editItemForm,
    deleteItemForm,
    getFilledForms
  };
}
