import { ResponseType } from '@microsoft/microsoft-graph-client'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { ClaimWorkbookRow } from './supplier-claim-writer'

const GRAPH_DRIVES_BASE = 'https://graph.microsoft.com/v1.0/drives'
const GRAPH_SHARES_BASE = 'https://graph.microsoft.com/v1.0/shares'
const DEFAULT_WORKSHEET_NAME = 'SUIVI_SAV'
const TARGET_START_COL_INDEX = 2 // C, zero-based
const TARGET_END_COL_INDEX = 14 // O, zero-based
const MIN_DATA_ROW = 3
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const MAX_UPLOAD_ATTEMPTS = 4
const UPLOAD_RETRY_DELAYS_MS = [300, 900, 1_800]
const LOCKED_WORKBOOK_MESSAGE =
  'Le fichier OneDrive fournisseur est verrouillé. Fermez le classeur Excel/OneDrive, attendez quelques secondes, puis réessayez.'

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

type ZipEntries = Record<string, Uint8Array>

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
  deps: { graphClient?: GraphClientLike; retryDelayMs?: number } = {}
): Promise<SupplierClaimOneDriveResult> {
  if (rows.length === 0) {
    return { status: 'skipped', message: 'Aucune ligne à ajouter dans OneDrive.' }
  }

  if (config === null) {
    return { status: 'skipped', message: 'Configuration OneDrive fournisseur absente.' }
  }

  try {
    const client = deps.graphClient ?? getDefaultGraphClient()
    const workbook = await appendWithRetry(client, config, rows, deps.retryDelayMs)

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
  rows: ClaimWorkbookRow[],
  retryDelayMs: number | undefined
): Promise<ResolvedWorkbook> {
  let lastRetryableError: unknown = null

  for (let attempt = 0; attempt < MAX_UPLOAD_ATTEMPTS; attempt++) {
    const workbook = await resolveWorkbook(client, config)
    const buffer = await downloadWorkbook(client, workbook)
    const updated = appendRowsToWorkbookBuffer(buffer, rows, config.worksheetName || DEFAULT_WORKSHEET_NAME)

    try {
      await uploadWorkbook(client, workbook, updated)
      return workbook
    } catch (err) {
      const retryable = isETagConflict(err) || isOneDriveLocked(err)
      if (!retryable || attempt === MAX_UPLOAD_ATTEMPTS - 1) {
        if (isOneDriveLocked(err)) {
          throw new Error(LOCKED_WORKBOOK_MESSAGE)
        }
        throw err
      }
      lastRetryableError = err
      await sleep(retryDelayMs ?? UPLOAD_RETRY_DELAYS_MS[attempt] ?? 0)
    }
  }

  if (isOneDriveLocked(lastRetryableError)) {
    throw new Error(LOCKED_WORKBOOK_MESSAGE)
  }
  throw lastRetryableError instanceof Error ? lastRetryableError : new Error('Conflit OneDrive pendant la mise à jour.')
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
  const entries = unzipSync(buffer)
  const sheetPath = resolveWorksheetPath(entries, worksheetName)
  const sheetEntry = entries[sheetPath]
  if (!sheetEntry) {
    throw new Error(`Onglet OneDrive introuvable : ${worksheetName}`)
  }

  const sheetXml = strFromU8(sheetEntry)
  const nextRow = getNextAppendRowFromSheetXml(sheetXml)
  const finalRow = nextRow + rows.length - 1
  const updatedSheetXml = appendRowsToSheetXml(sheetXml, rows, nextRow)

  entries[sheetPath] = strToU8(updateWorksheetRefs(updatedSheetXml, finalRow))
  updateLinkedTableRefs(entries, sheetPath, finalRow)

  return Buffer.from(zipSync(entries))
}

function resolveWorksheetPath(entries: ZipEntries, worksheetName: string): string {
  const workbookXml = readZipText(entries, 'xl/workbook.xml')
  const workbookRelsXml = readZipText(entries, 'xl/_rels/workbook.xml.rels')
  const sheetRe = /<sheet\b[^>]*>/g
  let match: RegExpExecArray | null

  while ((match = sheetRe.exec(workbookXml)) !== null) {
    const tag = match[0]!
    if (decodeXmlAttr(readAttr(tag, 'name')) !== worksheetName) continue

    const relId = readAttr(tag, 'r:id') ?? readAttr(tag, 'id')
    if (!relId) break

    const rel = findRelationshipById(workbookRelsXml, relId)
    if (!rel?.target) break
    return normalizeZipPath('xl', rel.target)
  }

  throw new Error(`Onglet OneDrive introuvable : ${worksheetName}`)
}

function appendRowsToSheetXml(sheetXml: string, rows: ClaimWorkbookRow[], startRow: number): string {
  const sheetDataMatch = sheetXml.match(/<sheetData\b[^>]*>[\s\S]*?<\/sheetData>/)
  if (!sheetDataMatch?.[0]) {
    throw new Error('Feuille Excel invalide : sheetData manquant.')
  }

  const sheetDataXml = sheetDataMatch[0]
  const openTag = sheetDataXml.match(/^<sheetData\b[^>]*>/)?.[0] ?? '<sheetData>'
  const inner = sheetDataXml.slice(openTag.length, -'</sheetData>'.length)
  const rowMap = new Map<number, string>()
  const rowOrder: number[] = []
  const rowRe = /<row\b[^>]*(?:>[\s\S]*?<\/row>|\/>)/g
  let match: RegExpExecArray | null

  while ((match = rowRe.exec(inner)) !== null) {
    const rowXml = match[0]!
    const rowNumber = Number(readAttr(rowXml, 'r'))
    if (!Number.isInteger(rowNumber)) continue
    rowMap.set(rowNumber, rowXml)
    rowOrder.push(rowNumber)
  }

  for (let offset = 0; offset < rows.length; offset++) {
    const rowNumber = startRow + offset
    const styleMap = getStyleMapForRow(sheetXml, rowNumber - 1)
    const cells = buildCellsForRow(rows[offset]!, rowNumber, styleMap)
    rowMap.set(rowNumber, mergeCellsIntoRow(rowMap.get(rowNumber), rowNumber, cells))
    if (!rowOrder.includes(rowNumber)) rowOrder.push(rowNumber)
  }

  rowOrder.sort((a, b) => a - b)
  const updatedSheetData = `${openTag}${rowOrder.map((row) => rowMap.get(row) ?? '').join('')}</sheetData>`
  return sheetXml.replace(sheetDataXml, updatedSheetData)
}

function getNextAppendRowFromSheetXml(sheetXml: string): number {
  const cellRe = /<c\b[^>]*\br="([A-Z]+)(\d+)"[^>]*(?:>[\s\S]*?<\/c>|\/>)/g
  let lastDataRow = MIN_DATA_ROW - 1
  let match: RegExpExecArray | null

  while ((match = cellRe.exec(sheetXml)) !== null) {
    const col = columnNameToIndex(match[1]!)
    if (col < TARGET_START_COL_INDEX || col > TARGET_END_COL_INDEX) continue
    const row = Number(match[2])
    if (!Number.isInteger(row) || row < MIN_DATA_ROW) continue
    const cellXml = match[0]!
    if (cellHasValue(cellXml)) {
      lastDataRow = Math.max(lastDataRow, row)
    }
  }

  return Math.max(MIN_DATA_ROW, lastDataRow + 1)
}

function buildCellsForRow(
  values: ClaimWorkbookRow,
  rowNumber: number,
  styleMap: Map<number, string>
): string[] {
  return values.map((value, offset) => {
    const colIndex = TARGET_START_COL_INDEX + offset
    const colName = columnIndexToName(colIndex)
    const ref = `${colName}${rowNumber}`
    const style = styleMap.get(colIndex)
    const styleAttr = style ? ` s="${escapeXmlAttr(style)}"` : ''

    if (typeof value === 'number') {
      return `<c r="${ref}"${styleAttr}><v>${String(value)}</v></c>`
    }
    if (value === '') {
      return `<c r="${ref}"${styleAttr}/>`
    }
    return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t>${escapeXmlText(value)}</t></is></c>`
  })
}

function mergeCellsIntoRow(existingRowXml: string | undefined, rowNumber: number, newCells: string[]): string {
  const baseRowXml = existingRowXml ?? `<row r="${rowNumber}"></row>`
  const rowTagMatch = baseRowXml.match(/^<row\b[^>]*\/?>/)
  const rowTag = rowTagMatch?.[0]?.replace(/\/>$/, '>') ?? `<row r="${rowNumber}">`
  const existingCells: string[] = []
  const cellRe = /<c\b[^>]*\br="([A-Z]+)\d+"[^>]*(?:>[\s\S]*?<\/c>|\/>)/g
  let match: RegExpExecArray | null

  while ((match = cellRe.exec(baseRowXml)) !== null) {
    const colIndex = columnNameToIndex(match[1]!)
    if (colIndex < TARGET_START_COL_INDEX || colIndex > TARGET_END_COL_INDEX) {
      existingCells.push(match[0]!)
    }
  }

  const cells = [...existingCells, ...newCells]
  cells.sort((a, b) => {
    const aRef = readAttr(a, 'r') ?? 'A1'
    const bRef = readAttr(b, 'r') ?? 'A1'
    return columnNameToIndex(aRef.replace(/\d+$/, '')) - columnNameToIndex(bRef.replace(/\d+$/, ''))
  })

  return `${rowTag}${cells.join('')}</row>`
}

function getStyleMapForRow(sheetXml: string, rowNumber: number): Map<number, string> {
  const styles = new Map<number, string>()
  if (rowNumber < MIN_DATA_ROW) return styles

  const rowRe = new RegExp(`<row\\b[^>]*\\br="${rowNumber}"[^>]*(?:>[\\s\\S]*?<\\/row>|\\/>)`)
  const rowXml = sheetXml.match(rowRe)?.[0]
  if (!rowXml) return styles

  const cellRe = /<c\b[^>]*\br="([A-Z]+)\d+"[^>]*>/g
  let match: RegExpExecArray | null
  while ((match = cellRe.exec(rowXml)) !== null) {
    const colIndex = columnNameToIndex(match[1]!)
    const style = readAttr(match[0]!, 's')
    if (style) styles.set(colIndex, style)
  }
  return styles
}

function updateWorksheetRefs(sheetXml: string, finalRow: number): string {
  let updated = updateFirstRefAttr(sheetXml, 'dimension', finalRow)
  updated = updateFirstRefAttr(updated, 'autoFilter', finalRow)
  return updated
}

function updateLinkedTableRefs(entries: ZipEntries, sheetPath: string, finalRow: number): void {
  const relsPath = sheetPath.replace(/^(.*\/)([^/]+)$/, '$1_rels/$2.rels')
  const relsEntry = entries[relsPath]
  if (!relsEntry) return

  const relsXml = strFromU8(relsEntry)
  const relRe = /<Relationship\b[^>]*>/g
  let match: RegExpExecArray | null

  while ((match = relRe.exec(relsXml)) !== null) {
    const relTag = match[0]!
    const type = readAttr(relTag, 'Type') ?? ''
    if (!type.endsWith('/table')) continue

    const target = readAttr(relTag, 'Target')
    if (!target) continue
    const tablePath = normalizeZipPath(pathDir(sheetPath), target)
    const tableEntry = entries[tablePath]
    if (!tableEntry) continue

    const tableXml = strFromU8(tableEntry)
    entries[tablePath] = strToU8(updateFirstRefAttr(updateFirstRefAttr(tableXml, 'table', finalRow), 'autoFilter', finalRow))
  }
}

function updateFirstRefAttr(xml: string, tagName: string, finalRow: number): string {
  const tagRe = new RegExp(`<${tagName}\\b[^>]*\\bref="([^"]+)"[^>]*>`)
  const match = xml.match(tagRe)
  if (!match?.[0] || !match[1]) return xml
  const nextRef = extendRefRows(match[1], finalRow)
  if (nextRef === match[1]) return xml
  return xml.replace(match[0], match[0].replace(`ref="${match[1]}"`, `ref="${nextRef}"`))
}

function extendRefRows(ref: string, finalRow: number): string {
  const match = ref.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/)
  if (!match) return ref
  const endRow = Math.max(Number(match[4]), finalRow)
  return `${match[1]}${match[2]}:${match[3]}${endRow}`
}

