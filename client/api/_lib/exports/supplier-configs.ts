import { rufinoConfig } from './rufinoConfig'
import { martinezConfig } from './martinezConfig'
import type { SupplierExportConfig } from './supplierExportBuilder'

/**
 * Story 5.2 / 5.6 — résolution `supplier_code → SupplierExportConfig`.
 *
 * Pattern FR36 (validé Story 5.6) : ce fichier est une map déclarative.
 * Ajouter un fournisseur N+1 (Alvarez, Garcia, …) = pur ajout d'une
 * entrée `<key>: <key>Config`. Aucun changement dans le builder
 * générique (`supplierExportBuilder.ts`) ni dans le handler endpoint
 * (qui consomme `supplierConfigs[code]`).
 *
 * Story 5.6 — `as const` permet d'auto-dériver le type
 * `KnownSupplierCode = 'RUFINO' | 'MARTINEZ' | …` sans cast manuel
 * downstream. Les clés sont en UPPERCASE (alignées sur le code stocké
 * en DB) ; le handler uppercase le code reçu côté body avant lookup.
 *
 * `KnownSupplierCode` est exporté pour que le handler `config-list`
 * puisse typer la liste retournée et que les ajouts futurs étendent
 * automatiquement le type.
 */

const _registry = {
  RUFINO: rufinoConfig,
  MARTINEZ: martinezConfig,
} as const satisfies Record<string, SupplierExportConfig>

/**
 * CR Story 5.6 P19 — Conserver le type narrow de `_registry` jusqu'aux
 * consommateurs. Un export `Record<string, SupplierExportConfig>` élargi
 * neutraliserait le bénéfice de `as const satisfies` (le lookup
 * `supplierConfigs[someString]` perdrait l'union littérale `KnownSupplierCode`).
 * Les rares consommateurs qui ont une string brute passent par
 * `resolveSupplierConfig()` qui retourne `null` sur clé inconnue.
 */
export const supplierConfigs = _registry

export type KnownSupplierCode = keyof typeof _registry

export function resolveSupplierConfig(supplierCode: string): SupplierExportConfig | null {
  const key = supplierCode.trim().toUpperCase()
  // Cast explicite — `key` peut être n'importe quelle string ; le `?? null`
  // gère le cas hors-registry sans throw.
  return (_registry as Record<string, SupplierExportConfig>)[key] ?? null
}

/**
 * Story 5.6 — liste des fournisseurs disponibles pour le UI dynamique
 * (modal export + filtre historique). Ordre stable = ordre de
 * déclaration de `_registry` (insertion order JS).
 *
 * CR Story 5.6 P7 — DOIT rester en sync avec `SupplierConfigEntry` exporté
 * par `client/src/features/back-office/composables/useSupplierExport.ts`.
 * Pas d'import croisé api↔src pour ne pas faire fuiter ce module serveur
 * dans le bundle SPA. Si un champ est ajouté ici, l'ajouter aussi côté
 * composable + valider dans `isSupplierConfigEntry`.
 */
export interface SupplierConfigEntry {
  code: string
  label: string
  language: 'fr' | 'es'
}

function humanLabel(code: string): string {
  // Capitalize first char only : RUFINO → Rufino, MARTINEZ → Martinez.
  // V1 simple — si on a besoin d'un display name distinct du code
  // technique (ex. "Rufino SARL"), on ajoutera un champ `display_name`
  // au contrat `SupplierExportConfig` (changement isolé).
  if (code.length === 0) return code
  return code.charAt(0).toUpperCase() + code.slice(1).toLowerCase()
}

export function listSupplierConfigs(): SupplierConfigEntry[] {
  return Object.entries(_registry).map(([code, cfg]) => ({
    code,
    label: `${humanLabel(code)} (${cfg.language.toUpperCase()})`,
    language: cfg.language,
  }))
}
