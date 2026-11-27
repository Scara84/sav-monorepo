import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import InvoiceDetails from '../../../../../src/features/sav/views/InvoiceDetails.vue'

describe('InvoiceDetails navigation guards', () => {
  it.each(['beforeRouteLeave', 'beforeRouteUpdate'])(
    '%s relaie le refus de quitter du formulaire SAV',
    (guardName) => {
      const confirmLeave = vi.fn(() => false)
      const context = {
        $refs: { savItemsList: { confirmLeave } },
        confirmSavLeave: InvoiceDetails.methods.confirmSavLeave,
      }

      expect(InvoiceDetails[guardName].call(context)).toBe(false)
      expect(confirmLeave).toHaveBeenCalledOnce()
    }
  )

  it('transmet l’identifiant et la référence reçus à la confirmation', () => {
    const push = vi.fn()
    InvoiceDetails.methods.handleSavSubmission.call({ $router: { push } }, {
      savId: 84, reference: 'SAV-TEST-84',
    })
    expect(push).toHaveBeenCalledWith({
      name: 'SavConfirmation',
      state: { savReceived: true, savId: 84, savReference: 'SAV-TEST-84' },
    })
  })

  it('autorise la navigation si le composant SAV n’est pas monté', () => {
    expect(InvoiceDetails.methods.confirmSavLeave.call({ $refs: {} })).toBe(true)
  })
})

describe('InvoiceDetails référence de la facture', () => {
  it.each([undefined, '   '])('bloque une facture sans référence exploitable', (invoice_number) => {
    const wrapper = mount(InvoiceDetails, {
      global: {
        mocks: {
          $route: { query: {
            invoiceNumber: 'F-2026-00001',
            webhookResponse: JSON.stringify({ invoice_number, line_items: [{ label: 'Carottes' }] }),
          } },
        },
        stubs: { WebhookItemsList: true },
      },
    })
    expect(wrapper.get('[role="alert"]').text()).toContain('ne contient pas de numéro')
    expect(wrapper.findComponent({ name: 'WebhookItemsList' }).exists()).toBe(false)
    expect(wrapper.get('router-link').attributes('to')).toBe('/')
  })
})
