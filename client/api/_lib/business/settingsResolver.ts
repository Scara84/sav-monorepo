/**
 * Story 4.2 — résolveur settings versionnés (PRD §NFR-D2, §FR60).
 *
 * Module PUR, stateless. L'appelant (handler serverless, Story 4.3/4.4) fetch
 * les lignes `settings` via Supabase et les passe en argument. Cette fonction
 * résout la valeur en vigueur à un timestamp donné (ou now()).
 *
 * Ne throw pas sur clé inconnue — retourne `null`, l'appelant décide si c'est
 * bloquant (Error Handling Rule 4 : jamais de fallback silencieux sur données
 * financières → l'appelant doit gérer explicitement).
 */

export type SettingRow = {
  key: string
  value: unknown
  valid_from: string // ISO 8601
  valid_to: string | null // ISO 8601 ou null (encore en vigueur)
  // W28 — id optionnel pour tie-break déterministe sur valid_from égal
  // (ordre Supabase fetch non garanti). Quand absent, fallback à -Infinity
  // → la première row au même valid_from gagne, comportement legacy.
  id?: number
}

function toDate(at: Date | string | undefined): Date {
  if (at === undefined) return new Date()
  if (at instanceof Date) return at
  return new Date(at)
}

/**
 * Résout la valeur d'une clé settings au timestamp donné (ou now).
 * Si plusieurs lignes sont en vigueur simultanément (race migration),
 * retourne la plus récente par `valid_from`. Tie-break déterministe
 * sur `id DESC` quand `valid_from` est égal (W28) — sinon ordre Supabase
 * fetch non garanti et le résultat dérive entre runs.
 */
export function resolveSettingAt<T = unknown>(
  rows: readonly SettingRow[],
  key: string,
  at?: Date | string
): T | null {
  const atDate = toDate(at)
  const atMs = atDate.getTime()

  let best: SettingRow | null = null
  let bestMs = -Infinity
  let bestId = -Infinity

  for (const row of rows) {
    if (row.key !== key) continue
    const fromMs = new Date(row.valid_from).getTime()
    // W32 — rejet explicite des dates non parsables (ex: valid_from='garbage')
    // pour ne jamais sélectionner une row corrompue comme best-row.
    if (Number.isNaN(fromMs)) continue
    if (fromMs > atMs) continue
    if (row.valid_to !== null) {
      const toMs = new Date(row.valid_to).getTime()
      if (Number.isNaN(toMs)) continue
      if (toMs <= atMs) continue
    }
    // W28 — tie-break déterministe : valid_from DESC, puis id DESC
    // (id optionnel : si absent, fallback -Infinity = legacy first-vue wins).
    const rowId = typeof row.id === 'number' ? row.id : -Infinity
    if (fromMs > bestMs || (fromMs === bestMs && rowId > bestId)) {
      best = row
      bestMs = fromMs
      bestId = rowId
    }
  }

  return best === null ? null : (best.value as T)
}

/**
 * Taux TVA par défaut en basis points (ex: 550 = 5.5 %).
 * Convention PRD : `settings.key = 'vat_rate_default'`, `value = <bigint cast as jsonb number>`.
 */
export function resolveDefaultVatRateBp(
  rows: readonly SettingRow[],
  at?: Date | string
): number | null {
  const raw = resolveSettingAt<unknown>(rows, 'vat_rate_default', at)
  if (raw === null || typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) return null
  return raw
}

/**
 * Remise responsable en basis points (ex: 400 = 4 %).
 * Convention PRD : `settings.key = 'group_manager_discount'`.
 */
export function resolveGroupManagerDiscountBp(
  rows: readonly SettingRow[],
  at?: Date | string
): number | null {
  const raw = resolveSettingAt<unknown>(rows, 'group_manager_discount', at)
  if (raw === null || typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > 10000)
    return null
  return raw
}
