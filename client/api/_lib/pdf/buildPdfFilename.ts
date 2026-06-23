/**
 * Story 4.5 — construction du nom de fichier PDF d'un bon SAV.
 *
 * Format : `<AV-YYYY-NNNNN> <nom-client>[ <P>.].pdf`
 *   - Source : `credit_notes.number_formatted` + membre
 *   - Exemple : `AV-2026-00042 Dupont J.pdf`
 *
 * Contraintes :
 *   - Sanitizer : tout caractère non `[A-Za-z0-9 .-]` → `_`
 *     (compat OneDrive / Windows, cf. Story 4.5 AC #2).
 *   - Tronqué à 80 caractères (avant `.pdf`), extension toujours `.pdf`.
 *   - `first_name` optionnel — si absent, uniquement `last_name`.
 *
 * Pur, stateless, aucun I/O.
 */

const FORBIDDEN = /[^A-Za-z0-9 .\-]/g
const MAX_STEM_LEN = 80

export interface BuildPdfFilenameInput {
  number_formatted: string
  first_name: string | null
  last_name: string
}

export function buildPdfFilename(input: BuildPdfFilenameInput): string {
  const numberPart = sanitize(input.number_formatted)
  const lastName = sanitize(input.last_name)
  // CR 4.5 P12 : trim avant check longueur pour traiter `"   "` comme null
  // (évite le suffixe " ." ou " _." sur prénom whitespace-only).
  const firstTrimmed = input.first_name === null ? '' : input.first_name.trim()
  const initial =
    firstTrimmed.length > 0 ? ` ${sanitize(firstTrimmed.charAt(0)).toUpperCase()}.` : ''

  let stem = `${numberPart} ${lastName}${initial}`.trim()
  if (stem.length > MAX_STEM_LEN) {
    stem = stem.slice(0, MAX_STEM_LEN).trimEnd()
  }
  return `${stem}.pdf`
}

function sanitize(raw: string): string {
  return raw.replace(FORBIDDEN, '_')
}
