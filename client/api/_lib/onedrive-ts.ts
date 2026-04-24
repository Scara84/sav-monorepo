// Wrapper TS typé autour de `onedrive.js` (CommonJS legacy Phase 1).
// Garder la source JS inchangée (consommée par upload-session.js legacy toujours actif).
// Les nouveaux endpoints Story 2.4+ consomment via ce wrapper → plus lisible, typé,
// et surtout mockable proprement par vi.mock() dans les tests Vitest.
import * as legacy from './onedrive.js'

export const ensureFolderExists: (path: string) => Promise<string> = (
  legacy as { ensureFolderExists: (p: string) => Promise<string> }
).ensureFolderExists

export const createUploadSession: (args: {
  parentFolderId: string
  filename: string
}) => Promise<{ uploadUrl: string; expirationDateTime: string }> = (
  legacy as {
    createUploadSession: (args: {
      parentFolderId: string
      filename: string
    }) => Promise<{ uploadUrl: string; expirationDateTime: string }>
  }
).createUploadSession

// ==============================================================
// Story 4.5 — upload PDF bon SAV (buffer direct, < 4 MB)
// ==============================================================
//
// Pour un PDF typique (50-200 KB) le simple `PUT /content` suffit et évite
// l'overhead d'une upload session (appel supplémentaire + URL pré-signée).
// Graph API plafonne le PUT direct à 4 MB — au-delà il faut `createUploadSession`.
// Les PDF bon SAV ne dépassent jamais cette taille (10 lignes max + texte vectorisé).
//
// Retourne `{ itemId, webUrl }` → persistés sur `credit_notes.pdf_onedrive_item_id`
// et `credit_notes.pdf_web_url` par `generateCreditNotePdfAsync`.

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0/drives'
const MAX_DIRECT_PUT_BYTES = 4 * 1024 * 1024 // 4 MB Graph limit

export interface UploadCreditNotePdfResult {
  itemId: string
  webUrl: string
}

export interface UploadCreditNotePdfOptions {
  folder: string // ex: '/SAV_PDF/2026/04'
  graphClient?: unknown // injection test
  driveId?: string // injection test
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

/**
 * Upload un PDF buffer vers OneDrive à `<folder>/<filename>` et retourne
 * `{ itemId, webUrl }`. Le dossier est créé si absent (`ensureFolderExists`
 * idempotent). En cas de collision, conflictBehavior=rename → Graph suffixe
 * `(1)` automatiquement.
 *
 * Throw si :
 *   - buffer > 4 MB (hors budget PDF bon SAV)
 *   - Graph API 4xx/5xx (appelant responsable du retry — cf.
 *     `generate-credit-note-pdf.ts` : backoff exponentiel × 3)
 */
export async function uploadCreditNotePdf(
  buffer: Buffer,
  filename: string,
  options: UploadCreditNotePdfOptions
): Promise<UploadCreditNotePdfResult> {
  if (buffer.byteLength > MAX_DIRECT_PUT_BYTES) {
    throw new Error(
      `PDF ${filename} dépasse ${MAX_DIRECT_PUT_BYTES} octets (taille=${buffer.byteLength}). ` +
        'Direct PUT Graph API limité à 4 MB — utiliser createUploadSession.'
    )
  }

  // Graph client : soit injecté (test), soit récupéré via legacy graph.js.
  const injected = options.graphClient
  let client: GraphClientLike
  if (injected !== undefined) {
    client = injected as GraphClientLike
  } else {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const graph = require('./graph.js') as { getGraphClient: () => GraphClientLike }
    client = graph.getGraphClient()
  }

  const driveId = options.driveId ?? process.env['MICROSOFT_DRIVE_ID'] ?? ''
  if (driveId === '') {
    throw new Error("Variable d'environnement MICROSOFT_DRIVE_ID manquante")
  }

  // CR 4.5 P5 : forward les deps injectées à `ensureFolderExists` legacy,
  // sinon un test injectant un `graphClient` mock devrait aussi setter
  // `MICROSOFT_DRIVE_ID` (fuite d'abstraction). Le legacy accepte déjà
  // `{ graphClient, driveId }` comme 2e arg.
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

  // `conflictBehavior=rename` : si collision → Graph ajoute ` (1)` au nom de
  // fichier automatiquement. Rare en pratique (`<n°> <client>` unique) mais
  // filet idempotence si Story 4.5 regenerate pointe sur un `number` qui a
  // déjà un PDF (régénération = normalement on veut `replace` + même itemId,
  // mais le régénérateur vérifie `pdf_web_url IS NULL` en amont donc rename
  // n'arrivera jamais en happy path).
  const url =
    `${GRAPH_BASE}/${driveId}/items/${parentFolderId}:/${encodeURIComponent(filename)}:/content` +
    '?@microsoft.graph.conflictBehavior=rename'

  const response = await client.api(url).header('Content-Type', 'application/pdf').put(buffer)

  // CR 4.5 P9 : utiliser `== null` pour attraper `null` ET `undefined`.
  // Le DTO Graph peut théoriquement renvoyer `{ id: 'abc', webUrl: null }`
  // sur certains edge cases (proxy middleware, reponse malformée). Stricter
  // check évite un DB row avec `pdf_onedrive_item_id` set mais
  // `pdf_web_url` null (orphelin silencieux).
  if (response.id == null || response.webUrl == null) {
    throw new Error(
      `Graph API réponse invalide pour upload PDF ${filename} : id ou webUrl manquant`
    )
  }
  return { itemId: response.id, webUrl: response.webUrl }
}
