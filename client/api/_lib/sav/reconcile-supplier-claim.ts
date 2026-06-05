/**
 * Story 8.2 — Helper pur de réconciliation SOL Y FRUTA (PATTERN-RECONCILE-PURE)
 *
 * Ce module est SANS effets de bord : pas de DB, pas de HTTP, pas d'I/O.
 * Toutes les dépendances externes (motifMap depuis validation_lists) sont
 * injectées via les arguments de `reconcile()`.
 *
 * Décisions appliquées :
 *   DN-2 = Option A — BDD prioritaire (bdd.designationEs ?? factureGroupeRow.descripcionEs)
 *   DN-4 = Option A — extractCodeToken strict (null si pas de match format SKU exact)
 *   AC #5 — matrice conversion d'unité 6 cellules + dégénérés
 *   AC #6 — ordre CRITIQUE : conversion g→kg AVANT cap QTE_FACT (R-3)
 *
 * Patterns posés :
 *   PATTERN-EXTRACT-CODE-TOKEN
 *   PATTERN-UNIT-CONVERSION-MATRIX
 *   PATTERN-RECONCILE-PURE
 */

import type { FactureGroupeRow, BddRow } from './supplier-file-parser'
export type { ParseWarning } from './supplier-file-parser'

// ---------------------------------------------------------------------------
// Types exportés (OQ-4 : réutilise ParseWarning depuis supplier-file-parser)
// ---------------------------------------------------------------------------

export interface SupplierFileParseResult {
  metadata: {
    reference: string | null
    albaran: string | number | null
    fechaAlbaran: string | null
    warnings: string[]
  }
  factureGroupe: {
    rows: FactureGroupeRow[]
    skippedRows: number
    warnings: Array<{ row: number; sheet: 'FACTURE_GROUPE' | 'BDD'; fields: string[] }>
  }
  bdd: {
    rows: BddRow[]
    skippedRows: number
    warnings: Array<{ row: number; sheet: 'FACTURE_GROUPE' | 'BDD'; fields: string[] }>
  }
  fileMeta: {
    filename: string
    sizeBytes: number
    sheetsDetected: string[]
    parser: string
  }
}

export interface SavLineInput {
  id: string | number
  productCodeSnapshot: string | null
  productNameSnapshot: string | null
  qtyArbitrated: number | null
  qtyInvoiced: number | null
  unitArbitrated: string | null
  /** mapped from request_reason (OQ-1: col DB = request_reason, not cause) */
  cause: string | null
}

export type ConversionFlag = 'ok' | 'ATTENTION A CONVERTIR' | 'Unité non reconnue'

export interface ConvertUnitInput {
  unit: string | null
  kilosPiezas: string | null
  qty: number
}

export interface ConvertUnitOutput {
  envase: number
  unidad: string
  conversionFlag: ConversionFlag
}

export interface ClaimLinePreview {
  savLineId: string | number
  creditNoteLink: { savId: string | number; savLineId: string | number }
  codeFr: string
  tokenExtracted: string
  codigoEs: string | null
  productoEs: string | null
  origen: string | null
  unite: string | null
  kilosPiezas: string | null
  unidad: string
  conversionFlag: ConversionFlag
  qteFact: number | null
  qtyDefaultClient: number
  qty: number
  peso: number
  precio: number | null
  importe: number | null
  causaEs: string | null
  comentarios: string
  blockingForGeneration: boolean
}

export interface UnmatchedSavLine {
  savLineId: string | number
  productCodeSnapshot: string | null
  tokenExtracted: string | null
  productNameSnapshot: string | null
}

export interface UnusedSupplierLine {
  codeFr: string
  codigoEs: string | null
  descripcionEs: string | null
}

export interface ReconcileWarning {
  savLineId?: string | number
  type: string
  count?: number
  [key: string]: unknown
}

export interface ReconcileResult {
  claimLines: ClaimLinePreview[]
  unmatchedSavLines: UnmatchedSavLine[]
  unusedSupplierLines: UnusedSupplierLine[]
  totals: {
    importe: number
    linesMatched: number
    linesUnmatched: number
    linesBlocking: number
  }
  meta: {
    reconciliation: {
      savLinesTotal: number
      matched: number
      unmatched: number
      multipleMatches: number
    }
    warnings: ReconcileWarning[]
  }
}

export interface ReconcileInput {
  savId: string | number
  savLines: SavLineInput[]
  parsed: SupplierFileParseResult
  /** Map<causeValue, value_es> injectée par le handler (PATTERN-RECONCILE-PURE) */
  motifMap: Map<string, string | null>
}

