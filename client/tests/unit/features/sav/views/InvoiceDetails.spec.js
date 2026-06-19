import { describe, expect, it, vi } from 'vitest'
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

  it('autorise la navigation si le composant SAV n’est pas monté', () => {
    expect(InvoiceDetails.methods.confirmSavLeave.call({ $refs: {} })).toBe(true)
  })
})
