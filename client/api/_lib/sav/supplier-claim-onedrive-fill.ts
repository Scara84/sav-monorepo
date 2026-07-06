import * as XLSX from 'xlsx'
import { ResponseType } from '@microsoft/microsoft-graph-client'
import type { ClaimWorkbookRow } from './supplier-claim-writer'

const GRAPH_DRIVES_BASE = 'https://graph.microsoft.com/v1.0/drives'
const GRAPH_SHARES_BASE = 'https://graph.microsoft.com/v1.0/shares'
const DEFAULT_WORKSHEET_NAME = 'SUIVI_SAV'
const TARGET_START_COL_INDEX = 2 // C, zero-based
const TARGET_END_COL_INDEX = 14 // O, zero-based
const MIN_DATA_ROW = 3
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const MAX_UPLOAD_ATTEMPTS = 2

interface GraphDriveItemResponse {
  id?: string
  eTag?: string
  '@odata.etag'?: string
  webUrl?: string
  parentReference?: {
    driveId?: string
  }
}

interface GraphClientLike {
  api: (path: string) => {
    get?: () => Promise<unknown>
    put?: (body: Buffer | Uint8Array) => Promise<GraphDriveItemResponse>
    responseType?: (type: ResponseType) => {
      get: () => Promise<ArrayBuffer | Buffer | Uint8Array>
    }
    header?: (
      name: string,
      value: string
    ) => {
      header: (
        nextName: string,
        nextValue: string
      ) => {
        put: (body: Buffer | Uint8Array) => Promise<GraphDriveItemResponse>
      }
      put: (body: Buffer | Uint8Array) => Promise<GraphDriveItemResponse>
    }
  }
}

export interface SupplierClaimOneDriveConfig {
  shareUrl: string | undefined
  itemId: string | undefined
  driveId: string | undefined
  worksheetName?: string
}

export interface SupplierClaimOneDriveResult {
  status: 'success' | 'skipped' | 'failed'
  webUrl?: string
  message?: string
  appendedRows?: number
}

interface ResolvedWorkbook {
  driveId: string
  itemId: string
  eTag: string
  webUrl?: string
}

export function readSupplierClaimOneDriveConfig(
  env: NodeJS.ProcessEnv = process.env
): SupplierClaimOneDriveConfig | null {
  const shareUrl = env['SUPPLIER_CLAIM_ONEDRIVE_SHARE_URL']?.trim()
  const itemId = env['SUPPLIER_CLAIM_ONEDRIVE_ITEM_ID']?.trim()
  const driveId = env['SUPPLIER_CLAIM_ONEDRIVE_DRIVE_ID']?.trim() || env['MICROSOFT_DRIVE_ID']?.trim()
  const worksheetName = env['SUPPLIER_CLAIM_ONEDRIVE_WORKSHEET']?.trim() || DEFAULT_WORKSHEET_NAME

  if (!shareUrl && !itemId) return null
  return { shareUrl, itemId, driveId, worksheetName }
}

export async function appendSupplierClaimRowsToOneDrive(
  rows: ClaimWorkbookRow[],
  config: SupplierClaimOneDriveConfig | null = readSupplierClaimOneDriveConfig(),
  deps: { graphClient?: GraphClientLike } = {}
): Promise<SupplierClaimOneDriveResult> {
  if (rows.length === 0) {
    return { status: 'skipped', message: 'Aucune ligne à ajouter dans OneDrive.' }
  }

  if (config === null) {
    return { status: 'skipped', message: 'Configuration OneDrive fournisseur absente.' }
  }

  try {
    const client = deps.graphClient ?? getDefaultGraphClient()
    const workbook = await appendWithRetry(client, config, rows)

    return {
      status: 'success',
      appendedRows: rows.length,
      message: `${rows.length} ligne(s) ajoutée(s) dans OneDrive.`,
      ...(workbook.webUrl ? { webUrl: workbook.webUrl } : {}),
    }
  } catch (err) {
    return {
      status: 'failed',
      message: err instanceof Error ? err.message : 'Erreur OneDrive inconnue.',
    }
  }
}

async function appendWithRetry(
  client: GraphClientLike,
  config: SupplierClaimOneDriveConfig,
  rows: ClaimWorkbookRow[]
): Promise<ResolvedWorkbook> {
  let lastConflict: unknown = null

  for (let attempt = 0; attempt < MAX_UPLOAD_ATTEMPTS; attempt++) {
    const workbook = await resolveWorkbook(client, config)
    const buffer = await downloadWorkbook(client, workbook)
    const updated = appendRowsToWorkbookBuffer(buffer, rows, config.worksheetName || DEFAULT_WORKSHEET_NAME)

    try {
      await uploadWorkbook(client, workbook, updated)
      return workbook
    } catch (err) {
      if (!isETagConflict(err) || attempt === MAX_UPLOAD_ATTEMPTS - 1) {
        throw err
      }
      lastConflict = err
    }
  }

  throw lastConflict instanceof Error ? lastConflict : new Error('Conflit OneDrive pendant la mise à jour.')
}

