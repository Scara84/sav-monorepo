/**
 * Story 8.3 — Composable useSupplierClaimArbitration
 *
 * Responsabilités :
 *   - State machine : reconciling → arbitrating | reconcile-error
 *   - Appel POST /api/sav?op=reconcile-supplier-claim&id=<savId>
 *   - State d'arbitrage : edits, exclusions, comments (Maps réactives côté client)
 *   - Helpers purs : clampQty, toggleExclude, computeTotals, canGenerate
 *   - Computed totals (recalcul live des importes et du total)
 *   - beforeunload guard (AC #10)
 *
 * Décisions appliquées (DN résolues) :
 *   DN-1 = step="any" (précision libre)
 *   DN-2 = Nouveau composable séparé de useSupplierClaimUpload
 *   DN-3 = Map<savLineId, {qty, comment, excluded}> reactive
 *   DN-4 = Pas de persistance sessionStorage (V1 — beforeunload guard seul)
 *   DN-5 = Enforcement serveur différé en 8.4 ; clamp client uniquement ici
 *   DN-6 = Bouton "Générer" présent mais disabled ; canGenerate le pilote
 *
 * OQ résolues :
 *   OQ-1 = toggleExclude retourne un NEW Map (immutable helper) ; vue reactive Map mutée en composable
 *   OQ-2 = computeTotals = helper pur + computed refs pour la réactivité (FR18)
 *   OQ-5 = Intl.NumberFormat('fr-FR') pour l'affichage — math interne en JS numbers
 */

import { ref, computed, watch, onUnmounted } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { SupplierFileParseResult } from './useSupplierClaimUpload'
// MEDIUM-1 (CR fix): import computeImporte from shared pure module (same impl as server 8.2)
import { computeImporte } from '@/shared/supplier-claim/math'

// ---------------------------------------------------------------------------
// Types publics (exportés pour les tests et la vue)
// ---------------------------------------------------------------------------

export interface ArbitrageClaimLine {
  savLineId: string | number
  codeFr: string
  codigoEs: string | null
  productoEs: string | null
  origen: string | null
  unidad: string
  conversionFlag: string
  causaEs: string | null
  precio: number | null
  qty: number
  peso: number
  qteFact: number | null
  importe: number | null
  blockingForGeneration: boolean
  productNameSnapshot: string | null
  comentarios: string
  /** Story 8.6 — ADDITIVE — plafond effectif dans l'unité du fournisseur (PATTERN-EFFECTIVE-CAP-EXPOSURE).
   *  Utilisé par computeTotals pour borner dans la bonne unité (kg si Kilos). */
  effectiveCap?: number | null
  /** Story 8.6 — ADDITIVE — unité du plafond effectif ('Kilos' ou 'Unidades'). */
  effectiveCapUnit?: string | null
  /** Story 8.6 — ADDITIVE — commentaire de conversion pièce→kg. */
  conversionComment?: string | null
  /** UNITE fournisseur brute (ex. « Pièce ») issue de FACTURE_GROUPE.
   *  ADDITIVE — utilisée pour libeller le message de cap dans la bonne unité
   *  (le cap = qteFact est exprimé dans CETTE unité quand la conversion n'est pas appliquée). */
  unite?: string | null
}

export interface ArbitrageUnmatchedLine {
  savLineId: string | number
  productCodeSnapshot: string | null
  tokenExtracted: string | null
  productNameSnapshot: string | null
}

export interface ArbitrageUnusedLine {
  codeFr: string
  codigoEs: string | null
  descripcionEs: string | null
}

export interface ArbitrageState {
  claimLines: ArbitrageClaimLine[]
  unmatchedSavLines: ArbitrageUnmatchedLine[]
  /** Map<savLineId, editedQty> */
  edits: Map<string | number, number>
  /** Map<savLineId, excluded> */
  exclusions: Map<string | number, boolean>
  /** Map<savLineId, comment> */
  comments: Map<string | number, string>
}

export interface ComputeTotalsResult {
  total: number
  lineImportes: Map<string | number, number>
}

