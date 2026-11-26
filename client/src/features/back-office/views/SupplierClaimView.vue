<script setup lang="ts">
/**
 * Story 8.1 — Vue "Demande de remboursement fournisseur" (DN-1=A : route dédiée)
 * Story 8.3 — Extension : grille d'arbitrage (PATTERN-CLIENT-ARBITRATION-GRID)
 * Story 8.5 — Extension : état existing-claim + historique + re-download + régénération
 *
 * Route : /admin/sav/:id/demande-fournisseur
 *
 * State machine (8.5) :
 *   - existing-claim   : affiche l'historique par défaut si claims.length > 0
 *   - awaiting-upload  : écran d'import 8.1 (si claims=[] ou après confirm régénération)
 *   - previewing       : après parse réussi
 *   - arbitrating      : grille d'arbitrage 8.3
 *   - generated        : après génération réussie → re-fetch historique → existing-claim
 *
 * PATTERN-DEFAULT-TO-HISTORY-IF-PRESENT posé en 8.5 (AC #5).
 */
import { computed, ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { z } from 'zod'
import { useRoute } from 'vue-router'
import { useSupplierClaimUpload } from '../composables/useSupplierClaimUpload'
import { useSupplierClaimArbitration, formatImporte, type ArbitrageClaimLine } from '../composables/useSupplierClaimArbitration'
import ClientDemandTable from '../components/ClientDemandTable.vue'

const route = useRoute()
const claimRouteName = route.name
const savId = computed(() => Number(route.params['id']))

// ---------------------------------------------------------------------------
// 8.5 — State historique
// ---------------------------------------------------------------------------

const claimItem = z.object({
  id: z.number(), generatedAt: z.string(),
  generatedByOperator: z.object({ id: z.number(), fullName: z.string() }),
  totalImporteCents: z.number(), lineCount: z.number(), filename: z.string(),
  version: z.number(), regenerationOf: z.number().nullable(), isLatest: z.boolean(), hasDocument: z.boolean(),
})
const historyPayload = z.object({ savId: z.number(), claims: z.array(claimItem) })
type SupplierClaimHistoryItem = z.infer<typeof claimItem>
const claimHistory = ref<SupplierClaimHistoryItem[]>([])
const historyError = ref<string | null>(null)

// UI state machine
type ViewState = 'loading' | 'existing-claim' | 'awaiting-upload' | 'previewing' | 'arbitrating' | 'generated'
const viewState = ref<ViewState>('loading')

// Modal de confirmation régénération (DN-4 LOCKED = A)
const showRegenerateModal = ref(false)
const cancelBtnRef = ref<HTMLButtonElement>()
const confirmBtnRef = ref<HTMLButtonElement>()
const regenerateBtn = ref<HTMLButtonElement>()
const uploadTitle = ref<HTMLElement>()
const downloadError = ref('')
let downloadContext = 0

const dossierReference = ref<string>()
const expectedOrder = ref<string | null>()
let historyRequest = 0

async function fetchHistory(prepareIfEmpty = false): Promise<boolean> {
  const request = ++historyRequest
  const id = savId.value
  historyError.value = null
  try {
    const res = await fetch(`/api/sav?op=get-supplier-claim-history&id=${id}`, { credentials: 'include' })
    if (!res.ok) throw new Error()
    const data = historyPayload.parse(await res.json())
    if (request !== historyRequest) return false
    if (data.savId !== id) throw new Error()
    claimHistory.value = data.claims
    if (viewState.value === 'loading') {
      viewState.value = data.claims.length ? 'existing-claim' : 'awaiting-upload'
      if (prepareIfEmpty && !data.claims.length) void prepare()
    }
    return true
  } catch {
    if (request !== historyRequest) return false
    historyError.value = 'Impossible de consulter l’historique des demandes.'
    if (viewState.value === 'loading') viewState.value = 'awaiting-upload'
    return false
  }
}

function retryHistory() {
  viewState.value = 'loading'
  void fetchHistory()
}

function openClaim() {
  if (route.name !== claimRouteName || !Number.isSafeInteger(savId.value)) return
  const navigation = window.history.state
  const fromDetail = navigation?.supplierSavId === savId.value
  const requested = fromDetail && navigation.prepareSupplier === true
  dossierReference.value = fromDetail ? navigation.supplierSavReference : undefined
  expectedOrder.value = fromDetail ? navigation.expectedOrder : undefined
  if (requested) {
    window.history.replaceState({ ...navigation, prepareSupplier: false }, '')
  }
  downloadContext++
  downloadError.value = ''
  claimHistory.value = []
  historyExpanded.value = false
  showRegenerateModal.value = false
  resetArbitrageState()
  viewState.value = 'loading'
  void fetchHistory(requested)
}

// Historique repliable
const historyExpanded = ref(false)

// Latest claim (first in list — ordered DESC)
const latestClaim = computed(() => claimHistory.value[0] ?? null)
// Older claims (all except the first)
const olderClaims = computed(() => claimHistory.value.slice(1))

// ---------------------------------------------------------------------------
// Re-télécharger (PATTERN-DIRECT-BLOB-DOWNLOAD hérité 8.4)
// ---------------------------------------------------------------------------

async function redownloadClaim(claim: SupplierClaimHistoryItem): Promise<void> {
  const attempt = downloadContext
  downloadError.value = ''
  try {
    const res = await fetch(
      `/api/sav?op=download-supplier-claim&id=${savId.value}&claimId=${claim.id}`,
      { credentials: 'include' }
    )
    if (!res.ok) throw new Error()
    const blob = await res.blob()
    if (attempt !== downloadContext) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = claim.filename
    a.click()
    URL.revokeObjectURL(url)
  } catch {
    if (attempt === downloadContext) {
      downloadError.value = `Le téléchargement de la version v${claim.version} a échoué. Vous pouvez réessayer.`
    }
  }
}

// ---------------------------------------------------------------------------
// Modale régénération (DN-4 LOCKED = A)
// ---------------------------------------------------------------------------

function onRegenerateClick(): void {
  showRegenerateModal.value = true
  void nextTick(() => cancelBtnRef.value?.focus())
}

function onModalCancel(): void {
  showRegenerateModal.value = false
  void nextTick(() => regenerateBtn.value?.focus())
  // ZÉRO side-effect : pas de reset, pas de transition, pas de POST (AC #7)
}

function onModalConfirm(): void {
  if (!showRegenerateModal.value) return
  historyError.value = null
  downloadError.value = ''
  downloadContext++
  showRegenerateModal.value = false
  // Transition vers awaiting-upload + reset composable (AC #5, AC #7)
  resetArbitrageState()
  viewState.value = 'awaiting-upload'
  void prepare()
  void nextTick(() => uploadTitle.value?.focus())
}

// Esc = Annuler (DN-4 LOCKED = A)
function onKeydown(event: KeyboardEvent): void {
  if (!showRegenerateModal.value) return
  if (event.key === 'Tab') {
    event.preventDefault()
    const target = document.activeElement === cancelBtnRef.value ? confirmBtnRef : cancelBtnRef
    target.value?.focus()
  } else if (event.key === 'Escape') {
    onModalCancel()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  downloadContext++
  historyRequest++
  window.removeEventListener('keydown', onKeydown)
})

// ---------------------------------------------------------------------------
// Upload composable (8.1)
// ---------------------------------------------------------------------------

const { state, parseResult, errorMessage, handleFileChange, prepare, reset: resetUpload } = useSupplierClaimUpload(savId, expectedOrder)

// Watch upload state to transition
watch(state, (newState) => {
  if (newState === 'uploading' || newState === 'preparing') {
    resetToArbitrating()
    viewState.value = 'awaiting-upload'
  } else if (newState === 'previewing' && viewState.value !== 'arbitrating') {
    viewState.value = 'previewing'
  }
})

// ---------------------------------------------------------------------------
// Arbitrage composable (8.3 + 8.4)
// ---------------------------------------------------------------------------

const {
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
  totalImporte,
  lineImportes,
  canGenerateComputed,
  blockingReasons,
  runReconcile,
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
} = useSupplierClaimArbitration(savId, parseResult)

onMounted(openClaim)
watch(savId, openClaim, { flush: 'sync' })

// Watch reconcileState to transition view
watch(reconcileState, (newState) => {
  if (newState === 'arbitrating') {
    viewState.value = 'arbitrating'
  } else if (newState === 'reconcile-error') {
    // Stay on previewing — error shown inline
  }
})

// Watch generateState — après génération réussie, re-fetch historique → existing-claim (AC #5)
watch(generateState, async (newState) => {
  if (newState === 'generated') {
    viewState.value = 'generated'
    // Re-fetch historique pour basculer en existing-claim avec la nouvelle version
    const id = savId.value
    const refreshed = await fetchHistory()
    if (!refreshed || savId.value !== id || viewState.value !== 'generated') return
    // Si on a des claims après le fetch, transitionner vers existing-claim
    if (claimHistory.value.length > 0) {
      viewState.value = 'existing-claim'
    }
  }
})

// CR fix M1 : AC #5/#7 — reset ALL state (arbitrage composable + upload composable)
// so no stale data (edits, exclusions, comments, parseResult, state) survives into new session.
function resetArbitrageState(): void {
  resetToArbitrating()   // resets arbitrage Maps + generate* + reconcile*
  resetUpload()          // resets upload state/parseResult/errorMessage
}

// Régénérer depuis l'état generated (8.4 fallback — quand l'historique n'est pas disponible)
// CR fix M2 : DN-4 carve out NO exception — doit passer par la modale comme tous les chemins.
// Après confirmation, on reset → awaiting-upload (AC #5/#7), PAS directement vers arbitrating.
function onRegenerateFromGenerated(): void {
  onRegenerateClick()
}

// 8.4 : trigger generate (creditNoteId = null par défaut — DN-2=B)
function onGenerate(): void {
  void generate(null)
}

function onRetryGenerate(): void {
  retryGenerate(null)
}

// Helpers for template
function getQty(lineId: string | number): number {
  return edits.value.get(lineId) ?? 0
}

function getComment(lineId: string | number): string {
  return comments.value.get(lineId) ?? ''
}

function isExcluded(lineId: string | number): boolean {
  return exclusions.value.get(lineId) === true
}

function blockingLineReason(line: ArbitrageClaimLine): string {
  if (line.conversionFlag === 'Unité non reconnue') return line.conversionFlag
  if (line.conversionFlag === 'ATTENTION A CONVERTIR' && line.unidad === 'Kilos' && line.qteFact) {
    return 'Conversion en kilos impossible'
  }
  if (!line.qteFact) return 'Quantité facturée manquante'
  return 'Prix manquant'
}

function getLineImporte(lineId: string | number): number | null {
  // Blocking lines have no importe
  const line = claimLines.value.find((l) => l.savLineId === lineId)
  if (line?.blockingForGeneration) return null
  return lineImportes.value.get(lineId) ?? null
}

function onQtyInput(lineId: string | number, event: Event): void {
  const el = event.target as HTMLInputElement
  // Real-time update for live recalc (FR18)
  const val = parseFloat(el.value)
  if (!isNaN(val)) {
    const newEdits = new Map(edits.value)
    newEdits.set(lineId, val)
    edits.value = newEdits
  }
}

function onQtyBlur(lineId: string | number, cap: number | null, capUnit: string | null | undefined, event: Event): void {
  const el = event.target as HTMLInputElement
  // HIGH-1 (CR fix): pass cap (effectiveCap ?? qteFact) + capUnit to handleQtyBlur
  handleQtyBlur(lineId, el.value, cap ?? 0, capUnit ?? undefined)
  // Sync input element value after clamping
  const clamped = edits.value.get(lineId)
  if (clamped !== undefined) {
    el.value = String(clamped)
  }
}

function onCommentInput(lineId: string | number, event: Event): void {
  const el = event.target as HTMLInputElement | HTMLTextAreaElement
  updateComment(lineId, el.value)
}

// Format date FR
function formatDateFR(isoDate: string): string {
  try {
    return new Intl.DateTimeFormat('fr-FR', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(isoDate))
  } catch {
    return isoDate
  }
}

// Format montant EUR from cents
function formatEUR(cents: number): string {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
  }).format(cents / 100)
}

