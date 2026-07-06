import { describe, expect, it, vi, afterEach } from 'vitest'
import { computed, ref, nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { useSupplierClaimArbitration } from '../../../../../src/features/back-office/composables/useSupplierClaimArbitration'
import type { SupplierFileParseResult } from '../../../../../src/features/back-office/composables/useSupplierClaimUpload'

function withSetup<T>(composableFn: () => T): { result: T; app: ReturnType<typeof mount> } {
  let result!: T
  const TestComponent = {
    setup() {
      result = composableFn()
      return {}
    },
    template: '<div/>',
  }
  const app = mount(TestComponent, { attachTo: document.body })
  return { result, app }
}

function makeParseResult(): SupplierFileParseResult {
  return {
    metadata: {
      reference: '337_26S27_64',
      albaran: '3749',
      fechaAlbaran: '2026-06-29',
      warnings: [],
    },
    factureGroupe: { rows: [], warnings: [], skippedRows: 0 },
    bdd: { rows: [], skippedRows: 0, warnings: [] },
    fileMeta: { filename: 'data.xlsx', sizeBytes: 1000, sheetsDetected: [], parser: 'xlsx' },
  } as SupplierFileParseResult
}

function makeReconcileResponse() {
  return {
    claimLines: [
      {
        savLineId: 1,
        codeFr: '1181',
        codigoEs: '1181',
        productoEs: 'Pomelo',
        origen: 'Málaga',
        unidad: 'Kilos',
        conversionFlag: 'ok',
        causaEs: 'estropeado',
        precio: 1.54,
        qty: 0.37944,
        peso: 0.37944,
        qteFact: 1,
        importe: 0.58,
        blockingForGeneration: false,
        productNameSnapshot: 'Pomelo',
        comentarios: '',
      },
    ],
    unmatchedSavLines: [],
    unusedSupplierLines: [],
    totals: { importe: 0.58, linesMatched: 1, linesUnmatched: 0, linesBlocking: 0 },
    meta: {
      reconciliation: { savLinesTotal: 1, matched: 1, unmatched: 0, multipleMatches: 0 },
      warnings: [],
    },
    savLines: [],
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useSupplierClaimArbitration — headers OneDrive génération', () => {
  it('expose le status et lien OneDrive depuis la réponse blob', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:claim')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const click = vi.fn()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(click)

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(makeReconcileResponse()),
      })
      .mockResolvedValueOnce({
        ok: true,
        blob: () => Promise.resolve(new Blob(['xlsx'])),
        headers: new Headers({
          'content-disposition': 'attachment; filename="RECLAMACION.xlsx"',
          'x-supplier-claim-onedrive-status': 'success',
          'x-supplier-claim-onedrive-web-url': 'https://onedrive.test/suivi.xlsx',
          'x-supplier-claim-onedrive-message': '1 ligne(s) ajoutée(s) dans OneDrive.',
        }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const parseResult = ref(makeParseResult())
    const { result, app } = withSetup(() =>
      useSupplierClaimArbitration(computed(() => 16), parseResult)
    )

    await flushPromises()
    await nextTick()
    await result.generate(null)

    expect(result.generateState.value).toBe('generated')
    expect(result.generateResult.value?.onedriveStatus).toBe('success')
    expect(result.generateResult.value?.onedriveWebUrl).toBe('https://onedrive.test/suivi.xlsx')
    expect(result.generateResult.value?.onedriveMessage).toContain('OneDrive')
    expect(click).toHaveBeenCalled()

    app.unmount()
  })
})
