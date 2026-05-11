<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSavDetail, type SavDetailLine } from '../composables/useSavDetail'
import { useSavLinePreview } from '../composables/useSavLinePreview'
import { useSavLineEdit } from '../composables/useSavLineEdit'
import AddLineDialog from '../components/AddLineDialog.vue'
import ImportSupplierPricesDialog from '../components/ImportSupplierPricesDialog.vue'
import SavTagsBar from '../components/SavTagsBar.vue'
import DuplicateButton from '../components/DuplicateButton.vue'
import OperatorFileUploader from '../components/OperatorFileUploader.vue'
import type { SavLineInput } from '../../../../api/_lib/business/creditCalculation'
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
const { sav, comments, auditTrail, settingsSnapshot, creditNote, loading, error, refresh } =
  useSavDetail(savId)
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
      : null) as SavLineInput['unit_arbitrated'],
    unit_price_ttc_cents: l.unitPriceTtcCents,
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
      qtyInvoiced: string | number
      unitInvoiced: string
      // V1.9-B — arbitrage opérateur (PATTERN-V9-D : pre-fill = qtyArbitrated ?? qtyInvoiced)
      qtyArbitrated: string | number
      unitArbitrated: string
      unitPriceEuros: string | number
      creditCoefficient: string | number
      pieceToKgWeightG: string | number
    }
  >
>({})

function beginEditLine(l: SavDetailLine): void {
  // V1.9-B PATTERN-V9-D — pre-fill arbitrage : qtyArbitrated ?? qtyInvoiced (DN-4 Option A).
  // L'opérateur voit la valeur facturée comme suggestion par défaut si pas encore arbitré.
  const prefilledQtyArbitrated =
    l.qtyArbitrated !== null
      ? String(l.qtyArbitrated)
      : l.qtyInvoiced !== null
        ? String(l.qtyInvoiced)
        : ''
  const prefilledUnitArbitrated = l.unitArbitrated ?? l.unitInvoiced ?? ''
  editDraft[l.id] = {
    qtyRequested: String(l.qtyRequested),
    unitRequested: l.unitRequested,
    qtyInvoiced: l.qtyInvoiced !== null ? String(l.qtyInvoiced) : '',
    unitInvoiced: l.unitInvoiced ?? '',
    qtyArbitrated: prefilledQtyArbitrated,
    unitArbitrated: prefilledUnitArbitrated,
    unitPriceEuros: l.unitPriceTtcCents !== null ? (l.unitPriceTtcCents / 100).toFixed(2) : '',
    creditCoefficient: String(l.creditCoefficient),
    pieceToKgWeightG: l.pieceToKgWeightG !== null ? String(l.pieceToKgWeightG) : '',
  }
  lineEdit.startEdit(l.id)
  toastMessage.value = null
}

function cancelEditLine(): void {
  const id = lineEdit.editingLineId.value
  lineEdit.cancelEdit()
  // P7 (CR Edge-11) : cleanup draft après annulation.
  if (id !== null) delete editDraft[id]
}

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

