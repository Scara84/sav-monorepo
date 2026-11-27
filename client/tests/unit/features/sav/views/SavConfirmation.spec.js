import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils'
import SavConfirmation from '../../../../../src/features/sav/views/SavConfirmation.vue'

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }))
vi.mock('vue-router', () => ({ useRouter: () => ({ replace }) }))

const receipt = { savReceived: true, savId: 84, savReference: 'SAV-TEST-84' }
let wrapper
function show(state = receipt) {
  history.replaceState(state, '')
  wrapper = mount(SavConfirmation, {
    attachTo: document.body,
    global: { stubs: { RouterLink: RouterLinkStub } },
  })
}
function dossierLink() {
  return wrapper
    .findAllComponents(RouterLinkStub)
    .find((link) => link.props('to')?.name === 'member-sav-detail')
}

afterEach(() => {
  wrapper?.unmount()
  history.replaceState(null, '')
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('Confirmation de réception', () => {
  it('redirige vers l’accueil sans reçu', () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    show({})
    expect(wrapper.find('main').exists()).toBe(false)
    expect(replace).toHaveBeenCalledWith({ name: 'Home' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('confirme l’enregistrement même si le reçu ne contient pas de référence', () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    show({ savReceived: true, savId: 84 })
    expect(wrapper.text()).toContain('enregistré pour traitement')
    expect(wrapper.text()).toContain('La référence du dossier est indisponible.')
    expect(wrapper.find('input').exists()).toBe(false)
    expect(wrapper.find('button').exists()).toBe(false)
    expect(dossierLink()).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('attend le droit de lecture du dossier correspondant avant de proposer le lien', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ data: { id: 84, reference: 'SAV-TEST-84' } }),
      })
    vi.stubGlobal('fetch', fetch)
    show()
    expect(dossierLink()).toBeUndefined()
    await flushPromises()
    expect(fetch).toHaveBeenCalledWith(
      '/api/self-service/sav/84',
      expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' })
    )
    expect(dossierLink().props('to')).toEqual({ name: 'member-sav-detail', params: { id: 84 } })
  })

  it.each([
    ['401', { ok: false, status: 401 }],
    ['404', { ok: false, status: 404 }],
    [
      'référence différente',
      { ok: true, json: async () => ({ data: { id: 84, reference: 'AUTRE' } }) },
    ],
    [
      'ID différent',
      { ok: true, json: async () => ({ data: { id: 85, reference: 'SAV-TEST-84' } }) },
    ],
    [
      'réponse illisible',
      {
        ok: true,
        json: async () => {
          throw new Error('JSON invalide')
        },
      },
    ],
  ])('conserve la suite garantie sans lien en cas de %s', async (_, response) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    show()
    await flushPromises()
    expect(dossierLink()).toBeUndefined()
    expect(wrapper.text()).toContain('enregistré pour traitement')
    expect(wrapper.get('input').element.value).toBe(receipt.savReference)
  })

  it.each([true, false])(
    'copie la référence, avec sélection manuelle si refus (autorisé %s)',
    async (allowed) => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Hors ligne')))
      const writeText = allowed
        ? vi.fn().mockResolvedValue()
        : vi.fn().mockRejectedValue(new Error('Refus'))
      vi.stubGlobal('navigator', { clipboard: { writeText } })
      show()
      await wrapper.get('button').trigger('click')
      await flushPromises()
      expect(writeText).toHaveBeenCalledWith(receipt.savReference)
      expect(wrapper.get('[role="status"]').text()).toContain(allowed ? 'copiée' : 'manuellement')
      if (!allowed) {
        const field = wrapper.get('input').element
        expect(document.activeElement).toBe(field)
        expect(field.value.slice(field.selectionStart, field.selectionEnd)).toBe(
          receipt.savReference
        )
      }
      expect(dossierLink()).toBeUndefined()
    }
  )
})