async function resolveWorkbook(
  client: GraphClientLike,
  config: SupplierClaimOneDriveConfig
): Promise<ResolvedWorkbook> {
  if (config.shareUrl) {
    const shareId = toGraphShareId(config.shareUrl)
    const item = (await client.api(`${GRAPH_SHARES_BASE}/${shareId}/driveItem`).get?.()) as
      | GraphDriveItemResponse
      | undefined
    if (!item?.id || !item.parentReference?.driveId) {
      throw new Error('Classeur OneDrive fournisseur introuvable depuis le lien de partage.')
    }
    return {
      driveId: item.parentReference.driveId,
      itemId: item.id,
      eTag: getETag(item),
      ...(item.webUrl ? { webUrl: item.webUrl } : {}),
    }
  }

  if (!config.itemId || !config.driveId) {
    throw new Error('Configuration OneDrive fournisseur incomplète.')
  }

  const item = (await client.api(`${GRAPH_DRIVES_BASE}/${config.driveId}/items/${config.itemId}`).get?.()) as
    | GraphDriveItemResponse
    | undefined
  return {
    driveId: config.driveId,
    itemId: config.itemId,
    eTag: getETag(item),
    ...(item?.webUrl ? { webUrl: item.webUrl } : {}),
  }
}

function appendRowsToWorkbookBuffer(
  buffer: Buffer,
  rows: ClaimWorkbookRow[],
  worksheetName: string
): Buffer {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false })
  const worksheet = workbook.Sheets[worksheetName]
  if (!worksheet) {
    throw new Error(`Onglet OneDrive introuvable : ${worksheetName}`)
  }

  const nextRow = getNextAppendRow(worksheet)
  XLSX.utils.sheet_add_aoa(worksheet, rows, { origin: { r: nextRow - 1, c: TARGET_START_COL_INDEX } })
  return Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }))
}

function getNextAppendRow(worksheet: XLSX.WorkSheet): number {
  const ref = worksheet['!ref']
  if (!ref) return MIN_DATA_ROW

  const range = XLSX.utils.decode_range(ref)
  let lastDataRow = MIN_DATA_ROW - 1

  for (let row = Math.max(MIN_DATA_ROW - 1, range.s.r); row <= range.e.r; row++) {
    for (let col = TARGET_START_COL_INDEX; col <= TARGET_END_COL_INDEX; col++) {
      const cell = worksheet[XLSX.utils.encode_cell({ r: row, c: col })]
      if (cell?.v !== null && cell?.v !== undefined && String(cell.v).trim() !== '') {
        lastDataRow = Math.max(lastDataRow, row + 1)
        break
      }
    }
  }

  return Math.max(MIN_DATA_ROW, lastDataRow + 1)
}

async function downloadWorkbook(client: GraphClientLike, workbook: ResolvedWorkbook): Promise<Buffer> {
  const request = client.api(`${GRAPH_DRIVES_BASE}/${workbook.driveId}/items/${workbook.itemId}/content`)
  if (!request.responseType) {
    throw new Error('Client Graph invalide : méthode responseType absente.')
  }
  const body = await request.responseType(ResponseType.ARRAYBUFFER).get()
  if (Buffer.isBuffer(body)) return body
  if (body instanceof Uint8Array) return Buffer.from(body)
  return Buffer.from(body)
}

async function uploadWorkbook(
  client: GraphClientLike,
  workbook: ResolvedWorkbook,
  buffer: Buffer
): Promise<void> {
  const request = client.api(`${GRAPH_DRIVES_BASE}/${workbook.driveId}/items/${workbook.itemId}/content`)
  if (!request.header) {
    throw new Error('Client Graph invalide : méthode header absente.')
  }
  await request
    .header('Content-Type', XLSX_MIME)
    .header('If-Match', workbook.eTag)
    .put(buffer)
}

export function toGraphShareId(shareUrl: string): string {
  const base64 = Buffer.from(shareUrl, 'utf8').toString('base64')
  return `u!${base64.replace(/=+$/g, '').replace(/\//g, '_').replace(/\+/g, '-')}`
}

function getETag(item: GraphDriveItemResponse | undefined): string {
  const eTag = item?.eTag ?? item?.['@odata.etag']
  if (!eTag) {
    throw new Error('Classeur OneDrive fournisseur sans eTag.')
  }
  return eTag
}

function isETagConflict(err: unknown): boolean {
  const e = err as { statusCode?: number; status?: number; code?: string } | null
  return e?.statusCode === 412 || e?.status === 412 || e?.code === 'preconditionFailed'
}

function getDefaultGraphClient(): GraphClientLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const graph = require('../graph.js') as { getGraphClient: () => GraphClientLike }
  return graph.getGraphClient()
}
