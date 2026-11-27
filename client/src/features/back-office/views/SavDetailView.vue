<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { isTransitionAllowed, type SavStatus } from '../../../shared/business/sav-status-machine'
import { useSavDetail, type SavDetailLine, type SavDetailComment } from '../composables/useSavDetail'
import { useSavLinePreview } from '../composables/useSavLinePreview'
import { useSavLineEdit } from '../composables/useSavLineEdit'
import AddLineDialog from '../components/AddLineDialog.vue'
import ImportSupplierPricesDialog from '../components/ImportSupplierPricesDialog.vue'
import SavTagsBar from '../components/SavTagsBar.vue'
import DuplicateButton from '../components/DuplicateButton.vue'
import OperatorFileUploader from '../components/OperatorFileUploader.vue'
import type { SavLineInput, Unit } from '../../../shared/business/creditCalculation'
import { formatDiff } from '../utils/format-audit-diff'
import { isOneDriveWebUrlTrusted } from '../../../shared/utils/onedrive-whitelist'
import { useCurrentUser } from '../../../shared/composables/useCurrentUser'
import { unitMarginHtCents } from '../lib/computeMargin'

/**
 * Story 3.4 — Vue détail SAV back-office.
 * Story 4.3 — Encart « Aperçu avoir » (preview live sans IO).
 * Story 3.7b — Tags, compose commentaire, M'assigner, DuplicateButton, OperatorFileUploader.
 *
 * Sections : header + lignes (readonly V1) + preview avoir + fichiers +
 * commentaires + audit. Dégradation propre si vignette image KO.
 */

const route = useRoute()
const router = useRouter()
const savId = computed(() => Number(route.params['id']))
const {
  sav,
  comments,
  commentsDegraded,
  auditTrail,
  auditDegraded,
  auditTruncated,
  settingsSnapshot,
  creditNote,
  creditNoteDegraded,
  // Story 8.5 — badge réclamation fournisseur (AC #3)
  supplierClaim,
  loading,
  error,
  refresh,
  refreshExchanges,
} = useSavDetail(savId)
const isNotFound = computed(() => (error.value as string | null) === 'not_found')
const hasOtherError = computed(() => error.value !== null && !isNotFound.value)

// --- Story 4.3 : preview avoir live -----------------------------------------
const UNITS = new Set(['kg', 'piece', 'liter'])

// `previewLines` = Ref mutable. V1 readonly (sync auto depuis `sav.lines`) ;
// Story 3.6b branchera l'édition inline directement sur ce ref pour que la
// preview réagisse au keystroke sans re-fetch.
const previewLines = ref<SavLineInput[]>([])
const vatRateDefaultBp = computed(() => settingsSnapshot.value.vat_rate_default_bp)
const groupManagerDiscountBp = computed(() => settingsSnapshot.value.group_manager_discount_bp)

// Review AC #3 — `isGroupManager` doit être un computed (vs ref+watch).
const isGroupManager = computed<boolean>(() => {
  const s = sav.value
  if (!s || !s.member) return false
  return !!s.member.isGroupManager && s.member.groupId !== null && s.member.groupId === s.groupId
})

// Review P3 — libellé remise dérivé des settings. Ex: 400 bp → « 4 % », 450 bp → « 4,5 % ».
function formatBp(bp: number | null | undefined): string {
  if (bp === null || bp === undefined || !Number.isFinite(bp)) return '—'
  const pct = bp / 100
  const formatted = (Math.round(pct * 100) / 100).toString().replace('.', ',')
  return `${formatted} %`
}
const discountLabel = computed(() => formatBp(groupManagerDiscountBp.value))

function toSavLineInput(l: {
  qtyRequested: number
  unitRequested: string
  qtyInvoiced: number | null
  unitInvoiced: string | null
  qtyArbitrated: number | null
  unitArbitrated: string | null
  unitPriceTtcCents: number | null
  unitPriceTtcArbitratedCents: number | null
  vatRateBpSnapshot: number | null
  creditCoefficient: number
  pieceToKgWeightG: number | null
}): SavLineInput {
  return {
    qty_requested: l.qtyRequested,
    unit_requested: (UNITS.has(l.unitRequested)
      ? l.unitRequested
      : 'kg') as SavLineInput['unit_requested'],
    qty_invoiced: l.qtyInvoiced,
    unit_invoiced: (l.unitInvoiced && UNITS.has(l.unitInvoiced)
      ? l.unitInvoiced
      : null) as SavLineInput['unit_invoiced'],
    // V1.9-B — toujours inclure les champs arbitrage (présence détectée par
    // `'qty_arbitrated' in input` côté engine : absent = backward compat
    // V1.9-A, présent-null = awaiting_arbitration, présent-non-null = arbitré).
    qty_arbitrated: l.qtyArbitrated,
    unit_arbitrated: (l.unitArbitrated && UNITS.has(l.unitArbitrated)
      ? l.unitArbitrated
      : null) as Unit | null,
    unit_price_ttc_cents: l.unitPriceTtcCents,
    // V1.9-B.2 — override opérateur PU TTC (Row 3, NULL = fallback facture)
    unit_price_ttc_arbitrated_cents: l.unitPriceTtcArbitratedCents,
    vat_rate_bp_snapshot: l.vatRateBpSnapshot,
    credit_coefficient: l.creditCoefficient,
    piece_to_kg_weight_g: l.pieceToKgWeightG,
  }
}

watch(
  () => sav.value,
  (s) => {
    previewLines.value = (s?.lines ?? []).map(toSavLineInput)
  },
  { immediate: true }
)

// Review P4 — le composable attend `Ref<number | null>` / `Ref<boolean>` ;
// on les adapte depuis les computed via des refs sync-one-way.
const vatRateDefaultBpRef = ref<number | null>(vatRateDefaultBp.value)
const groupManagerDiscountBpRef = ref<number | null>(groupManagerDiscountBp.value)
const isGroupManagerRef = ref<boolean>(isGroupManager.value)
watch(vatRateDefaultBp, (v) => {
  vatRateDefaultBpRef.value = v
})
watch(groupManagerDiscountBp, (v) => {
  groupManagerDiscountBpRef.value = v
})
watch(isGroupManager, (v) => {
  isGroupManagerRef.value = v
})

const preview = useSavLinePreview({
  lines: previewLines,
  vatRateDefaultBp: vatRateDefaultBpRef,
  groupManagerDiscountBp: groupManagerDiscountBpRef,
  isGroupManager: isGroupManagerRef,
})

// Review P1 — cible de l'ancre « lien vers la 1re ligne bloquante »
const firstBlockingLineId = computed<number | null>(() => {
  const lines = sav.value?.lines ?? []
  for (const l of lines) {
    if (l.validationStatus !== 'ok') return l.id
  }
  return null
})
function scrollToFirstBlocking(event: Event): void {
  const id = firstBlockingLineId.value
  if (id === null) return
  event.preventDefault()
  const el = document.getElementById(`sav-line-${id}`)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

const showPreview = computed(
  () => sav.value?.status === 'in_progress' || sav.value?.status === 'validated'
)

// --- Story 3.6b : édition inline lignes + bouton Valider -----------------
const savIdRef = computed<number>(() => sav.value?.id ?? 0)

// La version locale sert au CAS : après un save, on la met à jour sans
// attendre le refresh full (sauf POST/DELETE qui refresh).
const localVersion = ref<number>(0)
watch(
  () => sav.value?.version,
  (v) => {
    if (typeof v === 'number') localVersion.value = v
  }
)

const lineEdit = useSavLineEdit({
  savId: savIdRef,
  savVersion: localVersion,
  onVersionUpdated: (v) => {
    localVersion.value = v
  },
  onRefreshRequested: refresh,
})

// Draft values par ligne en édition (key = lineId).
// Les inputs type=number peuvent émettre string OU number (Vue binding + jsdom
// setValue coerce différemment) — on accepte les deux.
const editDraft = reactive<
  Record<
    number,
    {
      qtyRequested: string | number
      unitRequested: string
      qtyArbitrated: string | number
      unitArbitrated: string
      priceEdited: boolean
      unitPriceEuros: string | number
      creditCoefficient: string | number
      pieceToKgWeightG: string | number
    }
  >
>({})

const lineError = ref<{ id: number; message: string; field?: string } | null>(null)

function focusLineControl(id: number, control: string): void {
  void nextTick(() => document.getElementById(`${control}-${id}`)?.focus())
}

function beginEditLine(l: SavDetailLine): void {
  if (sav.value?.status !== 'in_progress' || lineEdit.savingLineId.value !== null) return
  lineError.value = null
  const previous = lineEdit.editingLineId.value
  if (previous !== null) delete editDraft[previous]
  editDraft[l.id] = {
    qtyRequested: String(l.qtyRequested),
    unitRequested: l.unitRequested,
    qtyArbitrated: l.qtyArbitrated ?? '',
    unitArbitrated: l.unitArbitrated ?? l.unitInvoiced ?? '',
    priceEdited: false,
    // V1.9-B.2 — pre-fill PU TTC arbitré : override ?? facture (DN-4 pattern étendu)
    unitPriceEuros: (() => {
      const effective = l.unitPriceTtcArbitratedCents ?? l.unitPriceTtcCents
      return effective !== null ? (effective / 100).toFixed(2) : ''
    })(),
    creditCoefficient: String(l.creditCoefficient),
    pieceToKgWeightG: l.pieceToKgWeightG !== null ? String(l.pieceToKgWeightG) : '',
  }
  lineEdit.startEdit(l.id)
  focusLineControl(l.id, 'edit-qty-requested')
  toastMessage.value = null
}

function cancelEditLine(): void {
  if (lineEdit.savingLineId.value !== null) return
  lineError.value = null
  const id = lineEdit.editingLineId.value
  lineEdit.cancelEdit()
  // P7 (CR Edge-11) : cleanup draft après annulation.
  if (id !== null) {
    delete editDraft[id]
    focusLineControl(id, 'edit-line')
  }
}

watch(() => sav.value?.status, (status) => {
  if (status && status !== 'in_progress' && lineEdit.editingLineId.value !== null) cancelEditLine()
})

// P2 (CR Blind-5) : locale FR — accepter virgule comme séparateur décimal.
// Défensif : Vue `<input type="number">` peut émettre number ou string selon
// le scénario (setValue en tests vs user type).
function parseLocaleNumber(raw: string | number): number {
  if (typeof raw === 'number') return raw
  return Number(String(raw).replace(',', '.').trim())
}

function isEmptyDraftField(v: unknown): boolean {
  return v === '' || v === null || v === undefined
}

async function saveEditLine(l: SavDetailLine, event: Event): Promise<void> {
  const draft = editDraft[l.id]
  if (!draft || sav.value?.status !== 'in_progress' || lineEdit.savingLineId.value !== null) return
  lineError.value = null
  const row = (event.currentTarget as HTMLElement).closest('tbody')
  const inputs = row?.querySelectorAll<HTMLInputElement>('input[data-quantity]')
  const invalid = inputs && Array.from(inputs).find(input => {
    if (input.validity.badInput) return true
    if (input.value === '') return input.required
    const value = Number(input.value)
    return !Number.isFinite(value) || value < Number(input.min) || value > Number(input.max)
      || value !== Number(value.toFixed(3))
  })
  if (invalid) {
    const requested = invalid.dataset.quantity === 'requested'
    lineError.value = {
      id: l.id,
      field: invalid.id,
      message: requested
        ? 'Saisissez une quantité demandée de 0,001 à 99 999, avec trois décimales maximum.'
        : 'Saisissez une quantité retenue de 0 à 99 999, avec trois décimales maximum, ou laissez le champ vide.',
    }
    invalid.focus()
    return
  }
  const patch: Record<string, unknown> = {}
  const qtyReq = parseLocaleNumber(draft.qtyRequested)
  if (Number.isFinite(qtyReq) && qtyReq !== l.qtyRequested) patch['qtyRequested'] = qtyReq
  if (draft.unitRequested && draft.unitRequested !== l.unitRequested)
    patch['unitRequested'] = draft.unitRequested
  const quantity = isEmptyDraftField(draft.qtyArbitrated) ? null : parseLocaleNumber(draft.qtyArbitrated)
  const initialUnit = l.unitArbitrated ?? l.unitInvoiced ?? null
  const unit = draft.unitArbitrated || (quantity !== null ? l.unitInvoiced : null)
  if (quantity !== null && !unit) {
    const field = `edit-unit-arbitrated-${l.id}`
    lineError.value = { id: l.id, field, message: 'Choisissez une unité pour la quantité retenue.' }
    focusLineControl(l.id, 'edit-unit-arbitrated')
    return
  }
  if (quantity !== (l.qtyArbitrated ?? null)) {
    patch['qtyArbitrated'] = quantity
    if (quantity !== null || unit !== initialUnit) patch['unitArbitrated'] = unit
  } else if (unit !== initialUnit) {
    patch['unitArbitrated'] = unit
  }
  // V1.9-B.2 — l'opérateur édite désormais unitPriceTtcArbitratedCents (override Row 3).
  // Le champ unit_price_ttc_cents (Row 2 = facture Pennylane) n'est plus éditable côté UI.
  if (draft.priceEdited && !isEmptyDraftField(draft.unitPriceEuros)) {
    const cents = Math.round(parseLocaleNumber(draft.unitPriceEuros) * 100)
    if (Number.isFinite(cents) && cents !== l.unitPriceTtcArbitratedCents)
      patch['unitPriceTtcArbitratedCents'] = cents
  }
  if (!isEmptyDraftField(draft.creditCoefficient)) {
    const c = parseLocaleNumber(draft.creditCoefficient)
    if (Number.isFinite(c) && c !== l.creditCoefficient) patch['creditCoefficient'] = c
  }
  if (!isEmptyDraftField(draft.pieceToKgWeightG)) {
    const g = Math.round(parseLocaleNumber(draft.pieceToKgWeightG))
    if (Number.isFinite(g) && g !== l.pieceToKgWeightG) patch['pieceToKgWeightG'] = g
  }
  if (Object.keys(patch).length === 0) {
    cancelEditLine()
    return
  }
  const result = await lineEdit.savePatch(l.id, patch)
  if (!result.ok) {
    if (result.error.code === 'VERSION_CONFLICT') {
      toastMessage.value = 'Rechargez, le SAV a été modifié par un autre utilisateur.'
      lineEdit.cancelEdit()
      delete editDraft[l.id]
      lineError.value = { id: l.id, message: 'Le dossier a changé. Vérifiez les valeurs rechargées avant de reprendre.' }
      await refresh()
      focusLineControl(l.id, 'edit-line')
    } else {
      lineError.value = { id: l.id, message: result.error.message }
    }
    return
  }
  // P7 (CR Edge-11) : cleanup draft pour éviter accumulation mémoire.
  delete editDraft[l.id]
  // V1.9-B.3 : refresh post-save réintroduit. La RPC retourne validationStatus
  // mais pas creditAmountCents recomputé par le trigger, ni les autres colonnes
  // recalculées. Sans refresh, l'opérateur voit l'état stale et croit que le
  // save a échoué ("rien ne se passe"). Le refresh garantit que Row 3 affiche
  // l'arbitrage saisi + l'avoir/validation à jour.
  await refresh()
  focusLineControl(l.id, 'edit-line')
}

async function deleteLineConfirmed(l: SavDetailLine): Promise<void> {
  if (!confirmFn(`Supprimer la ligne ${l.lineNumber ?? l.position} (${l.productNameSnapshot}) ?`))
    return
  const result = await lineEdit.deleteLine(l.id)
  if (!result.ok) {
    if (result.error.code === 'VERSION_CONFLICT') {
      toastMessage.value = 'Rechargez, le SAV a été modifié par un autre utilisateur.'
      await refresh()
    } else {
      toastMessage.value = result.error.message
    }
  }
}

// P5 (CR Blind-12) : wrapper minimal autour de window.confirm. Les tests
// stubbent `window.confirm` via `vi.stubGlobal('confirm', …)` — une injection
// via provide/props serait plus propre mais overkill V1 pour un simple yes/no.
function confirmFn(message: string): boolean {
  if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
    return window.confirm(message)
  }
  return true
}

