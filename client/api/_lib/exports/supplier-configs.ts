import { rufinoConfig } from './rufinoConfig'
import type { SupplierExportConfig } from './supplierExportBuilder'

/**
 * Story 5.2 — résolution `supplier_code → SupplierExportConfig`.
 *
 * Pattern FR36 : ce fichier est une map déclarative. Ajouter MARTINEZ
 * Story 5.6 = pur ajout d'une entrée `martinez: martinezConfig`. Aucun
 * changement dans le builder générique (`supplierExportBuilder.ts`) ni
 * dans le handler endpoint (qui consomme `supplierConfigs[code]`).
 *
 * Clés en lowercase (convention REST) ; le handler uppercase le code
 * reçu côté body pour insertion DB.
 */

export const supplierConfigs: Record<string, SupplierExportConfig> = {
  rufino: rufinoConfig,
}

export function resolveSupplierConfig(supplierCode: string): SupplierExportConfig | null {
  const key = supplierCode.trim().toLowerCase()
  return supplierConfigs[key] ?? null
}
