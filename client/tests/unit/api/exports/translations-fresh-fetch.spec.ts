import { describe, it, expect, beforeEach, vi } from 'vitest'

import {
  buildSupplierExport,
  type ExportRow,
} from '../../../../api/_lib/exports/supplierExportBuilder'
import { rufinoConfig } from '../../../../api/_lib/exports/rufinoConfig'

/**
 * Story 7-3c AC #4 + AC #5 — RED-PHASE régression `loadValidationListTranslations()`
 * fresh-fetch (D-9 dispo immédiate côté exports).
 *
 * Garantie : entre 2 appels successifs à `buildSupplierExport()`, la table
 * `validation_lists` doit être interrogée 2 fois (pas de cache module-level).
 *
 * Rationale (D-9) : si un admin ajoute une nouvelle entrée
 * `validation_lists.value='Périmé', value_es='caducado'`, l'export Rufino
 * suivant doit voir la nouvelle traduction immédiatement, sans redéploiement
 * ni invalidation manuelle. Un cache module-level casserait cette garantie.
 *
 * Stratégie : on espionne le compteur d'appels `from('validation_lists')` du
 * mock Supabase entre 2 invocations. Le test échoue (RED) si une optimisation
 * future cache la map en mémoire entre exports.
 */

function makeRow(overrides: Partial<ExportRow> = {}): ExportRow {
  return {
    id: 1,
    qty_invoiced: 3,
    piece_to_kg_weight_g: 2500,
    unit_price_ht_cents: 1250,
    vat_rate_bp_snapshot: 550,
    credit_coefficient: 1,
    credit_amount_cents: 3125,
    validation_messages: [{ kind: 'cause', text: 'Abîmé' }],
    product: {
      code: 'PECHE-001',
      name_fr: 'Pêche jaune',
      supplier_code: 'RUFINO',
      default_unit: 'kg',
      vat_rate_bp: 550,
    },
    sav: {
      id: 10,
      reference: 'SAV-2026-00042',
      received_at: '2026-01-15T14:30:00Z',
      invoice_ref: 'FAC-001',
      member: {
        id: 100,
        first_name: 'Jean',
        last_name: 'Dupont',
        pennylane_customer_id: 'PN-1',
      },
    },
    ...overrides,
  }
}

interface MockState {
  validationListsCallCount: number
  // Permet d'injecter une nouvelle traduction au 2e appel pour simuler
  // un admin qui ajoute une entrée entre 2 exports.
  translationsByCall: Array<Array<{ list_code: string; value: string; value_es: string | null }>>
}

function makeSupabaseMock(rows: ExportRow[], state: MockState) {
  function savLinesBuilder() {
    const chain: Record<string, unknown> = {
      select: () => chain,
      gte: () => chain,
      lt: () => chain,
      eq: () => chain,
      in: () => chain,
      order: () => chain,
      range: () => Promise.resolve({ data: rows, error: null }),
    }
    return chain
  }
  function validationListsBuilder() {
    state.validationListsCallCount += 1
    const idx = state.validationListsCallCount - 1
    const translations =
      state.translationsByCall[idx] ??
      state.translationsByCall[state.translationsByCall.length - 1]!
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => Promise.resolve({ data: translations, error: null }),
    }
    return chain
  }
  return {
    from: (table: string) => {
      if (table === 'sav_lines') return savLinesBuilder()
      if (table === 'validation_lists') return validationListsBuilder()
      throw new Error(`Unexpected table: ${table}`)
    },
  }
}

describe('Story 7-3c AC #4 — translations fresh-fetch (D-9)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  it('loadValidationListTranslations() est appelé fraîchement à chaque buildSupplierExport (pas de cache module-level)', async () => {
    const state: MockState = {
      validationListsCallCount: 0,
      translationsByCall: [
        // Appel 1 : seul "Abîmé" est traduit en ES.
        [{ list_code: 'sav_cause', value: 'Abîmé', value_es: 'estropeado' }],
        // Appel 2 : un admin a ajouté "Périmé" (D-9 dispo immédiate).
        // Le 2e export DOIT voir la nouvelle traduction.
        [
          { list_code: 'sav_cause', value: 'Abîmé', value_es: 'estropeado' },
          { list_code: 'sav_cause', value: 'Périmé', value_es: 'caducado' },
        ],
      ],
    }
    const client = makeSupabaseMock([makeRow()], state)

    // Premier export
    await buildSupplierExport({
      config: rufinoConfig,
      period_from: new Date('2026-01-01T00:00:00Z'),
      period_to: new Date('2026-01-31T00:00:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
    })
    expect(state.validationListsCallCount).toBe(1)

    // Deuxième export — doit refetch validation_lists (pas de cache stale).
    await buildSupplierExport({
      config: rufinoConfig,
      period_from: new Date('2026-02-01T00:00:00Z'),
      period_to: new Date('2026-02-28T00:00:00Z'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: client as any,
    })
    // RED si un futur cache module-level retient la map entre exports.
    expect(state.validationListsCallCount).toBe(2)
  })
})
