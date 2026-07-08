import { describe, expect, it, vi } from 'vitest'
import {
  appendSupplierClaimRowsToOneDrive,
  readSupplierClaimOneDriveConfig,
  toGraphShareId,
} from '../../../../api/_lib/sav/supplier-claim-onedrive-fill'
import type { ClaimWorkbookRow } from '../../../../api/_lib/sav/supplier-claim-writer'

function makeRows(): ClaimWorkbookRow[] {
  return [
    [
      '06/07/2026',
      '337_26S27_64',
      '2026-06-29',
      '3749',
      '1181',
      'Pomelo',
      'Málaga',
      0.37944,
      'Kilos',
      'estropeado',
      1.54,
      '',
      0.58,
    ],
  ]
}

function makeGraphRequest(methods: {
  get?: () => Promise<unknown>
  post?: (body?: unknown) => Promise<unknown>
}) {
  const request: {
    get?: () => Promise<unknown>
    post?: (body?: unknown) => Promise<unknown>
    header: ReturnType<typeof vi.fn>
  } = {
    ...methods,
    header: vi.fn(),
  }
  request.header.mockImplementation(() => request)
  return request
}

function makeExcelGraphClient(options: {
  addRows: (body?: unknown) => Promise<unknown>
  tables?: Array<{ id?: string; name?: string }>
}) {
  const closeSession = vi.fn(() => Promise.resolve({}))
  const createSession = vi.fn(() => Promise.resolve({ id: 'SESSION-1', persistChanges: true }))
  const listTables = vi.fn(() => Promise.resolve({ value: options.tables ?? [{ id: 'TABLE-ID-1', name: 'Table1' }] }))
  const addRows = vi.fn(options.addRows)

  const graphClient = {
    api: vi.fn((url: string) => {
      if (url.includes('/shares/')) {
        return makeGraphRequest({
          get: () =>
            Promise.resolve({
              id: 'ITEM-1',
              eTag: '"ETAG-1"',
              webUrl: 'https://onedrive.test/workbook.xlsx',
              parentReference: { driveId: 'DRIVE-1' },
            }),
        })
      }
      if (url.endsWith('/workbook/createSession')) {
        return makeGraphRequest({ post: createSession })
      }
      if (url.endsWith('/workbook/worksheets/SUIVI_SAV/tables')) {
        return makeGraphRequest({ get: listTables })
      }
      if (url.endsWith('/workbook/tables/Table1/rows/add')) {
        return makeGraphRequest({ post: addRows })
      }
      if (url.endsWith('/workbook/closeSession')) {
        return makeGraphRequest({ post: closeSession })
      }
      return makeGraphRequest({})
    }),
  }

  return { graphClient, createSession, listTables, addRows, closeSession }
}