// ---------------------------------------------------------------------------
// AC #3 — extractCodeToken (PATTERN-EXTRACT-CODE-TOKEN, DN-4=A strict)
// Regex : ^(\d+(?:-\d+(?:,\d+)?[A-Za-z]?)?)
// null si pas de match format SKU exact → ligne non appariée
// ---------------------------------------------------------------------------

/**
 * Extrait le token de tête SKU d'un snapshot produit potentiellement pollué.
 *
 * Format SKU SOL Y FRUTA : `1022-5K`, `3745-3,5K`, `1022` (code court)
 * Snapshot pollué possible : `"3745-3,5K AUBERGINE BIO"` → token `"3745-3,5K"`
 *
 * DN-4=A strict : si la regex ne matche pas le format numérique exact → null.
 * Pas de fallback starts-with, pas de trim brut, pas de fuzzy.
 *
 * M-1 FIX (DN-CR1=A): Regex ancored with lookahead (?=\s|$) to prevent silent truncation.
 * Without boundary: "1022extra" silently extracts "1022" (faux-positif jointure).
 * With boundary:    "1022extra" → null (rejected — no whitespace or end after token).
 * Cases:
 *   "1022-5K AUBERGINE BIO" → "1022-5K"  (whitespace boundary ✓)
 *   "3745-3,5K AUBERGINE BIO" → "3745-3,5K" (whitespace boundary ✓)
 *   "1022-5K" → "1022-5K" (end-of-string boundary ✓)
 *   "1022" → "1022" (end-of-string boundary ✓)
 *   "1022extra" → null (rejected — no boundary after "1022") ✓
 *   "1022-5KK" → null (rejected — no boundary after "1022-5K" due to extra "K") ✓
 *
 * @param snapshot  Valeur de `product_code_snapshot` (peut être null/vide)
 * @returns  Token extrait ou null si pas de match numérique avec boundary
 */
export function extractCodeToken(snapshot: string | null | undefined): string | null {
  if (snapshot === null || snapshot === undefined) return null
  const trimmed = snapshot.trim()
  if (!trimmed) return null

  // M-1 FIX: Lookahead (?=\s|$) enforces whitespace-or-end boundary after token.
  // Prevents silent truncation of tokens like "1022extra" → "1022".
  const match = trimmed.match(/^(\d+(?:-\d+(?:,\d+)?[A-Za-z]?)?)(?=\s|$)/)
  if (!match || !match[1]) return null

  const token = match[1]
  // DN-4=A strict : ne retourner que si le token n'est pas vide
  if (!token) return null

  return token
}

// ---------------------------------------------------------------------------
// AC #5 — convertUnit (PATTERN-UNIT-CONVERSION-MATRIX)
// Matrice gravée du legacy VBA RUFINO_GENERER_MAJ
// Les libellés "ATTENTION A CONVERTIR" et "Unité non reconnue" sont littéraux
// (reportés tels quels dans COMENTARIOS du doc 8.4)
// ---------------------------------------------------------------------------

/**
 * Normalise l'unité SAV pour la matrice de conversion.
 * kg|kilos → 'kg', g|gramme(s) → 'g', piece|pcs|unite(s) → 'piece'
 */
function normalizeUnit(unit: string | null | undefined): string | null {
  if (!unit) return null
  const u = unit.trim().toLowerCase()
  if (u === 'kg' || u === 'kilos' || u === 'kilo') return 'kg'
  if (u === 'g' || u === 'gramme' || u === 'grammes') return 'g'
  if (u === 'piece' || u === 'pcs' || u === 'unite' || u === 'unites' || u === 'pièce' || u === 'pièces') return 'piece'
  return u
}

/**
 * Applique la matrice de conversion d'unité (AC #5).
 *
 * Matrice (6 cellules + dégénérés) :
 * | unit_arbitrated | kilosPiezas | Résultat |
 * | g | Kilos | envase=qty/1000, unidad="Kilos", flag=ok |
 * | kg | Kilos | envase=qty, unidad="Kilos", flag=ok |
 * | piece | Unidades | envase=qty, unidad="Unidades", flag=ok |
 * | piece | Kilos | envase=qty, unidad="Kilos", flag="ATTENTION A CONVERTIR" |
 * | g|kg | Unidades | envase=qty, unidad="Unidades", flag="ATTENTION A CONVERTIR" |
 * | tout autre | quelconque | envase=qty, unidad=kilosPiezas??"?", flag="Unité non reconnue" |
 */
