import { effectScope, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSupplierClaimUpload } from './useSupplierClaimUpload'

afterEach(() => { vi.unstubAllGlobals() })

describe('Préparation de l’aperçu', () => {
  it.each([
    [400, { code: 'INVALID_FORMAT', reason: 'MISSING_SHEETS' }, 'FACTURE_GROUPE et BDD'],
    [413, { code: 'PAYLOAD_TOO_LARGE' }, '4 Mio'],
    [429, { code: 'RATE_LIMITED' }, 'une minute'],
  ] as const)('explique l’erreur du dépôt manuel HTTP %s', async (status, error, message) => {
    const scope = effectScope()
    const upload = scope.run(() => useSupplierClaimUpload(ref(1), ref('A')))!
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { ...error, message: 'détail privé' } }, { status })))
    const input = { files: [new File(['test'], 'data.xlsx')], value: '' }
    await upload.handleFileChange({ target: input } as unknown as Event)
    expect(upload.errorMessage.value).toContain(message)
    expect(upload.errorMessage.value).not.toContain('privé')
    scope.stop()
  })

  it('ignore le double clic et une réponse à une ancienne commande, même revenue à sa valeur initiale', async () => {
    const order = ref('commande A')
    const scope = effectScope()
    const upload = scope.run(() => useSupplierClaimUpload(ref(1), order))!
    let finish!: (response: Response) => void
    const request = vi.fn(() => new Promise<Response>(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', request)
    const first = upload.prepare()
    await upload.prepare()
    expect(request).toHaveBeenCalledTimes(1)
    expect(upload.state.value).toBe('preparing')
    order.value = 'commande B'
    order.value = 'commande A'
    finish(Response.json({ error: { message: 'erreur périmée' } }, { status: 422 }))
    await first
    expect(upload.state.value).toBe('idle')
    expect(upload.errorMessage.value).toBeNull()
    expect(upload.parseResult.value).toBeNull()
    scope.stop()
  })
})