export type ReconcileState = 'reconciling' | 'arbitrating' | 'reconcile-error'
export type GenerateState = 'idle' | 'generating' | 'generated' | 'generate-error'

export interface GenerateResult {
  claimId?: number
  totalImporteCents?: number
  lineCount?: number
  filename?: string
}

// ---------------------------------------------------------------------------
// Formatter d'affichage (OQ-5 : Intl.NumberFormat fr-FR, comma)
// CRITIQUE : display only, never feed back into calculations
// ---------------------------------------------------------------------------

const frFormatter = new Intl.NumberFormat('fr-FR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function formatImporte(value: number): string {
  return frFormatter.format(value)
}

// ---------------------------------------------------------------------------
// Pure helpers (exportés pour tests AC #12)
// ---------------------------------------------------------------------------

/**
 * Plafonne une quantité saisie.
 * - qty > cap → cap
 * - qty < 0 → 0
 * - qty = NaN → prevValid
 *
 * HIGH-1 (CR fix): renamed bound param qteFact → cap (unit-agnostic).
 * Callers must feed effectiveCap (kg for Kilos lines) or qteFact (pieces for Unidades lines).
 */
export function clampQty(qty: number, cap: number, prevValid: number): number {
  if (isNaN(qty)) return prevValid
  if (qty < 0) return 0
  if (qty > cap) return cap
  return qty
}

/**
 * Toggle exclusion d'une ligne (immutable — retourne un nouveau Map).
 * OQ-1 : helper pur retourne new Map pour testabilité.
 * La réactivité Vue est gérée via la mutation directe dans le composable.
 */
export function toggleExclude(
  lineId: string | number,
  exclusions: Map<string | number, boolean>
): Map<string | number, boolean> {
  const result = new Map(exclusions)
  const current = result.get(lineId)
  result.set(lineId, !current)
  return result
}

/**
 * Calcule les importes par ligne et le total (helper pur pour tests + réactivité Vue).
 *
 * Règles (AC #4) :
 *   - Utilise edits.get(savLineId) si édité, sinon line.qty initial
 *   - Exclut les lignes excluded=true
 *   - Exclut les lignes blockingForGeneration=true
 *   - Pas d'arrondi : précision double-précision (NFR-REL)
 *
 * HIGH-2 (CR fix) : qty is clamped at READ TIME before computing importe.
 * The raw edits Map may hold un-blurred values (operator typed but did not blur).
 * Display + total ALWAYS show bounded values regardless of blur state.
 * Lines with qteFact === null are blockingForGeneration and excluded above.
 */
export function computeTotals(state: ArbitrageState): ComputeTotalsResult {
  const lineImportes = new Map<string | number, number>()
  let total = 0

  for (const line of state.claimLines) {
    // Exclure les lignes bloquantes
    if (line.blockingForGeneration) continue

    // Exclure les lignes operator-excluded
    const isExcluded = state.exclusions.get(line.savLineId) === true
    if (isExcluded) continue

    // Qty effective (édition > valeur initiale)
    const rawQty = state.edits.has(line.savLineId)
      ? (state.edits.get(line.savLineId) as number)
      : line.qty

    // HIGH-2: clamp at read time so un-blurred values don't leak into display/total.
    // Story 8.6 (AC #5 parité): use effectiveCap when provided (kg for Kilos base),
    // fall back to qteFact for Unidades (pièces). This ensures client and server compute
    // the same cap bound (PATTERN-EFFECTIVE-CAP-EXPOSURE).
    // qteFact/effectiveCap null means blockingForGeneration (already filtered above).
    const capBound = line.effectiveCap !== undefined && line.effectiveCap !== null
      ? line.effectiveCap
      : (line.qteFact ?? 0)
    const effectiveQty = Math.min(Math.max(rawQty, 0), capBound)

    // importe = qty × precio (null si precio null — ne compte pas)
    const importe = computeImporte({ qty: effectiveQty, precio: line.precio })
    if (importe === null) continue

    lineImportes.set(line.savLineId, importe)
    total += importe
  }

  return { total, lineImportes }
}

