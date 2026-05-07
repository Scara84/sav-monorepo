/**
 * Story 4.8 — PATTERN-CSV-INJECTION-GUARD
 *
 * Helper pour protéger contre les formules injectées dans les cellules CSV/XLSX.
 *
 * Référence OWASP CSV Injection :
 *   https://owasp.org/www-community/attacks/CSV_Injection
 *
 * Décision DN-3 = Option A (préfixe silencieux) :
 *   Toute valeur string commençant par '=', '+', '-', '@', tabulation ou retour chariot
 *   est préfixée par une apostrophe (' ) pour la neutraliser.
 *   La valeur reste stockée et affichable comme texte littéral (inoffensif).
 *
 * Cette approche est préférable au rejet (DN-3 Option B) car :
 *   - Les fichiers fournisseurs peuvent contenir des codes commençant par '-' (ex: codes négatifs)
 *   - L'opérateur n'est pas bloqué par des faux positifs
 *   - La donnée reste traçable (avec le préfixe visible)
 */

/** Caractères déclenchant une formule injectable selon OWASP */
const DANGEROUS_PREFIXES = ['=', '+', '-', '@', '\t', '\r']

/**
 * Sanitise une cellule CSV/XLSX pour prévenir les formules injectées.
 *
 * @param value — valeur brute de la cellule (string)
 * @returns valeur sanitisée : préfixée par ' si dangereuse, inchangée sinon
 *
 * @example
 *   sanitizeCsvCell('=CMD()') → "'=CMD()"
 *   sanitizeCsvCell('+1') → "'+1"
 *   sanitizeCsvCell('RUF-001') → 'RUF-001' (inchangé)
 *   sanitizeCsvCell('') → '' (inchangé)
 */
export function sanitizeCsvCell(value: string): string {
  if (value.length === 0) return value
  const firstChar = value[0]
  if (firstChar !== undefined && DANGEROUS_PREFIXES.includes(firstChar)) {
    return `'${value}`
  }
  return value
}
