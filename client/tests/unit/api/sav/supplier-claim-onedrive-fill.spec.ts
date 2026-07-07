import { describe, expect, it, vi } from 'vitest'
import {
  appendSupplierClaimRowsToOneDrive,
  readSupplierClaimOneDriveConfig,
  toGraphShareId,
} from '../../../../api/_lib/sav/supplier-claim-onedrive-fill'
import type { ClaimWorkbookRow } from '../../../../api/_lib/sav/supplier-claim-writer'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import * as XLSX from 'xlsx'

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

function makeWorkbookBuffer(): Buffer {
  const workbook = XLSX.utils.book_new()
  const worksheet = XLSX.utils.aoa_to_sheet([
    ['A1', 'B1', '', '', '', '', '', '', '', '', '', '', '', '', '', 'P1'],
    ['A2', 'B2', 'FECHA', 'REFERENCE COMMANDE'],
    ['A3', 'B3', 'old fecha', 'old ref'],
    ['A4', 'B4', '', ''],
  ])
  XLSX.utils.book_append_sheet(workbook, worksheet, 'SUIVI_SAV')
  const buffer = Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }))
  const entries = unzipSync(buffer)
  const sheetPath = 'xl/worksheets/sheet1.xml'
  const sheetXml = strFromU8(entries[sheetPath]!)
  const sheetWithTablePart = sheetXml
    .replace('<worksheet ', '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ')
    .replace('</worksheet>', '<tableParts count="1"><tablePart r:id="rIdTable1"/></tableParts></worksheet>')

  entries[sheetPath] = strToU8(sheetWithTablePart)
  entries['xl/worksheets/_rels/sheet1.xml.rels'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdTable1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/>
</Relationships>`)
  entries['xl/tables/table1.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="Table1" displayName="Table1" ref="A2:X3" totalsRowShown="0">
  <autoFilter ref="A2:X3"/>
  <tableColumns count="24">
    ${Array.from({ length: 24 }, (_, index) => `<tableColumn id="${index + 1}" name="Col${index + 1}"/>`).join('')}
  </tableColumns>
  <tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/>
</table>`)

  return Buffer.from(zipSync(entries))
}

interface UploadRequestMock {
  header: (name: string, value: string) => UploadRequestMock
  put: (body: Buffer | Uint8Array) => Promise<unknown>
}

function makeUploadRequest(put: (body: Buffer | Uint8Array) => Promise<unknown>): {
  request: UploadRequestMock
  headerMock: unknown
} {
  const request = {} as UploadRequestMock
  const headerMock = vi.fn((_name: string, _value: string): UploadRequestMock => request)
  request.header = headerMock
  request.put = put
  return { request, headerMock }
}

