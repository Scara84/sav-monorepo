import { ref, computed } from 'vue'

/**
 * Composable pour gérer les formulaires SAV
 * Extrait la logique de gestion des formulaires de WebhookItemsList
 */
export function useSavForms(getItems) {
  const savForms = ref(new Map())
  // Une ligne historique sans identifiant conserve son objet comme clé locale.
  const lineKeys = computed(() => {
    const items = getItems?.() ?? []
    const seen = new Set()
    const duplicates = new Set()
    for (const item of items) {
      if (seen.has(item.id)) duplicates.add(item.id)
      seen.add(item.id)
    }
    return items.map((item) => (item.id != null && !duplicates.has(item.id) ? item.id : item))
  })
  const keyAt = (index) => (getItems ? lineKeys.value[index] : index)

  /**
   * Récupère ou crée un formulaire SAV pour un index donné
   */
  const getSavForm = (index) => {
    const key = keyAt(index)
    if (!savForms.value.has(key)) {
      savForms.value.set(key, {
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
          images: '',
        },
      })
    }
    return savForms.value.get(key)
  }

  /**
   * Vérifie si au moins un formulaire est rempli
   */
  const entries = computed(() => {
    const items = getItems ? getItems() : [...savForms.value.keys()]
    return items.flatMap((item, position) => {
      const form = savForms.value.get(getItems ? keyAt(position) : item)
      return form?.showForm ? [{ form, index: getItems ? position : item, item }] : []
    })
  })
  const getFilledForms = () => entries.value.filter(({ form }) => form.filled)
  const filledFormsCount = computed(() => getFilledForms().length)
  const hasFilledForms = computed(() => filledFormsCount.value > 0)

  /**
   * Vérifie s'il y a des formulaires non terminés
   */
  const hasUnfinishedForms = computed(() => {
    return entries.value.some(({ form }) => !form.filled)
  })

  const hasDirtyForms = computed(() => {
    return entries.value.some(
      ({ form }) =>
        !form.filled &&
        (form.quantity !== '' ||
          form.unit !== '' ||
          form.reason !== '' ||
          form.comment.trim() !== '' ||
          form.images.length > 0)
    )
  })

  /**
   * Valide un formulaire SAV
   */
  const validateForm = (form) => {
    form.errors = {
      quantity: '',
      unit: '',
      reason: '',
      images: '',
    }

    let isValid = true

    // Validation de la quantité
    if (!form.quantity && form.quantity !== 0) {
      form.errors.quantity = 'La quantité est requise'
      isValid = false
    } else if (form.quantity <= 0) {
      form.errors.quantity = 'La quantité doit être supérieure à 0'
      isValid = false
    }

    const quantity = Number(form.quantity)
    if (
      isValid &&
      (!Number.isFinite(quantity) || quantity > 9999.99 || quantity !== Number(quantity.toFixed(2)))
    ) {
      form.errors.quantity =
        'Saisissez une quantité de 0,01 à 9 999,99 avec deux décimales maximum.'
      isValid = false
    }

    // Validation de l'unité
    if (!form.unit) {
      form.errors.unit = 'Veuillez sélectionner une unité'
      isValid = false
    }

    // Validation du motif
    if (!form.reason) {
      form.errors.reason = 'Veuillez sélectionner un motif'
      isValid = false
    }

    // Validation des images pour le motif "abimé"
    if (form.reason === 'abime' && (!form.images || form.images.length === 0)) {
      form.errors.images = 'Veuillez ajouter au moins une photo du produit abîmé'
      isValid = false
    }

    return isValid
  }

  /**
   * Affiche/masque le formulaire SAV
   */
  const toggleSavForm = (index) => {
    const savForm = getSavForm(index)
    if (!savForm.submitted) {
      if (savForm.showForm) {
        // Si on ferme le formulaire, on le réinitialise
        deleteItemForm(index)
      } else {
        // Si on ouvre le formulaire
        savForm.showForm = true
      }
    }
  }

  /**
   * Valide un formulaire d'item
   */
  const validateItemForm = async (index, showToast) => {
    const form = getSavForm(index)
    if (form.loading) return

    form.loading = true
    try {
      const isValid = validateForm(form)
      if (!isValid) {
        if (form.errors.images) {
          showToast('Veuillez ajouter au moins une photo du produit abîmé', 'error')
        } else {
          showToast('Veuillez remplir tous les champs requis', 'error')
        }
        return
      }
      // Marquer le formulaire comme rempli et le griser
      form.filled = true
      form.showForm = true // Garder le formulaire visible mais grisé
      showToast('Réclamation ajoutée à votre demande SAV', 'success')
    } finally {
      form.loading = false
    }
  }

  /**
   * Permet de modifier à nouveau un formulaire
   */
  const editItemForm = (index, showToast) => {
    const savForm = getSavForm(index)
    savForm.filled = false
    showToast('Réclamation modifiable à nouveau', 'success')
  }

  /**
   * Supprime/réinitialise un formulaire
   */
  const deleteItemForm = (index) => {
    const savForm = getSavForm(index)
    savForm.showForm = false
    savForm.filled = false
    savForm.quantity = ''
    savForm.unit = ''
    savForm.reason = ''
    savForm.comment = ''
    savForm.images = []
    savForm.isDragging = false
    savForm.errors = {
      quantity: '',
      unit: '',
      reason: '',
      images: '',
    }
  }

  return {
    savForms,
    keyAt,
    getSavForm,
    hasFilledForms,
    filledFormsCount,
    hasUnfinishedForms,
    hasDirtyForms,
    validateForm,
    toggleSavForm,
    validateItemForm,
    editItemForm,
    deleteItemForm,
    getFilledForms,
  }
}
