// Wrapper TS typé autour de `mime.js` (CommonJS legacy).
import * as legacy from './mime.js'

export const isMimeAllowed: (m: string) => boolean = (
  legacy as { isMimeAllowed: (m: string) => boolean }
).isMimeAllowed

export const ALLOWED_MIME_TYPES: readonly string[] = (
  legacy as { ALLOWED_MIME_TYPES: readonly string[] }
).ALLOWED_MIME_TYPES