/**
 * Détermine si la génération est possible (AC #8).
 *
 * Conditions bloquantes :
 *   (a) Au moins une unmatchedSavLine non exclue
 *   (b) Aucune claimLine valide (non exclue ET non bloquante)
 *   (c) Au moins une claimLine blockingForGeneration=true ET non exclue
 */
export function canGenerate(state: ArbitrageState): boolean {
  // Condition (a) : unmatched non traitées
  const hasUntreatedUnmatched = state.unmatchedSavLines.some(
    (u) => state.exclusions.get(u.savLineId) !== true
  )
  if (hasUntreatedUnmatched) return false

  // Condition (c) : ligne bloquante non exclue
  const hasBlockingNonExcluded = state.claimLines.some(
    (l) => l.blockingForGeneration && state.exclusions.get(l.savLineId) !== true
  )
  if (hasBlockingNonExcluded) return false

  // Condition (b) : au moins une ligne valide
  const hasValidLine = state.claimLines.some(
    (l) => !l.blockingForGeneration && state.exclusions.get(l.savLineId) !== true
  )
  if (!hasValidLine) return false

  return true
}

// ---------------------------------------------------------------------------
// Messages de blocage de génération (AC #8 — inline reason)
// ---------------------------------------------------------------------------

export function buildBlockingReasons(state: ArbitrageState): string[] {
  const reasons: string[] = []

  const untreatedUnmatchedCount = state.unmatchedSavLines.filter(
    (u) => state.exclusions.get(u.savLineId) !== true
  ).length
  if (untreatedUnmatchedCount > 0) {
    reasons.push(`${untreatedUnmatchedCount} ligne${untreatedUnmatchedCount > 1 ? 's' : ''} SAV non appariée${untreatedUnmatchedCount > 1 ? 's' : ''} à traiter`)
  }

  const blockingNonExcludedCount = state.claimLines.filter(
    (l) => l.blockingForGeneration && state.exclusions.get(l.savLineId) !== true
  ).length
  if (blockingNonExcludedCount > 0) {
    reasons.push(`${blockingNonExcludedCount} ligne${blockingNonExcludedCount > 1 ? 's' : ''} sans prix fournisseur à exclure`)
  }

  const hasValidLine = state.claimLines.some(
    (l) => !l.blockingForGeneration && state.exclusions.get(l.savLineId) !== true
  )
  if (!hasValidLine && state.claimLines.length > 0 && blockingNonExcludedCount === 0) {
    reasons.push('aucune ligne valide à générer')
  }

  return reasons
}

// ---------------------------------------------------------------------------
// Message de plafonnement de quantité (libellé only — anti-confusion pièce/kilo)
//
// Le cap passé à handleQtyBlur vaut `line.effectiveCap ?? line.qteFact`, et `capUnit`
// vaut `line.effectiveCapUnit`. PROBLÈME : pour une ligne en conflit d'unité non
// auto-converti (conversionFlag = 'ATTENTION A CONVERTIR'), le serveur expose
// effectiveCap = qteFact (en PIÈCES) mais effectiveCapUnit = 'Kilos' → afficher
// « X kg » serait FAUX (la valeur est en pièces). L'unité correcte du cap dépend
// donc de l'état de conversion :
//   - conflit 'ATTENTION A CONVERTIR' → cap = qteFact en unité fournisseur → line.unite
//   - sinon, capUnit === 'Kilos' (converti/passthrough) → cap en kg → « kg »
//   - sinon (pièces/Unidades) → line.unite si présent, sinon pas de suffixe (fallback)
// Pure (exporté pour tests). Ne touche AUCUN calcul (clampQty/IMPORTE inchangés).
// ---------------------------------------------------------------------------

