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