// Modal ajout ligne
const addLineOpen = ref(false)
function openAddLine(): void {
  addLineOpen.value = true
}

// Story 4.8 — Modal import prix fournisseur
const importSupplierOpen = ref(false)
function openImportSupplier(): void {
  importSupplierOpen.value = true
}
function closeImportSupplierOnEsc(e?: KeyboardEvent): void {
  if (e && e.key !== 'Escape') return
  if (importSupplierOpen.value) importSupplierOpen.value = false
}
async function onImportApplied(): Promise<void> {
  // Refresh pour afficher les nouveaux prix fournisseur et marges
  await refresh()
  toastMessage.value = 'Prix fournisseur importés avec succès.'
}
async function handleAddLineCreate(body: {
  productCodeSnapshot: string
  productNameSnapshot: string
  qtyRequested: number
  unitRequested: 'kg' | 'piece' | 'liter'
  unitPriceTtcCents?: number
  vatRateBpSnapshot?: number
  creditCoefficient?: number
}): Promise<void> {
  const result = await lineEdit.createLine({ ...body })
  if (!result.ok) {
    toastMessage.value = result.error.message
    return
  }
  addLineOpen.value = false
}

// Bouton Valider
const toastMessage = ref<string | null>(null)
const canValidate = computed<boolean>(() => {
  const lines = sav.value?.lines ?? []
  return lines.length > 0 && lines.every((l) => l.validationStatus === 'ok')
})
function allowsTransition(to: SavStatus): boolean {
  return !!sav.value && isTransitionAllowed(sav.value.status as SavStatus, to)
}
const {
  user: currentUser, loading: currentUserLoading,
  retryable: identityRetryable, retry: retryIdentity,
} = useCurrentUser()
const isOperator = computed(() => currentUser.value?.type === 'operator')
const showValidateButton = computed(() => isOperator.value && allowsTransition('validated'))
const validating = ref(false)

// Story V1.13 AC#8 (D-1=a, D-5) — gate « Valider » :
// PDF avoir requis (creditNote.pdfWebUrl présent) + creditNote non dégradé.
// Priorité du title : lignes en erreur > bon SAV manquant > nominal.
const hasCreditNotePdf = computed<boolean>(() => Boolean(creditNote.value?.pdfWebUrl))
const validateGateAllowsPdf = computed<boolean>(
  () => hasCreditNotePdf.value && !creditNoteDegraded.value
)
const validateDisabled = computed<boolean>(
  () => !canValidate.value || !validateGateAllowsPdf.value || validating.value
)
const validateTitle = computed<string>(() => {
  if (!sav.value?.lines.length) return 'Ajoutez une ligne avant de valider'
  if (!canValidate.value) return 'Corrige les lignes en erreur avant de valider'
  if (creditNoteDegraded.value) return 'Rechargez la fiche pour vérifier le bon SAV'
  if (creditNote.value && !hasCreditNotePdf.value) return 'Le PDF du bon SAV doit être disponible avant la validation'
  if (!validateGateAllowsPdf.value) return "Générez d'abord le bon SAV"
  return 'Valider le SAV'
})

async function validateSav(): Promise<void> {
  if (!showValidateButton.value || validateDisabled.value) return
  await transitionStatus('validated', { onLinesBlocked: () => scrollToFirstBlockingAfterRefresh() })
}

// --- Workflow back-office : boutons transitions générique ------------------
// Centralise PATCH /api/sav/:id/status pour tous les boutons workflow
// (Marquer reçu, Démarrer, Valider, Clôturer, Annuler). Le serveur (RPC
// `transition_sav_status`) reste source de vérité — l'UI propose juste les
// transitions actuellement valides via `currentAllowedTransitions`.
const transitioning = ref<SavStatus | null>(null)

interface TransitionOptions {
  note?: string
  onLinesBlocked?: () => void
}

async function transitionStatus(target: SavStatus, opts: TransitionOptions = {}): Promise<boolean> {
  if (!sav.value) return false
  // CR F-2 : garde re-entry — bloque si une transition est déjà en vol pour
  // éviter race entre 2 PATCHes concurrents sur la même `localVersion`.
  if (transitioning.value !== null) return false
  transitioning.value = target
  toastMessage.value = null
  if (target === 'validated') validating.value = true
  try {
    const res = await fetch(`/api/sav/${sav.value.id}/status`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        status: target,
        version: localVersion.value,
        ...(opts.note ? { note: opts.note } : {}),
      }),
      signal: AbortSignal.timeout(30_000), // F-15 H-07
    })
    // CR F-8 : 401/403 — session perdue → redirect login (cohérent useSavDetail).
    if (res.status === 401 || res.status === 403) {
      toastMessage.value = 'Session expirée — reconnexion nécessaire.'
      if (typeof window !== 'undefined') window.location.href = '/admin/login'
      return false
    }
    // CR F-8 : 404 — SAV introuvable / supprimé entre-temps.
    if (res.status === 404) {
      toastMessage.value = 'SAV introuvable — il a peut-être été supprimé.'
      return false
    }
    if (res.status === 422) {
      const body = (await res.json().catch(() => null)) as {
        error?: { details?: { code?: string } }
      } | null
      const code = body?.error?.details?.code
      if (code === 'LINES_BLOCKED') {
        await refresh()
        toastMessage.value = 'Des lignes sont encore en erreur — valider impossible.'
        opts.onLinesBlocked?.()
        return false
      }
      if (code === 'CREDIT_NOTE_PDF_REQUIRED') {
        // Story V1.13 AC#8 (e) — race UI : l'opérateur a cliqué avant que le
        // poll PDF n'arrive, le serveur tranche. Libellé PO D-5.
        await refresh()
        toastMessage.value = "Générez d'abord le bon SAV (émettez l'avoir)."
        return false
      }
      if (code === 'INVALID_TRANSITION') {
        await refresh()
        toastMessage.value = 'Transition non autorisée — le SAV a été rechargé.'
        return false
      }
      toastMessage.value = 'Action refusée par le serveur.'
      return false
    }
    if (res.status === 409) {
      toastMessage.value = 'Version périmée — le SAV sera rechargé.'
      await refresh()
      return false
    }
    // CR F-5 : 400 — validation Zod côté serveur (note >500 chars, etc.).
    if (res.status === 400) {
      toastMessage.value = 'Données invalides — vérifie le motif (max 500 caractères).'
      return false
    }
    if (!res.ok) {
      toastMessage.value = `Échec ${target} (erreur serveur).`
      return false
    }
    const body = (await res.json().catch(() => null)) as {
      data?: {
        walletWarnings?: Array<{ message?: string }>
      }
    } | null
    await refresh()
    const walletWarnings = body?.data?.walletWarnings ?? []
    if (target === 'validated' && walletWarnings.length > 0) {
      const firstMessage = walletWarnings[0]?.message?.trim()
      toastMessage.value =
        firstMessage && firstMessage.length > 0
          ? firstMessage
          : "SAV validé, mais un problème est survenu pendant le crédit wallet."
    }
    return true
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      toastMessage.value = 'La requête a pris trop de temps, réessayez.'
    } else {
      toastMessage.value = e instanceof Error ? e.message : 'Erreur réseau'
    }
    return false
  } finally {
    transitioning.value = null
    if (target === 'validated') validating.value = false
  }
}

function scrollToFirstBlockingAfterRefresh(): void {
  if (firstBlockingLineId.value === null) return
  const el = document.getElementById(`sav-line-${firstBlockingLineId.value}`)
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

function isTransitioning(s: SavStatus): boolean {
  return transitioning.value === s
}

// Boutons header — lisibilité Vue.
const showReceiveButton = computed<boolean>(() => sav.value?.status === 'draft')
const showStartButton = computed(() => allowsTransition('in_progress'))
const showCloseButton = computed(() => allowsTransition('closed'))
const showCancelButton = computed(() => allowsTransition('cancelled'))

async function receiveSav(): Promise<void> {
  await transitionStatus('received')
}
async function startSav(): Promise<void> {
  await transitionStatus('in_progress')
}
async function closeSav(): Promise<void> {
  if (!confirmFn('Clôturer ce SAV ? L’état "clos" est définitif.')) return
  await transitionStatus('closed')
}
async function cancelSav(): Promise<void> {
  const raw = window.prompt('Motif (optionnel) — annuler ce SAV ?')
  // null = clic Annuler dans la prompt → on n'annule pas le SAV
  if (raw === null) return
  // CR F-5 : trim + cap 500 chars (cohérent avec `statusBodySchema.note.max(500)`
  // côté `transition-handlers.ts`). Évite un 400 VALIDATION_FAILED côté serveur
  // pour saisie pathologique > 500 chars (copy-paste). Empty string → no `note`.
  const trimmed = raw.trim().slice(0, 500)
  await transitionStatus('cancelled', trimmed ? { note: trimmed } : {})
}

// --- Workflow back-office : émission avoir ---------------------------------
const showEmitCreditButton = computed<boolean>(
  () =>
    isOperator.value &&
    (sav.value?.status === 'validated' || sav.value?.status === 'in_progress') &&
    !creditNote.value &&
    !creditNoteDegraded.value
)
const emitDialogSavId = ref<number | null>(null)
const emitting = ref(false)
const emitError = ref<string | null>(null)
const emitBonType = ref<'AVOIR' | 'VIREMENT BANCAIRE' | 'PAYPAL'>('AVOIR')

const emitTrigger = ref<HTMLButtonElement | null>(null)
const emitDialog = ref<HTMLElement | null>(null)
const workflowHeading = ref<HTMLElement | null>(null)

watch(savId, () => {
  emitDialogSavId.value = null
  emitError.value = null
}, { flush: 'sync' })

async function openEmitDialog(): Promise<void> {
  if (!showEmitCreditButton.value || !canValidate.value || emitting.value || sav.value?.id !== savId.value) return
  emitError.value = null
  emitBonType.value = 'AVOIR'
  emitDialogSavId.value = savId.value
  await nextTick()
  emitDialog.value?.querySelector<HTMLElement>('input:checked')?.focus()
}

function trapEmitFocus(event: KeyboardEvent): void {
  const first = emitDialog.value?.querySelector<HTMLElement>('input:checked')
  const last = emitDialog.value?.querySelector<HTMLElement>('[data-testid="sav-emit-confirm"]')
  if (emitting.value) {
    event.preventDefault()
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}

// CR F-7 : helper pour ESC / backdrop / bouton Annuler. Bloque pendant
// l'émission pour éviter une fermeture accidentelle pendant le POST.
async function closeEmitDialog(): Promise<void> {
  if (emitting.value) return
  emitDialogSavId.value = null
  await nextTick()
  emitTrigger.value?.focus()
}

async function submitEmit(): Promise<void> {
  const dossierId = emitDialogSavId.value
  if (dossierId === null || dossierId !== savId.value || dossierId !== sav.value?.id ||
      !showEmitCreditButton.value || !canValidate.value || emitting.value) return
  emitDialog.value?.focus()
  emitting.value = true
  emitError.value = null
  try {
    const res = await fetch(`/api/sav/${dossierId}/credit-notes`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bon_type: emitBonType.value }),
    })
    if (emitDialogSavId.value !== dossierId) return
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: {
          code: string
          message: string
          details?: { code?: string; number_formatted?: string }
        }
      } | null
      if (emitDialogSavId.value !== dossierId) return
      const detailsCode = body?.error?.details?.code
      if (detailsCode === 'CREDIT_NOTE_ALREADY_ISSUED') {
        // CR F-4 : refresh d'abord (pour exposer l'avoir existant côté UI),
        // puis fermer la modale et afficher le toast — l'opérateur voit la
        // section « Avoir émis » immédiatement, plus de cycle de re-clic.
        await refresh()
        if (emitDialogSavId.value !== dossierId) return
        maybeStartPdfPoll()
        emitDialogSavId.value = null
        toastMessage.value = `Un avoir a déjà été émis (n°${body?.error?.details?.number_formatted ?? '?'}).`
        return
      }
      if (detailsCode === 'NO_VALID_LINES') {
        emitError.value = 'Une ou plusieurs lignes ne sont pas validées.'
        return
      }
      if (detailsCode === 'NO_LINES') {
        emitError.value = 'Le SAV ne contient aucune ligne.'
        return
      }
      emitError.value = body?.error?.message ?? `Échec émission (HTTP ${res.status}).`
      return
    }
    emitDialogSavId.value = null
    await refresh()
    // spec credit-note-pdf-regenerate-feedback : la génération PDF est async
    // (waitUntil) ; on poll l'état pour éviter le « en cours » figé à l'infini.
    if (savId.value === dossierId) maybeStartPdfPoll()
  } catch (e) {
    if (emitDialogSavId.value !== dossierId) return
    emitError.value = e instanceof Error ? e.message : 'Erreur réseau'
  } finally {
    emitting.value = false
    await nextTick()
    if (emitDialogSavId.value === dossierId) {
      emitDialog.value?.querySelector<HTMLElement>('[data-testid="sav-emit-confirm"]')?.focus()
    } else if (savId.value === dossierId) {
      workflowHeading.value?.focus()
    }
  }
}