export function convertUnit(input: ConvertUnitInput): ConvertUnitOutput {
  const { qty } = input
  const normalizedUnit = normalizeUnit(input.unit)
  const kilosPiezas = input.kilosPiezas

  // L-2 FIX: treat whitespace-only kilosPiezas ("   ") same as null/empty
  // Previously: !kilosPiezas catches null/undefined/"" but NOT "   " (truthy string)
  // Fix: check !kilosPiezas || !kilosPiezas.trim() to handle whitespace-only strings
  if (!kilosPiezas || !kilosPiezas.trim()) {
    return { envase: qty, unidad: '?', conversionFlag: 'Unité non reconnue' }
  }

  const kp = kilosPiezas.trim()

  // Dégénéré : unit inconnu
  if (!normalizedUnit) {
    return { envase: qty, unidad: kp || '?', conversionFlag: 'Unité non reconnue' }
  }

  // Cellule 1 : g + Kilos → conversion g→kg
  if (normalizedUnit === 'g' && kp === 'Kilos') {
    return { envase: qty / 1000, unidad: 'Kilos', conversionFlag: 'ok' }
  }

  // Cellule 2 : kg + Kilos → passthrough
  if (normalizedUnit === 'kg' && kp === 'Kilos') {
    return { envase: qty, unidad: 'Kilos', conversionFlag: 'ok' }
  }

  // Cellule 3 : piece + Unidades → passthrough
  if (normalizedUnit === 'piece' && kp === 'Unidades') {
    return { envase: qty, unidad: 'Unidades', conversionFlag: 'ok' }
  }

  // Cellule 4 : piece + Kilos → ambigu
  if (normalizedUnit === 'piece' && kp === 'Kilos') {
    return { envase: qty, unidad: 'Kilos', conversionFlag: 'ATTENTION A CONVERTIR' }
  }

  // Cellule 5 : g|kg + Unidades → ambigu
  if ((normalizedUnit === 'g' || normalizedUnit === 'kg') && kp === 'Unidades') {
    return { envase: qty, unidad: 'Unidades', conversionFlag: 'ATTENTION A CONVERTIR' }
  }

  // Cellule 6 / catch-all : unité non reconnue
  return { envase: qty, unidad: kp || '?', conversionFlag: 'Unité non reconnue' }
}

// ---------------------------------------------------------------------------
// AC #6 — applyCap + computeImporte
// MEDIUM-1 (Story 8.3 CR fix) : implementations moved to shared pure module
// so the client composable 8.3 and this server engine share the same code.
// Imported here for use by the reconcile() orchestrator below, and re-exported
// so all 8.2 test imports (import { applyCap, computeImporte } from '...') stay unchanged.
// ORDRE CRITIQUE : la conversion g→kg doit être appliquée AVANT ce cap
// ---------------------------------------------------------------------------

import { applyCap, computeImporte } from '../../../src/shared/supplier-claim/math'
export { applyCap, computeImporte }

// ---------------------------------------------------------------------------
// AC #3, #4, #5, #6, #7 — reconcile (orchestrateur pur)
// Entrée : { savLines, parsed, motifMap } — motifMap injecté pour testabilité
// ---------------------------------------------------------------------------

/**
 * Orchestrateur de réconciliation pur (PATTERN-RECONCILE-PURE).
 *
 * Pas de DB, pas de réseau. Prend sa seule dépendance externe (motifMap)
 * en paramètre → testable sans mock Supabase, déterministe.
 *
 * Ordre strict AC #6 :
 *   1. qtyDefaultClient = sav_line.qty_arbitrated (fallback qty_invoiced)
 *   2. conversion g→kg si applicable (qtyForCap = qty/1000 si g+Kilos)
 *   3. cap = min(qtyForCap, qteFact)
 *   4. importe = cap × precio
 */
