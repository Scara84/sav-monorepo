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
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { useSupplierClaimUpload } from '../composables/useSupplierClaimUpload'
import { useSupplierClaimArbitration, formatImporte } from '../composables/useSupplierClaimArbitration'
import ClientDemandTable from '../components/ClientDemandTable.vue'

const route = useRoute()
const savId = computed(() => Number(route.params['id']))

// ---------------------------------------------------------------------------
// 8.5 — State historique
// ---------------------------------------------------------------------------

interface SupplierClaimHistoryItem {
  id: number
  generatedAt: string
  generatedByOperator: { id: number; fullName: string }
  totalImporteCents: number
  lineCount: number
  filename: string
  version: number
  regenerationOf: number | null
  isLatest: boolean
  hasDocument: boolean
}

const claimHistory = ref<SupplierClaimHistoryItem[]>([])
const historyLoading = ref(false)
const historyError = ref<string | null>(null)

// UI state machine
type ViewState = 'loading' | 'existing-claim' | 'awaiting-upload' | 'previewing' | 'arbitrating' | 'generated'
const viewState = ref<ViewState>('loading')

// Modal de confirmation régénération (DN-4 LOCKED = A)
const showRegenerateModal = ref(false)

// Fetch historique depuis l'API
async function fetchHistory(): Promise<void> {
  historyLoading.value = true
  historyError.value = null
  try {
    const res = await fetch(
      `/api/sav?op=get-supplier-claim-history&id=${savId.value}`,
      { credentials: 'include' }
    )
    if (!res.ok) {
      historyError.value = `Erreur ${res.status}`
      // Dégradation propre : erreur → afficher l'écran d'import (historique non disponible)
      if (viewState.value === 'loading') {
        viewState.value = 'awaiting-upload'
      }
      return
    }
    const data = await res.json() as { savId: number; claims: SupplierClaimHistoryItem[] }
    claimHistory.value = data.claims ?? []

    // PATTERN-DEFAULT-TO-HISTORY-IF-PRESENT (AC #5)
    if (claimHistory.value.length > 0 && viewState.value === 'loading') {
      viewState.value = 'existing-claim'
    } else if (viewState.value === 'loading') {
      viewState.value = 'awaiting-upload'
    }
  } catch (_err) {
    historyError.value = 'Erreur réseau'
    if (viewState.value === 'loading') {
      viewState.value = 'awaiting-upload'
    }
  } finally {
    historyLoading.value = false
  }
}

onMounted(() => {
  void fetchHistory()
})

// Historique repliable
const historyExpanded = ref(false)

// Latest claim (first in list — ordered DESC)
const latestClaim = computed(() => claimHistory.value[0] ?? null)
// Older claims (all except the first)
const olderClaims = computed(() => claimHistory.value.slice(1))

// ---------------------------------------------------------------------------
// Re-télécharger (PATTERN-DIRECT-BLOB-DOWNLOAD hérité 8.4)
// ---------------------------------------------------------------------------

async function redownloadClaim(claimId: number, filename: string): Promise<void> {
  try {
    const res = await fetch(
      `/api/sav?op=download-supplier-claim&id=${savId.value}&claimId=${claimId}`,
      { credentials: 'include' }
    )
    if (!res.ok) return
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  } catch (_err) {
    // Silent — user can retry
  }
}

// ---------------------------------------------------------------------------
// Modale régénération (DN-4 LOCKED = A)
// ---------------------------------------------------------------------------

function onRegenerateClick(): void {
  showRegenerateModal.value = true
}

function onModalCancel(): void {
  showRegenerateModal.value = false
  // ZÉRO side-effect : pas de reset, pas de transition, pas de POST (AC #7)
}

function onModalConfirm(): void {
  showRegenerateModal.value = false
  // Transition vers awaiting-upload + reset composable (AC #5, AC #7)
  resetArbitrageState()
  viewState.value = 'awaiting-upload'
}

// Esc = Annuler (DN-4 LOCKED = A)
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && showRegenerateModal.value) {
    onModalCancel()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})

// ---------------------------------------------------------------------------
// Upload composable (8.1)
// ---------------------------------------------------------------------------

const { state, parseResult, errorMessage, handleFileChange, reset: resetUpload } = useSupplierClaimUpload(savId)