// --- spec credit-note-pdf-regenerate-feedback : poll + régénération PDF ------
// Le PDF d'avoir est généré en tâche de fond après émission. On poll l'état de
// façon bornée ; si le timeout expire sans `pdfWebUrl`, on bascule en phase
// `failed` (message + bouton « Régénérer le PDF » → endpoint synchrone existant).
const PDF_POLL_INTERVAL_MS = 3000
const PDF_POLL_MAX_ATTEMPTS = 5

const PDF_FAILURE_MESSAGES: Record<string, string> = {
  PDF_GENERATION_FAILED:
    'Génération impossible : données manquantes (paramètres société non renseignés ?). Contactez un administrateur.',
  PDF_RENDER_FAILED:
    'Échec du rendu du document. Réessayez ; si ça persiste, contactez un admin.',
  PDF_UPLOAD_FAILED: "Échec de l'envoi du PDF (OneDrive indisponible). Réessayez.",
}
const PDF_FAILURE_FALLBACK = 'Échec de la régénération du PDF.'
const PDF_RATE_LIMITED_MSG = 'Trop de tentatives. Patientez avant de réessayer.'
const PDF_FAILED_DEFAULT_MSG =
  "Le PDF n'a pas pu être généré automatiquement. Vous pouvez relancer la génération."

const pdfPolling = ref(false)
const regenerating = ref(false)
const regenerateError = ref<string | null>(null)

// Token d'annulation : tout `await` reprend en vérifiant `token === pdfPollToken`.
// Incrémenté à `onUnmounted` (et à chaque nouveau poll) pour invalider l'ancien.
let pdfPollToken = 0

const creditNotePdfPhase = computed<'ready' | 'pending' | 'failed'>(() =>
  creditNote.value?.pdfWebUrl ? 'ready' : pdfPolling.value ? 'pending' : 'failed'
)

const accountingInstruction = computed(() => {
  if (!isOperator.value || !(showValidateButton.value || sav.value?.status === 'validated')) return ''
  if (creditNoteDegraded.value) return 'Rechargez la fiche pour vérifier si un avoir a déjà été émis.'
  if (creditNote.value && !hasCreditNotePdf.value) {
    const number = creditNote.value.numberFormatted
    return creditNotePdfPhase.value === 'pending'
      ? `Avoir ${number} émis. Le PDF est en préparation.`
      : `Avoir ${number} émis. Relancez la génération de son PDF.`
  }
  if (!showValidateButton.value && !showEmitCreditButton.value) return ''
  if (!sav.value?.lines.length) return 'Ajoutez une ligne au dossier.'
  if (!canValidate.value) return 'Corrigez les lignes en erreur.'
  if (showEmitCreditButton.value) return 'Émettre l’avoir attribue un numéro comptable et lance la préparation du PDF.'
  if (showValidateButton.value) return 'Le PDF de l’avoir est disponible. Vous pouvez valider le SAV.'
  return ''
})

async function reloadAccounting(): Promise<void> {
  await refresh()
  maybeStartPdfPoll()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pollPdfStatus(): Promise<void> {
  const token = ++pdfPollToken
  pdfPolling.value = true
  regenerateError.value = null
  try {
    for (let attempt = 0; attempt < PDF_POLL_MAX_ATTEMPTS; attempt++) {
      await sleep(PDF_POLL_INTERVAL_MS)
      if (token !== pdfPollToken) return // annulé (unmount / nouveau poll)
      await refresh()
      if (token !== pdfPollToken) return
      if (creditNote.value?.pdfWebUrl) return // prêt → stop
    }
  } finally {
    if (token === pdfPollToken) pdfPolling.value = false
  }
}

function maybeStartPdfPoll(): void {
  if (creditNote.value && !creditNote.value.pdfWebUrl && !pdfPolling.value) {
    void pollPdfStatus()
  }
}

// spec credit-note-force-regenerate-pdf : `regeneratePdf` accepte un flag `force`.
//   - { force: false } (défaut) : chemin AC #8 (relance d'une génération initiale
//     échouée). Sans force → contrat 409 PDF_ALREADY_GENERATED strictement inchangé.
//   - { force: true } : appelle l'endpoint force (recalcul totaux + RPC + delete
//     OneDrive + re-génération). Refresh après 200 ET après tout échec ≠ 422 ;
//     422 → message serveur sans refresh ; 409 CREDIT_NOTE_STATE_CHANGED →
//     message « lignes ont changé, rechargez » + refresh.
async function regeneratePdf(opts: { force?: boolean } = {}): Promise<void> {
  const cn = creditNote.value
  if (!isOperator.value || creditNoteDegraded.value || !cn || regenerating.value) return
  const force = opts.force === true
  regenerating.value = true
  regenerateError.value = null
  try {
    const res = await fetch(
      `/api/credit-notes/${encodeURIComponent(cn.numberFormatted)}/regenerate-pdf`,
      force
        ? {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ force: true }),
          }
        : { method: 'POST', credentials: 'include' }
    )
    if (res.ok) {
      await refresh() // pdfWebUrl désormais renseigné → phase `ready` → lien
      return
    }
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string; details?: { code?: string; failure_kind?: string } }
    } | null
    const details = body?.error?.details

    if (force) {
      // Mode force : mapping spécifique.
      if (res.status === 429) {
        regenerateError.value = PDF_RATE_LIMITED_MSG
        await refresh()
        return
      }
      if (res.status === 409 && details?.code === 'CREDIT_NOTE_STATE_CHANGED') {
        regenerateError.value = 'Les lignes ont changé, rechargez la page.'
        await refresh()
        return
      }
      if (res.status === 422) {
        // 422 → message serveur SANS refresh (l'opérateur garde la vue stable
        // pour comprendre la cause — typiquement SAV figé ou ligne bloquante).
        regenerateError.value =
          body?.error?.message ?? 'Régénération impossible.'
        return
      }
      // Tout autre échec ≠ 422 → refresh (pas de lien mort) + message mappé.
      const kindForce = details?.failure_kind
      regenerateError.value =
        (kindForce && PDF_FAILURE_MESSAGES[kindForce]) || PDF_FAILURE_FALLBACK
      await refresh()
      return
    }

    // Mode legacy (sans force) : contrat AC #8 inchangé.
    if (res.status === 409 && details?.code === 'PDF_ALREADY_GENERATED') {
      await refresh() // course bénigne : le PDF a fini entre-temps
      return
    }
    if (res.status === 429) {
      regenerateError.value = PDF_RATE_LIMITED_MSG
      return
    }
    const kind = details?.failure_kind
    regenerateError.value = (kind && PDF_FAILURE_MESSAGES[kind]) || PDF_FAILURE_FALLBACK
  } catch {
    regenerateError.value = PDF_FAILURE_FALLBACK
    // CR P4a : sur échec réseau/timeout du chemin force, un timeout lambda
    // peut survenir APRÈS commit de la RPC (totaux déjà mutés, pdf_web_url
    // remis à NULL). Sans refresh, l'UI resterait en phase `ready` avec un
    // lien mort vers l'ancien PDF. On rafraîchit pour récupérer l'état réel
    // (qui basculera typiquement en phase `failed`).
    if (force) {
      try {
        await refresh()
      } catch {
        // refresh peut aussi échouer si le réseau est cassé — on garde le
        // message d'erreur déjà posé.
      }
    }
  } finally {
    regenerating.value = false
  }
}

// spec credit-note-force-regenerate-pdf — confirmation utilisateur avant
// déclenchement du recalcul + écrasement du PDF.
async function forceRegeneratePdf(): Promise<void> {
  if (
    !confirmFn(
      'Régénérer le PDF : recalcule les montants de l’avoir et remplace le PDF. Continuer ?'
    )
  ) {
    return
  }
  await regeneratePdf({ force: true })
}

onUnmounted(() => {
  pdfPollToken++ // invalide tout poll en cours
})

onMounted(async () => {
  await refresh()
  // CN-PDF-D1 : armer le poll aussi au chargement/reload. Si on rouvre la page
  // d'un avoir dont le PDF est encore en cours de génération (pdfWebUrl null),
  // on montre « en cours… » + poll borné au lieu de basculer « failed » d'emblée.
  // Un avoir réellement en échec affichera donc ~15 s de « en cours » avant le
  // bouton — tradeoff assumé (le 409 idempotent couvre la course succès tardif).
  maybeStartPdfPoll()
})

const STATUS_COLOR: Record<string, string> = {
  draft: 'bg-violet',
  received: 'bg-blue',
  in_progress: 'bg-amber',
  validated: 'bg-green',
  closed: 'bg-gray',
  cancelled: 'bg-red',
}

const STATUS_LABEL: Record<string, string> = {
  draft: 'Brouillon',
  received: 'Reçu',
  in_progress: 'En cours',
  validated: 'Validé',
  closed: 'Clos',
  cancelled: 'Annulé',
}

const VALIDATION_COLOR: Record<string, string> = {
  ok: 'validation-ok',
  warning: 'validation-warn',
  error: 'validation-err',
  // V1.9-B — DN-1 Option A : nouveau statut orange (arbitrage opérateur requis)
  awaiting_arbitration: 'validation-warning',
}

// Map d'état « preview KO » par fileId (onerror → true → fallback icône)
const imgErrored = ref<Record<number, boolean>>({})
// Compteur retry pour cache-bust (force le browser à re-fetcher le webUrl)
const retryKey = ref<Record<number, number>>({})

function markImgError(id: number): void {
  imgErrored.value[id] = true
}

function retryImg(id: number): void {
  retryKey.value[id] = (retryKey.value[id] ?? 0) + 1
  delete imgErrored.value[id]
}

// V1.5 PATTERN-V5 — imgSrc() redirige vers le proxy backend `/api/sav/files/:id/thumbnail`
// au lieu du webUrl SharePoint direct (fix Chrome ORB cross-origin block).
// Cache-bust `?_r=N` préservé sur l'URL proxy pour le bouton Réessayer.
// Le webUrl SharePoint direct reste utilisé UNIQUEMENT pour le bouton "Ouvrir" (<a href>).
function imgSrc(file: { id: number; webUrl: string }): string {
  const key = retryKey.value[file.id] ?? 0
  const proxyUrl = `/api/sav/files/${file.id}/thumbnail`
  if (key === 0) return proxyUrl
  return `${proxyUrl}?_r=${key}`
}

function formatLineQuantity(quantity: number | null, unit: string | null): string {
  if (quantity == null) return '—'
  const plural = quantity >= 2 ? 's' : ''
  const labels: Record<string, string> = { piece: `pièce${plural}`, liter: `litre${plural}` }
  const label = unit ? (labels[unit] ?? unit) : '· unité à préciser'
  return `${quantity.toLocaleString('fr-FR')} ${label}`
}

function formatEur(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—'
  return (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })
}

/**
 * V1.11 AC#5 — Helper TTC d'affichage pour la cellule « Avoir TTC ».
 *
 * MIRROR (documenté) du helper backend `creditTtcCents` de
 * `client/api/_lib/pdf/CreditNotePdf.ts` — même formule (round half-up
 * de HT × (1 + bp/10000)), même contrat null-safe.
 *
 * Dette V2 (CR 8.7 / dette `projectSavLineToClientDemand`) : factoriser
 * dans un module partagé `client/src/shared/credit/creditTtc.ts` (ou
 * équivalent) le jour où ce helper est réutilisé ailleurs (ex : exports
 * UI Epic 5 ou autre vue). Tant que c'est le seul call-site front, on
 * garde un mirror local pour éviter un import cross-package
 * client/api ↔ client/src qui complique le bundling.
 *
 * Anti-W16 : pure, AUCUNE somme sur ces TTC pour reconstituer un total.
 * Les totaux moteur (cf. `useSavLinePreview`) restent issus du helper
 * `computeCreditNoteTotals` (engine TS).
 */
function creditTtcCentsLine(l: {
  creditAmountCents: number | null
  vatRateBpSnapshot: number | null
}): number | null {
  if (l.creditAmountCents === null || l.vatRateBpSnapshot === null) return null
  // CR M1 — formule entière exacte (cf. `creditTtcCents` côté PDF) :
  // `ht * (10000 + bp) / 10000` évite la perte de précision flottante
  // qui décalait certains boundaries half-up d'1 ct (ex. ht=1900, bp=550).
  return Math.round((l.creditAmountCents * (10000 + l.vatRateBpSnapshot)) / 10000)
}

