/**
 * Story 5.6 — configuration export fournisseur MARTINEZ (2e fournisseur).
 *
 * **Validation empirique FR36** : ce fichier prouve que l'ajout d'un
 * nouveau fournisseur se fait par PUR ajout de configuration. Aucune
 * modification de `supplierExportBuilder.ts` (verrouillé par le test
 * guard Story 5.1 AC #11 `supplier-export-builder.guard.spec.ts`).
 *
 * **Config V1 hypothétique** : pas de partenariat MARTINEZ réel chez
 * Fruitstock V1. Les libellés/widths/formats divergent de Rufino sur
 * suffisamment de points pour prouver le découplage. À ajuster lorsqu'un
 * vrai client MARTINEZ sera intégré (changement isolé à ce fichier).
 *
 * Différences vs Rufino (preuve config-driven) :
 *   - Libellés colonnes : FECHA_RECEPCION, NUM_PEDIDO, ALBARÁN (avec
 *     accent), CLIENTE_FRUIT, DESCRIPCIÓN_ES, CANTIDAD, PESO_KG,
 *     PRECIO_UNIT, TOTAL, DETERIORADO.
 *   - Formats : PESO_KG en `integer` (vs Rufino decimal), PRECIO_UNIT
 *     en cents-to-euros (idem Rufino), TOTAL via formula.
 *   - Widths : ajustées au plus large de chaque libellé.
 *   - Formula key : `TOTAL` (vs Rufino `IMPORTE`).
 *
 * Décision Option C (AC #2) : MARTINEZ réutilise `value_es` Story 5.1
 * sans divergence — pas de table `supplier_translations` V1. Un vrai
 * client MARTINEZ avec besoin de traduction divergente déclenchera un
 * refacto dédié (Option B post-V1).
 */

import { logger } from '../logger'
import type { SupplierExportConfig, ExportRow } from './supplierExportBuilder'

// Largeurs colonnes — divergent volontairement de Rufino pour prouver
// que la config pilote l'écriture XLSX.
const W_FECHA_RECEPCION = 14
const W_NUM_PEDIDO = 14
const W_ALBARAN = 16
const W_CLIENTE_FRUIT = 32
const W_DESCRIPCION_ES = 42
const W_CANTIDAD = 10
const W_PESO_KG = 10
const W_PRECIO_UNIT = 12
const W_TOTAL = 14
const W_DETERIORADO = 22

/**
 * Extrait la première entrée `kind='cause'` de `sav_lines.validation_messages`.
 * Identique au helper `rufinoConfig.ts` mais dupliqué intentionnellement —
 * chaque config est autonome, pas de couplage entre fournisseurs.
 */
function extractCauseText(row: ExportRow): string | null {
  const msgs = row.validation_messages
  if (!Array.isArray(msgs)) return null
  for (const m of msgs) {
    if (m && typeof m === 'object' && (m as { kind?: unknown }).kind === 'cause') {
      const text = (m as { text?: unknown }).text
      if (typeof text === 'string') {
        const trimmed = text.trim()
        if (trimmed.length > 0) return trimmed
      }
    }
  }
  return null
}

