import * as legacy from '../onedrive.js'

/**
 * Story 5.2 — wrapper OneDrive pour les exports fournisseurs (XLSX).
 *
 * Pattern calqué sur `uploadCreditNotePdf` (Story 4.5) mais adapté XLSX :
 *   - Content-Type `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
 *   - Pas de cap 4 MB explicite (un export Rufino typique = 10-50 KB ; Graph
 *     direct PUT plafonne à 4 MB — on relaye l'erreur si dépassé)
 *   - `conflictBehavior=replace` : re-générer un export Rufino sur la même
 *     période doit écraser le fichier précédent (UX : l'opérateur attend
 *     le fichier le plus récent, pas un `(1)` / `(2)` suffixé).
 */

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0/drives'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export interface UploadExportXlsxResult {
  itemId: string
  webUrl: string
}

export interface UploadExportXlsxOptions {
  folder: string
  graphClient?: unknown
  driveId?: string
}

interface GraphClientLike {
  api: (path: string) => {
    put: (body: Buffer | Uint8Array) => Promise<{ id?: string; webUrl?: string }>
    header: (
      name: string,
      value: string
    ) => {
      put: (body: Buffer | Uint8Array) => Promise<{ id?: string; webUrl?: string }>
    }
  }
}

// CR 5.2 P6 — défense-en-profondeur path traversal. Le builder 5.1
// `resolveFileName` sanitize déjà `file_name` via une whitelist
// `[A-Za-z0-9._-]`. Ce guard ici attrape un appelant futur qui
// bypasserait le builder (bench direct, job admin, etc.). Un nom de
// fichier avec `/`, `\`, null byte, ou `..` remonterait l'arborescence
// OneDrive via Graph API (`items/...:/PATH:/content`).
function assertSafeFilename(filename: string): void {
  if (
    filename.length === 0 ||
    filename.length > 255 ||
    /[/\\\0]/.test(filename) ||
    filename.includes('..')
  ) {
    throw new Error(`Nom de fichier OneDrive invalide : ${filename.slice(0, 64)}`)
  }
}

export async function uploadExportXlsx(
  buffer: Buffer,
  filename: string,
  options: UploadExportXlsxOptions
): Promise<UploadExportXlsxResult> {
  assertSafeFilename(filename)
  const injected = options.graphClient
  let client: GraphClientLike
  if (injected !== undefined) {
    client = injected as GraphClientLike
  } else {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const graph = require('../graph.js') as { getGraphClient: () => GraphClientLike }
    client = graph.getGraphClient()
  }

  const driveId = options.driveId ?? process.env['MICROSOFT_DRIVE_ID'] ?? ''
  if (driveId === '') {
    // CR 5.2 P7 — préfixe explicite pour que le handler distingue une
    // erreur de config (500) d'un Graph transitoire (502). Le handler
    // filtre sur `err.message.startsWith('CONFIG_ERROR|')`.
    throw new Error('CONFIG_ERROR|MICROSOFT_DRIVE_ID manquant')
  }

  const legacyEnsure = (
    legacy as unknown as {
      ensureFolderExists: (
        path: string,
        deps?: { graphClient?: unknown; driveId?: string }
      ) => Promise<string>
    }
  ).ensureFolderExists
  const parentFolderId = await legacyEnsure(options.folder, {
    graphClient: client,
    driveId,
  })

  // `conflictBehavior=replace` : une re-génération du même export (même
  // fournisseur, même période) écrase le fichier existant. L'historique
  // reste tracé côté DB (supplier_exports append-only).
  const url =
    `${GRAPH_BASE}/${driveId}/items/${parentFolderId}:/${encodeURIComponent(filename)}:/content` +
    '?@microsoft.graph.conflictBehavior=replace'

  const response = await client.api(url).header('Content-Type', XLSX_MIME).put(buffer)

  if (response.id == null || response.webUrl == null) {
    throw new Error(
      `Graph API réponse invalide pour upload XLSX ${filename} : id ou webUrl manquant`
    )
  }
  return { itemId: response.id, webUrl: response.webUrl }
}
