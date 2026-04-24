/**
 * Story 5.1 — configuration export fournisseur Rufino (1er fournisseur).
 *
 * Pattern FR36 : ce fichier est pure config (déclaration d'objets).
 * Toute modification colonne/libellé/format/ordre se fait ICI uniquement,
 * jamais dans `supplierExportBuilder.ts` (vérifié par le test guard
 * `supplier-export-builder.guard.spec.ts`).
 *
 * Colonnes alignées PRD §1526 / epics.md §928 / FR35 :
 *   FECHA, REFERENCE, ALBARAN, CLIENTE, DESCRIPCIÓN, UNIDADES, PESO,
 *   PRECIO, IMPORTE, CAUSA.
 *
 * Écarts schéma vs story spec (documentés Completion Notes Story 5.1) :
 *   - `members.name` n'existe pas → CLIENTE = last_name + ' ' + first_name
 *     (computed). Idem pour DESCRIPCIÓN : `products.designation_fr` n'existe
 *     pas, c'est `products.name_fr` qui est la colonne réelle.
 *   - `sav_lines.motif` n'existe pas en DB V1 : la cause est stockée dans
 *     `sav_lines.validation_messages` jsonb sous forme
 *     `[{kind:'cause', text:'Abîmé'}, ...]` (cf. migration
 *     20260421150000_rpc_capture_sav_from_webhook.sql). CAUSA = computed
 *     qui extrait le premier message `kind='cause'` puis traduit via la
 *     map validation_lists.
 *   - `sav_lines.piece_kg` n'existe pas : la DB stocke `piece_to_kg_weight_g`
 *     (grammes). PESO = computed qui divise par 1000 (kg).
 *   - List code des motifs = `sav_cause` (pas `motif_sav`) — c'est le
 *     code réel seedé Epic 1 (seed.sql §11-22).
 */

import { logger } from '../logger'
import type { SupplierExportConfig, ExportRow } from './supplierExportBuilder'

// Largeurs colonnes (AC #8).
const W_FECHA = 12
const W_REFERENCE = 14
const W_ALBARAN = 14
const W_CLIENTE = 30
const W_DESCRIPCION = 40
const W_UNIDADES = 10
const W_PESO = 8
const W_PRECIO = 10
const W_IMPORTE = 12
const W_CAUSA = 20

/**
 * Extrait la première entrée `kind='cause'` de `sav_lines.validation_messages`.
 * Retourne null si pas de cause ou si la structure est inattendue.
 *
 * CR 5.1 LOW : trim + skip whitespace-only — `text === '   '` ne doit pas
 * propager un cause "3 espaces" vers l'XLSX.
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

export const rufinoConfig: SupplierExportConfig = {
  supplier_code: 'RUFINO',
  language: 'es',
  file_name_template: 'RUFINO_{period_from}_{period_to}.xlsx',
  formulas: {
    // IMPORTE = PESO × PRECIO. Index colonnes (1-based Excel) :
    //   FECHA=A REFERENCE=B ALBARAN=C CLIENTE=D DESCRIPCIÓN=E UNIDADES=F
    //   PESO=G PRECIO=H IMPORTE=I CAUSA=J
    // ⇒ IMPORTE = G{row} × H{row}
    IMPORTE: '=G{row}*H{row}',
  },
  columns: [
    {
      key: 'FECHA',
      header: 'FECHA',
      source: { kind: 'field', path: 'sav.received_at' },
      format: 'date-iso',
      width: W_FECHA,
    },
    {
      key: 'REFERENCE',
      header: 'REFERENCE',
      source: { kind: 'field', path: 'sav.reference' },
      format: 'text',
      width: W_REFERENCE,
    },
    {
      key: 'ALBARAN',
      header: 'ALBARAN',
      source: { kind: 'field', path: 'sav.invoice_ref' },
      format: 'text',
      width: W_ALBARAN,
    },
    {
      key: 'CLIENTE',
      header: 'CLIENTE',
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
      width: W_CLIENTE,
    },
    {
      key: 'DESCRIPCIÓN',
      header: 'DESCRIPCIÓN',
      source: { kind: 'field', path: 'product.name_fr' },
      format: 'text',
      width: W_DESCRIPCION,
    },
    {
      key: 'UNIDADES',
      header: 'UNIDADES',
      source: { kind: 'field', path: 'qty_invoiced' },
      format: 'integer',
      width: W_UNIDADES,
    },
    {
      key: 'PESO',
      header: 'PESO',
      source: {
        kind: 'computed',
        compute: (ctx) => {
          // DB stocke piece_to_kg_weight_g en grammes. Conversion kg.
          const g = ctx.row.piece_to_kg_weight_g
          if (typeof g !== 'number') return 0
          return g / 1000
        },
      },
      width: W_PESO,
    },
    {
      key: 'PRECIO',
      header: 'PRECIO',
      source: { kind: 'field', path: 'unit_price_ht_cents' },
      format: 'cents-to-euros',
      width: W_PRECIO,
    },
    {
      key: 'IMPORTE',
      header: 'IMPORTE',
      source: { kind: 'formula', formula: 'IMPORTE' },
      width: W_IMPORTE,
    },
    {
      key: 'CAUSA',
      header: 'CAUSA',
      source: {
        kind: 'computed',
        compute: (ctx) => {
          const causeFr = extractCauseText(ctx.row)
          if (!causeFr) return ''
          const list = ctx.translations['sav_cause']
          const translated = list ? list[causeFr] : undefined
          if (translated === undefined || translated === null || translated === '') {
            // Fallback FR + warn structuré. CR 5.1 LOW : on passe par `logger`
            // (comme le resolver validation_list built-in) pour uniformiser
            // le format JSON sortie stdout et garder CI logs filtrables.
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
      width: W_CAUSA,
    },
  ],
  // Pas de row_filter V1 — export exhaustif de toutes les lignes Rufino
  // sur la période (sous statut validated/closed, filtré côté SQL).
}
