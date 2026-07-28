/**
 * H-05 AC#1 / AC#2 / AC#3 — ATDD RED-PHASE
 *
 * Covers the OneDrive upload flow of WebhookItemsList.vue:
 *
 *   AC#1 (H4) — SFC tests ≥4 cas pour le flow upload OneDrive
 *     Test 1 — Mount happy path : composant monte, image ajoutée à l'état interne
 *     Test 2 — imgObj.itemId capturé sur upload success
 *     Test 3 — Error UI sur GRAPH_ITEM_ID_INVALID (uploadError flag posé)
 *     Test 4 — Payload captureFiles[].onedriveItemId matche regex Graph ID
 *
 *   AC#2 (M1) — uploadError reset propre sur retry
 *     Test 5 — Retry après échec partiel : uploadError reset à false sur 2e tentative
 *
 *   AC#3 — Retrait de l'upload Excel client
 *     Test 6 — Aucun XLSX client généré/uploadé ; le webhook reste envoyé après upload photo
 *
 * DN tranchés :
 *   DN-1 : @vue/test-utils@^2.4.0 + happy-dom déjà installés
 *   DN-2 : Excel client supprimé du dossier OneDrive partagé fournisseur
 *   DN-3 : uploadFilesParallel deprecated (0 appelant prod)
 *   DN-4 : Tests AC#2 + AC#3 dans cette même spec
 *   DN-5 : TODO V1.7+ refactor errorCode AC#4(g) tracé
 *
 * Mock strategy :
 *   - vi.mock('@/features/sav/composables/useApiClient') au top scope (module-level)
 *   - vi.mock('axios') + vi.mock('xlsx') alignés sur les 2 specs existants
 *   - vi.useFakeTimers() + vi.advanceTimersByTime(2000) pour bypass setTimeout 1500ms
 *   - afterEach : wrapper.unmount() + vi.clearAllMocks() + vi.useRealTimers()
 *
 * Red phase attendue :
 *   - Test 5 (AC#2 retry reset) : RED — uploadError=true stale sans le reset M1
 *   - Test 6 : protège le retrait du call-site Excel client dans WebhookItemsList.vue
 *   - Tests 1-4 (AC#1) : certains peuvent être GREEN si V1.6 a bien posé itemId + regex
 */

import { mount, flushPromises } from '@vue/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import WebhookItemsList from '../../../../../src/features/sav/components/WebhookItemsList.vue'

// ---------------------------------------------------------------------------
// Mock Graph item IDs pour les tests (valident GRAPH_ITEM_ID_REGEX)
// ---------------------------------------------------------------------------
const MOCK_GRAPH_ID_1 = '01HAPPYPATHGRAPHID0000000000001A' // 32 chars, 01 + uppercase + digits
const MOCK_GRAPH_ID_2 = '01PAYLOADGRAPHID00000000000001BB' // 32 chars

// Validation préalable des mocks contre la regex (doit être GREEN dans tous les cas)
const GRAPH_ITEM_ID_REGEX = /^(01[A-Z0-9]{30,}|b![A-Za-z0-9_-]+)$/
if (!GRAPH_ITEM_ID_REGEX.test(MOCK_GRAPH_ID_1)) {
  throw new Error(`MOCK_GRAPH_ID_1 "${MOCK_GRAPH_ID_1}" ne matche pas GRAPH_ITEM_ID_REGEX`)
}
if (!GRAPH_ITEM_ID_REGEX.test(MOCK_GRAPH_ID_2)) {
  throw new Error(`MOCK_GRAPH_ID_2 "${MOCK_GRAPH_ID_2}" ne matche pas GRAPH_ITEM_ID_REGEX`)
}

// ---------------------------------------------------------------------------
// Mocks modules externes (alignés sur WebhookItemsList.spec.js + v1-1.spec.js)
// ---------------------------------------------------------------------------

vi.mock('axios', () => ({
  default: {
    post: vi.fn(() => Promise.resolve({ data: {} })),
    get: vi.fn(() => Promise.resolve({ data: {} })),
  },
}))

