<script setup lang="ts">
/**
 * Story 8.1 — Vue "Demande de remboursement fournisseur" (DN-1=A : route dédiée)
 *
 * Route : /admin/sav/:id/demande-fournisseur
 *
 * Responsabilités :
 *   - Upload du fichier data.xlsx SOL Y FRUTA (composable useSupplierClaimUpload)
 *   - Appel POST /api/sav?op=parse-supplier-file&id=:savId
 *   - Preview minimale : metadata + compteurs lignes + warnings
 *   - Gestion d'erreur (toast) — 0 persistance (PATTERN-PARSE-PREVIEW-NO-PERSIST)
 *
 * Stories suivantes (8.2/8.3/8.4/8.5) construiront sur ce squelette.
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useSupplierClaimUpload } from '../composables/useSupplierClaimUpload'

const route = useRoute()
const savId = computed(() => Number(route.params['id']))

const { state, parseResult, errorMessage, handleFileChange } = useSupplierClaimUpload(savId)
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

    <!-- Toast erreur (AC #12d) -->
    <div
      v-if="state === 'error' && errorMessage"
      role="alert"
      class="parse-error-toast"
      data-testid="parse-error-toast"
    >
      {{ errorMessage }}
    </div>

    <!-- Preview (AC #12c) -->
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

      <p class="preview-note preview-note--info">
        Stories suivantes (8.2/8.3) : réconciliation lignes SAV ↔ fournisseur + arbitrage
        quantités.
      </p>
    </section>
  </div>
</template>

<style scoped>
.supplier-claim-view {
  max-width: 900px;
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
</style>