export const martinezConfig: SupplierExportConfig = {
  supplier_code: 'MARTINEZ',
  language: 'es',
  file_name_template: 'MARTINEZ_{period_from}_{period_to}.xlsx',
  formulas: {
    // TOTAL = CANTIDAD × PRECIO_UNIT. Index colonnes (1-based Excel) :
    //   FECHA_RECEPCION=A NUM_PEDIDO=B ALBARÁN=C CLIENTE_FRUIT=D
    //   DESCRIPCIÓN_ES=E CANTIDAD=F PESO_KG=G PRECIO_UNIT=H TOTAL=I
    //   DETERIORADO=J
    // ⇒ TOTAL = F{row} × H{row}
    TOTAL: '=F{row}*H{row}',
  },
  columns: [
    {
      key: 'FECHA_RECEPCION',
      header: 'FECHA_RECEPCION',
      source: { kind: 'field', path: 'sav.received_at' },
      format: 'date-iso',
      width: W_FECHA_RECEPCION,
    },
    {
      key: 'NUM_PEDIDO',
      header: 'NUM_PEDIDO',
      source: { kind: 'field', path: 'sav.reference' },
      format: 'text',
      width: W_NUM_PEDIDO,
    },
    {
      key: 'ALBARÁN',
      header: 'ALBARÁN',
      source: { kind: 'field', path: 'sav.invoice_ref' },
      format: 'text',
      width: W_ALBARAN,
    },
    {
      key: 'CLIENTE_FRUIT',
      header: 'CLIENTE_FRUIT',
      source: {
        kind: 'computed',
        compute: (ctx) => {
          const member = ctx.row.sav?.member
          if (!member) return ''
          const last = member.last_name ?? ''
          const first = member.first_name ?? ''
          return first ? `${last} ${first}`.trim() : last
        },
      },
      format: 'text',
      width: W_CLIENTE_FRUIT,
    },
    {
      key: 'DESCRIPCIÓN_ES',
      header: 'DESCRIPCIÓN_ES',
      // CR Story 5.6 P13 — pas de colonne `product.name_es` en DB V1
      // (idem rufinoConfig). Le nom français est exporté tel quel ; à
      // étendre quand un schéma multi-langue produit sera ajouté (W69).
      source: { kind: 'field', path: 'product.name_fr' },
      format: 'text',
      width: W_DESCRIPCION_ES,
    },
    {
      key: 'CANTIDAD',
      header: 'CANTIDAD',
      source: { kind: 'field', path: 'qty_invoiced' },
      format: 'integer',
      width: W_CANTIDAD,
    },
    {
      key: 'PESO_KG',
      header: 'PESO_KG',
      source: {
        kind: 'computed',
        compute: (ctx) => {
          // CR Story 5.6 P11 — DB stocke `piece_to_kg_weight_g` en grammes.
          // MARTINEZ veut un entier (hypothèse métier V1 divergente de
          // Rufino qui veut decimal). Troncature explicite ici (`Math.trunc`)
          // pour ne pas dépendre du choix arbitraire `Math.trunc` vs
          // `Math.round` du builder générique sur le format `'integer'` :
          // 3500 g → 3 kg, 3999 g → 3 kg (pas 4). À confirmer avec un vrai
          // partenaire MARTINEZ au cutover (V1 hypothétique).
          const g = ctx.row.piece_to_kg_weight_g
          if (typeof g !== 'number') return 0
          return Math.trunc(g / 1000)
        },
      },
      format: 'integer',
      width: W_PESO_KG,
    },
    {
      key: 'PRECIO_UNIT',
      header: 'PRECIO_UNIT',
      source: { kind: 'field', path: 'unit_price_ht_cents' },
      format: 'cents-to-euros',
      width: W_PRECIO_UNIT,
    },
    {
      key: 'TOTAL',
      header: 'TOTAL',
      source: { kind: 'formula', formula: 'TOTAL' },
      width: W_TOTAL,
    },
    {
      key: 'DETERIORADO',
      header: 'DETERIORADO',
      source: {
        kind: 'computed',
        compute: (ctx) => {
          const causeFr = extractCauseText(ctx.row)
          if (!causeFr) return ''
          const list = ctx.translations['sav_cause']
          const translated = list ? list[causeFr] : undefined
          if (translated === undefined || translated === null || translated === '') {
            logger.warn('export.translation.missing', {
              supplier: ctx.supplier_code,
              list: 'sav_cause',
              value: causeFr,
            })
            return causeFr
          }
          return translated
        },
      },
      format: 'text',
      width: W_DETERIORADO,
    },
  ],
  // Pas de row_filter V1 — export exhaustif sur la période, filtré côté
  // SQL via `product.supplier_code = 'MARTINEZ'`.
}
