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
import { CATALOGUE_CODE_CORE_SOURCE } from '../schemas/capture-webhook'

// spec-reconcile-code-token-v114-align (2026-06-12) — regex reconcile dérivée
// du motif cœur partagé V1.14 (capture-webhook + extractProductCode SPA).
// Frontière `(?=\s|$)` au lieu de `\s` car le snapshot SAV peut être un code
// seul (sans libellé concaténé). Anti-drift verrouillé par sentinelle dédiée.
// EXPORTED pour la sentinelle de parité structurelle (PURE-17) : le test
// assert `.source` directement — une 4e regex copiée-collée ferait échouer.
export const RECONCILE_CODE_TOKEN_RE = new RegExp('^(' + CATALOGUE_CODE_CORE_SOURCE + ')(?=\\s|$)')

/**
 * spec-reconcile-code-token-v114-align — normalisation décimale des CLÉS de
 * jointure uniquement : `,` → `.`. Appliquée au token extrait + clés `fgIndex`
 * + clés `bddIndex` (CR : symétrie FG↔BDD) + entrées `consumedFgCodes`.
 * `fgRow.codeFr` reste VERBATIM dans toutes les
 * structures retournées (claimLines, unusedSupplierLines, payloads).
 */
function normalizeJoinKey(code: string): string {
  return code.replace(/,/g, '.')
}

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

export type ConversionFlag = 'ok' | 'ATTENTION A CONVERTIR' | 'Unité non reconnue' | 'converti pièce→kg' | 'converti pièce→unidades'

export interface ConvertUnitInput {
  unit: string | null
  kilosPiezas: string | null
  qty: number
  /** Story 8.6 — facteur de conversion pièce→kg : poids net total facturé (kg).
   *  Requis pour résoudre la cellule 4 (piece+Kilos). null = dégénéré → detect-only + bloquant. */
  kilosNetos?: number | null
  /** Story 8.6 — quantité facturée (pièces) servant de diviseur pour kilosNetos/qteFact.
   *  Requis pour résoudre la cellule 4. null/0 = dégénéré → detect-only + bloquant. */
  qteFact?: number | null
}

export interface ConvertUnitOutput {
  envase: number
  unidad: string
  conversionFlag: ConversionFlag
  /** Story 8.6 — chaîne de traçabilité COMENTARIOS pour la cellule 4 résolue.
   *  Non-null uniquement quand conversionFlag='converti pièce→kg' (8.6)
   *  ou 'converti pièce→unidades' (multi-pack 2026-06-12, cellule 3). */
  conversionComment?: string | null
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
  /** Story 8.6 — ADDITIVE — plafond effectif dans l'unité du fournisseur (kg si Kilos, pièces sinon).
   *  Exposé au client pour que clampQty borne dans la bonne unité (PATTERN-EFFECTIVE-CAP-EXPOSURE). */
  effectiveCap: number | null
  /** Story 8.6 — ADDITIVE — unité du plafond effectif ('Kilos' ou 'Unidades'). */
  effectiveCapUnit: string | null
  /** Story 8.6 — ADDITIVE — chaîne COMENTARIOS de traçabilité de conversion pièce→kg.
   *  Non-null uniquement pour la cellule 4 résolue (conversionFlag='converti pièce→kg'). */
  conversionComment: string | null
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
 *   "1022-5KK" → "1022-5KK" (V1.14 — segment `-[A-Z0-9]+` autorise plusieurs lettres ;
 *               aligné sur catalogue Fruitstock — cf. spec-reconcile-code-token-v114-align)
 *   "1028-8X750GR" → "1028-8X750GR" (V1.14 — multi-pack, fix UAT 2026-06-12)
 *   "3745-3.5K" / "3745-3,5K" → idem (V1.14 — décimal `.` ET `,`)
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
  //
  // spec-reconcile-code-token-v114-align (2026-06-12) — regex DÉRIVÉE du motif
  // cœur partagé V1.14 (`CATALOGUE_CODE_CORE_SOURCE`) au lieu d'une 4e regex
  // indépendante. Couvre les multi-packs (`1028-8X750GR`), décimaux (`.`/`,`),
  // multi-dash (`1100-1312-500GR`). Sentinelle de parité dédiée verrouille la
  // dérivation (cf. PURE-17 dans reconcile-supplier-claim-pure.spec.ts).
  const match = trimmed.match(RECONCILE_CODE_TOKEN_RE)
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