async function saveEditLine(l: SavDetailLine): Promise<void> {
  const draft = editDraft[l.id]
  if (!draft) return
  const patch: Record<string, unknown> = {}
  const qtyReq = parseLocaleNumber(draft.qtyRequested)
  if (Number.isFinite(qtyReq) && qtyReq !== l.qtyRequested) patch['qtyRequested'] = qtyReq
  if (draft.unitRequested && draft.unitRequested !== l.unitRequested)
    patch['unitRequested'] = draft.unitRequested
  // P3 (CR Blind-6) : qtyInvoiced/unitInvoiced resettables à null via valeur vide.
  if (isEmptyDraftField(draft.qtyInvoiced)) {
    if (l.qtyInvoiced !== null) patch['qtyInvoiced'] = null
  } else {
    const q = parseLocaleNumber(draft.qtyInvoiced)
    if (Number.isFinite(q) && q !== l.qtyInvoiced) patch['qtyInvoiced'] = q
  }
  if (isEmptyDraftField(draft.unitInvoiced)) {
    if (l.unitInvoiced !== null) patch['unitInvoiced'] = null
  } else if (draft.unitInvoiced !== l.unitInvoiced) {
    patch['unitInvoiced'] = draft.unitInvoiced
  }
  // V1.9-B — arbitrage opérateur (Row 3 : toujours inclus dans le patch si draft present)
  if (isEmptyDraftField(draft.qtyArbitrated)) {
    if (l.qtyArbitrated !== null) patch['qtyArbitrated'] = null
  } else {
    const qa = parseLocaleNumber(draft.qtyArbitrated)
    if (Number.isFinite(qa)) patch['qtyArbitrated'] = qa
  }
  if (isEmptyDraftField(draft.unitArbitrated)) {
    if (l.unitArbitrated !== null) patch['unitArbitrated'] = null
  } else if (draft.unitArbitrated !== (l.unitArbitrated ?? '')) {
    patch['unitArbitrated'] = draft.unitArbitrated
  } else {
    // unitArbitrated inchangé mais toujours envoyé pour cohérence avec qtyArbitrated
    if (!isEmptyDraftField(draft.unitArbitrated)) patch['unitArbitrated'] = draft.unitArbitrated
  }
  if (!isEmptyDraftField(draft.unitPriceEuros)) {
    const cents = Math.round(parseLocaleNumber(draft.unitPriceEuros) * 100)
    if (Number.isFinite(cents) && cents !== l.unitPriceTtcCents) patch['unitPriceTtcCents'] = cents
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
    lineEdit.cancelEdit()
    return
  }
  const result = await lineEdit.savePatch(l.id, patch)
  if (!result.ok) {
    if (result.error.code === 'VERSION_CONFLICT') {
      toastMessage.value = 'Rechargez, le SAV a été modifié par un autre utilisateur.'
      await refresh()
    } else {
      toastMessage.value = result.error.message
    }
    return
  }
  // P7 (CR Edge-11) : cleanup draft pour éviter accumulation mémoire.
  delete editDraft[l.id]
  // V1.9-B : refresh différé — savePatch retourne validationStatus depuis la RPC.
  // La vue déclenche un refresh complet au prochain cycle de navigation (sav.version
  // est mis à jour par onVersionUpdated). Pour voir creditAmountCents mis à jour,
  // l'opérateur peut recharger manuellement.
  // Note : refresh() immédiat était dans V1.9-A mais la RPC retourne déjà validationStatus.
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
const showValidateButton = computed<boolean>(() => sav.value?.status === 'in_progress')
const validating = ref(false)

async function validateSav(): Promise<void> {
  if (!canValidate.value || !sav.value) return
  await transitionStatus('validated', { onLinesBlocked: () => scrollToFirstBlockingAfterRefresh() })
}

// --- Workflow back-office : boutons transitions générique ------------------
// Centralise PATCH /api/sav/:id/status pour tous les boutons workflow
// (Marquer reçu, Démarrer, Valider, Clôturer, Annuler). Le serveur (RPC
// `transition_sav_status`) reste source de vérité — l'UI propose juste les
// transitions actuellement valides via `currentAllowedTransitions`.
const transitioning = ref<SavStatus | null>(null)
type SavStatus = 'draft' | 'received' | 'in_progress' | 'validated' | 'closed' | 'cancelled'

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
    await refresh()
    return true
  } catch (e) {
    toastMessage.value = e instanceof Error ? e.message : 'Erreur réseau'
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
const showStartButton = computed<boolean>(() => sav.value?.status === 'received')
const showCloseButton = computed<boolean>(() => sav.value?.status === 'validated')
const showCancelButton = computed<boolean>(() =>
  ['draft', 'received', 'in_progress', 'validated'].includes(sav.value?.status ?? '')
)

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
    (sav.value?.status === 'validated' || sav.value?.status === 'in_progress') && !creditNote.value
)
const emitDialogOpen = ref(false)
const emitting = ref(false)
const emitError = ref<string | null>(null)
const emitBonType = ref<'AVOIR' | 'VIREMENT BANCAIRE' | 'PAYPAL'>('AVOIR')

