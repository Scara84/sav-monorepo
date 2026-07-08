import type { ClaimWorkbookRow } from './supplier-claim-writer'

const GRAPH_DRIVES_BASE = 'https://graph.microsoft.com/v1.0/drives'
const GRAPH_SHARES_BASE = 'https://graph.microsoft.com/v1.0/shares'
const DEFAULT_WORKSHEET_NAME = 'SUIVI_SAV'
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
  api: (path: string) => GraphRequestLike
}

interface GraphRequestLike {
  get?: () => Promise<unknown>
  post?: (body?: unknown) => Promise<unknown>
  header?: (name: string, value: string) => GraphRequestLike
}

export interface SupplierClaimOneDriveConfig {
  shareUrl: string | undefined
  itemId: string | undefined
  driveId: string | undefined
  worksheetName?: string
  tableName?: string
}

export interface SupplierClaimOneDriveResult {
  status: 'success' | 'skipped' | 'failed'
  webUrl?: string
  message?: string
  appendedRows?: number
}

interface SupplierClaimOneDriveDeps {
  graphClient?: GraphClientLike
  retryDelayMs?: number
  photoFolderUrl?: string | null
}

interface ResolvedWorkbook {
  driveId: string
  itemId: string
  eTag: string
  webUrl?: string
}

interface WorkbookSessionResponse {
  id?: string
}

interface WorkbookTableResponse {
  id?: string
  name?: string
}

interface WorkbookTablesResponse {
  value?: WorkbookTableResponse[]
}

export function readSupplierClaimOneDriveConfig(
  env: NodeJS.ProcessEnv = process.env
): SupplierClaimOneDriveConfig | null {
  const shareUrl = env['SUPPLIER_CLAIM_ONEDRIVE_SHARE_URL']?.trim()
  const itemId = env['SUPPLIER_CLAIM_ONEDRIVE_ITEM_ID']?.trim()
  const driveId = env['SUPPLIER_CLAIM_ONEDRIVE_DRIVE_ID']?.trim() || env['MICROSOFT_DRIVE_ID']?.trim()
  const worksheetName = env['SUPPLIER_CLAIM_ONEDRIVE_WORKSHEET']?.trim() || DEFAULT_WORKSHEET_NAME
  const tableName = env['SUPPLIER_CLAIM_ONEDRIVE_TABLE']?.trim()

  if (!shareUrl && !itemId) return null
  return { shareUrl, itemId, driveId, worksheetName, ...(tableName ? { tableName } : {}) }
}

export async function appendSupplierClaimRowsToOneDrive(
  rows: ClaimWorkbookRow[],
  config: SupplierClaimOneDriveConfig | null = readSupplierClaimOneDriveConfig(),
  deps: SupplierClaimOneDriveDeps = {}
): Promise<SupplierClaimOneDriveResult> {
  if (rows.length === 0) {
    return { status: 'skipped', message: 'Aucune ligne à ajouter dans OneDrive.' }
  }

  if (config === null) {
    return { status: 'skipped', message: 'Configuration OneDrive fournisseur absente.' }
  }

  try {
    const client = deps.graphClient ?? getDefaultGraphClient()
    const workbook = await appendWithRetry(client, config, rows, deps.retryDelayMs, deps.photoFolderUrl ?? null)

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
  retryDelayMs: number | undefined,
  photoFolderUrl: string | null
): Promise<ResolvedWorkbook> {
  let lastRetryableError: unknown = null

  for (let attempt = 0; attempt < MAX_UPLOAD_ATTEMPTS; attempt++) {
    const workbook = await resolveWorkbook(client, config)

    try {
      await appendRowsWithExcelApi(client, workbook, rows, config, photoFolderUrl)
      return workbook
    } catch (err) {
      const retryable = isETagConflict(err) || isOneDriveLocked(err) || isGraphTimeout(err)
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

async function appendRowsWithExcelApi(
  client: GraphClientLike,
  workbook: ResolvedWorkbook,
  rows: ClaimWorkbookRow[],
  config: SupplierClaimOneDriveConfig,
  photoFolderUrl: string | null
): Promise<void> {
  const sessionId = await createWorkbookSession(client, workbook)
  try {
    const table = await resolveWorkbookTable(client, workbook, config, sessionId)
    const values = rows.map((row) => toSupplierTrackingTableRow(row, photoFolderUrl))
    const request = withWorkbookSession(
      client.api(`${workbookApiPath(workbook)}/tables/${encodeGraphPathSegment(table)}/rows/add`),
      sessionId
    )
    if (!request.post) {
      throw new Error('Client Graph invalide : méthode post absente.')
    }
    await request.post({ values })
  } finally {
    await closeWorkbookSession(client, workbook, sessionId)
  }
}

async function createWorkbookSession(client: GraphClientLike, workbook: ResolvedWorkbook): Promise<string> {
  const request = client.api(`${workbookApiPath(workbook)}/createSession`)
  if (!request.post) {
    throw new Error('Client Graph invalide : méthode post absente.')
  }
  const session = (await request.post({ persistChanges: true })) as WorkbookSessionResponse | undefined
  if (!session?.id) {
    throw new Error('Session Excel OneDrive introuvable.')
  }
  return session.id
}

async function closeWorkbookSession(
  client: GraphClientLike,
  workbook: ResolvedWorkbook,
  sessionId: string
): Promise<void> {
  const request = withWorkbookSession(client.api(`${workbookApiPath(workbook)}/closeSession`), sessionId)
  if (!request.post) return
  try {
    await request.post({})
  } catch {
    // Best-effort: persistent sessions save changes as calls are made.
  }
}

async function resolveWorkbookTable(
  client: GraphClientLike,
  workbook: ResolvedWorkbook,
  config: SupplierClaimOneDriveConfig,
  sessionId: string
): Promise<string> {
  if (config.tableName) return config.tableName

  const worksheetName = config.worksheetName || DEFAULT_WORKSHEET_NAME
  const request = withWorkbookSession(
    client.api(`${workbookApiPath(workbook)}/worksheets/${encodeGraphPathSegment(worksheetName)}/tables`),
    sessionId
  )
  if (!request.get) {
    throw new Error('Client Graph invalide : méthode get absente.')
  }

  const response = (await request.get()) as WorkbookTablesResponse | undefined
  const tables = response?.value ?? []
  if (tables.length === 1) {
    const table = tables[0]!
    const identifier = table.name || table.id
    if (identifier) return identifier
  }
  if (tables.length === 0) {
    throw new Error(`Aucun tableau Excel trouvé dans l'onglet ${worksheetName}.`)
  }
  throw new Error('Plusieurs tableaux Excel trouvés : définissez SUPPLIER_CLAIM_ONEDRIVE_TABLE.')
}

function toSupplierTrackingTableRow(row: ClaimWorkbookRow, photoFolderUrl: string | null): unknown[] {
  return ['', '', ...row, photoFolderUrl ?? '', '', '', '', '', '', '', '', '']
}

function workbookApiPath(workbook: ResolvedWorkbook): string {
  return `${GRAPH_DRIVES_BASE}/${workbook.driveId}/items/${workbook.itemId}/workbook`
}

function withWorkbookSession(request: GraphRequestLike, sessionId: string): GraphRequestLike {
  return request.header?.('workbook-session-id', sessionId) ?? request
}

function encodeGraphPathSegment(value: string): string {
  return encodeURIComponent(value).replace(/'/g, '%27')
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

function isGraphTimeout(err: unknown): boolean {
  const e = err as { statusCode?: number; status?: number } | null
  return e?.statusCode === 504 || e?.status === 504
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
