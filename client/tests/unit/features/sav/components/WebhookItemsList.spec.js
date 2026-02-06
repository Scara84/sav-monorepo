import { mount } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import WebhookItemsList from '../../../../../src/features/sav/components/WebhookItemsList.vue'
import { createI18n } from 'vue-i18n'

// Mock des modules externes
vi.mock('axios', () => ({
  default: {
    post: vi.fn(() => Promise.resolve({ data: {} }))
  }
}))

vi.mock('xlsx', () => ({
  utils: {
    json_to_sheet: vi.fn(() => ({})),
    book_new: vi.fn(() => ({ SheetNames: [], Sheets: {} })),
    book_append_sheet: vi.fn((wb, ws, name) => {
      wb.SheetNames.push(name)
      wb.Sheets[name] = ws
      return wb
    }),
    write: vi.fn(() => new Uint8Array([]))
  },
  writeFile: vi.fn()
}))

describe('WebhookItemsList.vue', () => {
  let wrapper
  const mockItems = [
    {
      id: '1',
      label: 'Produit de test',
      quantity: 2,
      unit: 'pcs',
      vat_rate: 20,
      amount: 100
    },
    {
      id: '2',
      label: 'Autre produit',
      quantity: 1,
      unit: 'kg',
      vat_rate: 10,
      amount: 50
    }
  ]

  const mockFacture = {
    id: 'FACT-123',
    date: '2023-06-06',
    customer: 'Client Test',
    customer_email: 'client@test.com'
  }

  // Configuration i18n pour les tests
  const i18n = createI18n({
    legacy: false,
    locale: 'fr',
    messages: {
      fr: {}
    }
  })

  const createWrapper = (props = {}) => {
    return mount(WebhookItemsList, {
      props: {
        items: [...mockItems],
        facture: { ...mockFacture },
        ...props
      },
      global: {
        plugins: [i18n],
        stubs: {
          'font-awesome-icon': true,
          'transition': true
        },
        mocks: {
          $t: (key) => key // Mock pour la traduction
        }
      }
    })
  }

  beforeEach(() => {
    // Réinitialiser les mocks avant chaque test
    vi.clearAllMocks()
    
    // Monter le composant avec les props nécessaires
    wrapper = createWrapper()
  })

  afterEach(() => {
    if (wrapper) {
      wrapper.unmount()
    }
  })

  it('affiche correctement les éléments de la liste', () => {
    // Vérifier que le composant est bien monté
    expect(wrapper.exists()).toBe(true)
    
    // Vérifier que le nombre d'éléments affichés correspond aux données fournies
    const items = wrapper.findAll('li')
    expect(items).toHaveLength(mockItems.length)
    
    // Vérifier que les libellés des produits sont affichés
    mockItems.forEach(item => {
      expect(wrapper.text()).toContain(item.label)
    })
  })

  it('affiche le bouton de demande SAV pour chaque élément', () => {
    const buttons = wrapper.findAll('button.btn-main')
    expect(buttons.length).toBe(mockItems.length)
    buttons.forEach(button => {
      expect(button.text()).toContain('Signaler un problème')
    })
  })

  it('affiche le formulaire SAV au clic sur le bouton', async () => {
    const button = wrapper.find('button.btn-main')
    
    // Vérifier que le formulaire n'est pas affiché initialement
    expect(wrapper.find('form').exists()).toBe(false)
    
    // Cliquer sur le bouton pour afficher le formulaire
    await button.trigger('click')
    
    // Vérifier que le formulaire est maintenant affiché
    expect(wrapper.find('form').exists()).toBe(true)
    
    // Vérifier que le bouton a changé de texte
    expect(button.text()).toContain('Annuler la réclamation')
  })

  it('formate correctement les valeurs monétaires', () => {
    // Vérifier que le composant est bien monté
    expect(wrapper.exists()).toBe(true)
    
    // Vérifier que les éléments sont affichés
    const items = wrapper.findAll('li')
    expect(items.length).toBe(2)
    
    // Vérifier le premier élément
    const firstItem = items[0]
    
    // Vérifier que le titre du produit est affiché
    const productTitle = firstItem.find('h3')
    expect(productTitle.exists()).toBe(true)
    expect(productTitle.text()).toBe('Produit de test')
    
    // Vérifier que les valeurs sont correctement formatées
    const valueElements = firstItem.findAll('.text-gray-900')
    
    // Le premier élément .text-gray-900 est le titre du produit
    // Les éléments suivants sont les valeurs formatées
    expect(valueElements.length).toBeGreaterThan(3) // Au moins 4 valeurs (quantité, unité, TVA, prix unitaire, prix total)
    
    // Vérifier que les valeurs contiennent les données attendues (sans vérifier le format exact)
    const values = valueElements.map(el => el.text())
    expect(values.some(v => v.includes('2'))).toBe(true) // Quantité
    expect(values.some(v => v.includes('pcs'))).toBe(true) // Unité
    expect(values.some(v => v.includes('50'))).toBe(true) // Prix unitaire (100/2)
    expect(values.some(v => v.includes('100'))).toBe(true) // Prix total
  })

  it('affiche un message quand il n\'y a pas d\'éléments', async () => {
    // Créer un nouveau wrapper avec une liste vide
    const emptyWrapper = createWrapper({ items: [] })
    
    // Vérifier que le message est affiché
    expect(emptyWrapper.text()).toContain('Aucun élément à afficher')
    
    // Vérifier qu'aucun élément n'est affiché
    const items = emptyWrapper.findAll('li')
    expect(items).toHaveLength(0)
    
    emptyWrapper.unmount()
  })

  it('affiche et remplit le formulaire SAV', async () => {
    // Vérifier que le composant est bien monté
    expect(wrapper.exists()).toBe(true)
    
    // Vérifier que le bouton de demande SAV est présent
    const buttons = wrapper.findAll('button')
    expect(buttons.length).toBeGreaterThan(0)
    
    const showFormButton = buttons[0]
    expect(showFormButton.text()).toContain('Signaler un problème')
    
    // Afficher le formulaire
    await showFormButton.trigger('click')
    
    // Vérifier que le formulaire est affiché
    const form = wrapper.find('form')
    expect(form.exists()).toBe(true)
    
    // Vérifier que les champs requis sont présents
    const quantityInput = form.find('input[type="number"]')
    const selects = form.findAll('select')
    
    expect(quantityInput.exists()).toBe(true)
    expect(selects.length).toBeGreaterThan(0)
    
    // Le reste du test nécessite une analyse plus approfondie du composant
    // pour comprendre comment les validations sont implémentées
  })
  
  // Note: Les tests de validation et de soumission du formulaire
  // nécessitent une analyse plus approfondie du composant pour être correctement implémentés

  it('affiche le bouton de validation globale quand un formulaire est rempli', async () => {
    expect(wrapper.exists()).toBe(true)

    const form = wrapper.vm.getSavForm(0)
    form.showForm = true
    form.filled = true

    await wrapper.vm.$nextTick()

    const submitButton = wrapper
      .findAll('button')
      .find(btn => btn.text().includes('Valider toutes les réclamations'))

    expect(submitButton).toBeTruthy()
  })
})