export function reconcile(input: ReconcileInput): ReconcileResult {
  const { savId, savLines, parsed, motifMap } = input
  const { factureGroupe, bdd } = parsed

  const warnings: ReconcileWarning[] = []

  // --- Indexer FACTURE_GROUPE par codeFr en O(1) (AC #10 performance) ---
  // Map<codeFr, [firstRow, count]> pour détecter multiple-matches
  const fgIndex = new Map<string, { row: FactureGroupeRow; count: number }>()
  for (const fgRow of factureGroupe.rows) {
    const existing = fgIndex.get(fgRow.codeFr)
    if (existing) {
      existing.count++
    } else {
      fgIndex.set(fgRow.codeFr, { row: fgRow, count: 1 })
    }
  }

  // --- Indexer BDD par code en O(1) (DN-2 : BDD prioritaire) ---
  const bddIndex = new Map<string, BddRow>()
  for (const bddRow of bdd.rows) {
    if (!bddIndex.has(bddRow.code)) {
      bddIndex.set(bddRow.code, bddRow)
    }
  }

  // --- Tracker les codes FG consommés (pour unusedSupplierLines) ---
  const consumedFgCodes = new Set<string>()

  const claimLines: ClaimLinePreview[] = []
  const unmatchedSavLines: UnmatchedSavLine[] = []

  // --- Traiter chaque sav_line dans l'ordre (stable, déterministe — AC #7) ---
  for (const savLine of savLines) {
    try {
      // AC #3 — extraire token de tête (DN-4=A strict)
      const tokenExtracted = extractCodeToken(savLine.productCodeSnapshot)

      if (tokenExtracted === null) {
        // DN-4 : token null → directement unmatched, skip lookup
        unmatchedSavLines.push({
          savLineId: savLine.id,
          productCodeSnapshot: savLine.productCodeSnapshot,
          tokenExtracted: null,
          productNameSnapshot: savLine.productNameSnapshot,
        })
        continue
      }

      // AC #3 — jointure exacte sur codeFr (case-sensitive, espace-insensitive via trim 8.1)
      const fgEntry = fgIndex.get(tokenExtracted)

      if (!fgEntry) {
        // Aucun match → unmatched
        unmatchedSavLines.push({
          savLineId: savLine.id,
          productCodeSnapshot: savLine.productCodeSnapshot,
          tokenExtracted,
          productNameSnapshot: savLine.productNameSnapshot,
        })
        continue
      }

      const fgRow = fgEntry.row
      consumedFgCodes.add(tokenExtracted)

      // AC #3 — multiple-matches : warning si count > 1
      if (fgEntry.count > 1) {
        warnings.push({
          savLineId: savLine.id,
          type: 'multiple-matches',
          count: fgEntry.count,
        })
      }

      // AC #4 — BDD lookup (DN-2 : BDD prioritaire)
      const bddRow = bddIndex.get(tokenExtracted) ?? null
      if (!bddRow) {
        warnings.push({
          savLineId: savLine.id,
          type: 'bdd-no-match',
        })
      }

      // AC #4 — productoEs = bdd.designationEs ?? fgRow.descripcionEs (DN-2=A)
      const productoEs = (bddRow?.designationEs ?? null) || fgRow.descripcionEs

      // AC #4 — origen depuis BDD
      const origen = bddRow?.origen ?? null

      // AC #4 — traduction motif depuis motifMap injecté
      const cause = savLine.cause
      let causaEs: string | null = null
      if (cause !== null && cause !== undefined) {
        if (motifMap.has(cause)) {
          const valueEs = motifMap.get(cause) ?? null
          if (valueEs === null || valueEs === '') {
            causaEs = 'otro'
            warnings.push({ savLineId: savLine.id, type: 'cause-translation-missing' })
          } else {
            causaEs = valueEs
          }
        } else {
          // Cause absente de validation_lists (cause libre legacy / data drift)
          causaEs = 'otro'
          warnings.push({ savLineId: savLine.id, type: 'cause-unknown' })
        }
      }

      // AC #6 — qty_arbitrated avec fallback qty_invoiced
      let qtyDefaultClient: number
      if (savLine.qtyArbitrated !== null && savLine.qtyArbitrated !== undefined) {
        qtyDefaultClient = savLine.qtyArbitrated
      } else if (savLine.qtyInvoiced !== null && savLine.qtyInvoiced !== undefined) {
        qtyDefaultClient = savLine.qtyInvoiced
        warnings.push({ savLineId: savLine.id, type: 'qty-arbitrated-null-fallback' })
      } else {
        qtyDefaultClient = 0
        warnings.push({ savLineId: savLine.id, type: 'qty-unavailable' })
      }

      // AC #5 + AC #6 — conversion d'unité (AVANT cap — ordre critique R-3)
      const unitConversion = convertUnit({
        unit: savLine.unitArbitrated,
        kilosPiezas: fgRow.kilosPiezas,
        qty: qtyDefaultClient,
      })

      // La valeur post-conversion est le qtyForCap (dans l'unité du fournisseur)
      const qtyForCap = unitConversion.envase

      // AC #6 — plafond QTE_FACT (APRÈS conversion — ordre critique)
      let blockingForGeneration = false
      let qty: number
      let importe: number | null

      const qteFact = fgRow.qteFact

      if (qteFact === null || qteFact === 0) {
        qty = 0
        importe = 0
        blockingForGeneration = true
        warnings.push({ savLineId: savLine.id, type: 'qte-fact-missing' })
      } else {
        qty = applyCap({ qtyForCap, qteFact })

        // AC #6 — precio null|0 → importe null + blockingForGeneration + warning
        // L-1 FIX: emit warning for precio===0 as well (AC #6 spec: "null/0" → blocking)
        // Previously only null emitted the warning; 0 silently set importe=null with no trace.
        if (fgRow.precio === null || fgRow.precio === 0) {
          importe = null
          blockingForGeneration = true
          warnings.push({ savLineId: savLine.id, type: 'precio-missing' })
        } else {
          importe = computeImporte({ qty, precio: fgRow.precio })
        }
      }

      // AC #7 — construction claimLine
      const claimLine: ClaimLinePreview = {
        savLineId: savLine.id,
        creditNoteLink: { savId, savLineId: savLine.id },
        codeFr: fgRow.codeFr,
        tokenExtracted,
        codigoEs: fgRow.codigoEs,
        productoEs,
        origen,
        unite: fgRow.unite,
        kilosPiezas: fgRow.kilosPiezas,
        unidad: unitConversion.unidad,
        conversionFlag: unitConversion.conversionFlag,
        qteFact: fgRow.qteFact,
        qtyDefaultClient,
        qty,
        peso: qty,
        precio: fgRow.precio,
        importe,
        causaEs,
        comentarios: '',
        blockingForGeneration,
      }

      claimLines.push(claimLine)
    } catch (err) {
      // AC #8 — tolérance : ne jamais lever d'exception sur une ligne fautive
      // M-2 FIX: surface exception as a warning so regressions are visible (not silently dropped)
      // Keep AC #8 resilience: don't re-throw, continue processing other lines
      // NOTE: access savLine properties defensively — the getter that threw might throw again
      const errMessage = err instanceof Error ? err.message : String(err)
      console.warn(`[reconcile] exception on savLine ${savLine.id}: ${errMessage}`)
      warnings.push({ savLineId: savLine.id, type: 'reconcile-exception', message: errMessage })
      // Safely read productCodeSnapshot and productNameSnapshot (may throw if malformed)
      let safeProductCodeSnapshot: string | null = null
      let safeProductNameSnapshot: string | null = null
      try { safeProductCodeSnapshot = savLine.productCodeSnapshot } catch { /* ignore */ }
      try { safeProductNameSnapshot = savLine.productNameSnapshot } catch { /* ignore */ }
      unmatchedSavLines.push({
        savLineId: savLine.id,
        productCodeSnapshot: safeProductCodeSnapshot,
        tokenExtracted: null,
        productNameSnapshot: safeProductNameSnapshot,
      })
    }
  }

  // --- Lignes FG non consommées → unusedSupplierLines (AC #3) ---
  const unusedSupplierLines: UnusedSupplierLine[] = []
  for (const fgRow of factureGroupe.rows) {
    if (!consumedFgCodes.has(fgRow.codeFr)) {
      // Dédupliquer (plusieurs rows même codeFr → une seule entrée unused)
      const alreadyListed = unusedSupplierLines.some((u) => u.codeFr === fgRow.codeFr)
      if (!alreadyListed) {
        unusedSupplierLines.push({
          codeFr: fgRow.codeFr,
          codigoEs: fgRow.codigoEs,
          descripcionEs: fgRow.descripcionEs,
        })
      }
    }
  }

  // --- Totaux ---
  const linesMatched = claimLines.length
  const linesUnmatched = unmatchedSavLines.length
  const linesBlocking = claimLines.filter((l) => l.blockingForGeneration).length
  const totalImporte = claimLines.reduce((acc, l) => {
    if (typeof l.importe === 'number') return acc + l.importe
    return acc
  }, 0)

  const multipleMatchesCount = warnings.filter((w) => w.type === 'multiple-matches').length

  return {
    claimLines,
    unmatchedSavLines,
    unusedSupplierLines,
    totals: {
      importe: totalImporte,
      linesMatched,
      linesUnmatched,
      linesBlocking,
    },
    meta: {
      reconciliation: {
        savLinesTotal: savLines.length,
        matched: linesMatched,
        unmatched: linesUnmatched,
        multipleMatches: multipleMatchesCount,
      },
      warnings,
    },
  }
}