describe('supplier-claim-onedrive-fill', () => {
  it('ODF-01: config absente → skipped sans appel Graph', async () => {
    const graphClient = { api: vi.fn() }

    const result = await appendSupplierClaimRowsToOneDrive(makeRows(), null, { graphClient })

    expect(result.status).toBe('skipped')
    expect(graphClient.api).not.toHaveBeenCalled()
  })

  it('ODF-02: lien de partage → télécharge, calcule next row, réupload avec If-Match', async () => {
    let uploaded: Buffer | null = null
    const put = vi.fn((body: Buffer | Uint8Array) => {
      uploaded = Buffer.from(body)
      return Promise.resolve({ id: 'ITEM-1', webUrl: 'https://onedrive.test/workbook.xlsx' })
    })
    const { request: uploadRequest, headerMock } = makeUploadRequest(put)
    const graphClient = {
      api: vi.fn((url: string) => {
        if (url.includes('/shares/')) {
          return {
            get: () =>
              Promise.resolve({
                id: 'ITEM-1',
                eTag: '"ETAG-1"',
                webUrl: 'https://onedrive.test/workbook.xlsx',
                parentReference: { driveId: 'DRIVE-1' },
              }),
          }
        }
        if (url.endsWith('/content')) {
          return {
            responseType: () => ({ get: () => Promise.resolve(makeWorkbookBuffer()) }),
            header: uploadRequest.header,
          }
        }
        return {}
      }),
    }

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
    expect(headerMock).toHaveBeenCalledWith('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(headerMock).toHaveBeenCalledWith('If-Match', '"ETAG-1"')
    expect(put).toHaveBeenCalled()
    expect(graphClient.api).not.toHaveBeenCalledWith(expect.stringContaining('/workbook/'))

    const workbook = XLSX.read(uploaded, { type: 'buffer' })
    const worksheet = workbook.Sheets['SUIVI_SAV']!
    expect(worksheet['C4']?.v).toBe('06/07/2026')
    expect(worksheet['D4']?.v).toBe('337_26S27_64')
    expect(worksheet['O4']?.v).toBe(0.58)

    const uploadedEntries = unzipSync(uploaded!)
    const tableXml = strFromU8(uploadedEntries['xl/tables/table1.xml']!)
    const sheetXml = strFromU8(uploadedEntries['xl/worksheets/sheet1.xml']!)
    expect(tableXml).toContain('ref="A2:X4"')
    expect(tableXml).toContain('TableStyleMedium2')
    expect(sheetXml).toContain('<tableParts count="1"><tablePart r:id="rIdTable1"/></tableParts>')
  })

  it('ODF-02b: conflit eTag → relit et retente une fois', async () => {
    const put = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 412 })
      .mockResolvedValueOnce({ id: 'ITEM-1', webUrl: 'https://onedrive.test/workbook.xlsx' })
    const { request: uploadRequest, headerMock } = makeUploadRequest(put)
    let eTagRead = 0
    const graphClient = {
      api: vi.fn((url: string) => {
        if (url.includes('/shares/')) {
          eTagRead += 1
          return {
            get: () =>
              Promise.resolve({
                id: 'ITEM-1',
                eTag: `"ETAG-${eTagRead}"`,
                webUrl: 'https://onedrive.test/workbook.xlsx',
                parentReference: { driveId: 'DRIVE-1' },
              }),
          }
        }
        if (url.endsWith('/content')) {
          return {
            responseType: () => ({ get: () => Promise.resolve(makeWorkbookBuffer()) }),
            header: uploadRequest.header,
          }
        }
        return {}
      }),
    }

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
    expect(put).toHaveBeenCalledTimes(2)
    expect(headerMock).toHaveBeenCalledWith('If-Match', '"ETAG-1"')
    expect(headerMock).toHaveBeenCalledWith('If-Match', '"ETAG-2"')
  })

  it('ODF-02c: fichier OneDrive verrouillé temporairement → retente puis succès', async () => {
    const put = vi
      .fn()
      .mockRejectedValueOnce({
        statusCode: 423,
        code: 'resourceLocked',
        message: 'The resource you are attempting to access is locked',
      })
      .mockResolvedValueOnce({ id: 'ITEM-1', webUrl: 'https://onedrive.test/workbook.xlsx' })
    const { request: uploadRequest } = makeUploadRequest(put)
    let eTagRead = 0
    const graphClient = {
      api: vi.fn((url: string) => {
        if (url.includes('/shares/')) {
          eTagRead += 1
          return {
            get: () =>
              Promise.resolve({
                id: 'ITEM-1',
                eTag: `"ETAG-${eTagRead}"`,
                webUrl: 'https://onedrive.test/workbook.xlsx',
                parentReference: { driveId: 'DRIVE-1' },
              }),
          }
        }
        if (url.endsWith('/content')) {
          return {
            responseType: () => ({ get: () => Promise.resolve(makeWorkbookBuffer()) }),
            header: uploadRequest.header,
          }
        }
        return {}
      }),
    }

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
    expect(put).toHaveBeenCalledTimes(2)
  })

  it('ODF-02d: fichier OneDrive verrouillé persistant → message actionnable', async () => {
    const put = vi.fn().mockRejectedValue({
      statusCode: 423,
      message: 'The resource you are attempting to access is locked',
    })
    const { request: uploadRequest } = makeUploadRequest(put)
    const graphClient = {
      api: vi.fn((url: string) => {
        if (url.includes('/shares/')) {
          return {
            get: () =>
              Promise.resolve({
                id: 'ITEM-1',
                eTag: '"ETAG-1"',
                webUrl: 'https://onedrive.test/workbook.xlsx',
                parentReference: { driveId: 'DRIVE-1' },
              }),
          }
        }
        if (url.endsWith('/content')) {
          return {
            responseType: () => ({ get: () => Promise.resolve(makeWorkbookBuffer()) }),
            header: uploadRequest.header,
          }
        }
        return {}
      }),
    }

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
    expect(put).toHaveBeenCalledTimes(4)
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
    })

    expect(config).toEqual({
      shareUrl: 'https://1drv.ms/x/test',
      itemId: undefined,
      driveId: undefined,
      worksheetName: 'SUIVI_SAV',
    })
  })
})