export function buildClampMessage(
  cap: number,
  capUnit: string | undefined,
  line: Pick<ArbitrageClaimLine, 'conversionFlag' | 'unite'> | undefined
): string {
  const isConversionConflict = line?.conversionFlag === 'ATTENTION A CONVERTIR'
  const unite = line?.unite ?? null

  let unitLabel: string | null
  if (isConversionConflict) {
    unitLabel = unite
  } else if (capUnit === 'Kilos') {
    unitLabel = 'kg'
  } else {
    unitLabel = unite
  }

  const capDisplay = unitLabel ? `${cap} ${unitLabel}` : `${cap}`

  if (isConversionConflict) {
    // capUnit === 'Kilos' ⇒ prix au kilo (cellule 4 pièce→Kilos). Sinon (ex. g/kg→Unidades),
    // rester générique pour ne pas affirmer à tort « le prix est au kilo ».
    const detail = capUnit === 'Kilos'
      ? ' le prix est au kilo — vérifiez la quantité en kg avant de générer.'
      : ' vérifiez la quantité dans la bonne unité avant de générer.'
    return `Plafonné à ${capDisplay} (qté facturée fournisseur). ⚠ Unité à convertir :${detail}`
  }

  return `Quantité plafonnée à la quantité facturée fournisseur (${capDisplay})`
}

// ---------------------------------------------------------------------------
// 8.7 — Type ClientDemandLine (projection 1:1 sav_lines pour contrôle visuel)
// Exporté pour réutilisation par SupplierClaimView.vue et les tests
// ---------------------------------------------------------------------------

export interface ClientDemandLine {
  savLineId: string | number
  codeFr: string | null
  designationFr: string | null
  qtyRequested: number | null
  unitRequested: string | null
  qtyArbitrated: number | null
  unitArbitrated: string | null
  requestReason: string | null
}

// ---------------------------------------------------------------------------
// Response type from reconcile-supplier-claim op
// ---------------------------------------------------------------------------

interface ReconcileResponse {
  claimLines: Array<ArbitrageClaimLine & {
    creditNoteLink?: unknown
    tokenExtracted?: string
    unite?: string | null
    kilosPiezas?: string | null
    qtyDefaultClient?: number
  }>
  unmatchedSavLines: ArbitrageUnmatchedLine[]
  unusedSupplierLines: ArbitrageUnusedLine[]
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
    warnings: unknown[]
  }
  // 8.7 (AC #5) — bloc additif optionnel (défensif : serveur ancien sans savLines → fallback [])
  savLines?: ClientDemandLine[]
}

// ---------------------------------------------------------------------------
// Composable principal
// ---------------------------------------------------------------------------