function findRelationshipById(xml: string, id: string): { target: string } | null {
  const relRe = /<Relationship\b[^>]*>/g
  let match: RegExpExecArray | null
  while ((match = relRe.exec(xml)) !== null) {
    const tag = match[0]!
    if (readAttr(tag, 'Id') === id) {
      const target = readAttr(tag, 'Target')
      return target ? { target } : null
    }
  }
  return null
}

function readZipText(entries: ZipEntries, path: string): string {
  const entry = entries[path]
  if (!entry) throw new Error(`Fichier XLSX invalide : ${path} manquant.`)
  return strFromU8(entry)
}

function readAttr(tag: string, attr: string): string | null {
  const escaped = attr.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
  return tag.match(new RegExp(`\\b${escaped}="([^"]*)"`))?.[1] ?? null
}

function cellHasValue(cellXml: string): boolean {
  const value = cellXml.match(/<v>([\s\S]*?)<\/v>/)?.[1]
  if (value !== undefined) return value.trim() !== ''
  const inlineText = cellXml.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/)?.[1]
  if (inlineText !== undefined) return inlineText.trim() !== ''
  if (/<f\b[^>]*>[\s\S]*?<\/f>/.test(cellXml)) return true
  return false
}

function normalizeZipPath(base: string, target: string): string {
  const raw = target.startsWith('/') ? target.slice(1) : `${base}/${target}`
  const parts: string[] = []
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/')
}