function openEmitDialog(): void {
  emitError.value = null
  emitBonType.value = 'AVOIR'
  emitDialogOpen.value = true
}

// CR F-7 : helper pour ESC / backdrop / bouton Annuler. Bloque pendant
// l'émission pour éviter une fermeture accidentelle pendant le POST.
function closeEmitDialog(): void {
  if (emitting.value) return
  emitDialogOpen.value = false
}

async function submitEmit(): Promise<void> {
  if (!sav.value || emitting.value) return
  emitting.value = true
  emitError.value = null
  try {
    const res = await fetch(`/api/sav/${sav.value.id}/credit-notes`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bon_type: emitBonType.value }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: {
          code: string
          message: string
          details?: { code?: string; number_formatted?: string }
        }
      } | null
      const detailsCode = body?.error?.details?.code
      if (detailsCode === 'CREDIT_NOTE_ALREADY_ISSUED') {
        // CR F-4 : refresh d'abord (pour exposer l'avoir existant côté UI),
        // puis fermer la modale et afficher le toast — l'opérateur voit la
        // section « Avoir émis » immédiatement, plus de cycle de re-clic.
        await refresh()
        emitDialogOpen.value = false
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
    emitDialogOpen.value = false
    await refresh()
  } catch (e) {
    emitError.value = e instanceof Error ? e.message : 'Erreur réseau'
  } finally {
    emitting.value = false
  }
}

