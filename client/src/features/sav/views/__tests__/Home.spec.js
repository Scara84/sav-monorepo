/* global globalThis */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'

/**
 * Story 5.7 AC #6 — Home.vue input validation cutover.
 * UX change : input passe de hashid 14 chars à `F-YYYY-NNNNN`.
 */

const mocks = vi.hoisted(() => ({
  lookupCalls: [],
  lookupResult: { invoice_number: 'F-2025-37039' },
  lookupError: null,
}))

vi.mock('../../composables/useApiClient.js', () => ({
  useApiClient: () => ({
    submitInvoiceLookupWebhook: async (payload) => {
      mocks.lookupCalls.push({ invoiceNumber: payload.invoiceNumber, email: payload.email })
      if (mocks.lookupError) throw mocks.lookupError
      return mocks.lookupResult
    },
  }),
}))

vi.mock('../../components/HeroSection.vue', () => ({
  default: { name: 'HeroSection', template: '<div class="hero-mock"/>' },
}))

import HomeView from '../Home.vue'

const flush = () => new Promise((r) => setTimeout(r, 0))

const $router = { push: vi.fn() }
const stubAlert = vi.fn()

beforeEach(() => {
  mocks.lookupCalls = []
  mocks.lookupError = null
  $router.push.mockReset()
  stubAlert.mockReset()
  globalThis.alert = stubAlert
})

function makeWrapper() {
  return mount(HomeView, {
    global: {
      mocks: { $router },
      stubs: { HeroSection: true },
    },
  })
}

describe('Home.vue — input numéro facture cutover Story 5.7', () => {
  it('saisie F-2025-12345 valide → submit fire + router.push InvoiceDetails', async () => {
    const w = makeWrapper()
    await w.find('#invoiceNumber').setValue('F-2025-12345')
    await w.find('#email').setValue('user@example.com')
    await w.find('form').trigger('submit.prevent')
    await flush()
    await flush()
    expect(mocks.lookupCalls.length).toBe(1)
    expect(mocks.lookupCalls[0]).toEqual({
      invoiceNumber: 'F-2025-12345',
      email: 'user@example.com',
    })
    expect($router.push).toHaveBeenCalled()
    const arg = $router.push.mock.calls[0][0]
    expect(arg.name).toBe('InvoiceDetails')
    expect(arg.query.invoiceNumber).toBe('F-2025-12345')
  })

  it("saisie ZF4SLLB1CU (legacy hashid) → message d'erreur, pas de fetch", async () => {
    const w = makeWrapper()
    await w.find('#invoiceNumber').setValue('ZF4SLLB1CU')
    await w.find('#email').setValue('user@example.com')
    await w.find('form').trigger('submit.prevent')
    await flush()
    expect(mocks.lookupCalls.length).toBe(0)
    expect(stubAlert).toHaveBeenCalledWith(
      'Le numéro de facture doit avoir le format F-AAAA-NNNNN.'
    )
  })

  it("saisie F-25-X invalide → message d'erreur", async () => {
    const w = makeWrapper()
    await w.find('#invoiceNumber').setValue('F-25-X')
    await w.find('#email').setValue('user@example.com')
    await w.find('form').trigger('submit.prevent')
    await flush()
    expect(mocks.lookupCalls.length).toBe(0)
    expect(stubAlert).toHaveBeenCalled()
  })

  it('trim + uppercase tolérés (f-2025-37039 → F-2025-37039)', async () => {
    const w = makeWrapper()
    await w.find('#invoiceNumber').setValue('  f-2025-37039  ')
    await w.find('#email').setValue('user@example.com')
    await w.find('form').trigger('submit.prevent')
    await flush()
    await flush()
    expect(mocks.lookupCalls[0]?.invoiceNumber).toBe('F-2025-37039')
  })

  it('404 → alert "Référence facture incorrecte"', async () => {
    mocks.lookupError = { response: { status: 404 } }
    const w = makeWrapper()
    await w.find('#invoiceNumber').setValue('F-2099-99999')
    await w.find('#email').setValue('user@example.com')
    await w.find('form').trigger('submit.prevent')
    await flush()
    await flush()
    expect(stubAlert).toHaveBeenCalledWith('Référence facture incorrecte.')
  })

  it('429 → alert rate-limit', async () => {
    mocks.lookupError = { response: { status: 429 } }
    const w = makeWrapper()
    await w.find('#invoiceNumber').setValue('F-2025-12345')
    await w.find('#email').setValue('user@example.com')
    await w.find('form').trigger('submit.prevent')
    await flush()
    await flush()
    expect(stubAlert).toHaveBeenCalledWith(
      'Trop de tentatives, merci de réessayer dans quelques instants.'
    )
  })
})
