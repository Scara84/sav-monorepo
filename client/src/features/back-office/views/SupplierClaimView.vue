<script setup lang="ts">
/**
 * Story 8.1 — Vue "Demande de remboursement fournisseur" (DN-1=A : route dédiée)
 * Story 8.3 — Extension : grille d'arbitrage (PATTERN-CLIENT-ARBITRATION-GRID)
 *
 * Route : /admin/sav/:id/demande-fournisseur
 *
 * Responsabilités :
 *   - Upload du fichier data.xlsx SOL Y FRUTA (composable useSupplierClaimUpload)
 *   - Appel POST /api/sav?op=parse-supplier-file&id=:savId
 *   - Preview minimale : metadata + compteurs lignes + warnings (8.1)
 *   - Après parse réussi : déclenchement automatique de reconcile-supplier-claim (8.3)
 *   - Grille d'arbitrage : édition qty, commentaires, exclusion lignes, total live (8.3)
 *   - Garde-fou génération FR21 : bouton "Générer" disabled + message inline (8.3)
 *   - Gestion d'erreur (toast) — 0 persistance (PATTERN-PARSE-PREVIEW-NO-PERSIST)
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useSupplierClaimUpload } from '../composables/useSupplierClaimUpload'
import { useSupplierClaimArbitration, formatImporte } from '../composables/useSupplierClaimArbitration'

const route = useRoute()
const savId = computed(() => Number(route.params['id']))

const { state, parseResult, errorMessage, handleFileChange } = useSupplierClaimUpload(savId)

const {
  reconcileState,
  reconcileError,
  claimLines,
  unmatchedSavLines,
  unusedSupplierLines,
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

// 8.4 : trigger generate (creditNoteId = null par défaut — DN-2=B)
function onGenerate(): void {
  void generate(null)
}

function onRetryGenerate(): void {
  retryGenerate(null)
}

function onRegenerateClick(): void {
  resetToArbitrating()
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

function onQtyBlur(lineId: string | number, qteFact: number | null, event: Event): void {
  const el = event.target as HTMLInputElement
  handleQtyBlur(lineId, el.value, qteFact ?? 0)
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
</script>

<template>
  <div class="supplier-claim-view" data-testid="supplier-claim-view">
    <h1>Demande de remboursement fournisseur</h1>

    <!-- Upload zone -->
    <section class="upload-section card">
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
      v-if="state === 'previewing' && parseResult"
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
      v-if="reconcileState === 'arbitrating'"
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
                  :max="line.qteFact !== null ? String(line.qteFact) : undefined"
                  step="any"
                  :value="getQty(line.savLineId)"
                  :disabled="isExcluded(line.savLineId)"
                  @input="onQtyInput(line.savLineId, $event)"
                  @blur="onQtyBlur(line.savLineId, line.qteFact, $event)"
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
         Story 8.4 — État "generated" (AC #12)
         ===================================================================== -->
    <section
      v-if="generateState === 'generated'"
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

      <!-- Bouton Régénérer (retour arbitrating — AC #13e) -->
      <button
        class="regenerate-btn"
        data-testid="regenerate-btn"
        @click="onRegenerateClick()"
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
</style>
