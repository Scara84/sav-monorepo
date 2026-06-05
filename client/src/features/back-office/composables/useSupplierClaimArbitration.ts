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
 * - qty > qteFact → qteFact
 * - qty < 0 → 0
 * - qty = NaN → prevValid
 */
export function clampQty(qty: number, qteFact: number, prevValid: number): number {
  if (isNaN(qty)) return prevValid
  if (qty < 0) return 0
  if (qty > qteFact) return qteFact
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
    // qteFact null means blockingForGeneration (already filtered above), so always non-null here.
    const effectiveQty = Math.min(Math.max(rawQty, 0), line.qteFact ?? 0)

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

  // Données de réconciliation
  const claimLines = ref<ArbitrageClaimLine[]>([])
  const unmatchedSavLines = ref<ArbitrageUnmatchedLine[]>([])
  const unusedSupplierLines = ref<ArbitrageUnusedLine[]>([])

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

  function handleQtyBlur(lineId: string | number, inputValue: string, qteFact: number): void {
    const numValue = parseFloat(inputValue)
    const line = claimLines.value.find((l) => l.savLineId === lineId)
    const prevValid = edits.value.get(lineId) ?? line?.qty ?? 0

    const clamped = clampQty(numValue, qteFact, prevValid)
    const newEdits = new Map(edits.value)
    newEdits.set(lineId, clamped)
    edits.value = newEdits

    // Show clamp message if value was out of bounds
    const wasOOB = isNaN(numValue) || numValue < 0 || numValue > qteFact
    if (wasOOB) {
      const newClampMap = new Map(clampMessages.value)
      newClampMap.set(lineId, `Quantité plafonnée à la quantité facturée fournisseur (${qteFact})`)
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

    // Formatter (for template use)
    formatImporte,
  }
}