function pathDir(path: string): string {
  return path.slice(0, path.lastIndexOf('/'))
}

function columnIndexToName(index: number): string {
  let n = index + 1
  let name = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    name = String.fromCharCode(65 + rem) + name
    n = Math.floor((n - 1) / 26)
  }
  return name
}

function columnNameToIndex(name: string): number {
  let n = 0
  for (const char of name) {
    n = n * 26 + char.charCodeAt(0) - 64
  }
  return n - 1
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replace(/"/g, '&quot;')
}

function decodeXmlAttr(value: string | null): string | null {
  if (value === null) return null
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
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

function isOneDriveLocked(err: unknown): boolean {
  const e = err as { statusCode?: number; status?: number; code?: string; message?: string; body?: unknown } | null
  const body = typeof e?.body === 'string' ? e.body : ''
  const message = `${e?.code ?? ''} ${e?.message ?? ''} ${body}`.toLowerCase()
  return (
    e?.statusCode === 423 ||
    e?.status === 423 ||
    e?.code === 'resourceLocked' ||
    message.includes('resourcelocked') ||
    message.includes('resource you are attempting to access is locked')
  )
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function getDefaultGraphClient(): GraphClientLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const graph = require('../graph.js') as { getGraphClient: () => GraphClientLike }
  return graph.getGraphClient()
}