onMounted(() => {
  void refresh()
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

function formatEur(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—'
  return (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })
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
const { user: currentUser, loading: currentUserLoading } = useCurrentUser()

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
// Optimistic comment list (extends comments ref)
interface OptimisticComment {
  id: string | number
  body: string
  visibility: 'internal' | 'all'
  createdAt: string
  authorOperator: { id: number; displayName: string } | null
  authorMember: null
}

const optimisticComments = ref<OptimisticComment[]>([])
const composeBody = ref('')
const composeVisibility = ref<'internal' | 'all'>('internal')
const composeSubmitting = ref(false)
const composeError = ref<string | null>(null)

// Merged comment list: server comments + optimistic ones
const allComments = computed(() => {
  // Filter out optimistic entries that have been replaced by real server entries
  return [...(comments.value ?? []), ...optimisticComments.value]
})

async function submitComment(): Promise<void> {
  if (!sav.value || !composeBody.value.trim()) return
  composeError.value = null
  composeSubmitting.value = true

  const sentinelId = `optimistic-${Date.now()}`
  const optimistic: OptimisticComment = {
    id: sentinelId,
    body: composeBody.value.trim(),
    visibility: composeVisibility.value,
    createdAt: new Date().toISOString(),
    authorOperator: currentUser.value ? { id: currentUser.value.sub, displayName: 'Vous' } : null,
    authorMember: null,
  }

  optimisticComments.value = [...optimisticComments.value, optimistic]
  const bodyText = composeBody.value.trim()
  composeBody.value = ''

  try {
    const res = await fetch(`/api/sav/${sav.value.id}/comments`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        body: bodyText,
        visibility: composeVisibility.value,
      }),
    })
    if (!res.ok) {
      // Rollback optimistic comment
      optimisticComments.value = optimisticComments.value.filter((c) => c.id !== sentinelId)
      composeBody.value = bodyText
      composeError.value = `Erreur lors de l'envoi du commentaire (${res.status}).`
      return
    }
    const data = (await res.json()) as {
      data: {
        commentId: number
        createdAt: string
        visibility: string
        body: string
        authorOperator?: { id: number }
      }
    }
    // Replace sentinel with real comment
    optimisticComments.value = optimisticComments.value.map((c) =>
      c.id === sentinelId
        ? {
            ...c,
            id: data.data.commentId,
            createdAt: data.data.createdAt,
          }
        : c
    )
  } catch {
    // Rollback on network error
    optimisticComments.value = optimisticComments.value.filter((c) => c.id !== sentinelId)
    composeBody.value = bodyText
    composeError.value = 'Erreur réseau — réessayez.'
  } finally {
    composeSubmitting.value = false
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
        <div class="header-title-row">
          <h1 id="sav-detail-title">{{ sav.reference }}</h1>
          <span :class="['status-badge', STATUS_COLOR[sav.status] ?? 'bg-gray']">
            {{ STATUS_LABEL[sav.status] ?? sav.status }}
          </span>
          <div class="workflow-actions" role="group" aria-label="Actions workflow SAV">
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
              v-if="showValidateButton"
              type="button"
              class="workflow-btn workflow-btn--primary validate-btn"
              :disabled="!canValidate || validating"
              :title="
                !canValidate ? 'Corrige les lignes en erreur avant de valider' : 'Valider le SAV'
              "
              data-testid="sav-validate-btn"
              @click="validateSav"
            >
              {{ validating ? 'Validation…' : 'Valider le SAV' }}
            </button>
            <button
              v-if="showEmitCreditButton"
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
        </div>
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
            <dt>Montant avoir</dt>
            <dd>{{ formatEur(sav.totalAmountCents) }}</dd>
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
        <table class="lines-table" role="table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Code</th>
              <th scope="col">Produit</th>
              <th scope="col">Qté demandée</th>
              <th scope="col">Qté facturée</th>
              <th scope="col">PU TTC</th>
              <!-- Story 4.8 — colonnes prix fournisseur + marge -->
              <th scope="col">PU achat HT</th>
              <th scope="col">Marge unit. HT</th>
              <th scope="col">Coef.</th>
              <th scope="col">Avoir</th>
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
              <td>{{ l.lineNumber ?? l.position }}</td>
              <td>{{ l.productCodeSnapshot }}</td>
              <td>{{ l.productNameSnapshot }}</td>
              <!-- Qté demandée + unité demandée (V1.x-B — l'unité est éditable en
                   cas d'erreur de capture, reste la voix du client). -->
              <td>
                <span
                  v-if="lineEdit.editingLineId.value === l.id && editDraft[l.id]"
                  class="cell-pair"
                >
                  <input
                    v-model="editDraft[l.id]!.qtyRequested"
                    type="number"
                    min="0.001"
                    max="99999"
                    step="0.001"
                    :aria-label="`Quantité demandée, ligne ${l.lineNumber ?? l.position}`"
                    class="cell-input"
                    :data-testid="`edit-qty-requested-${l.id}`"
                    @keydown.enter.prevent="saveEditLine(l)"
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
                <span v-else>{{ l.qtyRequested }} {{ l.unitRequested }}</span>
              </td>
              <!-- V1.9-B — colspan=8 : colonnes 5-12 — motif demande adhérent (requestReason) + commentaire.
                   reason-pill (badge ambre) si requestReason set, sinon fallback stub italic gris.
                   requestComment affiché si set. (AC#3.2, AC#3.3) -->
              <td colspan="8" class="line-request-context">
                <template v-if="l.requestReason || l.requestComment">
                  <span v-if="l.requestReason" class="reason-pill">{{ l.requestReason }}</span>
                  <span v-if="l.requestComment" class="comment-text">{{ l.requestComment }}</span>
                </template>
                <span v-else class="line-request-context-empty">Demande adhérent</span>
              </td>
            </tr>
            <!-- Row 2 — Facturé read-only (voix Pennylane, fond subtle gris italique) V1.9-B NEW -->
            <tr class="sav-line-invoiced" :data-testid="`sav-line-${l.id}-invoiced-row`">
              <!-- Colonnes 1-4 vides (alignement avec Row 1) -->
              <td></td>
              <td></td>
              <td></td>
              <td></td>
              <!-- Qté facturée (colonne 5) — 100% read-only D-3 (jamais d'input, même en édition) -->
              <td>
                <span>
                  {{ l.qtyInvoiced ?? '—' }}
                  {{ l.qtyInvoiced !== null ? (l.unitInvoiced ?? l.unitRequested) : '' }}
                </span>
              </td>
              <!-- Colonnes 6-12 vides (alignement) -->
              <td></td>
              <td></td>
              <td></td>
              <td></td>
              <td></td>
              <td></td>
              <td></td>
            </tr>
            <!-- Row 3 — Arbitrage opérateur (fond blanc, font-weight 500) — RENOMMÉ from sav-line-validation -->
            <tr class="sav-line-arbitration" :data-testid="`sav-line-${l.id}-arbitration-row`">
              <!-- Colonnes 1-4 vides (alignement avec Row 1 et Row 2) -->
              <td></td>
              <td></td>
              <td></td>
              <td></td>
              <!-- Qté arbitrée (colonne 5) — éditable en mode édition (AC#4.3) -->
              <td>
                <span
                  v-if="lineEdit.editingLineId.value === l.id && editDraft[l.id]"
                  class="cell-pair"
                >
                  <input
                    v-model="editDraft[l.id]!.qtyArbitrated"
                    type="number"
                    min="0"
                    max="99999"
                    step="0.001"
                    placeholder="—"
                    :aria-label="`Quantité arbitrée, ligne ${l.lineNumber ?? l.position}`"
                    class="cell-input"
                    :data-testid="`edit-qty-arbitrated-${l.id}`"
                    @keydown.enter.prevent="saveEditLine(l)"
                    @keydown.esc.prevent="cancelEditLine"
                  />
                  <select
                    v-model="editDraft[l.id]!.unitArbitrated"
                    class="cell-select"
                    :aria-label="`Unité arbitrée, ligne ${l.lineNumber ?? l.position}`"
                    :data-testid="`edit-unit-arbitrated-${l.id}`"
                  >
                    <option value="">—</option>
                    <option value="kg">kg</option>
                    <option value="piece">pièce</option>
                    <option value="liter">litre</option>
                  </select>
                </span>
                <span v-else>
                  <span v-if="l.qtyArbitrated !== null" style="font-weight: 500">
                    {{ l.qtyArbitrated }} {{ l.unitArbitrated }}
                  </span>
                  <span v-else style="font-style: italic; color: #6b7280">—</span>
                </span>
              </td>
              <!-- PU TTC (colonne 6) -->
              <td>
                <input
                  v-if="lineEdit.editingLineId.value === l.id && editDraft[l.id]"
                  v-model="editDraft[l.id]!.unitPriceEuros"
                  type="number"
                  min="0"
                  max="999999.99"
                  step="0.01"
                  placeholder="€"
                  :aria-label="`Prix unitaire TTC, ligne ${l.lineNumber ?? l.position}`"
                  class="cell-input"
                  @keydown.enter.prevent="saveEditLine(l)"
                  @keydown.esc.prevent="cancelEditLine"
                />
                <span v-else>{{ formatEur(l.unitPriceTtcCents) }}</span>
              </td>
              <!-- Story 4.8 — PU achat HT (colonne 7, avec tooltip supplier_reference) -->
              <td>
                <span
                  :title="
                    l.supplierReference ? `Réf. fournisseur : ${l.supplierReference}` : undefined
                  "
                >
                  {{ formatEur(l.supplierPurchasePriceHtCents) }}
                </span>
              </td>
              <!-- Story 4.8 — Marge unit. HT (colonne 8, positif=vert, négatif=rouge, null=gris) -->
              <td>
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
              <td>
                <input
                  v-if="lineEdit.editingLineId.value === l.id && editDraft[l.id]"
                  v-model="editDraft[l.id]!.creditCoefficient"
                  type="number"
                  min="0"
                  max="1"
                  step="0.01"
                  :aria-label="`Coefficient avoir, ligne ${l.lineNumber ?? l.position}`"
                  class="cell-input"
                  @keydown.enter.prevent="saveEditLine(l)"
                  @keydown.esc.prevent="cancelEditLine"
                />
                <span v-else>
                  {{
                    l.creditCoefficientLabel ??
                    (Number.isFinite(l.creditCoefficient) ? l.creditCoefficient : '—')
                  }}
                </span>
              </td>
              <!-- Avoir (colonne 10) -->
              <td>{{ formatEur(l.creditAmountCents) }}</td>
              <!-- Validation (colonne 11) -->
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
              <!-- Actions (colonne 12) -->
              <td class="actions-cell">
                <span v-if="lineEdit.editingLineId.value === l.id" class="actions-pair">
                  <button
                    type="button"
                    class="btn-sm"
                    :disabled="lineEdit.savingLineId.value !== null"
                    :data-testid="`save-line-${l.id}`"
                    @click="saveEditLine(l)"
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
              <td colspan="12">
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
                    @keydown.enter.prevent="saveEditLine(l)"
                    @keydown.esc.prevent="cancelEditLine"
                  />
                </label>
              </td>
            </tr>
          </tbody>
          <!-- Empty state — wrap dans <tbody> séparé pour cohérence HTML5 multi-tbody -->
          <tbody v-if="sav.lines.length === 0" class="sav-line-empty">
            <tr>
              <td colspan="12" class="empty">Aucune ligne sur ce SAV.</td>
            </tr>
          </tbody>
        </table>

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
        <h2 id="credit-note-title">Avoir émis</h2>
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
            <dt>Total TTC</dt>
            <dd>{{ formatEur(creditNote.totalTtcCents) }}</dd>
          </div>
        </dl>
        <!-- CR F-3 : lien désactivé tant que le PDF n'est pas généré (Story 4.5
             écrit pdfWebUrl quand le rendu OneDrive est terminé). Sinon le clic
             ouvre une page d'erreur. -->
        <a
          v-if="creditNote.pdfWebUrl"
          class="credit-note-pdf-link"
          :href="`/api/credit-notes/${creditNote.numberFormatted}/pdf`"
          target="_blank"
          rel="noopener noreferrer"
          data-testid="credit-note-pdf-link"
        >
          Télécharger le PDF
        </a>
        <span
          v-else
          class="credit-note-pdf-link credit-note-pdf-link--disabled"
          aria-disabled="true"
          data-testid="credit-note-pdf-link"
        >
          PDF en cours de génération…
        </span>
      </section>

      <!-- Modale émission avoir — CR F-7 : a11y ESC + backdrop click pour
           fermer (cohérent contract `aria-modal=true`). Le clic sur la modale
           elle-même ne propage pas (`@click.stop`). -->
      <div
        v-if="emitDialogOpen"
        class="modal-backdrop"
        role="dialog"
        aria-modal="true"
        aria-labelledby="emit-dialog-title"
        data-testid="sav-emit-dialog"
        tabindex="-1"
        @click.self="closeEmitDialog"
        @keydown.esc.prevent="closeEmitDialog"
      >
        <div class="modal" @click.stop>
          <h2 id="emit-dialog-title">Émettre l’avoir</h2>
          <p class="modal-info">
            Numéro d’avoir attribué automatiquement. Le PDF sera généré en arrière-plan.
          </p>
          <fieldset class="emit-bon-type" :disabled="emitting">
            <legend>Type de bon</legend>
            <label
              ><input
                v-model="emitBonType"
                type="radio"
                value="AVOIR"
                data-testid="emit-bon-type-AVOIR"
              />
              Avoir comptable</label
            >
            <label
              ><input
                v-model="emitBonType"
                type="radio"
                value="VIREMENT BANCAIRE"
                data-testid="emit-bon-type-VIREMENT"
              />
              Virement bancaire</label
            >
            <label
              ><input
                v-model="emitBonType"
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
              class="btn-primary"
              :disabled="emitting"
              data-testid="sav-emit-confirm"
              @click="submitEmit"
            >
              {{ emitting ? 'Émission…' : 'Émettre' }}
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
        <h2 id="files-title">Fichiers ({{ sav.files.length }})</h2>
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
        <h2 id="comments-title">Commentaires ({{ allComments.length }})</h2>
        <ul v-if="allComments.length > 0" class="comments">
          <li v-for="c in allComments" :key="c.id" class="comment">
            <div class="avatar" aria-hidden="true">
              {{ initials(c.authorMember, c.authorOperator) }}
            </div>
            <div class="body">
              <header>
                <strong>{{ c.authorOperator?.displayName ?? memberName(c.authorMember) }}</strong>
                <span v-if="c.visibility === 'internal'" class="badge-internal">interne</span>
                <time :datetime="c.createdAt">{{ timeRelative(c.createdAt) }}</time>
              </header>
              <!-- JAMAIS v-html — body interpolé safely -->
              <p class="comment-body">{{ c.body }}</p>
            </div>
          </li>
        </ul>
        <p v-else class="empty">Aucun commentaire pour ce SAV.</p>

        <!-- Story 3.7b — ComposeCommentForm inline (AC #6.2) -->
        <form class="compose-form" @submit.prevent="submitComment">
          <textarea
            v-model="composeBody"
            aria-label="Nouveau commentaire"
            class="compose-textarea"
            placeholder="Saisir un commentaire..."
            :disabled="composeSubmitting"
          />
          <fieldset class="compose-visibility">
            <legend>Visibilité</legend>
            <label class="radio-label">
              <input
                v-model="composeVisibility"
                type="radio"
                value="internal"
                name="compose-visibility"
              />
              Interne (opérateurs)
            </label>
            <label class="radio-label">
              <input
                v-model="composeVisibility"
                type="radio"
                value="all"
                name="compose-visibility"
              />
              Adhérent + opérateurs
            </label>
          </fieldset>
          <button
            type="submit"
            class="btn-primary"
            :disabled="composeSubmitting || !composeBody.trim()"
          >
            {{ composeSubmitting ? 'Envoi…' : 'Envoyer' }}
          </button>
          <div v-if="composeError" class="compose-error" role="alert">
            {{ composeError }}
            <button type="button" class="toast-close" @click="composeError = null">×</button>
          </div>
        </form>
      </section>

      <!-- Audit trail -->
      <section class="card" aria-labelledby="audit-title">
        <h2 id="audit-title">Historique ({{ auditTrail.length }})</h2>
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
        <p v-else class="empty">Aucun événement enregistré.</p>
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
  outline: 2px solid #0066cc;
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
  min-width: 90px; /* Qté demandée */
}
.lines-table th:nth-child(5),
.lines-table td:nth-child(5) {
  min-width: 145px; /* Qté facturée + select unité */
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
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  background: #dbeafe;
  color: #1e40af;
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
  background: #0066cc;
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  flex-shrink: 0;
  font-size: 0.75rem;
}
.comment .body {
  flex: 1;
}
.comment header {
  display: flex;
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
  background: #16a34a;
  color: white;
  border-color: #15803d;
}
.workflow-btn--primary:hover:not(:disabled) {
  background: #15803d;
}
.workflow-btn--primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  background: #86efac;
  border-color: #86efac;
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
  width: min(420px, 95vw);
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
  outline: 2px solid #0066cc;
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
.cell-pair {
  display: inline-flex;
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
/* Libellé contextuel Row 1 colspan=8 : italic muted */
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
</style>
