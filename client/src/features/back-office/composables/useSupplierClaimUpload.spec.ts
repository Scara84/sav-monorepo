import { effectScope, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSupplierClaimUpload } from './useSupplierClaimUpload'

afterEach(() => { vi.unstubAllGlobals() })

describe('Préparation de l’aperçu', () => {
  it.each([
    [400, { code: 'INVALID_FORMAT', reason: 'MISSING_SHEETS' }, 'FACTURE_GROUPE et BDD'],
    [400, { reason: 'MISSING_SHEETS', missingSheets: ['BDD'] }, 'absent du classeur · BDD'],
    [403, {}, 'Accès refusé'],
    [422, { code: 'PREPARATION_FAILED' }, 'stockage fournisseur est indisponible'],
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

  it('affiche la cause de la préparation refusée', async () => {
    const scope = effectScope()
    const upload = scope.run(() => useSupplierClaimUpload(ref(150), ref('A')))!
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      error: { code: 'PREPARATION_FAILED', diagnostic: 'Redirection refusée.' },
    }, { status: 422 })))
    await upload.prepare()
    expect(upload.errorMessage.value).toBe('Redirection refusée.')
    scope.stop()
  })

  it('conserve le nouvel aperçu après une réponse tardive du précédent SAV', async () => {
    const id = ref(1)
    const scope = effectScope()
    const upload = scope.run(() => useSupplierClaimUpload(id, ref('A')))!
    let finish!: (r: Response) => void
    const response = (reference: string) => Response.json({
      metadata: { reference, albaran: 42, fechaAlbaran: null, warnings: [] },
      factureGroupe: { rows: [], warnings: [], skippedRows: 0 },
      bdd: { rows: [], warnings: [], skippedRows: 0 },
      fileMeta: { filename: 'data.xlsx', sizeBytes: 200, sheetsDetected: ['BDD', 'FACTURE_GROUPE'], parser: 'xlsx' },
    })
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
      .mockResolvedValueOnce(response('seconde')))
    const first = upload.prepare()
    id.value = 2
    await upload.prepare()
    finish(response('première'))
    await first
    expect(upload.parseResult.value?.metadata.reference).toBe('seconde')
    expect(upload.state.value).toBe('previewing')
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