export function useSupplierClaimArbitration(
  savId: ComputedRef<number>,
  parseResult: Ref<SupplierFileParseResult | null>
) {
  const reconcileState = ref<ReconcileState | null>(null)
  const reconcileError = ref<string | null>(null)

  // 8.4 : state machine génération
  const generateState = ref<GenerateState>('idle')
  const generateError = ref<string | null>(null)
  const generateResult = ref<GenerateResult | null>(null)

  // Données de réconciliation
  const claimLines = ref<ArbitrageClaimLine[]>([])
  const unmatchedSavLines = ref<ArbitrageUnmatchedLine[]>([])
  const unusedSupplierLines = ref<ArbitrageUnusedLine[]>([])

  // 8.7 (AC #5) — projection 1:1 sav_lines pour la table « Demande client » (read-only)
  const clientDemandLines = ref<ClientDemandLine[]>([])

  // State d'arbitrage (DN-3 = Maps réactives)
  // MEDIUM-3: These are ref<Map> (NOT reactive(Map)). Vue tracks .value reassignment only.
  // ALWAYS reassign .value = new Map(...) — do NOT call .value.set() in place (ref is not deep-reactive).
  const edits = ref(new Map<string | number, number>())
  const exclusions = ref(new Map<string | number, boolean>())
  const comments = ref(new Map<string | number, string>())

  // Messages de clamp par ligne
  // MEDIUM-3: Same ref<Map> pattern — reassign .value = new Map(...) to trigger reactivity.
  const clampMessages = ref(new Map<string | number, string>())

  // ---------------------------------------------------------------------------
  // State dérivé pour computeTotals (OQ-2 : computed refs pour réactivité FR18)
  // ---------------------------------------------------------------------------

  const arbitrageState = computed<ArbitrageState>(() => ({
    claimLines: claimLines.value,
    unmatchedSavLines: unmatchedSavLines.value,
    edits: edits.value,
    exclusions: exclusions.value,
    comments: comments.value,
  }))

  const totalsResult = computed(() => computeTotals(arbitrageState.value))

  const totalImporte = computed(() => totalsResult.value.total)

  const lineImportes = computed(() => totalsResult.value.lineImportes)

  const canGenerateComputed = computed(() => canGenerate(arbitrageState.value))

  const blockingReasons = computed(() => buildBlockingReasons(arbitrageState.value))

  // ---------------------------------------------------------------------------
  // API call
  // ---------------------------------------------------------------------------

  async function runReconcile(): Promise<void> {
    if (!parseResult.value) return

    reconcileState.value = 'reconciling'
    reconcileError.value = null

    try {
      const res = await fetch(
        `/api/sav?op=reconcile-supplier-claim&id=${savId.value}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ parsed: parseResult.value }),
          credentials: 'include',
        }
      )

      const data = await res.json() as ReconcileResponse | { error?: { message?: string } }

      if (!res.ok) {
        const errData = data as { error?: { message?: string } }
        reconcileError.value = errData.error?.message ?? `Erreur ${res.status} — pré-remplissage impossible`
        reconcileState.value = 'reconcile-error'
        return
      }

      const result = data as ReconcileResponse

      // Hydrate state from reconcile response
      claimLines.value = result.claimLines
      unmatchedSavLines.value = result.unmatchedSavLines ?? []
      unusedSupplierLines.value = result.unusedSupplierLines ?? []
      // 8.7 (AC #5) — hydrate clientDemandLines (fallback [] si serveur ancien sans savLines)
      clientDemandLines.value = result.savLines ?? []

      // Initialize edits + comments from claimLines defaults
      const newEdits = new Map<string | number, number>()
      const newComments = new Map<string | number, string>()

      for (const line of result.claimLines) {
        newEdits.set(line.savLineId, line.qty)
        // AC #5 : pré-remplir le commentaire si conversionFlag !== 'ok'
        const flag = line.conversionFlag
        const baseComment = line.comentarios ?? ''
        if (flag !== 'ok' && flag) {
          newComments.set(line.savLineId, flag + (baseComment ? ` ${baseComment}` : ''))
        } else {
          newComments.set(line.savLineId, baseComment)
        }
      }

      edits.value = newEdits
      comments.value = newComments
      exclusions.value = new Map()
      clampMessages.value = new Map()

      reconcileState.value = 'arbitrating'

      // AC #10 : register beforeunload guard (OQ-3)
      registerBeforeUnload()
    } catch (err) {
      reconcileError.value = err instanceof Error ? err.message : 'Erreur réseau — pré-remplissage impossible'
      reconcileState.value = 'reconcile-error'
    }
  }

  // ---------------------------------------------------------------------------
  // Arbitrage actions
  // ---------------------------------------------------------------------------

  function updateQty(lineId: string | number, newQty: number): void {
    const newMap = new Map(edits.value)
    newMap.set(lineId, newQty)
    edits.value = newMap
    // Clear clamp message on update
    const newClampMap = new Map(clampMessages.value)
    newClampMap.delete(lineId)
    clampMessages.value = newClampMap
  }

  function handleQtyBlur(lineId: string | number, inputValue: string, cap: number, capUnit?: string): void {
    const numValue = parseFloat(inputValue)
    const line = claimLines.value.find((l) => l.savLineId === lineId)
    const prevValid = edits.value.get(lineId) ?? line?.qty ?? 0

    // HIGH-1 (CR fix): clamp on cap (effectiveCap in kg for Kilos lines, qteFact in pieces otherwise)
    const clamped = clampQty(numValue, cap, prevValid)
    const newEdits = new Map(edits.value)
    newEdits.set(lineId, clamped)
    edits.value = newEdits

    // Show clamp message if value was out of bounds
    const wasOOB = isNaN(numValue) || numValue < 0 || numValue > cap
    if (wasOOB) {
      const newClampMap = new Map(clampMessages.value)
      // Libellé unité-correcte + mention conversion (anti-confusion pièce/kilo).
      // `line` est déjà résolu ci-dessus (porte conversionFlag + unite).
      newClampMap.set(lineId, buildClampMessage(cap, capUnit, line))
      clampMessages.value = newClampMap
    } else {
      const newClampMap = new Map(clampMessages.value)
      newClampMap.delete(lineId)
      clampMessages.value = newClampMap
    }
  }

  function updateComment(lineId: string | number, comment: string): void {
    const newMap = new Map(comments.value)
    newMap.set(lineId, comment)
    comments.value = newMap
  }

  function toggleLineExclusion(lineId: string | number): void {
    // OQ-1 : mutation in place of reactive Map (Vue 3 idiom)
    const current = exclusions.value.get(lineId)
    const newMap = new Map(exclusions.value)
    newMap.set(lineId, !current)
    exclusions.value = newMap
  }

  // ---------------------------------------------------------------------------
  // 8.4 : generate() — POST /api/sav?op=generate-supplier-claim (PATTERN-DIRECT-BLOB-DOWNLOAD)
  // ---------------------------------------------------------------------------

  async function generate(creditNoteId: number | null = null): Promise<void> {
    if (!canGenerateComputed.value) return

    generateState.value = 'generating'
    generateError.value = null
    generateResult.value = null

    // Build payload (PATTERN-ARBITRATED-CLAIM-PAYLOAD, AC #2)
    // Need access to parseResult to get metadata
    const meta = (parseResult.value as Record<string, unknown> | null)?.['metadata'] as Record<string, unknown> | undefined

    const payloadLines = claimLines.value.map((line) => {
      const qty = arbitrageState.value.edits.get(line.savLineId) ?? line.qty
      const excluded = arbitrageState.value.exclusions.get(line.savLineId) === true
      const comentarios = arbitrageState.value.comments.get(line.savLineId) ?? ''
      return {
        savLineId: line.savLineId,
        codigoEs: line.codigoEs ?? '',
        productoEs: line.productoEs ?? '',
        origen: line.origen ?? null,
        qty,
        unidad: line.unidad,
        causaEs: line.causaEs ?? '',
        precio: line.precio ?? null,
        comentarios,
        excluded,
        blockingForGeneration: line.blockingForGeneration,
        conversionFlag: line.conversionFlag,
      }
    })

    const body = {
      metadata: {
        reference: meta?.['reference'] ?? '',
        albaran: meta?.['albaran'] ?? '',
        fechaAlbaran: meta?.['fechaAlbaran'] ?? '',
      },
      creditNoteId: creditNoteId ?? null,
      claimLines: payloadLines,
    }

    try {
      const res = await fetch(
        `/api/sav?op=generate-supplier-claim&id=${savId.value}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          credentials: 'include',
        }
      )

      if (!res.ok) {
        const errData = await res.json() as { error?: { message?: string; code?: string } }
        generateError.value = errData.error?.message ?? `Erreur ${res.status} — génération impossible`
        generateState.value = 'generate-error'
        return
      }

      // Success : trigger download (PATTERN-DIRECT-BLOB-DOWNLOAD)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const contentDisposition = res.headers.get('content-disposition') ?? ''
      const filenameMatch = contentDisposition.match(/filename="([^"]+)"/)
      const dlFilename = filenameMatch?.[1] ?? 'RECLAMACION_SOL_Y_FRUTA.xlsx'

      const a = document.createElement('a')
      a.href = url
      a.download = dlFilename
      a.click()
      URL.revokeObjectURL(url)

      generateResult.value = { filename: dlFilename, lineCount: payloadLines.filter((l) => !l.excluded).length }
      generateState.value = 'generated'
    } catch (err) {
      generateError.value = err instanceof Error ? err.message : 'Erreur réseau — génération impossible'
      generateState.value = 'generate-error'
    }
  }

  function retryGenerate(creditNoteId: number | null = null): void {
    void generate(creditNoteId)
  }

  // CR fix M1 : AC #5/#7 — confirming Régénérer must fully reset ALL composable state
  // so no stale arbitrage data (edits, exclusions, comments, clampMessages, claimLines,
  // unmatchedSavLines, unusedSupplierLines) survives into the new session.
  // The view is responsible for also resetting the upload composable (state/parseResult).
  function resetToArbitrating(): void {
    generateState.value = 'idle'
    generateError.value = null
    generateResult.value = null
    // Clear all arbitrage state (M1 fix — was missing before CR)
    edits.value = new Map()
    exclusions.value = new Map()
    comments.value = new Map()
    clampMessages.value = new Map()
    claimLines.value = []
    unmatchedSavLines.value = []
    unusedSupplierLines.value = []
    clientDemandLines.value = []  // 8.7 (AC #5) — reset propre (cohérent M1 fix CR 8.5)
    reconcileState.value = null   // reset to initial state (null = no reconcile started)
    reconcileError.value = null
    unregisterBeforeUnload()
  }

  // ---------------------------------------------------------------------------
  // beforeunload guard (AC #10, OQ-3 — MANDATORY anti-false-green)
  // Must register OUR handler that sets the warning text
  // ---------------------------------------------------------------------------

  let _beforeUnloadHandler: ((event: BeforeUnloadEvent) => void) | null = null

  function registerBeforeUnload(): void {
    if (_beforeUnloadHandler) return // Already registered

    _beforeUnloadHandler = (event: BeforeUnloadEvent) => {
      const message = 'Vos modifications ne sont pas sauvegardées'
      event.preventDefault()
      // Modern browsers ignore returnValue but some require it
      event.returnValue = message
      return message
    }

    window.addEventListener('beforeunload', _beforeUnloadHandler)
  }

  function unregisterBeforeUnload(): void {
    if (_beforeUnloadHandler) {
      window.removeEventListener('beforeunload', _beforeUnloadHandler)
      _beforeUnloadHandler = null
    }
  }

  onUnmounted(() => {
    unregisterBeforeUnload()
  })

  // ---------------------------------------------------------------------------
  // Watch parseResult: auto-trigger reconcile when parse completes
  // (AC #1 : "appel automatique après transition previewing")
  //
  // MEDIUM-2 (CR fix): original guard `reconcileState.value === null` blocked reconcile on
  // a SECOND successful upload (parseResult changes but reconcileState is already 'arbitrating').
  // Fixed: re-trigger on any non-loading state (any state except 'reconciling' which is in-flight).
  // On re-trigger, reset ALL arbitrage state so stale savLineId keys from the prior file don't leak.
  // ---------------------------------------------------------------------------

  watch(
    parseResult,
    (newVal) => {
      if (newVal !== null && reconcileState.value !== 'reconciling') {
        // MEDIUM-2: reset stale arbitrage state before re-reconciling
        edits.value = new Map()
        exclusions.value = new Map()
        comments.value = new Map()
        clampMessages.value = new Map()
        claimLines.value = []
        unmatchedSavLines.value = []
        unusedSupplierLines.value = []
        clientDemandLines.value = []  // 8.7 (AC #5) — reset avant re-réconciliation (MEDIUM-2 8.3)
        void runReconcile()
      }
    },
    { immediate: true }
  )

  // ---------------------------------------------------------------------------
  // Expose
  // ---------------------------------------------------------------------------

  return {
    // State
    reconcileState,
    reconcileError,
    claimLines,
    unmatchedSavLines,
    unusedSupplierLines,
    clientDemandLines,  // 8.7 (AC #5) — projection 1:1 sav_lines pour table « Demande client »
    edits,
    exclusions,
    comments,
    clampMessages,

    // Computed
    totalImporte,
    lineImportes,
    canGenerateComputed,
    blockingReasons,

    // Actions
    runReconcile,
    updateQty,
    handleQtyBlur,
    updateComment,
    toggleLineExclusion,

    // 8.4 : génération
    generateState,
    generateError,
    generateResult,
    generate,
    retryGenerate,
    resetToArbitrating,

    // Formatter (for template use)
    formatImporte,
  }
}