vi.mock('xlsx', () => ({
  default: {
    utils: {
      json_to_sheet: vi.fn(() => ({})),
      book_new: vi.fn(() => ({ SheetNames: [], Sheets: {} })),
      book_append_sheet: vi.fn((wb, ws, name) => {
        wb.SheetNames.push(name)
        wb.Sheets[name] = ws
        return wb
      }),
      write: vi.fn(() => new Uint8Array([])),
    },
    writeFile: vi.fn(),
  },
  utils: {
    json_to_sheet: vi.fn(() => ({})),
    book_new: vi.fn(() => ({ SheetNames: [], Sheets: {} })),
    book_append_sheet: vi.fn((wb, ws, name) => {
      wb.SheetNames.push(name)
      wb.Sheets[name] = ws
      return wb
    }),
    write: vi.fn(() => new Uint8Array([])),
  },
  writeFile: vi.fn(),
}))

// Garde-fou legacy : si WebhookItemsList réimporte le générateur Excel client,
// le test final échouera parce que generateExcelFile aura été appelé.
const mockGenerateExcelFile = vi.fn(() => 'bW9ja2Jhc2U2NA==') // 'mockbase64' en base64

vi.mock('@/features/sav/composables/useExcelGenerator', () => ({
  useExcelGenerator: () => ({
    generateExcelFile: mockGenerateExcelFile,
  }),
}))

// ---------------------------------------------------------------------------
// Mock useApiClient — module-level, spies injectés par test
// ---------------------------------------------------------------------------

const mockUploadToBackend = vi.fn()
const mockGetFolderShareLink = vi.fn()
const mockSubmitSavWebhook = vi.fn()

vi.mock('@/features/sav/composables/useApiClient', () => ({
  useApiClient: () => ({
    uploadToBackend: mockUploadToBackend,
    getFolderShareLink: mockGetFolderShareLink,
    uploadFilesParallel: vi.fn(),
    submitUploadedFileUrls: vi.fn(),
    submitSavWebhook: mockSubmitSavWebhook,
    submitInvoiceLookupWebhook: vi.fn(),
    fetchCaptureToken: vi.fn(),
    withRetry: vi.fn(),
  }),
}))

// ---------------------------------------------------------------------------
// Props fixtures
// ---------------------------------------------------------------------------

const mockItems = [
  {
    id: '1',
    label: 'Pommes Bio',
    quantity: 5,
    unit: 'kg',
    vat_rate: 5.5,
    amount: 120,
  },
]

const mockFacture = {
  invoice_number: 'FACT-H05',
  date: '2024-10-01',
  special_mention: 'TEST_MENTION',
  customer: {
    email: 'adherent@fruitstock.fr',
    emails: ['adherent@fruitstock.fr'],
    first_name: 'Adhérent',
    last_name: 'Test',
  },
}

// ---------------------------------------------------------------------------
// Helper createWrapper (pattern identique aux 2 specs existants)
// ---------------------------------------------------------------------------

const createWrapper = (props = {}) =>
  mount(WebhookItemsList, {
    props: {
      items: [...mockItems],
      facture: { ...mockFacture },
      ...props,
    },
    global: {
      stubs: {
        'font-awesome-icon': true,
        transition: true,
      },
      mocks: {
        $t: (key: string) => key,
      },
    },
  })

/**
 * Helper : prépare un formulaire SAV "filled" avec une image mock
 * directement via vm.getSavForm() (sans passer par le DOM).
 *
 * @param vm - instance du composant
 * @param formIndex - index du formulaire (0 pour le 1er item)
 * @param imageFile - File mock à ajouter à form.images
 */
function prepareFillledForm(vm: any, formIndex: number, imageFile: File) {
  const form = vm.getSavForm(formIndex)
  form.showForm = true
  form.filled = true
  form.quantity = '2'
  form.unit = 'kg'
  form.reason = 'abime'
  form.images = [
    {
      file: imageFile,
      preview: 'data:image/jpeg;base64,mockpreview',
      uploadedUrl: '',
      itemId: '',
      uploadError: false,
    },
  ]
}

/**
 * Helper : crée un File mock valide
 */