  // Cellule 3 : piece + Unidades → résoudre via kilosNetos/qteFact (Story Unidades multi-pack)
  // Symétrique 8.6 : si kilosNetos>0 ET qteFact>0 ET facteur ≠ 1
  //   → envase = qty × facteur, flag='converti pièce→unidades' + COMENTARIOS traçable
  // Si facteur = 1 (pièce=unidad, cas courant) → passthrough flag='ok' SANS COMENTARIOS (zéro bruit)
  // Si kilosNetos absent/0 → passthrough flag='ok' SANS blocage (décision PO 2026-06-12 — inverse de Q2 Kilos)
  if (normalizedUnit === 'piece' && kp === 'Unidades') {
    const kilosNetos = input.kilosNetos ?? null
    const qteFact = input.qteFact ?? null
    if (kilosNetos !== null && kilosNetos > 0 && qteFact !== null && qteFact > 0) {
      const facteur = kilosNetos / qteFact
      // CR 2026-06-12 : comparaison à epsilon (pas stricte) — une valeur cached
      // xlsx (7.999999999999999) produirait un facteur ≈1 et un flag « converti »
      // parasite sur une ligne pièce=unidad (leçon xlsx cached-value).
      if (Math.abs(facteur - 1) > 1e-9) {
        // Cellule 3 résolue (multi-pack) : envase = qty × (kilosNetos / qteFact)
        const envase = qty * facteur
        const kilosNetosFormatted = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 }).format(kilosNetos)
        const conversionComment = `converti pièce→unidades via Kilos Netos (${kilosNetosFormatted} unités)`
        return { envase, unidad: 'Unidades', conversionFlag: 'converti pièce→unidades', conversionComment }
      }
      // Facteur 1 (pièce=unidad) → passthrough zéro bruit
      return { envase: qty, unidad: 'Unidades', conversionFlag: 'ok' }
    }
    // Décision PO 2026-06-12 : kilosNetos absent/0 sur ligne Unidades → passthrough 'ok' NON bloquant
    return { envase: qty, unidad: 'Unidades', conversionFlag: 'ok' }
  }

  // Cellule 4 : piece + Kilos → résoudre via kilosNetos/qteFact (Story 8.6)
  // Si kilosNetos > 0 ET qteFact > 0 → conversion résolue (DN-A=B : flag 'converti pièce→kg')
  // Sinon → detect-only (dégénéré Q2 : kilosNetos absent/0 ou qteFact≤0 → ATTENTION A CONVERTIR)
  if (normalizedUnit === 'piece' && kp === 'Kilos') {
    const kilosNetos = input.kilosNetos ?? null
    const qteFact = input.qteFact ?? null
    if (kilosNetos !== null && kilosNetos > 0 && qteFact !== null && qteFact > 0) {
      // Cellule 4 résolue : envase = qty × (kilosNetos / qteFact)
      const facteur = kilosNetos / qteFact
      const envase = qty * facteur
      // LOW-1 (CR fix): format kilosNetos as fr-FR (comma decimal) for COMENTARIOS consistency
      const kilosNetosFormatted = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 }).format(kilosNetos)
      const conversionComment = `converti pièce→kg via Kilos Netos (${kilosNetosFormatted} kg)`
      return { envase, unidad: 'Kilos', conversionFlag: 'converti pièce→kg', conversionComment }
    }
    // Dégénéré Q2 : detect-only (kilosNetos absent/0/qteFact≤0) → blockingForGeneration posé par reconcile
    return { envase: qty, unidad: 'Kilos', conversionFlag: 'ATTENTION A CONVERTIR', conversionComment: null }
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
// FR12 fix (Sprint Change Proposal 2026-06-05) : clé motif normalisée (slug↔libellé)
import { normalizeCauseKey } from '../../../src/shared/validation/normalize-cause-key'

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
  //
  // spec-reconcile-code-token-v114-align (2026-06-12) — les CLÉS de l'index
  // sont normalisées (`,`→`.`) pour permettre la jointure croisée snapshot↔file
  // quelle que soit la convention décimale. `fgRow.codeFr` reste VERBATIM dans
  // la valeur (claimLines.codeFr / unusedSupplierLines.codeFr inchangés).
  const fgIndex = new Map<string, { row: FactureGroupeRow; count: number }>()
  for (const fgRow of factureGroupe.rows) {
    const key = normalizeJoinKey(fgRow.codeFr)
    const existing = fgIndex.get(key)
    if (existing) {
      existing.count++
    } else {
      fgIndex.set(key, { row: fgRow, count: 1 })
    }
  }

  // --- Indexer BDD par code en O(1) (DN-2 : BDD prioritaire) ---
  // CR spec-reconcile-code-token-v114-align : clés normalisées (`,`→`.`) comme
  // fgIndex — sinon un snapshot point canonique (DB post-V1.14) vs une feuille
  // BDD en virgule matchait FG mais ratait BDD (origen null + producto dégradé
  // + warning bdd-no-match trompeur). Valeurs BddRow verbatim inchangées.
  const bddIndex = new Map<string, BddRow>()
  for (const bddRow of bdd.rows) {
    const bddKey = normalizeJoinKey(bddRow.code)
    if (!bddIndex.has(bddKey)) {
      bddIndex.set(bddKey, bddRow)
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
      // spec-reconcile-code-token-v114-align : normalisation `,`→`.` côté clé
      // de lookup (l'index a déjà été normalisé à la construction).
      const joinKey = normalizeJoinKey(tokenExtracted)
      const fgEntry = fgIndex.get(joinKey)

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
      // spec-reconcile-code-token-v114-align : marqueur consommé = clé normalisée
      // (cohérence avec l'index ; le check `unused` ci-dessous compare la même clé).
      consumedFgCodes.add(joinKey)

      // AC #3 — multiple-matches : warning si count > 1
      if (fgEntry.count > 1) {
        warnings.push({
          savLineId: savLine.id,
          type: 'multiple-matches',
          count: fgEntry.count,
        })
      }

      // AC #4 — BDD lookup (DN-2 : BDD prioritaire)
      const bddRow = bddIndex.get(joinKey) ?? null
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
      if (cause !== null && cause !== undefined && cause !== '') {
        // FR12 fix : la cause stockée est un SLUG (`abime`) et motifMap est keyé sur
        // la clé normalisée des libellés validation_lists → on normalise des 2 côtés.
        const causeKey = normalizeCauseKey(cause)
        if (motifMap.has(causeKey)) {
          const valueEs = motifMap.get(causeKey) ?? null
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
      // Story 8.6 : passer kilosNetos + qteFact pour résoudre la cellule 4 (piece+Kilos)
      const unitConversion = convertUnit({
        unit: savLine.unitArbitrated,
        kilosPiezas: fgRow.kilosPiezas,
        qty: qtyDefaultClient,
        kilosNetos: fgRow.kilosNetos,
        qteFact: fgRow.qteFact,
      })

      // La valeur post-conversion est le qtyForCap (dans l'unité du fournisseur)
      const qtyForCap = unitConversion.envase

      // AC #6 — plafond (APRÈS conversion — ordre critique)
      // Story 8.6 (AC #3) : si cellule 4 dégénérée (kilosNetos absent/0, qteFact≤0)
      //   → blockingForGeneration=true + warning 'conversion-impossible-kilos-netos-missing'
      let blockingForGeneration = false
      let qty: number
      let importe: number | null

      const qteFact = fgRow.qteFact

      // Story 8.6 AC #3 : dégénéré cellule 4 → bloquant avant même le cap
      if (unitConversion.conversionFlag === 'ATTENTION A CONVERTIR' &&
          unitConversion.unidad === 'Kilos' &&
          qteFact !== null && qteFact !== 0) {
        // Cellule 4 detect-only (kilosNetos absent/0) → blocage génération
        // On pose qty = envase (passthrough) mais blockingForGeneration = true
        qty = qtyForCap
        importe = computeImporte({ qty, precio: fgRow.precio })
        blockingForGeneration = true
        warnings.push({
          savLineId: savLine.id,
          type: 'conversion-impossible-kilos-netos-missing',
        })
      } else if (unitConversion.conversionFlag === 'Unité non reconnue') {
        // MEDIUM-3 / AC #1 / DN-Q6: unité indéterminée → blocage génération (pas de conversion silencieuse)
        // "bloquant — pas de conversion silencieuse" (DN-Q6 implémentation)
        qty = qtyForCap
        importe = computeImporte({ qty, precio: fgRow.precio })
        blockingForGeneration = true
        warnings.push({
          savLineId: savLine.id,
          type: 'unit-unrecognized-blocking',
        })
      } else if (qteFact === null || qteFact === 0) {
        qty = 0
        importe = 0
        blockingForGeneration = true
        warnings.push({ savLineId: savLine.id, type: 'qte-fact-missing' })
      } else {
        // Story 8.6 (NEW-1 fix) — Compute effectiveCap ONCE, use for BOTH the server cap bound
        // AND the exposed effectiveCap field. This ensures server↔client can never diverge.
        //
        // Rule (unified — same as the client effectiveCap rule from HIGH-1 CR fix):
        //   (unidad ∈ {Kilos, Unidades}) AND kilosNetos > 0 → capMax = kilosNetos (fournisseur bound)
        //   otherwise                                        → capMax = qteFact   (pieces bound)
        //
        // Covers ALL Kilos lines (cellule-1 g→kg, cellule-2 kg+Kilos, cellule-4 converted)
        // AND Unidades lines (cellule-3 multi-pack converted, cellule-5 g/kg+Unidades),
        // ensuring multi-pack scenarios (UAT 2026-06-12, datte 1028-8X750GR) cap on the
        // total number of unidades (kilosNetos) rather than on cartons (qteFact).
        const kilosNetosForCap = fgRow.kilosNetos
        const capMax: number | null =
          ((unitConversion.unidad === 'Kilos' || unitConversion.unidad === 'Unidades') && kilosNetosForCap != null && kilosNetosForCap > 0)
            ? kilosNetosForCap
            : qteFact

        qty = applyCap({ qtyForCap, capMax })

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

      // Story 8.6 (AC #4) — plafond effectif exposé au client (PATTERN-EFFECTIVE-CAP-EXPOSURE)
      // NEW-1 fix: effectiveCap is now the SAME variable as capMax (computed above in the else branch,
      // or falls back to the appropriate bound for the blocking paths). This ensures they can never
      // diverge. For the blocking paths (dégénéré, unrecognized unit, qteFact=null/0), the
      // effectiveCap is still meaningful for display but the line is blocked anyway.
      // We recompute using the same unified rule so effectiveCap is always set correctly.
      const kilosNetosForEffectiveCap = fgRow.kilosNetos
      const effectiveCap: number | null =
        ((unitConversion.unidad === 'Kilos' || unitConversion.unidad === 'Unidades') && kilosNetosForEffectiveCap != null && kilosNetosForEffectiveCap > 0)
          ? kilosNetosForEffectiveCap
          : fgRow.qteFact
      const effectiveCapUnit: string | null = unitConversion.unidad || null

      // Story 8.6 (AC #2) — COMENTARIOS de traçabilité pour la cellule 4 résolue
      const conversionComment: string | null = unitConversion.conversionComment ?? null

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
        comentarios: conversionComment ?? '',
        blockingForGeneration,
        // Story 8.6 — ADDITIVE fields (AC #4, AC #6)
        effectiveCap,
        effectiveCapUnit,
        conversionComment,
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
  // spec-reconcile-code-token-v114-align : check + dédoublonnage sur la CLÉ
  // normalisée pour cohérence avec consumedFgCodes (qui stocke des clés
  // normalisées). La VALEUR retournée (`codeFr`) reste VERBATIM `fgRow.codeFr`.
  const unusedSupplierLines: UnusedSupplierLine[] = []
  const seenUnusedKeys = new Set<string>()
  for (const fgRow of factureGroupe.rows) {
    const key = normalizeJoinKey(fgRow.codeFr)
    if (!consumedFgCodes.has(key)) {
      // Dédupliquer (plusieurs rows même codeFr → une seule entrée unused)
      if (!seenUnusedKeys.has(key)) {
        seenUnusedKeys.add(key)
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
  // Exclure les lignes bloquantes du total (DISC-07d / DISC-03b — parité client computeTotals)
  const totalImporte = claimLines.reduce((acc, l) => {
    if (l.blockingForGeneration) return acc
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