// Story 4.8 — Calcul marge totale HT estimée (AC #5)
// Agrège unitMarginHtCents * qty sur les lignes ayant les 2 prix renseignés
const totalMarginHtCents = computed<number | null>(() => {
  const lines = sav.value?.lines ?? []
  let total = 0
  let hasAny = false
  for (const l of lines) {
    const margin = unitMarginHtCents(l)
    if (margin !== null) {
      const qty = l.qtyInvoiced ?? l.qtyRequested
      total += margin * qty
      hasAny = true
    }
  }
  return hasAny ? total : null
})

function formatBytes(b: number | null | undefined): string {
  if (!b) return '—'
  if (b < 1024) return `${b} o`
  if (b < 1048576) return `${(b / 1024).toFixed(1)} Ko`
  return `${(b / 1048576).toFixed(1)} Mo`
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    // F43 (CR Epic 3) : force Europe/Paris pour éviter que 23:30 UTC
    // n'affiche le lendemain côté utilisateur (server stocke UTC).
    return new Date(iso).toLocaleString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Paris',
    })
  } catch {
    return iso
  }
}

function timeRelative(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime()
  // F44 (CR Epic 3) : timestamp futur (clock drift) → « à l'instant » plutôt
  // que « il y a 0 min » ou delta négatif absurde.
  if (delta < 0) return "à l'instant"
  const minutes = Math.floor(delta / 60000)
  if (minutes < 1) return "à l'instant"
  if (minutes < 60) return `il y a ${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `il y a ${hours} h`
  const days = Math.floor(hours / 24)
  return `il y a ${days} j`
}

function memberName(m: { firstName: string | null; lastName: string } | null): string {
  if (!m) return '—'
  return m.firstName ? `${m.firstName} ${m.lastName}` : m.lastName
}

function auditActorName(a: {
  actorOperator: { displayName: string } | null
  actorMember: { firstName: string | null; lastName: string } | null
  actorSystem: string | null
}): string {
  if (a.actorOperator) return `Op. ${a.actorOperator.displayName}`
  if (a.actorMember) return memberName(a.actorMember)
  if (a.actorSystem) return `système (${a.actorSystem})`
  return 'inconnu'
}

function isImagePreviewable(file: { mimeType: string; webUrl: string }): boolean {
  return (
    typeof file.mimeType === 'string' &&
    file.mimeType.startsWith('image/') &&
    isOneDriveWebUrlTrusted(file.webUrl)
  )
}

function initials(
  m: { firstName: string | null; lastName: string } | null,
  op: { displayName: string } | null
): string {
  if (op) return op.displayName.slice(0, 2).toUpperCase()
  if (m) {
    const fn = m.firstName ?? ''
    return ((fn[0] ?? '') + (m.lastName[0] ?? '')).toUpperCase()
  }
  return '?'
}

function backToList(): void {
  void router.push({ name: 'admin-sav-list' })
}

// --- Story 3.7b — PATTERN-A: useCurrentUser --------------------------------


// --- Story 3.7b — M'assigner -----------------------------------------------
const assignMeError = ref<string | null>(null)

async function assignMe(): Promise<void> {
  if (!sav.value || !currentUser.value) return
  assignMeError.value = null
  try {
    const res = await fetch(`/api/sav/${sav.value.id}/assign`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        assigneeOperatorId: currentUser.value.sub,
        version: localVersion.value,
      }),
    })
    if (!res.ok) {
      const body = (await res.json()) as {
        error: { code: string; details?: { code?: string } }
      }
      const code = body.error?.details?.code ?? body.error?.code
      if (code === 'VERSION_CONFLICT') {
        assignMeError.value = 'Conflit de version — le SAV a été rechargé.'
        await refresh()
      } else {
        assignMeError.value = `Erreur lors de l'assignation (${res.status}).`
      }
      return
    }
    await refresh()
  } catch {
    assignMeError.value = 'Erreur réseau — réessayez.'
  }
}

// --- Story 3.7b — ComposeCommentForm inline --------------------------------
const postedComments = ref<SavDetailComment[]>([])
const composeBody = ref('')
const composeVisibility = ref<'internal' | 'all'>('internal')
const composeSubmitting = ref(false)
const composeError = ref<string | null>(null)
const publicationUncertain = ref(false)
function markPublicationUncertain(): void {
  publicationUncertain.value = true
  composeError.value = 'Publication non confirmée. Votre brouillon est conservé. Vérifiez les échanges avant de réessayer.'
}
let dossierGeneration = 0

watch(savId, () => {
  dossierGeneration++
  postedComments.value = []
  composeBody.value = ''
  composeVisibility.value = 'internal'
  composeSubmitting.value = false
  composeError.value = null
  publicationUncertain.value = false
}, { flush: 'sync' })

// Keep a confirmed POST visible until a detail response includes the same id.
watch(comments, (rows) => {
  const ids = new Set(rows.map(c => c.id))
  postedComments.value = postedComments.value.filter(c => !ids.has(c.id))
}, { flush: 'sync' })
const allComments = computed(() => {
  if (!postedComments.value.length) return comments.value
  const byId = new Map(postedComments.value.map(c => [c.id, c]))
  for (const c of comments.value) byId.set(c.id, c)
  return [...byId.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
})

async function submitComment(): Promise<void> {
  const body = composeBody.value.trim()
  if (!sav.value || sav.value.id !== savId.value || !body || composeSubmitting.value) return
  const generation = dossierGeneration
  const visibility = composeVisibility.value
  composeError.value = null
  publicationUncertain.value = false
  composeSubmitting.value = true
  try {
    const res = await fetch(`/api/sav/${savId.value}/comments`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body, visibility }),
    })
    if (generation !== dossierGeneration) return
    if (res.status >= 500 || res.status === 408) {
      markPublicationUncertain()
      return
    }
    if (!res.ok) {
      composeError.value = res.status === 403
        ? 'Publication refusée. Votre brouillon est conservé.'
        : `Échec de la publication (${res.status}). Votre brouillon est conservé.`
      return
    }
    const { data } = (await res.json()) as {
      data: Pick<SavDetailComment, 'createdAt' | 'body' | 'visibility'> & {
        commentId: number
        authorOperator: { id: number }
      }
    }
    if (generation !== dossierGeneration) return
    postedComments.value.push({
      id: data.commentId,
      createdAt: data.createdAt,
      body: data.body,
      visibility: data.visibility,
      authorMember: null,
      authorOperator: { id: data.authorOperator.id, displayName: 'Vous' },
    })
    composeBody.value = ''
    void refreshExchanges()
  } catch {
    if (generation === dossierGeneration) {
      markPublicationUncertain()
    }
  } finally {
    if (generation === dossierGeneration) composeSubmitting.value = false
  }
}

// Tags update handler (from SavTagsBar)
function onTagsUpdated(newTags: string[], newVersion: number): void {
  if (sav.value) {
    // Update local version to avoid stale-version issues
    localVersion.value = newVersion
  }
}
</script>

