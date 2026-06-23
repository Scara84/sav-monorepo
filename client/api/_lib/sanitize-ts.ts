// Wrapper TS typé autour de `sanitize.js` (CommonJS legacy).
import * as legacy from './sanitize.js'

export const sanitizeFilename: (name: string) => string | null = (
  legacy as { sanitizeFilename: (n: string) => string | null }
).sanitizeFilename

export const sanitizeSavDossier: (name: string) => string | null = (
  legacy as { sanitizeSavDossier: (n: string) => string | null }
).sanitizeSavDossier