const oneDriveStatusClass = computed(() => {
  const status = generateResult.value?.onedriveStatus
  if (status === 'success') return 'onedrive-status--success'
  if (status === 'failed') return 'onedrive-status--warning'
  return 'onedrive-status--muted'
})

const oneDriveStatusText = computed(() => {
  const result = generateResult.value
  if (result?.onedriveStatus === 'success') {
    return result.onedriveMessage ?? 'Fichier de suivi fournisseur mis à jour dans OneDrive.'
  }
  if (result?.onedriveStatus === 'failed') {
    return result.onedriveMessage ?? 'Document généré, mais le remplissage OneDrive a échoué.'
  }
  if (result?.onedriveStatus === 'skipped') {
    return result.onedriveMessage ?? 'Remplissage OneDrive non configuré.'
  }
  return null
})
</script>

<template>
  <div class="supplier-claim-view" data-testid="supplier-claim-view" @keydown.esc="onKeydown">
    <nav class="breadcrumb" aria-label="Fil d’Ariane">
      <RouterLink :to="{ name: 'admin-sav-list' }" data-testid="supplier-claim-back-list">
        Liste SAV
      </RouterLink>
      <span aria-hidden="true"> &gt; </span>
      <RouterLink
        :to="{ name: 'admin-sav-detail', params: { id: savId } }"
        data-testid="supplier-claim-back-detail"
      >
        Retour au SAV
      </RouterLink>
      <span aria-hidden="true"> &gt; </span>
      <span aria-current="page">Demande fournisseur</span>
    </nav>

    <h1>Demande de remboursement fournisseur</h1>
    <dl class="order-context" aria-label="Commande associée">
      <div><dt>Dossier</dt><dd>{{ dossierReference || `SAV nº ${savId}` }}</dd></div>
      <div><dt>Fournisseur</dt><dd>SOL Y FRUTA</dd></div>
      <div><dt>Commande attendue</dt><dd>{{ expectedOrder || 'Référence indisponible' }}</dd></div>
    </dl>
    <p v-if="viewState === 'loading'" role="status">Lecture de l’historique en cours…</p>

    <!-- =====================================================================
         Story 8.5 — État "existing-claim" (PATTERN-DEFAULT-TO-HISTORY-IF-PRESENT)
         AC #5 — affiché par défaut quand claims.length > 0
         ===================================================================== -->
    <section
      v-if="viewState === 'existing-claim'"
      class="existing-claim-state card"
      data-testid="existing-claim-state"
    >
      <h2>Réclamation fournisseur SOL Y FRUTA</h2>

      <!-- Carte dernière version -->
      <div v-if="latestClaim" class="latest-claim-card card">
        <p v-if="generateResult && generateResult.filename === latestClaim.filename" role="status">
          Document généré et prêt à télécharger.
        </p>
        <h3>Dernière version (v{{ latestClaim.version }})</h3>
        <div class="claim-metadata-grid">
          <div class="claim-meta-item">
            <span class="meta-label">Date de génération</span>
            <span class="meta-value">{{ formatDateFR(latestClaim.generatedAt) }}</span>
          </div>
          <div class="claim-meta-item">
            <span class="meta-label">Généré par</span>
            <span class="meta-value">{{ latestClaim.generatedByOperator.fullName }}</span>
          </div>
          <div class="claim-meta-item">
            <span class="meta-label">Montant total</span>
            <span class="meta-value">{{ formatEUR(latestClaim.totalImporteCents) }}</span>
          </div>
          <div class="claim-meta-item">
            <span class="meta-label">Lignes</span>
            <span class="meta-value">{{ latestClaim.lineCount }} ligne{{ latestClaim.lineCount > 1 ? 's' : '' }}</span>
          </div>
          <div class="claim-meta-item claim-meta-filename">
            <span class="meta-label">Fichier</span>
            <code class="meta-value filename-mono">{{ latestClaim.filename }}</code>
          </div>
        </div>

        <div class="claim-actions">
          <button
            class="btn-primary"
            data-testid="redownload-btn"
            :aria-label="`Re-télécharger la version v${latestClaim.version}`"
            :disabled="!latestClaim.hasDocument"
            @click="redownloadClaim(latestClaim!)"
          >
            Re-télécharger
          </button>
          <button
            class="btn-secondary"
            ref="regenerateBtn" data-testid="regenerate-btn"
            @click="onRegenerateClick()"
          >
            Régénérer (nouvel import)
          </button>
        </div>

        <div
          v-if="oneDriveStatusText && generateResult?.filename === latestClaim.filename"
          class="onedrive-status"
          :class="oneDriveStatusClass"
          data-testid="onedrive-fill-status"
        >
          <span>{{ oneDriveStatusText }}</span>
          <a
            v-if="generateResult?.onedriveWebUrl"
            :href="generateResult.onedriveWebUrl"
            target="_blank"
            rel="noopener noreferrer"
            data-testid="onedrive-fill-link"
          >
            Ouvrir le fichier OneDrive
          </a>
        </div>
      </div>

      <p v-if="downloadError" role="alert" class="generate-error-toast">{{ downloadError }}</p>

      <!-- Section historique repliable -->
      <div v-if="olderClaims.length > 0" class="history-section">
        <button
          class="history-toggle"
          data-testid="history-toggle"
          :aria-expanded="historyExpanded"
          @click="historyExpanded = !historyExpanded"
        >
          {{ historyExpanded ? '▲' : '▼' }} Historique ({{ olderClaims.length }} version{{ olderClaims.length > 1 ? 's' : '' }} antérieure{{ olderClaims.length > 1 ? 's' : '' }})
        </button>

        <div v-if="historyExpanded" class="history-list">
          <div
            v-for="claim in olderClaims"
            :key="claim.id"
            class="history-item card"
          >
            <div class="history-item-header">
              <strong>v{{ claim.version }}</strong>
              <span class="history-item-date">{{ formatDateFR(claim.generatedAt) }}</span>
              <span class="history-item-operator">{{ claim.generatedByOperator.fullName }}</span>
              <span class="history-item-amount">{{ formatEUR(claim.totalImporteCents) }}</span>
              <span class="history-item-lines">{{ claim.lineCount }} ligne{{ claim.lineCount > 1 ? 's' : '' }}</span>
            </div>
            <code class="filename-mono">{{ claim.filename }}</code>
            <div class="history-item-actions">
              <button
                class="btn-secondary btn-sm"
                data-testid="redownload-btn"
                :aria-label="`Re-télécharger la version v${claim.version}`"
                :disabled="!claim.hasDocument"
                @click="redownloadClaim(claim)"
              >
                Re-télécharger cette version
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- =====================================================================
         Modale de confirmation régénération (DN-4 LOCKED = A)
         [Annuler] focus par défaut, Esc = Annuler, "L'historique précédent est conservé"
         ===================================================================== -->
    <div
      v-if="showRegenerateModal"
      class="modal-overlay"
      data-testid="regenerate-confirm-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      aria-describedby="modal-description"
    >
      <div class="modal-dialog">
        <h2 id="modal-title" class="modal-title">Confirmer la régénération ?</h2>
        <p id="modal-description" class="modal-body">
          L'historique précédent est conservé.
          <span v-if="latestClaim">La version v{{ latestClaim.version }} actuelle restera consultable dans l'historique.</span>
        </p>
        <div class="modal-actions">
          <!-- [Annuler] focus par défaut (DN-4 LOCKED = A) -->
          <button
            ref="cancelBtnRef"
            class="btn-secondary"
            data-testid="regenerate-cancel-btn"
            autofocus
            @click="onModalCancel()"
          >
            Annuler
          </button>
          <button
            class="btn-danger"
            ref="confirmBtnRef" data-testid="regenerate-confirm-btn"
            @click="onModalConfirm()"
          >
            Confirmer
          </button>
        </div>
      </div>
    </div>

    <!-- =====================================================================
         État "awaiting-upload" (8.1) — affiché si pas de claims OU après confirm régénération
         ===================================================================== -->
    <section
      v-if="viewState === 'awaiting-upload' || viewState === 'previewing' || viewState === 'arbitrating' || viewState === 'generated'"
      class="upload-section card"
      data-testid="awaiting-upload-state"
    >
      <h2 ref="uploadTitle" tabindex="-1">Choisir le classeur</h2>
      <p v-if="historyError" role="alert">{{ historyError }}</p>
      <button v-if="historyError && viewState === 'awaiting-upload'" class="btn-secondary" @click="retryHistory">
        Relire l’historique
      </button>
      <button v-if="!historyError && viewState === 'awaiting-upload'" type="button" class="btn-primary"
        :disabled="state === 'preparing' || state === 'uploading'" @click="prepare">
        {{ state === 'error' ? 'Réessayer la préparation' : 'Préparer depuis kDrive' }}
      </button>
      <label for="supplier-workbook" class="manual-label">Importer manuellement le classeur (.xlsx)</label>
      <input
        id="supplier-workbook"
        type="file"
        accept=".xlsx"
        data-testid="file-input"
        :disabled="state === 'uploading'"
        @change="handleFileChange"
      />

      <div v-if="state === 'preparing'" role="status">Lecture du classeur de la commande en cours…</div>
      <div v-if="state === 'uploading'" class="uploading-indicator" aria-live="polite">
        Analyse du fichier en cours…
      </div>
    </section>

    <!-- Toast erreur parse (AC #12d 8.1) -->
    <div
      v-if="state === 'error' && errorMessage"
      role="alert"
      class="parse-error-toast"
      data-testid="parse-error-toast"
    >
      {{ errorMessage }}
    </div>

    <!-- Preview (AC #12c 8.1) — shown in previewing state (may overlap with reconciling) -->
    <section
      v-if="(viewState === 'previewing' || viewState === 'arbitrating') && state === 'previewing' && parseResult"
      class="preview-section card"
      data-testid="preview-panel"
    >
      <h2>Résultat de l'import</h2>

      <!-- Métadonnées commande -->
      <div class="metadata-grid">
        <div class="metadata-item">
          <span class="label">Référence commande</span>
          <span class="value" data-testid="preview-reference">{{
            parseResult.metadata.reference ?? '—'
          }}</span>
        </div>
        <div class="metadata-item">
          <span class="label">N° albarán</span>
          <span class="value" data-testid="preview-albaran">{{
            parseResult.metadata.albaran ?? '—'
          }}</span>
        </div>
        <div class="metadata-item">
          <span class="label">Date livraison</span>
          <span class="value" data-testid="preview-fecha-albaran">{{
            parseResult.metadata.fechaAlbaran ?? '—'
          }}</span>
        </div>
      </div>

      <!-- Avertissements métadonnées -->
      <ul v-if="parseResult.metadata.warnings.length > 0" class="metadata-warnings">
        <li v-for="w in parseResult.metadata.warnings" :key="w">{{ w }}</li>
      </ul>

      <p class="detected-sheets"><strong>Onglets détectés</strong> · {{ parseResult.fileMeta.sheetsDetected.join(', ') }}</p>

      <!-- Compteurs lignes -->
      <div class="counts-row">
        <div class="count-item">
          <span class="count-label">Lignes FACTURE_GROUPE</span>
          <span class="count-value" data-testid="preview-facture-groupe-count">
            {{ parseResult.factureGroupe.rows.length }}
          </span>
        </div>
        <div class="count-item">
          <span class="count-label">Lignes BDD</span>
          <span class="count-value" data-testid="preview-bdd-count">
            {{ parseResult.bdd.rows.length }}
          </span>
        </div>
      </div>

      <!-- Warnings lignes -->
      <div v-if="parseResult.factureGroupe.warnings.length > 0" class="sheet-warnings">
        <strong>Avertissements FACTURE_GROUPE :</strong>
        <ul>
          <li
            v-for="w in parseResult.factureGroupe.warnings"
            :key="`${w.row}-${w.fields.join(',')}`"
          >
            Ligne {{ w.row }} : champs {{ w.fields.join(', ') }} non lisibles
          </li>
        </ul>
      </div>

      <p class="preview-note">
        Lignes ignorées FACTURE_GROUPE : {{ parseResult.factureGroupe.skippedRows }} — Lignes
        ignorées BDD : {{ parseResult.bdd.skippedRows }}
      </p>
      <p class="file-info">
        Fichier : {{ parseResult.fileMeta.filename }} ({{
          (parseResult.fileMeta.sizeBytes / 1024).toFixed(0)
        }}
        Ko) — Parser : {{ parseResult.fileMeta.parser }}
      </p>
    </section>

    <!-- =====================================================================
         Story 8.3 — Grille d'arbitrage
         ===================================================================== -->

    <!-- Reconciling indicator (AC #1) -->
    <div
      v-if="reconcileState === 'reconciling'"
      class="reconciling-indicator"
      data-testid="reconciling-indicator"
      aria-live="polite"
    >
      Pré-remplissage de la réclamation…
    </div>

    <!-- Toast erreur réconciliation (AC #1) -->
    <div
      v-if="reconcileState === 'reconcile-error'"
      role="alert"
      class="reconcile-error-toast"
      data-testid="reconcile-error-toast"
    >
      <p>Pré-remplissage impossible — réessayer ou réimporter le fichier</p>
      <button
        class="retry-btn"
        data-testid="reconcile-retry-btn"
        @click="runReconcile()"
      >
        Réessayer
      </button>
    </div>

    <!-- Grille d'arbitrage (AC #2, état arbitrating) -->
    <section
      v-if="viewState === 'arbitrating' && reconcileState === 'arbitrating'"
      class="arbitrage-section card"
      data-testid="arbitrage-grid"
    >
      <h2>Arbitrer les lignes</h2>

      <!-- Table des lignes appariées -->
      <div class="table-container">
        <table class="arbitrage-table">
          <caption>Lignes rapprochées</caption>
          <thead>
            <tr>
              <th scope="col">Code</th>
              <th scope="col">Produit</th>
              <th scope="col">Origine</th>
              <th scope="col">Quantité</th>
              <th scope="col">Unité</th>
              <th scope="col">Cause</th>
              <th scope="col">Prix</th>
              <th scope="col">Commentaire</th>
              <th scope="col">Montant</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="line in claimLines"
              :key="String(line.savLineId)"
              :data-testid="line.blockingForGeneration ? 'row-blocking' : undefined"
              :class="{
                'row-excluded': isExcluded(line.savLineId),
                'row-blocking': line.blockingForGeneration,
              }"
            >
              <!-- CODIGO (read-only) -->
              <td data-label="Code" :data-testid="`arbitrage-row-${line.savLineId}`">
                {{ line.codigoEs ?? '—' }}
                <div class="product-name-snapshot">{{ line.codeFr }}</div>
                <!-- productNameSnapshot as secondary info (AC #2) -->
                <div v-if="line.productNameSnapshot" class="product-name-snapshot">
                  {{ line.productNameSnapshot }}
                </div>
              </td>
              <!-- PRODUCTO (read-only) -->
              <td data-label="Produit">{{ line.productoEs ?? '—' }}</td>
              <!-- ORIGEN (read-only) -->
              <td data-label="Origine">{{ line.origen ?? '—' }}</td>
              <!-- PESO / Qty (editable AC #3) -->
              <td data-label="Quantité">
                <input
                  type="number"
                  :aria-label="`Quantité · ${line.productoEs ?? line.codeFr}`"
                  :data-testid="`qty-input-${line.savLineId}`"
                  min="0"
                  :max="(line.effectiveCap ?? line.qteFact) !== null ? String(line.effectiveCap ?? line.qteFact) : undefined"
                  step="any"
                  :value="getQty(line.savLineId)"
                  :disabled="isExcluded(line.savLineId)"
                  @input="onQtyInput(line.savLineId, $event)"
                  @blur="onQtyBlur(line.savLineId, line.effectiveCap ?? line.qteFact, line.effectiveCapUnit, $event)"
                />
                <!-- Clamp message (AC #3) -->
                <div
                  v-if="clampMessages.has(line.savLineId)"
                  :data-testid="`clamp-msg-${line.savLineId}`"
                  class="clamp-message"
                  aria-live="polite"
                >
                  {{ clampMessages.get(line.savLineId) }}
                </div>
              </td>
              <!-- ENVASE / unidad (read-only, with conversion badge if needed) -->
              <td data-label="Unité">
                {{ line.unidad }}
                <span
                  v-if="line.conversionFlag !== 'ok'"
                  class="conversion-badge"
                >
                  {{ line.conversionFlag }}
                </span>
              </td>
              <!-- CAUSA (read-only V1) -->
              <td data-label="Cause">{{ line.causaEs ?? '—' }}</td>
              <!-- PRECIO (read-only V1) -->
              <td data-label="Prix">
                <span v-if="line.precio !== null">€ {{ formatImporte(line.precio) }}</span>
                <span v-else>—</span>
              </td>
              <!-- COMENTARIOS (editable AC #5) -->
              <td data-label="Commentaire">
                <input
                  type="text"
                  :aria-label="`Commentaire · ${line.productoEs ?? line.codeFr}`"
                  :data-testid="`comment-input-${line.savLineId}`"
                  :value="getComment(line.savLineId)"
                  maxlength="500"
                  :disabled="isExcluded(line.savLineId)"
                  @input="onCommentInput(line.savLineId, $event)"
                />
              </td>
              <!-- IMPORTE (read-only, recalculated live AC #4) -->
              <td data-label="Montant" :data-testid="`importe-${line.savLineId}`">
                <span v-if="getLineImporte(line.savLineId) !== null">
                  {{ formatImporte(getLineImporte(line.savLineId) as number) }} €
                </span>
                <span v-else>—</span>
              </td>
              <!-- Action Exclure / Réinclure (AC #7) -->
              <td data-label="Action">
                <span v-if="isExcluded(line.savLineId)" class="line-state">Exclue</span>
                <span v-else-if="line.blockingForGeneration" class="line-state">
                  {{ blockingLineReason(line) }}
                </span>
                <button
                  :aria-label="`${isExcluded(line.savLineId) ? 'Réinclure' : 'Exclure'} · ${line.productoEs ?? line.codeFr}`"
                  :data-testid="`exclude-btn-${line.savLineId}`"
                  class="exclude-btn"
                  @click="toggleLineExclusion(line.savLineId)"
                >
                  {{ isExcluded(line.savLineId) ? 'Réinclure' : 'Exclure' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="supplier-total" aria-live="polite">
        Total fournisseur
        <strong data-testid="arbitrage-total">{{ formatImporte(totalImporte) }} €</strong>
      </p>

      <!-- 8.7 (AC #1/#6) — Table « Demande client » (contrôle visuel read-only)
           Rendue APRÈS la table arbitrage, AVANT la section unmatched.
           v-if : masquée si clientDemandLines est vide (AC #6).
           Extrait en sous-composant ClientDemandTable.vue pour testabilité isolée. -->
      <ClientDemandTable
        v-if="clientDemandLines.length > 0"
        :lines="clientDemandLines"
      />

      <!-- Section A — Lignes SAV non appariées (AC #6) -->
      <section
        v-if="unmatchedSavLines.length > 0"
        class="unmatched-section warning-section"
        data-testid="unmatched-sav-lines"
      >
        <h3>Lignes SAV non appariées ({{ unmatchedSavLines.length }})</h3>
        <p class="section-hint">
          Ces lignes doivent être traitées (exclure) avant de pouvoir générer le document.
        </p>
        <ul>
          <li
            v-for="uLine in unmatchedSavLines"
            :key="String(uLine.savLineId)"
            :class="{ 'line-excluded': isExcluded(uLine.savLineId) }"
            class="unmatched-line"
          >
            <span class="code">{{ uLine.productCodeSnapshot ?? '—' }}</span>
            <span class="name">{{ uLine.productNameSnapshot ?? '—' }}</span>
            <span v-if="uLine.tokenExtracted" class="token">(token: {{ uLine.tokenExtracted }})</span>
            <button
              :aria-label="`${isExcluded(uLine.savLineId) ? 'Réinclure' : 'Exclure'} · ${uLine.productNameSnapshot ?? uLine.productCodeSnapshot ?? uLine.savLineId}`"
              :data-testid="`exclude-unmatched-btn-${uLine.savLineId}`"
              class="exclude-btn"
              @click="toggleLineExclusion(uLine.savLineId)"
            >
              {{ isExcluded(uLine.savLineId) ? 'Réinclure' : 'Exclure' }}
            </button>
          </li>
        </ul>
      </section>

      <!-- Section B — Lignes fournisseur non utilisées (AC #6) -->
      <section
        v-if="unusedSupplierLines.length > 0"
        class="unused-section"
        data-testid="unused-supplier-lines"
      >
        <h3>Lignes fournisseur non utilisées ({{ unusedSupplierLines.length }})</h3>
        <p class="section-hint">Informationnel — ces lignes figurent dans le fichier fournisseur mais n'ont pas de correspondance SAV.</p>
        <ul>
          <li
            v-for="uLine in unusedSupplierLines"
            :key="uLine.codeFr"
          >
            {{ uLine.codeFr }} — {{ uLine.codigoEs ?? '—' }} — {{ uLine.descripcionEs ?? '—' }}
          </li>
        </ul>
      </section>

      <!-- Garde-fou génération + bouton Générer (AC #8, DN-6) -->
      <div class="generation-section">
        <!-- Message de blocage (AC #8) -->
        <div
          v-if="!canGenerateComputed"
          role="status"
          id="generation-blocked-reason"
          class="generation-blocked-msg"
          data-testid="generation-blocked-msg"
        >
          Génération bloquée : {{ blockingReasons.join(' ; ') }}
        </div>

        <!-- Toast erreur génération (AC #12) -->
        <div
          v-if="generateState === 'generate-error' && generateError"
          role="alert"
          class="generate-error-toast"
          data-testid="generate-error-toast"
        >
          <p>{{ generateError }}</p>
          <button
            class="retry-btn"
            data-testid="generate-retry-btn"
            @click="onRetryGenerate()"
          >
            Réessayer
          </button>
        </div>

        <!-- Indicateur génération en cours (AC #12) -->
        <div
          v-if="generateState === 'generating'"
          class="generating-indicator"
          data-testid="generating-indicator"
          aria-live="polite"
        >
          Génération en cours…
        </div>

        <!-- Bouton Générer (présent mais potentiellement disabled — AC #8, DN-6) -->
        <!-- Disabled aussi pendant la génération en cours (AC #12) -->
        <button
          v-if="generateState !== 'generated'"
          class="generate-btn"
          data-testid="generate-btn"
          :aria-describedby="!canGenerateComputed ? 'generation-blocked-reason' : undefined"
          :disabled="!canGenerateComputed || generateState === 'generating'"
          :aria-disabled="(!canGenerateComputed || generateState === 'generating') ? 'true' : 'false'"
          @click="onGenerate()"
        >
          <span v-if="generateState === 'generating'">Génération en cours…</span>
          <span v-else>Générer le document</span>
        </button>
      </div>
    </section>

    <!-- =====================================================================
         Story 8.4 — État "generated" (immédiatement après génération)
         Normalement court-circuité par le watch qui bascule vers existing-claim.
         Affiché quand l'historique n'est pas encore disponible ou en erreur.
         ===================================================================== -->
    <section
      v-if="viewState === 'generated' && generateState === 'generated'"
      class="generated-state card"
      data-testid="generated-state"
    >
      <h2>Réclamation générée</h2>

      <!-- Toast success (AC #8) -->
      <div
        role="status"
        class="generate-success-toast"
        data-testid="generate-success-toast"
      >
        Réclamation générée — {{ generateResult?.lineCount }} ligne{{ (generateResult?.lineCount ?? 0) > 1 ? 's' : '' }}
        <span v-if="generateResult?.filename"> · {{ generateResult.filename }}</span>
      </div>

      <div
        v-if="oneDriveStatusText"
        class="onedrive-status"
        :class="oneDriveStatusClass"
        data-testid="onedrive-fill-status"
      >
        <span>{{ oneDriveStatusText }}</span>
        <a
          v-if="generateResult?.onedriveWebUrl"
          :href="generateResult.onedriveWebUrl"
          target="_blank"
          rel="noopener noreferrer"
          data-testid="onedrive-fill-link"
        >
          Ouvrir le fichier OneDrive
        </a>
      </div>

      <!-- Bouton Régénérer — retour arbitrating (8.4 AC #13e — fallback si historique non chargé) -->
      <button
        class="btn-secondary"
        ref="regenerateBtn" data-testid="regenerate-btn"
        style="margin-top: 1rem;"
        @click="onRegenerateFromGenerated()"
      >
        Régénérer
      </button>
    </section>
  </div>
</template>

<style scoped>
.supplier-claim-view {
  max-width: 1200px;
  margin: 0 auto;
  padding: 1.5rem;
}

.breadcrumb {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1rem;
  color: #6b7280;
  font-size: 0.875rem;
}

.breadcrumb a {
  color: #1d4ed8;
}

.card {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 1.5rem;
  margin-bottom: 1.5rem;
}

.hint {
  color: #6b7280;
  margin-bottom: 1rem;
}

.uploading-indicator {
  margin-top: 0.75rem;
  color: #6b7280;
  font-style: italic;
}

.parse-error-toast {
  background: #fef2f2;
  border: 1px solid #fca5a5;
  border-radius: 6px;
  padding: 0.75rem 1rem;
  color: #b91c1c;
  margin-bottom: 1rem;
}

.reconciling-indicator {
  background: #eff6ff;
  border: 1px solid #93c5fd;
  border-radius: 6px;
  padding: 0.75rem 1rem;
  color: #1d4ed8;
  margin-bottom: 1rem;
  font-style: italic;
}

.reconcile-error-toast {
  background: #fef2f2;
  border: 1px solid #fca5a5;
  border-radius: 6px;
  padding: 0.75rem 1rem;
  color: #b91c1c;
  margin-bottom: 1rem;
}

.retry-btn {
  margin-top: 0.5rem;
  background: #b91c1c;
  color: white;
  border: none;
  border-radius: 4px;
  padding: 0.375rem 0.75rem;
  cursor: pointer;
}

.metadata-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1rem;
  margin-bottom: 1rem;
}

.metadata-item {
  display: flex;
  flex-direction: column;
}

.label {
  font-size: 0.75rem;
  color: #6b7280;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.value {
  font-weight: 600;
  font-size: 1rem;
}

.metadata-warnings {
  color: #92400e;
  background: #fffbeb;
  border: 1px solid #fcd34d;
  border-radius: 4px;
  padding: 0.5rem 1rem;
  margin-bottom: 1rem;
}

.counts-row {
  display: flex;
  gap: 2rem;
  margin-bottom: 1rem;
}

.count-item {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.count-label {
  font-size: 0.75rem;
  color: #6b7280;
}

.count-value {
  font-size: 2rem;
  font-weight: 700;
  color: #1f2937;
}

.sheet-warnings {
  color: #92400e;
  font-size: 0.875rem;
  margin-bottom: 0.75rem;
}

.preview-note {
  font-size: 0.875rem;
  color: #6b7280;
}

.preview-note--info {
  font-style: italic;
}

.file-info {
  font-size: 0.75rem;
  color: #9ca3af;
}

.onedrive-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
  margin-top: 1rem;
  border-radius: 6px;
  padding: 0.75rem 1rem;
  font-size: 0.875rem;
}

.onedrive-status a {
  font-weight: 600;
  color: inherit;
  text-decoration: underline;
}

.onedrive-status--success {
  background: #ecfdf5;
  border: 1px solid #86efac;
  color: #166534;
}

.onedrive-status--warning {
  background: #fffbeb;
  border: 1px solid #fcd34d;
  color: #92400e;
}

.onedrive-status--muted {
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  color: #4b5563;
}

/* Arbitrage grid */
.arbitrage-section {
  overflow-x: auto;
}

.table-container {
  overflow-x: auto;
  margin-bottom: 1.5rem;
}

.arbitrage-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}

.arbitrage-table th {
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  padding: 0.5rem 0.75rem;
  text-align: left;
  font-weight: 600;
  white-space: nowrap;
}

.arbitrage-table td {
  border: 1px solid #e5e7eb;
  padding: 0.375rem 0.5rem;
  vertical-align: middle;
}

.arbitrage-table input[type="number"],
.arbitrage-table input[type="text"] {
  width: 100%;
  box-sizing: border-box;
  min-width: 4rem;
  padding: 0.25rem 0.375rem;
  border: 1px solid #d1d5db;
  border-radius: 3px;
  font-size: 0.875rem;
}

.arbitrage-table input:disabled {
  background: #f3f4f6;
  color: #9ca3af;
  cursor: not-allowed;
}

.row-excluded {
  background: #faf7f2;
}

.row-blocking {
  border-left: 3px solid #ef4444;
}

.product-name-snapshot {
  font-size: 0.7rem;
  color: #58606b;
  font-style: italic;
}

.conversion-badge {
  display: inline-block;
  background: #fef3c7;
  color: #92400e;
  border: 1px solid #fcd34d;
  border-radius: 3px;
  font-size: 0.65rem;
  padding: 0.1rem 0.3rem;
  margin-left: 0.25rem;
}

.clamp-message {
  font-size: 0.7rem;
  color: #d97706;
  margin-top: 0.15rem;
}

.arbitrage-table caption {
  text-align: left;
  font-weight: 700;
  font-size: 1.1rem;
  margin-bottom: .75rem;
}
.arbitrage-section h2, .arbitrage-section h3 { color: #392711; }
.line-state { display: block; font-weight: 600; margin-bottom: .25rem; }
.supplier-total {
  padding: 1rem;
  background: #faf7f2;
  border-left: 4px solid var(--main-orange, #e88a23);
  font-weight: 600;
}
.supplier-total strong { display: block; margin-top: .25rem; font-size: 1.5rem; }

/* Sections unmatched / unused */
.unmatched-section {
  margin-bottom: 1rem;
}

.warning-section {
  background: #fffbeb;
  border: 1px solid #fcd34d;
  border-radius: 6px;
  padding: 1rem;
  margin-bottom: 1rem;
}

.unused-section {
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 1rem;
  margin-bottom: 1rem;
}

.section-hint {
  font-size: 0.875rem;
  color: #6b7280;
  margin-bottom: 0.5rem;
}

.unmatched-line {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.375rem 0;
  border-bottom: 1px solid #fde68a;
}

.unmatched-line:last-child {
  border-bottom: none;
}

.line-excluded {
  background: #faf7f2;
  text-decoration: line-through;
}

.code {
  font-family: monospace;
  font-weight: 600;
}

.token {
  font-size: 0.75rem;
  color: #9ca3af;
}

.exclude-btn {
  background: #f3f4f6;
  border: 1px solid #d1d5db;
  border-radius: 3px;
  padding: 0.2rem 0.5rem;
  cursor: pointer;
  font-size: 0.75rem;
  white-space: nowrap;
}

.exclude-btn:hover {
  background: #e5e7eb;
}

/* Generation section */
.generation-section {
  margin-top: 1.5rem;
  padding-top: 1rem;
  border-top: 1px solid #e5e7eb;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  align-items: flex-start;
}

.generation-blocked-msg {
  background: #fef3c7;
  border: 1px solid #f59e0b;
  border-radius: 4px;
  padding: 0.5rem 0.75rem;
  color: #92400e;
  font-size: 0.875rem;
}

.generate-btn {
  background: var(--main-orange, #e88a23);
  color: #30200e;
  border: none;
  border-radius: 6px;
  padding: 0.625rem 1.25rem;
  font-size: 0.9375rem;
  font-weight: 600;
  cursor: pointer;
}

.generate-btn:disabled {
  background: #9ca3af;
  cursor: not-allowed;
}

.generate-btn:not(:disabled):hover {
  background: #ed983a;
}

/* Story 8.5 — existing-claim state */
.existing-claim-state {
  /* inherits .card */
}

.latest-claim-card {
  background: #f0fdf4;
  border-color: #86efac;
  margin-top: 1rem;
}

.claim-metadata-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.claim-meta-filename {
  grid-column: 1 / -1;
}

.claim-meta-item {
  display: flex;
  flex-direction: column;
}

.meta-label {
  font-size: 0.75rem;
  color: #6b7280;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.meta-value {
  font-weight: 600;
}

.filename-mono {
  font-family: monospace;
  font-size: 0.8125rem;
  color: #374151;
  word-break: break-all;
}

.claim-actions {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
}

/* History section */
.history-section {
  margin-top: 1rem;
}

.history-toggle {
  background: none;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  padding: 0.375rem 0.75rem;
  cursor: pointer;
  font-size: 0.875rem;
  color: #374151;
}

.history-toggle:hover {
  background: #f9fafb;
}

.history-list {
  margin-top: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.history-item {
  background: #f9fafb;
  border-color: #e5e7eb;
  padding: 0.75rem 1rem;
}

.history-item-header {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 0.375rem;
}

.history-item-date {
  font-size: 0.875rem;
  color: #6b7280;
}

.history-item-operator {
  font-size: 0.875rem;
  color: #374151;
}

.history-item-amount {
  font-weight: 600;
  color: #059669;
}

.history-item-lines {
  font-size: 0.8125rem;
  color: #58606b;
}

.history-item-actions {
  margin-top: 0.5rem;
}

/* Buttons */
.btn-primary {
  background: #2563eb;
  color: white;
  border: none;
  border-radius: 6px;
  padding: 0.5rem 1rem;
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
}

.btn-primary:hover {
  background: #1d4ed8;
}

.btn-secondary {
  background: #f3f4f6;
  color: #374151;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  padding: 0.5rem 1rem;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
}

.btn-secondary:hover {
  background: #e5e7eb;
}

.btn-danger {
  background: #dc2626;
  color: white;
  border: none;
  border-radius: 6px;
  padding: 0.5rem 1rem;
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
}

.btn-danger:hover {
  background: #b91c1c;
}

.btn-sm {
  padding: 0.25rem 0.625rem;
  font-size: 0.8125rem;
}

/* Modal (DN-4 LOCKED = A) */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-dialog {
  background: white;
  border-radius: 8px;
  padding: 2rem;
  max-width: 480px;
  width: 90%;
  box-sizing: border-box;
  max-height: 90vh;
  overflow: auto;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}

.modal-title {
  margin: 0 0 0.75rem;
  font-size: 1.25rem;
  font-weight: 700;
  color: #111827;
}

.modal-body {
  color: #374151;
  margin-bottom: 1.5rem;
  line-height: 1.6;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
}

/* generated-state */
.generated-state {
  /* inherits .card */
}

.generate-success-toast {
  background: #f0fdf4;
  border: 1px solid #86efac;
  border-radius: 6px;
  padding: 0.75rem 1rem;
  color: #166534;
}

.generate-error-toast {
  background: #fef2f2;
  border: 1px solid #fca5a5;
  border-radius: 6px;
  padding: 0.75rem 1rem;
  color: #b91c1c;
}

.generating-indicator {
  color: #6b7280;
  font-style: italic;
}

.order-context {
  display: flex;
  flex-wrap: wrap;
  gap: .75rem 2.5rem;
  padding: 1rem;
  background: #fff7ec;
  border-left: 4px solid var(--main-orange, #e88a23);
}
.order-context dt { color: #634a31; font-size: .875rem; }
.order-context dd { margin: .25rem 0 0; font-weight: 700; overflow-wrap: anywhere; }
.manual-label { display: block; margin: 1rem 0 .5rem; font-weight: 600; }
.upload-section input { max-width: 100%; }
.upload-section .btn-primary { background: var(--main-orange, #e88a23); color: #30200e; }
.upload-section .btn-primary:hover { background: #ed983a; }
.upload-section .btn-primary:disabled { opacity: .65; cursor: wait; }
.supplier-claim-view :focus-visible { outline: 3px solid #80400b; outline-offset: 3px; }
.supplier-claim-view h1, .upload-section h2, .preview-section h2 { color: #392711; }
.breadcrumb a { color: #79400e; }
.file-info { color: #58606b; }
@media (max-width: 600px) {
  .supplier-claim-view { padding: .75rem; overflow-wrap: anywhere; }
  .upload-section, .preview-section, .arbitrage-section { padding: 1rem; }
  .arbitrage-table, .arbitrage-table tbody { display: block; }
  .arbitrage-table thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .arbitrage-table tbody tr { display: block; border: 1px solid #ded8cf; border-radius: .5rem; margin-bottom: .75rem; }
  .arbitrage-table td { display: flow-root; min-height: 1.4rem; border: 0; border-bottom: 1px solid #eee9e2; padding: .45rem .6rem; }
  .arbitrage-table td:last-child { border-bottom: 0; }
  .arbitrage-table td::before { content: attr(data-label); float: left; width: 38%; font-weight: 600; }
  .arbitrage-table td input { width: 60%; }
  .arbitrage-table .product-name-snapshot { margin-left: 38%; }
  .unmatched-line { flex-wrap: wrap; }
  .exclude-btn { min-height: 2.25rem; }
  .counts-row { flex-wrap: wrap; gap: 1rem; }
}
</style>