// Watch upload state to transition
import { watch } from 'vue'
watch(state, (newState) => {
  if (newState === 'previewing' && viewState.value !== 'arbitrating') {
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
    await fetchHistory()
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
            @click="redownloadClaim(latestClaim!.id, latestClaim!.filename)"
          >
            Re-télécharger
          </button>
          <button
            class="btn-secondary"
            data-testid="regenerate-btn"
            @click="onRegenerateClick()"
          >
            Régénérer (nouvel import)
          </button>
        </div>
      </div>

      <!-- Section historique repliable -->
      <div v-if="olderClaims.length > 0" class="history-section">
        <button
          class="history-toggle"
          data-testid="history-toggle"
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
                @click="redownloadClaim(claim.id, claim.filename)"
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
    >
      <div class="modal-dialog">
        <h2 id="modal-title" class="modal-title">Confirmer la régénération ?</h2>
        <p class="modal-body">
          L'historique précédent est conservé.
          La version v{{ latestClaim?.version }} actuelle restera consultable dans l'historique.
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
            data-testid="regenerate-confirm-btn"
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
      <h2>Importer le fichier SOL Y FRUTA</h2>
      <p class="hint">
        Déposez le fichier <code>data.xlsx</code> de la commande SOL Y FRUTA. Le système lira les
        onglets <strong>FACTURE_GROUPE</strong> et <strong>BDD</strong>.
      </p>

      <input
        type="file"
        accept=".xlsx"
        data-testid="file-input"
        :disabled="state === 'uploading'"
        @change="handleFileChange"
      />

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
      <h2>Arbitrage de la réclamation</h2>

      <!-- Table des lignes appariées -->
      <div class="table-container">
        <table class="arbitrage-table">
          <thead>
            <tr>
              <th>CODIGO</th>
              <th>PRODUCTO</th>
              <th>ORIGEN</th>
              <th>PESO / Qty</th>
              <th>ENVASE</th>
              <th>CAUSA</th>
              <th>PRECIO</th>
              <th>COMENTARIOS</th>
              <th>IMPORTE</th>
              <th>Action</th>
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
              <td :data-testid="`arbitrage-row-${line.savLineId}`">
                {{ line.codigoEs ?? '—' }}
                <!-- productNameSnapshot as secondary info (AC #2) -->
                <div v-if="line.productNameSnapshot" class="product-name-snapshot">
                  {{ line.productNameSnapshot }}
                </div>
              </td>
              <!-- PRODUCTO (read-only) -->
              <td>{{ line.productoEs ?? '—' }}</td>
              <!-- ORIGEN (read-only) -->
              <td>{{ line.origen ?? '—' }}</td>
              <!-- PESO / Qty (editable AC #3) -->
              <td>
                <input
                  type="number"
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
              <td>
                {{ line.unidad }}
                <span
                  v-if="line.conversionFlag !== 'ok'"
                  class="conversion-badge"
                >
                  {{ line.conversionFlag }}
                </span>
              </td>
              <!-- CAUSA (read-only V1) -->
              <td>{{ line.causaEs ?? '—' }}</td>
              <!-- PRECIO (read-only V1) -->
              <td>
                <span v-if="line.precio !== null">€ {{ formatImporte(line.precio) }}</span>
                <span v-else>—</span>
              </td>
              <!-- COMENTARIOS (editable AC #5) -->
              <td>
                <input
                  type="text"
                  :data-testid="`comment-input-${line.savLineId}`"
                  :value="getComment(line.savLineId)"
                  maxlength="500"
                  :disabled="isExcluded(line.savLineId)"
                  @input="onCommentInput(line.savLineId, $event)"
                />
              </td>
              <!-- IMPORTE (read-only, recalculated live AC #4) -->
              <td :data-testid="`importe-${line.savLineId}`">
                <span v-if="getLineImporte(line.savLineId) !== null">
                  {{ formatImporte(getLineImporte(line.savLineId) as number) }}
                </span>
                <span v-else>—</span>
              </td>
              <!-- Action Exclure / Réinclure (AC #7) -->
              <td>
                <button
                  :data-testid="`exclude-btn-${line.savLineId}`"
                  class="exclude-btn"
                  @click="toggleLineExclusion(line.savLineId)"
                >
                  {{ isExcluded(line.savLineId) ? 'Réinclure' : 'Exclure' }}
                </button>
              </td>
            </tr>
          </tbody>
          <!-- Pied de table : total IMPORTE (AC #4) -->
          <tfoot>
            <tr>
              <td colspan="8" class="total-label">TOTAL IMPORTE</td>
              <td
                class="total-value"
                data-testid="arbitrage-total"
              >
                {{ formatImporte(totalImporte) }}
              </td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>

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

      <!-- Bouton Régénérer — retour arbitrating (8.4 AC #13e — fallback si historique non chargé) -->
      <button
        class="btn-secondary"
        data-testid="regenerate-btn"
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
  opacity: 0.5;
}

.row-blocking {
  border-left: 3px solid #ef4444;
}

.product-name-snapshot {
  font-size: 0.7rem;
  color: #9ca3af;
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

.total-label {
  text-align: right;
  font-weight: 600;
  padding-right: 1rem;
}

.total-value {
  font-weight: 700;
  font-size: 1rem;
}

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
  opacity: 0.5;
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
  background: #2563eb;
  color: white;
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
  background: #1d4ed8;
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
  color: #9ca3af;
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
</style>