describe('supplier-claim-onedrive-fill', () => {
  it('ODF-01: config absente → skipped sans appel Graph', async () => {
    const graphClient = { api: vi.fn() }

    const result = await appendSupplierClaimRowsToOneDrive(makeRows(), null, { graphClient })

    expect(result.status).toBe('skipped')
    expect(graphClient.api).not.toHaveBeenCalled()
  })

  it('ODF-02: lien de partage → ajoute les lignes via Excel Graph table rows/add', async () => {
    const { graphClient, createSession, listTables, addRows, closeSession } = makeExcelGraphClient({
      addRows: () => Promise.resolve({ index: 3, values: [] }),
    })

    const result = await appendSupplierClaimRowsToOneDrive(
      makeRows(),
      {
        shareUrl: 'https://1drv.ms/x/test',
        itemId: undefined,
        driveId: undefined,
        worksheetName: 'SUIVI_SAV',
      },
      { graphClient: graphClient as never }
    )

    expect(result.status).toBe('success')
    expect(result.webUrl).toBe('https://onedrive.test/workbook.xlsx')
    expect(createSession).toHaveBeenCalledWith({ persistChanges: true })
    expect(listTables).toHaveBeenCalled()
    expect(closeSession).toHaveBeenCalled()
    expect(addRows).toHaveBeenCalledWith({
      values: [
        [
          '',
          '',
          '06/07/2026',
          '337_26S27_64',
          '2026-06-29',
          '3749',
          '1181',
          'Pomelo',
          'Málaga',
          0.37944,
          'Kilos',
          'estropeado',
          1.54,
          '',
          0.58,
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
        ],
      ],
    })
    expect(graphClient.api).not.toHaveBeenCalledWith(expect.stringContaining('/content'))
  })

  it('ODF-02a: lien photos SAV fourni → renseigne uniquement la colonne P des lignes ajoutées', async () => {
    const { graphClient, addRows } = makeExcelGraphClient({
      addRows: () => Promise.resolve({ index: 3, values: [] }),
    })

    const result = await appendSupplierClaimRowsToOneDrive(
      makeRows(),
      {
        shareUrl: 'https://1drv.ms/x/test',
        itemId: undefined,
        driveId: undefined,
        worksheetName: 'SUIVI_SAV',
      },
      {
        graphClient: graphClient as never,
        photoFolderUrl: 'https://1drv.ms/f/photos-sav',
      }
    )

    expect(result.status).toBe('success')
    const body = addRows.mock.calls[0]?.[0] as { values: unknown[][] }
    expect(body.values[0]?.[15]).toBe('https://1drv.ms/f/photos-sav')
    expect(body.values[0]?.slice(2, 15)).toEqual(makeRows()[0])
  })

  it('ODF-02b: conflit Graph → relit et retente une fois', async () => {
    const addRows = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 412 })
      .mockResolvedValueOnce({ index: 3, values: [] })
    const { graphClient, createSession } = makeExcelGraphClient({ addRows: addRows as (body?: unknown) => Promise<unknown> })

    const result = await appendSupplierClaimRowsToOneDrive(
      makeRows(),
      {
        shareUrl: 'https://1drv.ms/x/test',
        itemId: undefined,
        driveId: undefined,
        worksheetName: 'SUIVI_SAV',
      },
      { graphClient: graphClient as never }
    )

    expect(result.status).toBe('success')
    expect(addRows).toHaveBeenCalledTimes(2)
    expect(createSession).toHaveBeenCalledTimes(2)
  })

  it('ODF-02c: fichier OneDrive verrouillé temporairement → retente puis succès', async () => {
    const addRows = vi
      .fn()
      .mockRejectedValueOnce({
        statusCode: 423,
        code: 'resourceLocked',
        message: 'The resource you are attempting to access is locked',
      })
      .mockResolvedValueOnce({ index: 3, values: [] })
    const { graphClient } = makeExcelGraphClient({ addRows: addRows as (body?: unknown) => Promise<unknown> })

    const result = await appendSupplierClaimRowsToOneDrive(
      makeRows(),
      {
        shareUrl: 'https://1drv.ms/x/test',
        itemId: undefined,
        driveId: undefined,
        worksheetName: 'SUIVI_SAV',
      },
      { graphClient: graphClient as never, retryDelayMs: 0 }
    )

    expect(result.status).toBe('success')
    expect(addRows).toHaveBeenCalledTimes(2)
  })

  it('ODF-02d: fichier OneDrive verrouillé persistant → message actionnable', async () => {
    const addRows = vi.fn().mockRejectedValue({
      statusCode: 423,
      message: 'The resource you are attempting to access is locked',
    })
    const { graphClient } = makeExcelGraphClient({ addRows: addRows as (body?: unknown) => Promise<unknown> })

    const result = await appendSupplierClaimRowsToOneDrive(
      makeRows(),
      {
        shareUrl: 'https://1drv.ms/x/test',
        itemId: undefined,
        driveId: undefined,
        worksheetName: 'SUIVI_SAV',
      },
      { graphClient: graphClient as never, retryDelayMs: 0 }
    )

    expect(result.status).toBe('failed')
    expect(result.message).toBe(
      'Le fichier OneDrive fournisseur est verrouillé. Fermez le classeur Excel/OneDrive, attendez quelques secondes, puis réessayez.'
    )
    expect(addRows).toHaveBeenCalledTimes(4)
  })

  it('ODF-03: erreur Graph → failed non throw', async () => {
    const graphClient = {
      api: vi.fn(() => ({
        get: () => Promise.reject(new Error('Graph 403')),
      })),
    }

    const result = await appendSupplierClaimRowsToOneDrive(
      makeRows(),
      {
        shareUrl: 'https://1drv.ms/x/test',
        itemId: undefined,
        driveId: undefined,
        worksheetName: 'SUIVI_SAV',
      },
      { graphClient }
    )

    expect(result.status).toBe('failed')
    expect(result.message).toBe('Graph 403')
  })

  it('ODF-04: encode un partage OneDrive en shareId Graph', () => {
    expect(toGraphShareId('https://1drv.ms/x/test')).toMatch(/^u![A-Za-z0-9_-]+$/)
  })

  it('ODF-05: lit la config depuis env', () => {
    const config = readSupplierClaimOneDriveConfig({
      SUPPLIER_CLAIM_ONEDRIVE_SHARE_URL: 'https://1drv.ms/x/test',
      SUPPLIER_CLAIM_ONEDRIVE_WORKSHEET: 'SUIVI_SAV',
      SUPPLIER_CLAIM_ONEDRIVE_TABLE: 'Table1',
    })

    expect(config).toEqual({
      shareUrl: 'https://1drv.ms/x/test',
      itemId: undefined,
      driveId: undefined,
      worksheetName: 'SUIVI_SAV',
      tableName: 'Table1',
    })
  })
})