<template>
  <main
    class="sav-detail-view"
    aria-labelledby="sav-detail-title"
    tabindex="-1"
    @keydown="closeImportSupplierOnEsc"
  >
    <nav class="breadcrumb" aria-label="Fil d'Ariane">
      <a href="#" @click.prevent="backToList">Liste SAV</a>
      <span aria-hidden="true"> &gt; </span>
      <span>{{ sav?.reference ?? '...' }}</span>
    </nav>

    <template v-if="loading && !sav">
      <div class="skeleton" aria-busy="true" aria-label="Chargement">
        <div class="skeleton-block" />
        <div class="skeleton-block" />
      </div>
    </template>

    <template v-else-if="isNotFound">
      <div class="not-found" role="status">
        <h1>SAV introuvable</h1>
        <p>Ce SAV n'existe pas ou a été supprimé.</p>
        <button type="button" @click="backToList">Retour à la liste</button>
      </div>
    </template>

    <template v-else-if="hasOtherError">
      <div class="error" role="alert">
        <p>Erreur : {{ error }}</p>
        <button type="button" @click="refresh">Réessayer</button>
      </div>
    </template>

    <template v-else-if="sav">
      <!-- Header -->
      <section class="header card" :aria-labelledby="'sav-detail-title'">
        <!-- H-07 F-10 — bannière dégradation avoir -->
        <div
          v-if="creditNoteDegraded"
          class="credit-note-degraded-banner"
          role="alert"
          data-testid="credit-note-degraded-banner"
        >
          Données d'avoir indisponibles — rafraîchissez la page pour réessayer.
        </div>

        <!-- Story 8.5 — AC #3 : badge réclamation fournisseur (DN-2=A LOCKED) -->
        <!-- Affiché si supplierClaim.exists — lien vers la page dédiée -->
        <div
          v-if="supplierClaim?.exists"
          class="supplier-claim-badge"
          data-testid="supplier-claim-badge"
          role="status"
        >
          <span class="supplier-claim-badge-icon">📋</span>
          Réclamation fournisseur émise le {{ formatDateTime(supplierClaim.latestGeneratedAt) }}
          — {{ supplierClaim.count }} version{{ supplierClaim.count > 1 ? 's' : '' }}
          — {{ formatEur(supplierClaim.latestTotalImporteCents) }}
          <router-link
            :to="{ path: `/admin/sav/${sav.id}/demande-fournisseur`, state: { supplierSavId: sav.id, supplierSavReference: sav.reference, expectedOrder: sav.invoiceSpecialMention } }"
            class="supplier-claim-badge-link"
            data-testid="supplier-claim-badge-link"
          >
            Voir la réclamation →
          </router-link>
        </div>

        <div class="header-title-row">
          <h1 id="sav-detail-title">{{ sav.reference }}</h1>
          <span :class="['status-badge', STATUS_COLOR[sav.status] ?? 'bg-gray']">
            {{ STATUS_LABEL[sav.status] ?? sav.status }}
          </span>
        </div>
        <h2 ref="workflowHeading" tabindex="-1" class="action-title">Suite du dossier</h2>
        <p v-if="sav.status === 'closed' || sav.status === 'cancelled'">Ce statut est définitif.</p>
        <template v-else>
          <div v-if="identityRetryable" role="status">
            Les droits de l’opérateur sont momentanément indisponibles.
            <button type="button" class="workflow-btn" data-testid="retry-identity" @click="retryIdentity">
              Vérifier à nouveau mes droits
            </button>
          </div>
          <p v-if="accountingInstruction" id="validation-help" role="status">{{ accountingInstruction }}</p>
          <div v-if="isOperator" class="workflow-actions" role="group" aria-label="Actions workflow SAV">
            <button
              v-if="showReceiveButton"
              type="button"
              class="workflow-btn workflow-btn--primary"
              :disabled="isTransitioning('received')"
              data-testid="sav-receive-btn"
              @click="receiveSav"
            >
              {{ isTransitioning('received') ? 'Réception…' : 'Marquer reçu' }}
            </button>
            <button
              v-if="showStartButton"
              type="button"
              class="workflow-btn workflow-btn--primary"
              :disabled="isTransitioning('in_progress')"
              data-testid="sav-start-btn"
              @click="startSav"
            >
              {{ isTransitioning('in_progress') ? 'Démarrage…' : 'Démarrer le traitement' }}
            </button>
            <button
              v-if="creditNoteDegraded"
              data-testid="accounting-reload"
              type="button"
              class="workflow-btn workflow-btn--primary"
              :disabled="loading"
              @click="reloadAccounting"
            >
              Recharger la fiche
            </button>
            <a
              v-else-if="creditNote && !hasCreditNotePdf"
              class="workflow-btn workflow-btn--primary"
              href="#credit-note-title"
            >
              {{ creditNotePdfPhase === 'pending' ? 'Suivre la génération du PDF' : 'Voir la reprise du PDF' }}
            </a>
            <button
              v-if="showValidateButton"
              type="button"
              class="workflow-btn workflow-btn--primary validate-btn"
              :disabled="validateDisabled"
              :title="validateTitle"
              :aria-describedby="validateDisabled ? 'validation-help' : undefined"
              data-testid="sav-validate-btn"
              @click="validateSav"
            >
              {{ validating ? 'Validation…' : 'Valider le SAV' }}
            </button>
            <button
              v-if="showEmitCreditButton"
              ref="emitTrigger"
              type="button"
              class="workflow-btn workflow-btn--primary"
              :disabled="emitting || !canValidate"
              :title="
                !canValidate
                  ? 'Toutes les lignes doivent être validées'
                  : 'Émettre l’avoir comptable'
              "
              data-testid="sav-emit-credit-btn"
              @click="openEmitDialog"
            >
              Émettre l’avoir
            </button>
            <button
              v-if="showCloseButton"
              type="button"
              class="workflow-btn workflow-btn--primary"
              :disabled="isTransitioning('closed')"
              data-testid="sav-close-btn"
              @click="closeSav"
            >
              {{ isTransitioning('closed') ? 'Clôture…' : 'Clôturer' }}
            </button>
            <button
              v-if="showCancelButton"
              type="button"
              class="workflow-btn workflow-btn--ghost"
              :disabled="isTransitioning('cancelled')"
              data-testid="sav-cancel-btn"
              @click="cancelSav"
            >
              {{ isTransitioning('cancelled') ? 'Annulation…' : 'Annuler le SAV' }}
            </button>
          </div>
        </template>
        <dl class="metadata">
          <div>
            <dt>Adhérent</dt>
            <dd>{{ memberName(sav.member) }}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>
              <a v-if="sav.member" :href="`mailto:${sav.member.email}`">{{ sav.member.email }}</a>
              <span v-else>—</span>
            </dd>
          </div>
          <div>
            <dt>Groupe</dt>
            <dd>{{ sav.group?.name ?? '—' }}</dd>
          </div>
          <div>
            <dt>Facture</dt>
            <dd>{{ sav.invoiceRef || '—' }}</dd>
          </div>
          <div>
            <dt>Commande groupe</dt>
            <dd>{{ sav.invoiceSpecialMention || '—' }}</dd>
          </div>
          <div>
            <dt>Reçu le</dt>
            <dd>{{ formatDateTime(sav.receivedAt) }}</dd>
          </div>
          <div>
            <dt>Assigné à</dt>
            <dd>
              {{ sav.assignee?.displayName ?? 'Non assigné' }}
              <!-- Story 3.7b — M'assigner wired to useCurrentUser (PATTERN-A) -->
              <button
                v-if="!sav.assignee"
                type="button"
                class="assign-me"
                aria-label="M'assigner ce SAV"
                :disabled="currentUserLoading || !currentUser"
                @click="assignMe"
              >
                M'assigner
              </button>
            </dd>
          </div>
          <div>
            <dt>Lignes validées HT</dt>
            <dd>{{ sav.totalAmountCents == null ? 'Indisponible' : formatEur(sav.totalAmountCents) }}</dd>
          </div>
          <div>
            <dt>Avoir</dt>
            <dd v-if="creditNoteDegraded">Information indisponible</dd>
            <dd v-else-if="creditNote"><a href="#credit-note-title">{{ creditNote.numberFormatted }} · {{ formatEur(creditNote.totalTtcCents) }} TTC</a></dd>
            <dd v-else>Aucun avoir émis</dd>
          </div>
        </dl>
        <!-- Story 3.7b — SavTagsBar avec gestion optimistic -->
        <div class="tags-row">
          <SavTagsBar
            :sav-id="sav.id"
            :tags="sav.tags"
            :version="sav.version"
            @updated="onTagsUpdated"
          />
        </div>

        <!-- Story 3.7b — DuplicateButton -->
        <div class="header-actions-row">
          <DuplicateButton :sav-id="sav.id" />
          <!-- Story 4.8 — Import prix fournisseur (visible uniquement si in_progress) -->
          <button
            v-if="sav.status === 'in_progress'"
            type="button"
            class="btn-sm"
            data-testid="import-supplier-prices-btn"
            @click="openImportSupplier"
          >
            Importer prix fournisseur
          </button>
          <!-- Story 8.1 — Demande remboursement fournisseur (AC #1, FR3) :
               visible quel que soit le statut du SAV (FR3) ; RBAC enforced server-side (AC #3).
               CTA proéminent si sav.status === 'validated' (DN-3, FR2). -->
          <button
            type="button"
            :class="['btn-sm', sav.status === 'validated' ? 'cta-primary' : '']"
            data-testid="supplier-claim-btn"
            @click="router.push({ name: 'admin-sav-demande-fournisseur', params: { id: sav.id }, state: { supplierSavId: sav.id, supplierSavReference: sav.reference, prepareSupplier: sav.status === 'validated', expectedOrder: sav.invoiceSpecialMention } })"
          >
            {{
              sav.status === 'validated'
                ? 'Préparer la demande fournisseur'
                : 'Demande de remboursement fournisseur'
            }}
          </button>
        </div>

        <!-- Assign-me error toast -->
        <div v-if="assignMeError" class="assign-error" role="alert">
          {{ assignMeError }}
          <button type="button" class="toast-close" @click="assignMeError = null">×</button>
        </div>
      </section>

      <!-- Lignes -->
      <section class="card" aria-labelledby="lines-title">
        <h2 id="lines-title">Lignes du SAV</h2>
        <div class="lines-scroll" role="region" aria-label="Lignes du dossier" tabindex="0">
        <table class="lines-table" role="table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Code</th>
              <th scope="col">Produit</th>
              <th scope="col">Quantité</th>
              <th scope="col">Avoir TTC</th>
              <th scope="col">PU TTC</th>
              <!-- Story 4.8 — colonnes prix fournisseur + marge -->
              <th scope="col">PU achat HT</th>
              <th scope="col">Marge unit. HT</th>
              <th scope="col">Coef.</th>
              <th scope="col">Validation</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <!-- V1.9-B — Split UX 3 rows : 1 <tbody class="sav-line-group"> par ligne SAV.
               Row 1 = demande adhérent (qtyRequested + motif requestReason).
               Row 2 = facturé read-only (qtyInvoiced — voix Pennylane, jamais éditable).
               Row 3 = arbitrage opérateur (qtyArbitrated, PU, marge, coef, avoir, validation, actions).
               Edit-extra-row (pieceToKgWeightG) reste dans le même <tbody> (Story 3.6 pattern preserved).
               Ancre DOM id="sav-line-{id}" sur <tbody> (D-5 scroll-to-blocking preserved V1.9-A). -->
          <tbody
            v-for="l in sav.lines"
            :key="l.id"
            class="sav-line-group"
            :id="`sav-line-${l.id}`"
            :data-blocking="l.validationStatus !== 'ok' ? 'true' : 'false'"
            :aria-busy="lineEdit.savingLineId.value === l.id ? 'true' : 'false'"
            :class="{ 'line-saving': lineEdit.savingLineId.value === l.id }"
          >
            <!-- Row 1 — Demande adhérent (voix du client, fond gris italique) -->
            <tr class="sav-line-request" :data-testid="`sav-line-${l.id}-request-row`">
              <td data-label="Ligne">{{ l.lineNumber ?? l.position }}</td>
              <td data-label="Code">{{ l.productCodeSnapshot }}</td>
              <td>{{ l.productNameSnapshot }}</td>
              <!-- Qté demandée + unité demandée (V1.x-B — l'unité est éditable en
                   cas d'erreur de capture, reste la voix du client). -->
              <td>
                <span
                  v-if="lineEdit.editingLineId.value === l.id && editDraft[l.id]"
                  class="cell-pair"
                >
                  <label :for="`edit-qty-requested-${l.id}`" class="quantity-label">Demandé</label>
                  <input
                    :id="`edit-qty-requested-${l.id}`"
                    data-quantity="requested"
                    :aria-invalid="lineError?.field === `edit-qty-requested-${l.id}` || undefined"
                    :aria-describedby="lineError?.field === `edit-qty-requested-${l.id}` ? `line-error-${l.id}` : undefined"
                    required
                    v-model="editDraft[l.id]!.qtyRequested"
                    type="number"
                    min="0.001"
                    max="99999"
                    step="0.001"
                    :aria-label="`Demandé, quantité, ligne ${l.lineNumber ?? l.position}`"
                    class="cell-input"
                    :data-testid="`edit-qty-requested-${l.id}`"
                    @keydown.enter.prevent="saveEditLine(l, $event)"
                    @keydown.esc.prevent="cancelEditLine"
                  />
                  <select
                    v-model="editDraft[l.id]!.unitRequested"
                    class="cell-select"
                    :aria-label="`Unité demandée, ligne ${l.lineNumber ?? l.position}`"
                    :data-testid="`edit-unit-requested-${l.id}`"
                  >
                    <option value="kg">kg</option>
                    <option value="piece">pièce</option>
                    <option value="liter">litre</option>
                  </select>
                </span>
                <span v-else><span class="quantity-label">Demandé</span> {{ formatLineQuantity(l.qtyRequested, l.unitRequested) }}</span>
              </td>
              <!-- V1.9-B — colspan=7 : colonnes 5-11 — motif demande adhérent (requestReason) + commentaire.
                   reason-pill (badge ambre) si requestReason set, sinon fallback stub italic gris.
                   requestComment affiché si set. (AC#3.2, AC#3.3) -->
              <td colspan="7" class="line-request-context">
                <template v-if="l.requestReason || l.requestComment">
                  <span v-if="l.requestReason" class="reason-pill">{{ l.requestReason }}</span>
                  <span v-if="l.requestComment" class="comment-text">{{ l.requestComment }}</span>
                </template>
                <span v-else class="line-request-context-empty">Demande adhérent</span>
              </td>
            </tr>
            <!-- Row 2 — Facturé read-only (voix Pennylane, fond subtle gris italique) V1.9-B NEW
                 V1.9-B.2 : PU TTC facture exposé colonne 6 (séparé de Row 3 arbitrage) -->
            <tr class="sav-line-invoiced" :data-testid="`sav-line-${l.id}-invoiced-row`">
              <td></td>
              <td></td>
              <td></td>
              <td>
                <span class="quantity-label">Facturé</span>
                {{ formatLineQuantity(l.qtyInvoiced, l.unitInvoiced) }}
              </td>
              <td></td>
              <!-- PU TTC facture (colonne 6) — V1.9-B.2 read-only Pennylane -->
              <td data-label="PU TTC facturé">
                <span>{{ formatEur(l.unitPriceTtcCents) }}</span>
              </td>
              <!-- Colonnes restantes -->
              <td></td>
              <td></td>
              <td></td>
              <td></td>
              <td></td>
            </tr>
            <!-- Row 3 — Arbitrage opérateur (fond blanc, font-weight 500) — RENOMMÉ from sav-line-validation -->
            <tr class="sav-line-arbitration" :data-testid="`sav-line-${l.id}-arbitration-row`">
              <td></td>
              <td></td>
              <td></td>
              <td>
                <span
                  v-if="lineEdit.editingLineId.value === l.id && editDraft[l.id]"
                  class="cell-pair"
                >
                  <label :for="`edit-qty-arbitrated-${l.id}`" class="quantity-label">Retenu</label>
                  <input
                    :id="`edit-qty-arbitrated-${l.id}`"
                    data-quantity="arbitrated"
                    :aria-invalid="lineError?.field === `edit-qty-arbitrated-${l.id}` || undefined"
                    :aria-describedby="lineError?.field === `edit-qty-arbitrated-${l.id}` ? `line-error-${l.id}` : undefined"
                    v-model="editDraft[l.id]!.qtyArbitrated"
                    type="number"
                    min="0"
                    max="99999"
                    step="0.001"
                    placeholder="—"
                    :aria-label="`Retenu, quantité, ligne ${l.lineNumber ?? l.position}`"
                    class="cell-input"
                    :data-testid="`edit-qty-arbitrated-${l.id}`"
                    @keydown.enter.prevent="saveEditLine(l, $event)"
                    @keydown.esc.prevent="cancelEditLine"
                  />
                  <select
                    :id="`edit-unit-arbitrated-${l.id}`"
                    :aria-invalid="lineError?.field === `edit-unit-arbitrated-${l.id}` || undefined"
                    :aria-describedby="lineError?.field === `edit-unit-arbitrated-${l.id}` ? `line-error-${l.id}` : undefined"
                    v-model="editDraft[l.id]!.unitArbitrated"
                    class="cell-select"
                    :aria-label="`Unité retenue, ligne ${l.lineNumber ?? l.position}`"
                    :data-testid="`edit-unit-arbitrated-${l.id}`"
                  >
                    <option v-if="!l.unitInvoiced" value="">—</option>
                    <option value="kg">kg</option>
                    <option value="piece">pièce</option>
                    <option value="liter">litre</option>
                  </select>
                </span>
                <span v-else>
                  <span class="quantity-label">Retenu</span>
                  {{ formatLineQuantity(l.qtyArbitrated, l.unitArbitrated ?? l.unitInvoiced) }}
                </span>
              </td>
              <td class="line-credit">
                <span class="quantity-label">Avoir TTC<span v-if="lineEdit.editingLineId.value === l.id"> enregistré</span></span>
                {{ formatEur(creditTtcCentsLine(l)) }}
              </td>
              <!-- PU TTC arbitré (colonne 6) — V1.9-B.2 override opérateur
                   Affichage non-édition : override si set, sinon vide (la facture est Row 2) -->
              <td data-label="PU TTC arbitré">
                <input
                  v-if="lineEdit.editingLineId.value === l.id && editDraft[l.id]"
                  v-model="editDraft[l.id]!.unitPriceEuros"
                  @input="editDraft[l.id]!.priceEdited = true"
                  type="number"
                  min="0"
                  max="999999.99"
                  step="0.01"
                  placeholder="€"
                  :aria-label="`Prix unitaire TTC arbitré, ligne ${l.lineNumber ?? l.position}`"
                  class="cell-input"
                  :data-testid="`edit-unit-price-arbitrated-${l.id}`"
                  @keydown.enter.prevent="saveEditLine(l, $event)"
                  @keydown.esc.prevent="cancelEditLine"
                />
                <span v-else>
                  <span
                    v-if="l.unitPriceTtcArbitratedCents !== null"
                    style="font-weight: 500"
                    :title="`Override opérateur (facture : ${formatEur(l.unitPriceTtcCents)})`"
                  >
                    {{ formatEur(l.unitPriceTtcArbitratedCents) }}
                  </span>
                  <span v-else style="font-style: italic; color: #6b7280">—</span>
                </span>
              </td>
              <!-- Story 4.8 — PU achat HT (colonne 7, avec tooltip supplier_reference) -->
              <td data-label="PU achat HT">
                <span
                  :title="
                    l.supplierReference ? `Réf. fournisseur : ${l.supplierReference}` : undefined
                  "
                >
                  {{ formatEur(l.supplierPurchasePriceHtCents) }}
                </span>
              </td>
              <!-- Story 4.8 — Marge unit. HT (colonne 8, positif=vert, négatif=rouge, null=gris) -->
              <td data-label="Marge unit. HT">
                <span
                  v-if="unitMarginHtCents(l) !== null"
                  :class="{
                    'margin-positive': (unitMarginHtCents(l) ?? 0) > 0,
                    'margin-negative': (unitMarginHtCents(l) ?? 0) < 0,
                  }"
                >
                  {{ formatEur(unitMarginHtCents(l)) }}
                </span>
                <span v-else class="margin-null">—</span>
              </td>
              <!-- Coefficient (colonne 9) -->
              <td data-label="Coefficient">
                <input
                  v-if="lineEdit.editingLineId.value === l.id && editDraft[l.id]"
                  v-model="editDraft[l.id]!.creditCoefficient"
                  type="number"
                  min="0"
                  max="1"
                  step="0.01"
                  :aria-label="`Coefficient avoir, ligne ${l.lineNumber ?? l.position}`"
                  class="cell-input"
                  @keydown.enter.prevent="saveEditLine(l, $event)"
                  @keydown.esc.prevent="cancelEditLine"
                />
                <span v-else>
                  {{
                    l.creditCoefficientLabel ??
                    (Number.isFinite(l.creditCoefficient) ? l.creditCoefficient : '—')
                  }}
                </span>
              </td>
              <!-- Validation -->
              <td>
                <span
                  :class="[
                    'validation-badge',
                    VALIDATION_COLOR[l.validationStatus] ?? 'validation-ok',
                  ]"
                  :title="l.validationMessage ?? ''"
                >
                  {{ l.validationStatus }}
                </span>
              </td>
              <!-- Actions -->
              <td class="actions-cell">
                <span v-if="lineEdit.editingLineId.value === l.id" class="actions-pair">
                  <button
                    type="button"
                    class="btn-sm line-save"
                    :disabled="lineEdit.savingLineId.value !== null || sav.status !== 'in_progress'"
                    :data-testid="`save-line-${l.id}`"
                    @click="saveEditLine(l, $event)"
                  >
                    Enregistrer
                  </button>
                  <button
                    type="button"
                    class="btn-sm"
                    :disabled="lineEdit.savingLineId.value !== null"
                    @click="cancelEditLine"
                  >
                    Annuler
                  </button>
                </span>
                <span v-else class="actions-pair">
                  <button
                    type="button"
                    class="btn-sm"
                    :disabled="sav.status !== 'in_progress'"
                    :id="`edit-line-${l.id}`"
                    :data-testid="`edit-line-${l.id}`"
                    @click="beginEditLine(l)"
                  >
                    Éditer
                  </button>
                  <button
                    type="button"
                    class="btn-sm btn-danger"
                    :disabled="sav.status !== 'in_progress'"
                    :data-testid="`delete-line-${l.id}`"
                    @click="deleteLineConfirmed(l)"
                  >
                    Supprimer
                  </button>
                </span>
              </td>
            </tr>
            <tr v-if="lineError?.id === l.id">
              <td colspan="11">
                <p :id="`line-error-${l.id}`" class="line-edit-error" role="alert">{{ lineError.message }}</p>
              </td>
            </tr>
            <!-- Row 4 (optionnel) — poids unité (g) visible si to_calculate + édition.
                 Reste dans le même <tbody class="sav-line-group"> (Story 3.6 pattern preserved). -->
            <tr
              v-if="
                lineEdit.editingLineId.value === l.id &&
                editDraft[l.id] &&
                l.validationStatus === 'to_calculate'
              "
              class="edit-extra-row"
            >
              <td colspan="11">
                <label class="extra-label">
                  Poids unité (g)
                  <input
                    v-model="editDraft[l.id]!.pieceToKgWeightG"
                    type="number"
                    min="1"
                    max="100000"
                    step="1"
                    :aria-label="`Poids unité en grammes, ligne ${l.lineNumber ?? l.position}`"
                    class="cell-input"
                    data-testid="edit-piece-to-kg-weight-g"
                    @keydown.enter.prevent="saveEditLine(l, $event)"
                    @keydown.esc.prevent="cancelEditLine"
                  />
                </label>
              </td>
            </tr>
          </tbody>
          <!-- Empty state — wrap dans <tbody> séparé pour cohérence HTML5 multi-tbody -->
          <tbody v-if="sav.lines.length === 0" class="sav-line-empty">
            <tr>
              <td colspan="11" class="empty">Aucune ligne sur ce SAV.</td>
            </tr>
          </tbody>
        </table>
        </div>

        <!-- Story 4.8 — Footer marge totale HT estimée (AC #5) -->
        <div
          v-if="totalMarginHtCents !== null"
          class="margin-total-footer"
          data-testid="margin-total-footer"
        >
          <strong>Marge totale HT estimée :</strong>
          <span
            :class="{
              'margin-positive': totalMarginHtCents > 0,
              'margin-negative': totalMarginHtCents < 0,
            }"
          >
            {{ formatEur(totalMarginHtCents) }}
          </span>
        </div>

        <div v-if="sav.status === 'in_progress'" class="lines-actions">
          <button
            type="button"
            class="btn-primary"
            data-testid="sav-add-line-btn"
            @click="openAddLine"
          >
            + Ajouter une ligne
          </button>
        </div>
      </section>

      <AddLineDialog
        :open="addLineOpen"
        :saving="lineEdit.savingLineId.value === -1"
        @create="handleAddLineCreate"
        @cancel="addLineOpen = false"
      />

      <!-- Story 4.8 — Modal import prix fournisseur -->
      <ImportSupplierPricesDialog
        :open="importSupplierOpen"
        :sav-id="sav.id"
        @close="importSupplierOpen = false"
        @applied="onImportApplied"
      />

      <div v-if="toastMessage" class="toast toast-error" role="alert" data-testid="sav-toast">
        {{ toastMessage }}
        <button type="button" class="toast-close" @click="toastMessage = null">×</button>
      </div>

      <!-- Workflow — Avoir émis (Story 4.4) -->
      <section
        v-if="creditNote"
        class="card credit-note-issued"
        aria-labelledby="credit-note-title"
        data-testid="sav-credit-note-issued"
      >
        <h2 id="credit-note-title" tabindex="-1">Avoir émis</h2>
        <dl class="credit-note-dl">
          <div>
            <dt>Numéro</dt>
            <dd data-testid="credit-note-number">{{ creditNote.numberFormatted }}</dd>
          </div>
          <div>
            <dt>Type de bon</dt>
            <dd>{{ creditNote.bonType }}</dd>
          </div>
          <div>
            <dt>Émis le</dt>
            <dd>{{ formatDateTime(creditNote.issuedAt) }}</dd>
          </div>
          <div>
            <dt>Sous-total HT</dt>
            <dd>{{ formatEur(creditNote.totalHtCents) }}</dd>
          </div>
          <div>
            <dt>Remise HT</dt>
            <dd>{{ formatEur(creditNote.discountCents) }}</dd>
          </div>
          <div>
            <dt>TVA</dt>
            <dd>{{ formatEur(creditNote.vatCents) }}</dd>
          </div>
          <div>
            <dt>Total TTC</dt>
            <dd>{{ formatEur(creditNote.totalTtcCents) }}</dd>
          </div>
        </dl>
        <!-- CR F-3 : lien désactivé tant que le PDF n'est pas généré (Story 4.5
             écrit pdfWebUrl quand le rendu OneDrive est terminé). Sinon le clic
             ouvre une page d'erreur.
             spec credit-note-pdf-regenerate-feedback : 3 phases (ready / pending
             / failed). En `failed` (génération async échouée ou timeout du poll)
             on offre le bouton « Régénérer le PDF » plutôt qu'un « en cours »
             figé à l'infini. -->
        <template v-if="creditNotePdfPhase === 'ready'">
          <a
            class="credit-note-pdf-link"
            :href="`/api/credit-notes/${creditNote.numberFormatted}/pdf`"
            target="_blank"
            rel="noopener noreferrer"
            data-testid="credit-note-pdf-link"
          >
            Télécharger le PDF
          </a>
          <!-- spec credit-note-force-regenerate-pdf : bouton secondaire phase
               ready pour forcer la régénération (recalcul totaux + écrasement
               PDF). Confirmation obligatoire (`confirmFn`). -->
          <button
            type="button"
            v-if="isOperator && !creditNoteDegraded"
            class="credit-note-force-regenerate-btn"
            :disabled="regenerating"
            data-testid="credit-note-force-regenerate-btn"
            @click="forceRegeneratePdf"
          >
            {{ regenerating ? 'Régénération…' : 'Régénérer le PDF' }}
          </button>
          <p
            v-if="regenerateError"
            class="credit-note-force-regenerate-error"
            data-testid="credit-note-force-regenerate-error"
          >
            {{ regenerateError }}
          </p>
        </template>
        <span
          v-else-if="creditNotePdfPhase === 'pending'"
          class="credit-note-pdf-link credit-note-pdf-link--disabled"
          aria-disabled="true"
          data-testid="credit-note-pdf-pending"
        >
          Génération du PDF en cours…
        </span>
        <div v-else class="credit-note-pdf-failed" data-testid="credit-note-pdf-failed">
          <p class="credit-note-pdf-failed-msg" data-testid="credit-note-pdf-failed-msg">
            {{ regenerateError ?? PDF_FAILED_DEFAULT_MSG }}
          </p>
          <button
            type="button"
            v-if="isOperator && !creditNoteDegraded"
            class="credit-note-regenerate-btn"
            :disabled="regenerating"
            data-testid="credit-note-regenerate-btn"
            @click="() => regeneratePdf()"
          >
            {{ regenerating ? 'Régénération…' : 'Régénérer le PDF' }}
          </button>
        </div>
      </section>

      <!-- Modale émission avoir — CR F-7 : a11y ESC + backdrop click pour
           fermer (cohérent contract `aria-modal=true`). Le clic sur la modale
           elle-même ne propage pas (`@click.stop`). -->
      <div
        v-if="emitDialogSavId === savId && isOperator"
        ref="emitDialog"
        class="modal-backdrop"
        role="dialog"
        aria-modal="true"
        aria-labelledby="emit-dialog-title"
        aria-describedby="emit-consequence"
        @keydown.tab="trapEmitFocus"
        data-testid="sav-emit-dialog"
        tabindex="-1"
        @click.self="closeEmitDialog"
        @keydown.esc.prevent="closeEmitDialog"
      >
        <div class="modal" @click.stop>
          <h2 id="emit-dialog-title">Émettre l’avoir</h2>
          <p id="emit-consequence" class="modal-info">
            La confirmation émet un avoir numéroté pour ce dossier. Son PDF sera généré en arrière-plan.
          </p>
          <fieldset class="emit-bon-type" :disabled="emitting">
            <legend>Type de bon</legend>
            <label
              ><input
                v-model="emitBonType"
                name="emit-bon-type"
                type="radio"
                value="AVOIR"
                data-testid="emit-bon-type-AVOIR"
              />
              Avoir comptable</label
            >
            <label
              ><input
                v-model="emitBonType"
                name="emit-bon-type"
                type="radio"
                value="VIREMENT BANCAIRE"
                data-testid="emit-bon-type-VIREMENT"
              />
              Virement bancaire</label
            >
            <label
              ><input
                v-model="emitBonType"
                name="emit-bon-type"
                type="radio"
                value="PAYPAL"
                data-testid="emit-bon-type-PAYPAL"
              />
              PayPal</label
            >
          </fieldset>
          <p v-if="emitError" class="modal-error" role="alert" data-testid="sav-emit-error">
            {{ emitError }}
          </p>
          <div class="modal-actions">
            <button type="button" class="btn-sm" :disabled="emitting" @click="closeEmitDialog">
              Annuler
            </button>
            <button
              type="button"
              class="workflow-btn workflow-btn--primary"
              :disabled="emitting"
              data-testid="sav-emit-confirm"
              @click="submitEmit"
            >
              {{ emitting ? 'Émission…' : 'Confirmer l’émission' }}
            </button>
          </div>
        </div>
      </div>

      <!-- Story 4.3 — Aperçu avoir (preview live, AC #2) -->
      <section
        v-if="showPreview"
        class="card preview-credit-note"
        aria-labelledby="preview-title"
        data-testid="sav-preview-credit-note"
      >
        <h2 id="preview-title">Aperçu avoir</h2>
        <div
          v-if="preview.anyLineBlocking.value"
          class="preview-blocking"
          role="alert"
          aria-live="polite"
          data-testid="sav-preview-blocking"
        >
          {{ preview.blockingCount.value }} ligne(s) bloquante(s) — aucun avoir ne peut être émis
          <a
            v-if="firstBlockingLineId !== null"
            :href="`#sav-line-${firstBlockingLineId}`"
            class="preview-blocking-jump"
            data-testid="sav-preview-blocking-jump"
            @click="scrollToFirstBlocking"
            >Voir la 1re ligne bloquante</a
          >
        </div>
        <p v-if="preview.anyLineBlocking.value">Les totaux de l’aperçu portent sur les lignes calculables.</p>
        <dl class="preview-totals">
          <div>
            <dt>Sous-total HT</dt>
            <dd data-testid="preview-ht">{{ formatEur(preview.totalHtCents.value) }}</dd>
          </div>
          <div v-if="isGroupManager" data-testid="preview-discount-row">
            <dt>
              Remise responsable {{ discountLabel }}
              <span class="badge-info" data-testid="preview-discount-badge"
                >Remise responsable {{ discountLabel }} appliquée</span
              >
            </dt>
            <dd data-testid="preview-discount">-{{ formatEur(preview.discountCents.value) }}</dd>
          </div>
          <div>
            <dt>TVA</dt>
            <dd data-testid="preview-vat">{{ formatEur(preview.vatCents.value) }}</dd>
          </div>
          <div class="preview-total-ttc">
            <dt>Total TTC</dt>
            <dd data-testid="preview-ttc">{{ formatEur(preview.totalTtcCents.value) }}</dd>
          </div>
        </dl>
      </section>

      <!-- Fichiers -->
      <section class="card" aria-labelledby="files-title">
        <h2 id="files-title">Pièces jointes ({{ sav.files.length }})</h2>
        <!-- Story 3.7b — OperatorFileUploader -->
        <OperatorFileUploader :sav-id="sav.id" @uploaded="refresh" />
        <div v-if="sav.files.length === 0" class="empty">Aucun fichier joint.</div>
        <div v-else class="files-grid">
          <article v-for="f in sav.files" :key="f.id" class="file-card">
            <template v-if="isImagePreviewable(f) && !imgErrored[f.id]">
              <img
                :src="imgSrc(f)"
                :alt="f.originalFilename"
                loading="lazy"
                @error="markImgError(f.id)"
              />
            </template>
            <template v-else-if="imgErrored[f.id]">
              <div
                class="file-fallback"
                role="img"
                :aria-label="`Aperçu indisponible pour ${f.originalFilename}`"
              >
                <span aria-hidden="true">⚠️</span>
                <p>Aperçu indisponible</p>
                <button type="button" @click="retryImg(f.id)">Réessayer</button>
              </div>
            </template>
            <template v-else>
              <div class="file-icon" aria-hidden="true">
                {{
                  f.mimeType.includes('pdf') ? '📄' : f.mimeType.startsWith('image/') ? '🖼' : '📎'
                }}
              </div>
            </template>
            <p class="file-name">{{ f.originalFilename }}</p>
            <!-- AC #6.5 — Badge source FR (D-2: libellés FR + title a11y) -->
            <span
              v-if="
                f.source === 'capture' || f.source === 'member-add' || f.source === 'operator-add'
              "
              class="file-source-badge"
              :class="`file-source-badge--${f.source}`"
              :title="
                f.source === 'capture'
                  ? 'Fichier issu de la capture'
                  : f.source === 'member-add'
                    ? 'Fichier ajouté par le membre'
                    : 'Fichier ajouté par un opérateur'
              "
              :aria-label="
                f.source === 'capture'
                  ? 'Source : Capture'
                  : f.source === 'member-add'
                    ? 'Source : Membre'
                    : 'Source : Opérateur'
              "
              >{{
                f.source === 'capture'
                  ? 'Capture'
                  : f.source === 'member-add'
                    ? 'Membre'
                    : 'Opérateur'
              }}</span
            >
            <span v-else class="file-meta">Provenance non renseignée</span>
            <p class="file-meta">{{ formatBytes(f.sizeBytes) }}</p>
            <!-- UAT V1.8 — bouton "Ouvrir" passe par le proxy backend
                 /api/sav/files/:id/download (extension PATTERN-V5) au lieu
                 de pointer directement sur SharePoint webUrl, qui demandait
                 une session Microsoft à l'opérateur back-office. -->
            <a
              v-if="isOneDriveWebUrlTrusted(f.webUrl)"
              :href="`/api/sav/files/${f.id}/download`"
              target="_blank"
              rel="noopener noreferrer"
              :aria-label="`Ouvrir ${f.originalFilename} (nouvel onglet)`"
              >Ouvrir</a
            >
            <span v-else class="link-unsafe" :title="`Lien non fiable : ${f.webUrl}`"
              >Lien suspect</span
            >
          </article>
        </div>
      </section>

      <!-- Commentaires -->
      <section class="card" aria-labelledby="comments-title">
        <h2 id="comments-title">Commentaires<span v-if="!commentsDegraded"> ({{ allComments.length }})</span></h2>
        <p v-if="commentsDegraded" class="read-warning" role="status">
          Impossible de charger les commentaires.
          <button type="button" :disabled="loading" @click="refreshExchanges">Réessayer la lecture</button>
        </p>
        <ul v-if="allComments.length > 0" class="comments">
          <li v-for="c in allComments" :key="c.id" class="comment">
            <div class="avatar" aria-hidden="true">
              {{ initials(c.authorMember, c.authorOperator) }}
            </div>
            <div class="body">
              <header>
                <strong>{{ c.authorOperator?.displayName ?? memberName(c.authorMember) }}</strong>
                <span v-if="c.visibility === 'internal'" class="badge-internal">Note interne · équipe SAV</span>
                <span v-else-if="c.visibility === 'all'" class="badge-shared">Partagé avec l’adhérent</span>
                <span v-else>Visibilité non renseignée</span>
                <time :datetime="c.createdAt">{{ timeRelative(c.createdAt) }}</time>
              </header>
              <!-- JAMAIS v-html — body interpolé safely -->
              <p class="comment-body">{{ c.body }}</p>
            </div>
          </li>
        </ul>
        <p v-else-if="!commentsDegraded" class="empty">Aucun commentaire pour ce SAV.</p>

        <!-- Story 3.7b — ComposeCommentForm inline (AC #6.2) -->
        <form class="compose-form" @submit.prevent="submitComment">
          <textarea
            v-model="composeBody"
            aria-label="Nouveau commentaire"
            class="compose-textarea"
            placeholder="Saisir un commentaire..."
            :disabled="composeSubmitting"
          />
          <fieldset class="compose-visibility" :disabled="composeSubmitting">
            <legend>Visibilité</legend>
            <label class="radio-label">
              <input
                v-model="composeVisibility"
                type="radio"
                value="internal"
                name="compose-visibility"
              />
              Équipe SAV uniquement
            </label>
            <label class="radio-label">
              <input
                v-model="composeVisibility"
                type="radio"
                value="all"
                name="compose-visibility"
              />
              Adhérent et équipe SAV
            </label>
          </fieldset>
          <p class="audience-hint" role="status">{{ composeVisibility === 'internal' ? 'Seule l’équipe SAV pourra lire cette note.' : 'L’adhérent pourra lire ce message avec l’équipe SAV.' }}</p>
          <button
            type="submit"
            class="btn-primary"
            :disabled="composeSubmitting || !composeBody.trim()"
          >
            {{ composeSubmitting ? 'Envoi…' : 'Envoyer' }}
          </button>
          <div v-if="composeError" class="compose-error" role="alert">
            {{ composeError }}
            <button v-if="publicationUncertain" type="button" :disabled="loading" @click="refreshExchanges">Relire les échanges</button>
            <button type="button" aria-label="Fermer le message" @click="composeError = null">×</button>
          </div>
        </form>
      </section>

      <!-- Audit trail -->
      <section class="card" aria-labelledby="audit-title">
        <h2 id="audit-title">Historique<span v-if="!auditDegraded"> ({{ auditTrail.length }})</span></h2>
        <p v-if="auditDegraded" class="read-warning" role="status">
          Impossible de charger l’historique.
          <button type="button" :disabled="loading" @click="refreshExchanges">Réessayer la lecture</button>
        </p>
        <p v-else-if="auditTruncated" class="read-warning">Affichage limité aux {{ auditTrail.length }} événements les plus récents.</p>
        <ol v-if="auditTrail.length > 0" class="audit">
          <li v-for="event in auditTrail" :key="event.id">
            <time :datetime="event.createdAt">{{ formatDateTime(event.createdAt) }}</time>
            — <strong>{{ auditActorName(event) }}</strong>
            <ul class="diff-lines">
              <li v-for="(line, idx) in formatDiff(event.action, event.diff)" :key="idx">
                {{ line }}
              </li>
            </ul>
          </li>
        </ol>
        <p v-else-if="!auditDegraded" class="empty">Aucun événement enregistré.</p>
      </section>
    </template>
  </main>
</template>

<style scoped>
.sav-detail-view {
  padding: 1rem;
  max-width: 1200px;
  margin: 0 auto;
}
.breadcrumb {
  margin-bottom: 1rem;
  color: #666;
  font-size: 0.875rem;
}
.breadcrumb a {
  color: #0066cc;
  text-decoration: underline;
}
.breadcrumb a:focus-visible,
button:focus-visible,
a:focus-visible {
  outline: 2px solid #80400b;
  outline-offset: 2px;
}
.card {
  background: white;
  border: 1px solid #eee;
  border-radius: 8px;
  padding: 1.25rem;
  margin-bottom: 1rem;
}
.card h1 {
  margin: 0 0 0.5rem;
}
.card h2, .modal h2 { color: #30200e; }
.card h2 {
  margin: 0 0 0.75rem;
  font-size: 1.125rem;
}
.status-badge {
  display: inline-block;
  padding: 0.125rem 0.5rem;
  border: 1px solid;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 600;
}
.bg-violet {
  background: #f3e8ff;
  color: #6b21a8;
  border-color: #d8b4fe;
}
.bg-blue {
  background: #dbeafe;
  color: #1e40af;
  border-color: #93c5fd;
}
.bg-amber {
  background: #fef3c7;
  color: #92400e;
  border-color: #fcd34d;
}
.bg-green {
  background: #dcfce7;
  color: #166534;
  border-color: #86efac;
}
.bg-gray {
  background: #f3f4f6;
  color: #374151;
  border-color: #d1d5db;
}
.bg-red {
  background: #fee2e2;
  color: #991b1b;
  border-color: #fca5a5;
}
.metadata {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0.5rem 1rem;
  margin: 1rem 0;
}
.metadata div {
  display: flex;
  flex-direction: column;
}
.metadata dt {
  font-size: 0.75rem;
  color: #666;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.metadata dd {
  margin: 0;
  font-size: 0.9375rem;
}
.assign-me:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  margin-left: 0.5rem;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}
.tag {
  background: #eef;
  padding: 0.125rem 0.5rem;
  border-radius: 4px;
  font-size: 0.75rem;
}
.lines-table {
  width: 100%;
  border-collapse: collapse;
}
.lines-table th,
.lines-table td {
  text-align: left;
  padding: 0.5rem;
  border-bottom: 1px solid #eee;
  font-size: 0.875rem;
}
/* Min-widths colonnes en mode édition — évite la troncature des inputs. */
.lines-table th:nth-child(4),
.lines-table td:nth-child(4) {
  min-width: 145px; /* Qté demandée + select unité (était 90px → troncature 1,5 / kg) */
}
.lines-table th:nth-child(5),
.lines-table td:nth-child(5) {
  min-width: 95px; /* Avoir TTC */
}
.lines-table th:nth-child(6),
.lines-table td:nth-child(6) {
  min-width: 100px; /* PU TTC */
}
.lines-table th:nth-child(7),
.lines-table td:nth-child(7) {
  min-width: 80px; /* Coef. */
}
.validation-badge {
  padding: 0.125rem 0.375rem;
  border: 1px solid;
  border-radius: 4px;
  font-size: 0.75rem;
}
.validation-ok {
  background: #dcfce7;
  color: #166534;
  border-color: #86efac;
}
.validation-warn {
  background: #fef3c7;
  color: #92400e;
  border-color: #fcd34d;
}
.validation-err {
  background: #fee2e2;
  color: #991b1b;
  border-color: #fca5a5;
}
.files-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 0.75rem;
}
.file-card {
  border: 1px solid #eee;
  border-radius: 4px;
  padding: 0.5rem;
  font-size: 0.875rem;
}
.file-card img {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  border-radius: 4px;
}
.file-icon,
.file-fallback {
  width: 100%;
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f5f5f5;
  border-radius: 4px;
  font-size: 2rem;
  flex-direction: column;
  gap: 0.25rem;
}
.file-fallback button {
  font-size: 0.75rem;
}
.file-name {
  font-weight: 600;
  margin: 0.25rem 0 0;
  overflow-wrap: anywhere;
}
.file-meta {
  color: #666;
  font-size: 0.75rem;
  margin: 0;
}
/* AC #6.5 — Source badge per file */
.file-source-badge {
  display: inline-block;
  font-size: 0.65rem;
  font-weight: 600;
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  margin-top: 0.2rem;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
.file-source-badge--capture {
  background: #f8eedf;
  color: #664626;
}
.file-source-badge--member-add {
  background: #dcfce7;
  color: #166534;
}
.file-source-badge--operator-add {
  background: #ffedd5;
  color: #9a3412;
}
.link-unsafe {
  color: #c00;
  font-size: 0.75rem;
}
.comments {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.comment {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
}
.avatar {
  width: 2rem;
  height: 2rem;
  border-radius: 50%;
  background: #506133;
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  flex-shrink: 0;
  font-size: 0.75rem;
}
.comment .body {
  min-width: 0;
  flex: 1;
}
.comment header {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: baseline;
  font-size: 0.875rem;
}
.comment header time {
  color: #666;
  font-size: 0.75rem;
}
.badge-internal {
  background: #ffe4b5;
  color: #8b4513;
  padding: 0 0.375rem;
  border-radius: 4px;
  font-size: 0.75rem;
}
.comment-body {
  margin: 0.25rem 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.badge-shared {
  background: #e8f1de;
  color: #314c20;
  padding: 0 0.375rem;
  border-radius: 4px;
  font-size: 0.75rem;
}
.audience-hint, .read-warning {
  margin: 0.25rem 0;
  color: #594322;
}
.compose-form .btn-primary {
  background: #ef922d;
  border-color: #9b520f;
  color: #30200e;
  align-self: flex-start;
}
.compose-form .btn-primary:disabled { opacity: 0.65; }
.compose-placeholder {
  margin-top: 1rem;
  padding: 0.75rem;
  background: #f9f9f9;
  border-left: 3px solid #ccc;
  color: #666;
  font-size: 0.875rem;
}
.audit {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  font-size: 0.875rem;
}
.audit time {
  color: #666;
  font-size: 0.8125rem;
}
.diff-lines {
  margin: 0.25rem 0 0 1rem;
  font-size: 0.8125rem;
  color: #444;
}
.empty {
  color: #666;
  text-align: center;
  padding: 1rem;
}
.skeleton {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.skeleton-block {
  height: 8rem;
  background: linear-gradient(90deg, #eee, #f5f5f5, #eee);
  animation: shimmer 1.5s infinite;
  border-radius: 8px;
}
@keyframes shimmer {
  0% {
    background-position: -200px 0;
  }
  100% {
    background-position: 200px 0;
  }
}
.not-found,
.error {
  padding: 2rem;
  text-align: center;
}
.error {
  color: #800;
  background: #fee;
  border: 1px solid #c00;
  border-radius: 4px;
}

/* Story 4.3 — preview avoir */
.preview-credit-note {
  max-width: 480px;
  margin-left: auto;
}
.preview-blocking {
  background: #fee2e2;
  color: #991b1b;
  border: 1px solid #fca5a5;
  border-radius: 4px;
  padding: 0.5rem 0.75rem;
  margin-bottom: 0.75rem;
  font-size: 0.875rem;
}
.preview-blocking-jump {
  display: inline-block;
  margin-left: 0.5rem;
  color: #991b1b;
  text-decoration: underline;
  font-weight: 600;
}
.preview-blocking-jump:hover {
  text-decoration: none;
}
.preview-totals {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.preview-totals div {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 0.25rem 0;
  border-bottom: 1px dashed #e5e7eb;
}
.preview-totals dt {
  color: #374151;
  font-size: 0.9375rem;
}
.preview-totals dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
  font-size: 0.9375rem;
}
.preview-total-ttc {
  border-bottom: none !important;
  border-top: 2px solid #111827;
  margin-top: 0.25rem;
  padding-top: 0.5rem !important;
}
.preview-total-ttc dt,
.preview-total-ttc dd {
  font-weight: 700;
  font-size: 1.25em;
}
.badge-info {
  background: #dbeafe;
  color: #1e40af;
  border: 1px solid #93c5fd;
  padding: 0 0.375rem;
  border-radius: 4px;
  font-size: 0.75rem;
  margin-left: 0.5rem;
  font-weight: 400;
}

/* Story 3.6b — édition inline + bouton Valider */
.header.card { border-top: 5px solid var(--main-orange, #e88a23); }
.header h1 { color: #30200e; overflow-wrap: anywhere; }
.header .action-title { margin: 1rem 0 .5rem; }
.lines-scroll { overflow-x: auto; }
.lines-scroll:focus-visible { outline: 2px solid #80400b; }
.header-title-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.workflow-actions {
  margin-left: auto;
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.workflow-btn {
  padding: 0.5rem 1rem;
  border-radius: 4px;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid transparent;
}
.workflow-btn--primary {
  background: var(--main-orange, #e88a23);
  color: #30200e;
  border-color: #af6820;
}
.workflow-btn--primary:hover:not(:disabled) {
  background: #ed983a;
}
.workflow-btn--primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  background: #ece6df;
  border-color: #84796d;
}
.workflow-btn--ghost {
  background: white;
  color: #b91c1c;
  border-color: #fecaca;
}
.workflow-btn--ghost:hover:not(:disabled) {
  background: #fef2f2;
}
.workflow-btn--ghost:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
/* Garder la cible du lien visible sous l’en-tête fixe. */
#credit-note-title {
  scroll-margin-top: 5rem;
}

/* Section avoir émis */
.credit-note-issued {
  border-left: 4px solid #16a34a;
}
.credit-note-dl {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0.5rem 1rem;
  margin: 0.5rem 0;
}
.credit-note-dl dt {
  font-size: 0.8125rem;
  color: #6b7280;
}
.credit-note-dl dd {
  margin: 0;
  font-weight: 600;
}
.credit-note-pdf-link {
  display: inline-block;
  margin-top: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: #f9fafb;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  color: #1f2937;
  text-decoration: none;
  font-weight: 600;
}
.credit-note-pdf-link--disabled {
  opacity: 0.6;
  cursor: not-allowed;
  font-style: italic;
}
.credit-note-pdf-link:hover {
  background: #f3f4f6;
}
/* spec credit-note-pdf-regenerate-feedback : état d'échec génération PDF */
.credit-note-pdf-failed {
  margin-top: 0.5rem;
}
.credit-note-pdf-failed-msg {
  margin: 0 0 0.5rem;
  color: #b91c1c;
  font-size: 0.875rem;
}
.credit-note-regenerate-btn {
  padding: 0.5rem 0.75rem;
  background: #fff;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  color: #1f2937;
  font-weight: 600;
  cursor: pointer;
}
.credit-note-regenerate-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.credit-note-regenerate-btn:not(:disabled):hover {
  background: #f3f4f6;
}
/* spec credit-note-force-regenerate-pdf : bouton force phase ready,
   même famille visuelle que le lien PDF / bouton recovery */
.credit-note-force-regenerate-btn {
  display: inline-block;
  margin-top: 0.5rem;
  margin-left: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: #fff;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  color: #1f2937;
  font-weight: 600;
  cursor: pointer;
}
.credit-note-force-regenerate-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.credit-note-force-regenerate-btn:not(:disabled):hover {
  background: #f3f4f6;
}
.credit-note-force-regenerate-error {
  margin: 0.5rem 0 0;
  color: #b91c1c;
  font-size: 0.875rem;
}
/* Modale émission avoir */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.modal {
  background: white;
  border-radius: 8px;
  padding: 1.5rem;
  box-sizing: border-box;
  width: min(420px, 95vw);
  max-height: 95dvh;
  overflow-y: auto;
  box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
}
.modal h2 {
  margin: 0 0 0.5rem;
}
.modal-info {
  color: #4b5563;
  font-size: 0.875rem;
  margin: 0 0 0.75rem;
}
.emit-bon-type {
  border: 1px solid #e5e7eb;
  border-radius: 4px;
  padding: 0.5rem 0.75rem;
  margin: 0 0 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.emit-bon-type legend {
  padding: 0 0.25rem;
  color: #374151;
  font-size: 0.875rem;
  font-weight: 600;
}
.emit-bon-type label {
  font-size: 0.9375rem;
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
.modal-error {
  background: #fee2e2;
  color: #991b1b;
  border: 1px solid #fca5a5;
  border-radius: 4px;
  padding: 0.5rem 0.75rem;
  margin: 0 0 0.75rem;
  font-size: 0.875rem;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
.line-credit { font-variant-numeric: tabular-nums; }
@media (max-width: 600px) {
  .lines-table, .lines-table tbody { display: block; }
  .lines-table thead { position: absolute; clip-path: inset(50%); width: 1px; height: 1px; overflow: hidden; }
  .lines-table tr { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .lines-table tr td { min-width: 0; overflow-wrap: anywhere; }
  .lines-table td:empty { display: none; }
  .lines-table td[colspan], .lines-table .actions-cell, .sav-line-request td:nth-child(3),
  .sav-line-request td:nth-child(4), .sav-line-arbitration td:nth-child(4) { grid-column: 1 / -1; }
  .lines-table [data-label]::before {
    display: block;
    font-size: .75rem;
    font-style: normal;
    font-weight: 600;
    color: #563916;
  }
  .lines-table [data-label]::before { content: attr(data-label); }
  .lines-table .cell-pair { width: 100%; grid-template-columns: 1fr 1fr; }
  .lines-table tbody + tbody { margin-top: 1rem; }
}
.cell-input,
.cell-select {
  width: 100%;
  padding: 0.25rem 0.375rem;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  font: inherit;
  font-size: 0.875rem;
  box-sizing: border-box;
}
.cell-input:focus-visible,
.cell-select:focus-visible {
  outline: 2px solid #80400b;
  outline-offset: 1px;
}
.actions-cell {
  vertical-align: middle;
}
.actions-pair {
  display: inline-flex;
  gap: 0.25rem;
  flex-wrap: wrap;
}
.quantity-label {
  display: block;
  grid-column: 1 / -1;
  font-style: normal;
  white-space: normal;
}
.quantity-label { font-weight: 600; color: #30200e; }
.line-edit-error { color: #842c16; margin: 0; white-space: normal; }
.cell-pair {
  display: inline-grid;
  grid-template-columns: auto auto;
  gap: 0.25rem;
  align-items: center;
}
.btn-sm {
  padding: 0.25rem 0.5rem;
  font-size: 0.8125rem;
  border: 1px solid #d1d5db;
  background: white;
  border-radius: 4px;
  cursor: pointer;
}
.btn-sm:hover:not(:disabled) {
  background: #f3f4f6;
}
.btn-sm.line-save { background: #ef922d; border-color: #9b520f; color: #30200e; }
.btn-sm.line-save:hover:not(:disabled) { background: #e38724; }
.btn-sm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-danger {
  color: #991b1b;
  border-color: #fca5a5;
}
.btn-danger:hover:not(:disabled) {
  background: #fee2e2;
}
.btn-primary {
  padding: 0.5rem 0.875rem;
  background: #0066cc;
  color: white;
  border: 1px solid #0066cc;
  border-radius: 4px;
  font: inherit;
  cursor: pointer;
}
.btn-primary:hover {
  background: #0052a3;
}
.lines-actions {
  margin-top: 0.75rem;
}
/* V1.9-A — Split UX lignes SAV (D-9 styles) */
/* Groupe tbody : border-bottom ferme visuellement le groupe */
tbody.sav-line-group {
  border-bottom: 2px solid #e5e7eb;
}
/* Row 1 — Demande adhérent : fond gris subtle + italique (voix du client) */
tr.sav-line-request td {
  background: var(--c-line-request-bg, #fafafa);
  font-style: italic;
  color: var(--c-line-request-text, #525252);
}
/* V1.9-B — Row 2 — Facturé read-only : fond blanc subtle + italique light (voix Pennylane) */
tr.sav-line-invoiced td {
  background: #f9fafb;
  font-style: italic;
  color: #6b7280;
}
/* V1.9-B — Row 3 — Arbitrage opérateur : fond blanc + font-weight 500 (RENOMMÉ from sav-line-validation) */
tr.sav-line-arbitration td {
  background: var(--c-line-validation-bg, #ffffff);
  font-weight: 500;
}
/* Alternance lecture : lignes paires légèrement différenciées */
tbody.sav-line-group:nth-of-type(even) tr.sav-line-request td {
  background: var(--c-line-alt, #f3f4f6);
}
tbody.sav-line-group:nth-of-type(even) tr.sav-line-arbitration td {
  background: var(--c-line-validation-alt, #f9fafb);
}
/* Sentinelle visuelle blocking : inset left border rouge.
   V1.9-A.1 — box-shadow:inset sur <tbody display:table-row-group> n'est pas
   rendu visuellement par Chrome (computed OK, paint KO). Fallback sur le
   premier <td> de chaque row du groupe (Row 1 + Row 2 + Row 3 + edit-extra-row). */
tbody.sav-line-group[data-blocking='true'] > tr > td:first-child {
  box-shadow: inset 4px 0 0 var(--c-error, #dc2626);
}
/* Libellé contextuel Row 1 colspan=7 : italic muted */
.line-request-context {
  font-style: italic;
  color: #9ca3af;
  font-size: 0.8125rem;
}
/* V1.9-B — Fallback stub quand requestReason IS NULL */
.line-request-context-empty {
  font-style: italic;
  color: #9ca3af;
  font-size: 0.8125rem;
}
/* V1.9-B — Badge motif demande (reason-pill) : ambre sobre */
.reason-pill {
  display: inline-flex;
  padding: 2px 8px;
  border-radius: 4px;
  background: #fef3c7;
  color: #92400e;
  font-style: normal;
  font-weight: 500;
  font-size: 0.85em;
}
/* V1.9-B — Commentaire demande : italic muted, décalé à droite du pill */
.comment-text {
  margin-left: 0.5em;
  font-style: italic;
  color: #6b7280;
}
/* V1.9-B — Badge awaiting_arbitration (orange) — DN-1 Option A */
.validation-warning {
  background: #fef3c7;
  color: #92400e;
  border-color: #fcd34d;
}
.line-saving {
  opacity: 0.6;
}
.edit-extra-row td {
  background: #f9fafb;
}
.extra-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8125rem;
}
.extra-label .cell-input {
  width: 120px;
}

/* Story 3.7b */
.tags-row {
  margin-top: 0.5rem;
}
.header-actions-row {
  margin-top: 0.75rem;
  display: flex;
  gap: 0.5rem;
}
.assign-error {
  background: #fee2e2;
  color: #991b1b;
  padding: 0.5rem 0.75rem;
  border-radius: 4px;
  font-size: 0.875rem;
  margin-top: 0.5rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.compose-form {
  margin-top: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.compose-textarea {
  width: 100%;
  min-height: 80px;
  padding: 0.5rem;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  font: inherit;
  font-size: 0.875rem;
  resize: vertical;
  box-sizing: border-box;
}
.compose-visibility {
  border: 1px solid #d1d5db;
  border-radius: 4px;
  padding: 0.375rem 0.75rem;
}
.compose-visibility legend {
  font-size: 0.8125rem;
  font-weight: 600;
  padding: 0 0.25rem;
}
.radio-label {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.875rem;
  margin-right: 1rem;
  cursor: pointer;
}
.compose-error {
  background: #fee2e2;
  color: #991b1b;
  padding: 0.5rem 0.75rem;
  border-radius: 4px;
  font-size: 0.875rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.toast {
  position: fixed;
  bottom: 1rem;
  right: 1rem;
  padding: 0.75rem 2.5rem 0.75rem 1rem;
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 100;
  max-width: 420px;
  font-size: 0.875rem;
}
.toast-error {
  background: #fee2e2;
  color: #991b1b;
  border: 1px solid #fca5a5;
}
.toast-close {
  position: absolute;
  top: 0.25rem;
  right: 0.5rem;
  background: transparent;
  border: none;
  font-size: 1.25rem;
  line-height: 1;
  cursor: pointer;
  color: inherit;
}

/* Story 4.8 — Styles marge (AC #5) */
.margin-positive {
  color: #166534; /* vert foncé */
  font-weight: 500;
}
.margin-negative {
  color: #991b1b; /* rouge */
  font-weight: 500;
}
.margin-null {
  color: #9ca3af; /* gris */
}
.margin-total-footer {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: #f0fdf4;
  border: 1px solid #bbf7d0;
  border-radius: 4px;
  margin-top: 0.75rem;
  font-size: 0.875rem;
}
.margin-total-footer.margin-negative {
  background: #fef2f2;
  border-color: #fecaca;
}

/* H-07 F-10 — bannière dégradation avoir */
.credit-note-degraded-banner {
  background: #fef3c7; /* amber-100 */
  border-left: 4px solid #d97706; /* amber-600 */
  padding: 0.75rem 1rem;
  margin-bottom: 0.75rem;
  border-radius: 4px;
  font-size: 0.9rem;
}

/* Story 8.5 — AC #3 : badge réclamation fournisseur (DN-2=A LOCKED) */
.supplier-claim-badge {
  background: #f0fdf4; /* green-50 */
  border-left: 4px solid #16a34a; /* green-600 */
  padding: 0.625rem 1rem;
  margin-bottom: 0.75rem;
  border-radius: 4px;
  font-size: 0.875rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  color: #166534; /* green-800 */
}

.supplier-claim-badge-icon {
  flex-shrink: 0;
}

.supplier-claim-badge-link {
  margin-left: auto;
  color: #15803d; /* green-700 */
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
}

.supplier-claim-badge-link:hover {
  text-decoration: underline;
}
</style>
