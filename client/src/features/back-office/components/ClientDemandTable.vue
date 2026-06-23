<script setup lang="ts">
/**
 * Story 8.7 — AC #1/#6 — ClientDemandTable.vue
 *
 * Table « Demande client » (contrôle visuel read-only).
 * Affiche pour chaque ligne SAV : Code FR, Désignation, Qté demandée, Unité demandée,
 * Qté remboursée client (arbitrée), Unité arbitrée, Motif.
 *
 * Props :
 *   lines: ClientDemandLine[] — projection 1:1 de sav_lines (PATTERN-CLIENT-DEMAND-PROJECTION)
 *
 * Usage dans SupplierClaimView :
 *   <ClientDemandTable :lines="clientDemandLines" />
 *   (le parent conserve le v-if="clientDemandLines.length > 0" — AC #6)
 *
 * AC couvertes : AC #1 (7 colonnes, data-testid, séparée), AC #6 (read-only, structure),
 *               AC #9 (iso-fact Epic 5 — pas d'import exports/*)
 *
 * DN-B : formatImporte (2 décimales fr-FR) — cohérence visuelle table 8.3.
 * OOS-1 : table read-only — 0 input, 0 button.
 * OOS-2 : motif = request_reason brut FR (slug non traduit ES).
 */

import type { ClientDemandLine } from '../composables/useSupplierClaimArbitration'
import { formatImporte } from '../composables/useSupplierClaimArbitration'

defineProps<{
  lines: ClientDemandLine[]
}>()
</script>

<template>
  <!-- Section « Demande client » (AC #1 / AC #6)
       data-testid="client-demand-table" pour testabilité MCP + Vitest (AC #1) -->
  <section
    class="client-demand-section card"
    data-testid="client-demand-table"
  >
    <h3>Demande client</h3>
    <p class="section-hint">
      Ce que l'adhérent a réclamé (qty/unité demandées) vs ce qui est arbitré pour la réclamation fournisseur.
    </p>
    <div class="table-container">
      <table class="arbitrage-table">
        <thead>
          <tr>
            <th>Code (SKU FR)</th>
            <th>Désignation</th>
            <th>Qté demandée</th>
            <th>Unité demandée</th>
            <th>Qté remboursée client (arbitrée)</th>
            <th>Unité arbitrée</th>
            <th>Motif</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="line in lines"
            :key="String(line.savLineId)"
            :data-testid="`client-demand-row-${line.savLineId}`"
          >
            <!-- Code (SKU FR) : product_code_snapshot — AC #1 col 1 -->
            <td>{{ line.codeFr ?? '—' }}</td>
            <!-- Désignation : product_name_snapshot — AC #1 col 2 -->
            <td>{{ line.designationFr ?? '—' }}</td>
            <!-- Qté demandée : qty_requested, formatImporte 2 déc. (DN-B) — AC #1 col 3 -->
            <td>{{ line.qtyRequested !== null ? formatImporte(line.qtyRequested) : '—' }}</td>
            <!-- Unité demandée : unit_requested brut — AC #1 col 4 -->
            <td>{{ line.unitRequested ?? '—' }}</td>
            <!-- Qté remboursée client (arbitrée) : qty_arbitrated — AC #1 col 5 -->
            <td>{{ line.qtyArbitrated !== null ? formatImporte(line.qtyArbitrated) : '—' }}</td>
            <!-- Unité arbitrée : unit_arbitrated brut — AC #1 col 6 -->
            <td>{{ line.unitArbitrated ?? '—' }}</td>
            <!-- Motif : request_reason brut FR (OOS-2 : non traduit ES) — AC #1 col 7 -->
            <td>{{ line.requestReason ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
/* Story 8.7 — aligne le style sur la table d'arbitrage de SupplierClaimView.
   Les styles scoped du parent ne s'appliquent pas aux éléments internes d'un
   composant enfant (seul le root .card hérite) → on réplique ici à l'identique
   pour une cohérence visuelle stricte avec la table du dessus. */
.card {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 1.5rem;
  margin-bottom: 1.5rem;
}

.client-demand-section {
  overflow-x: auto;
}

.table-container {
  overflow-x: auto;
  margin-bottom: 0;
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

.section-hint {
  font-size: 0.875rem;
  color: #6b7280;
  margin-bottom: 0.5rem;
}
</style>
