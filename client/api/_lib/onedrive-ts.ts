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