function createMockImageFile(name = 'test-image.jpg'): File {
  return new File(['mock-image-content'], name, { type: 'image/jpeg' })
}

// ---------------------------------------------------------------------------
// Suite principale
// ---------------------------------------------------------------------------

describe('WebhookItemsList.vue — H-05 Upload OneDrive flow (AC#1 / AC#2 / AC#3)', () => {
  let wrapper: ReturnType<typeof createWrapper>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()

    // Défaut happy path pour getFolderShareLink et submitSavWebhook
    mockGetFolderShareLink.mockResolvedValue('https://mock-sharepoint.local/folder')
    mockSubmitSavWebhook.mockResolvedValue({ success: true })
  })

  afterEach(() => {
    if (wrapper) wrapper.unmount()
    vi.useRealTimers()
  })

  // =========================================================================
  // AC#1 — Test 1 : Mount happy path
  // =========================================================================

  describe('AC#1 — Test 1 : mount happy path + image ajoutee a l etat interne', () => {
    it('monte le composant avec props items + facture et accepte 1 image via handleImageUpload', async () => {
      wrapper = createWrapper()
      expect(wrapper.exists()).toBe(true)

      // Vérifie que le composant est bien monté avec les items
      const items = wrapper.findAll('li')
      expect(items.length).toBe(mockItems.length)

      // Simule l'ajout d'une image directement via vm (pattern specs existants)
      const form = wrapper.vm.getSavForm(0)
      const mockFile = createMockImageFile('photo-produit.jpg')
      form.images = [
        {
          file: mockFile,
          preview: 'data:image/jpeg;base64,test',
          uploadedUrl: '',
          itemId: '',
          uploadError: false,
        },
      ]

      await wrapper.vm.$nextTick()
      expect(wrapper.vm.getSavForm(0).images.length).toBe(1)
    })
  })

  // =========================================================================
  // AC#1 — Test 2 : imgObj.itemId capturé sur upload success
  // =========================================================================

  describe('AC#1 — Test 2 : imgObj.itemId capturé sur upload success', () => {
    it('stocke itemId dans form.images[0].itemId après upload réussi', async () => {
      wrapper = createWrapper()
      const mockFile = createMockImageFile('img-success.jpg')

      // Mock uploadToBackend retourne success avec Graph ID valide
      mockUploadToBackend.mockResolvedValueOnce({
        webUrl: 'https://mock-sharepoint.local/img-success.jpg',
        itemId: MOCK_GRAPH_ID_1,
      })
      prepareFillledForm(wrapper.vm, 0, mockFile)
      await wrapper.vm.$nextTick()

      // Déclenche submitAllForms
      wrapper.vm.submitAllForms()

      // Flush les promises asynchrones
      await flushPromises()
      // Avance le fake timer pour bypasser le setTimeout 1500ms (R-1 mitigation)
      vi.advanceTimersByTime(2000)
      await flushPromises()

      // Assert : imgObj.itemId doit contenir le Graph ID retourné
      const imgObj = wrapper.vm.getSavForm(0).images[0]
      expect(imgObj.itemId).toBe(MOCK_GRAPH_ID_1)
      expect(mockUploadToBackend).toHaveBeenCalledTimes(1)

      // Critère bloquant anti-régression : si le code réintroduit img.uploadedUrl.split('/').pop()
      expect(imgObj.itemId).not.toMatch(/\.jpg$/)
      expect(imgObj.itemId).not.toMatch(/^https?:\/\//)
    })
  })

  // =========================================================================
  // AC#1 — Test 3 : Error UI sur GRAPH_ITEM_ID_INVALID
  // =========================================================================

  describe('AC#1 — Test 3 : error UI sur GRAPH_ITEM_ID_INVALID', () => {
    it('pose uploadStatus=error + uploadError=true sur GRAPH_ITEM_ID_INVALID', async () => {
      wrapper = createWrapper()
      const mockFile = createMockImageFile('img-invalid.jpg')

      // Mock uploadToBackend throw GRAPH_ITEM_ID_INVALID
      mockUploadToBackend.mockRejectedValueOnce(
        new Error(
          'GRAPH_ITEM_ID_INVALID: driveItem.id "img-invalid.jpg" ne matche pas le pattern Graph ID attendu /^(01[A-Z0-9]{30,}|b![A-Za-z0-9_-]+)$/'
        )
      )

      prepareFillledForm(wrapper.vm, 0, mockFile)
      await wrapper.vm.$nextTick()

      wrapper.vm.submitAllForms()
      await flushPromises()
      vi.advanceTimersByTime(2000)
      await flushPromises()

      // uploadStatus doit être 'error' après l'erreur
      expect(wrapper.vm.uploadStatus).toBe('error')

      // Le flag uploadError doit être posé sur l'image (régression M1 : même avant le reset AC#2,
      // sur fail le flag doit être true — cet assert reste valide dans tous les cas)
      const imgObj = wrapper.vm.getSavForm(0).images[0]
      expect(imgObj.uploadError).toBe(true)

      // submitSavWebhook ne doit PAS avoir été appelé (early return avant ligne 844)
      expect(mockSubmitSavWebhook).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // AC#1 — Test 4 : Payload captureFiles[].onedriveItemId matche regex Graph ID
  // =========================================================================

  describe('AC#1 — Test 4 : payload captureFiles[].onedriveItemId matche regex Graph ID', () => {
    it('appelle submitSavWebhook avec files[].onedriveItemId qui matche la regex', async () => {
      wrapper = createWrapper()
      const mockFile = createMockImageFile('img-payload.jpg')

      // Mock uploadToBackend : image upload → Graph ID valide
      mockUploadToBackend.mockResolvedValueOnce({
        webUrl: 'https://mock-sharepoint.local/img-payload.jpg',
        itemId: MOCK_GRAPH_ID_2,
      })
      prepareFillledForm(wrapper.vm, 0, mockFile)
      await wrapper.vm.$nextTick()

      wrapper.vm.submitAllForms()
      await flushPromises()
      vi.advanceTimersByTime(2000)
      await flushPromises()

      // Assert submitSavWebhook appelé exactement 1 fois
      expect(mockSubmitSavWebhook).toHaveBeenCalledTimes(1)
      expect(mockUploadToBackend).toHaveBeenCalledTimes(1)

      const callPayload = mockSubmitSavWebhook.mock.calls[0][0]
      expect(callPayload.files).toBeDefined()
      expect(callPayload.files.length).toBeGreaterThan(0)

      const onedriveItemId = callPayload.files[0].onedriveItemId

      // Matche la regex GRAPH_ITEM_ID_REGEX
      expect(onedriveItemId).toMatch(GRAPH_ITEM_ID_REGEX)

      // Anti-régression : n'est PAS une URL ni un filename (bug SAV-18/SAV-19)
      expect(onedriveItemId).not.toMatch(/^https?:\/\//)
      expect(onedriveItemId).not.toMatch(/\.[a-zA-Z]{2,5}$/)
    })
  })

  // =========================================================================
  // AC#2 — Test 5 : uploadError reset propre sur retry (M1)
  // RED phase : sans le reset M1, images[0].uploadError reste true du 1er run
  // =========================================================================

  describe('AC#2 — Test 5 : uploadError reset propre sur retry (M1)', () => {
    it('images[0].uploadError === false après retry réussi (sans reset M1 = RED)', async () => {
      wrapper = createWrapper()
      const mockFile0 = createMockImageFile('img-retry-0.jpg')
      const mockFile1 = createMockImageFile('img-retry-1.jpg')

      // 1er submit : img0 échoue, img1 réussit
      mockUploadToBackend
        .mockRejectedValueOnce(new Error('GRAPH_ITEM_ID_INVALID: img0 fail'))
        .mockResolvedValueOnce({
          webUrl: 'https://mock.local/img1.jpg',
          itemId: MOCK_GRAPH_ID_1,
        })

      const form = wrapper.vm.getSavForm(0)
      form.showForm = true
      form.filled = true
      form.quantity = '2'
      form.unit = 'kg'
      form.reason = 'abime'
      form.images = [
        {
          file: mockFile0,
          preview: 'data:image/jpeg;base64,test0',
          uploadedUrl: '',
          itemId: '',
          uploadError: false,
        },
        {
          file: mockFile1,
          preview: 'data:image/jpeg;base64,test1',
          uploadedUrl: '',
          itemId: '',
          uploadError: false,
        },
      ]
      await wrapper.vm.$nextTick()

      // 1er submit — img0 fail, img1 OK
      wrapper.vm.submitAllForms()
      await flushPromises()
      vi.advanceTimersByTime(2000)
      await flushPromises()

      // Après 1er submit : img0.uploadError === true (erreur posée)
      expect(form.images[0].uploadError).toBe(true)

      // Reset le globalLoading pour permettre un 2e submit
      // (après closeUploadModal ou equivalent)
      wrapper.vm.closeUploadModal()
      await wrapper.vm.$nextTick()

      // img0 n'a pas encore d'itemId/uploadedUrl → sera re-tenté au 2e submit
      // Réinitialiser uploadedUrl/itemId sur img0 pour forcer re-upload
      form.images[0].uploadedUrl = ''
      form.images[0].itemId = ''

      // 2e submit : seul img0 est re-uploadé ; img1 a déjà uploadedUrl + itemId.
      mockUploadToBackend.mockResolvedValueOnce({
        webUrl: 'https://mock.local/img0-retry.jpg',
        itemId: MOCK_GRAPH_ID_1,
      })

      wrapper.vm.submitAllForms()
      await flushPromises()
      vi.advanceTimersByTime(2000)
      await flushPromises()

      // Assert principal AC#2 : img0.uploadError doit être FALSE après retry réussi
      // Sans le reset M1 (imgObj.uploadError = false au début de chaque tentative),
      // img0.uploadError reste true du 1er run → ce test est RED
      expect(form.images[0].uploadError).toBe(false)
    })
  })

  // =========================================================================
  // AC#3 — Test 6 : retrait de l'upload Excel client
  // =========================================================================

  describe("AC#3 — Test 6 : aucun XLSX client n'est uploadé", () => {
    it('soumet le webhook après upload photo sans générer ni uploader de fichier xlsx client', async () => {
      wrapper = createWrapper()
      const mockFile = createMockImageFile('img-no-excel-test.jpg')

      // Image upload réussit
      mockUploadToBackend.mockResolvedValueOnce({
        webUrl: 'https://mock.local/img-no-excel-test.jpg',
        itemId: MOCK_GRAPH_ID_1,
      })
      // Garde-fou : cet échec ne doit jamais être consommé, car l'upload Excel client
      // n'existe plus dans le flow de soumission SAV.
      mockUploadToBackend.mockRejectedValueOnce(
        new Error(
          'GRAPH_ITEM_ID_INVALID: driveItem.id "excel.xlsx" ne matche pas le pattern Graph ID attendu'
        )
      )

      prepareFillledForm(wrapper.vm, 0, mockFile)
      await wrapper.vm.$nextTick()

      wrapper.vm.submitAllForms()
      await flushPromises()
      vi.advanceTimersByTime(2000)
      await flushPromises()

      expect(mockGenerateExcelFile).not.toHaveBeenCalled()
      expect(mockUploadToBackend).toHaveBeenCalledTimes(1)
      expect(mockUploadToBackend.mock.calls[0][0].name).toBe(mockFile.name)
      expect(mockUploadToBackend.mock.calls[0][0].type).toBe(mockFile.type)
      expect(mockUploadToBackend.mock.calls[0][2]).toMatchObject({ isBase64: false })
      expect(mockSubmitSavWebhook).toHaveBeenCalledTimes(1)
      expect(wrapper.vm.uploadStatus).toBe('success')

      const callPayload = mockSubmitSavWebhook.mock.calls[0][0]
      expect(callPayload.files).toHaveLength(1)
      expect(callPayload.files[0].originalFilename).toBe('img-no-excel-test.jpg')
      expect(callPayload.files[0].originalFilename).not.toMatch(/\.xlsx$/)
    })
  })
})
