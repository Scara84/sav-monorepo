/**
 * Story 8.6 — AC #11(a) : Test vraie-DB skipIf (PATTERN-H15-A)
 *
 * Test type: INTEGRATION (vraie DB Supabase Preview — PATTERN-H15-A)
 *
 * PATTERN-H15-A : ces tests exercent la vraie DB Supabase Preview (viwgyrqpyryagzgvnfoi)
 * car les mocks Vitest ne détectent pas les contrats réels de données (AC #11 story 8.6).
 * Ref : memory/feedback_test_integration_gap.md
 *
 * Conditions d'exécution :
 *   - SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env vars requis (DB preview)
 *   - SAV-2026-00002 (sav_id=3) doit exister avec ligne 3115-2K en sav_lines
 *   - `npm run test:integration` (vitest.config.integration.ts, pool: forks, timeout: 30s)
 *   - Si env vars absents → skip automatique (describe.skipIf pattern, cf. H15)
 *
 * Scénario couvert (AC #11) :
 *   INT-8.6-01 : ligne courgette 3115-2K via vraie DB + vrai moteur reconcile → importe=3.38
 *   INT-8.6-02 : vérifier unit_arbitrated réel sur 3115-2K (evidence DN-Q6)
 *   INT-8.6-03 : vérifier unit_arbitrated réel sur 3104-2K (pêche — contre-exemple Q6)
 *
 * NOTE RED phase :
 *   Le fix 8.6 n'est pas encore implémenté.
 *   INT-8.6-01 ÉCHOUE sous le code actuel (importe=1.69 au lieu de 3.38).
 *   INT-8.6-02/03 peuvent passer (lecture seule DB — valeurs réelles pour DN-Q6).
 *
 * Source autoritative : _bmad-output/stories/8-6-fix-conversion-piece-kilo.md AC #11
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { reconcile } from '../../../api/_lib/sav/reconcile-supplier-claim'
import type { ReconcileInput, SavLineInput } from '../../../api/_lib/sav/reconcile-supplier-claim'
import { normalizeCauseKey } from '../../../src/shared/validation/normalize-cause-key'

// ---------------------------------------------------------------------------
// Env gate — skipIf pattern (PATTERN-H15-A)
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env['SUPABASE_URL'] || process.env['VITE_SUPABASE_URL']
const SERVICE_ROLE = process.env['SUPABASE_SERVICE_ROLE_KEY']
const HAS_DB = Boolean(SUPABASE_URL && SERVICE_ROLE)

if (!HAS_DB) {
  console.warn(
    '[INT-8.6] Integration tests SKIPPED — set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env vars'
  )
}

// ---------------------------------------------------------------------------
// SAV-2026-00002 fixture (sav_id=3, commande 505_25S25_30)
// ---------------------------------------------------------------------------

const SAV_ID = 3  // SAV-2026-00002

/**
 * Build un FactureGroupe row pour 3115-2K depuis les données réelles connues
 * (utilisé comme fixture de remplacement si la DB preview n'a pas le fichier parsé)
 */
function buildCourgetteRealFgRow() {
  return {
    codeFr: '3115-2K',
    designationFr: 'COURGETTE VERTE (CAGETTE DE 2KG)',
    prixVenteClientHt: null,
    unite: 'Pièce',
    qteCmd: 1,
    qteFact: 1,
    codigoEs: '3115',
    descripcionEs: 'Calabacín verde (caja 2KG)',
    kilosPiezas: 'Kilos',
    kilosNetos: 2,     // Valeur réelle vérifiée 2026-06-08
    precio: 1.69,      // Valeur réelle vérifiée 2026-06-08
    importe: null,
    cmd: null,
  }
}

// ---------------------------------------------------------------------------
// Helper : charger les sav_lines depuis la vraie DB
// ---------------------------------------------------------------------------

async function loadSavLines(admin: SupabaseClient, savId: number): Promise<SavLineInput[]> {
  const { data, error } = await admin
    .from('sav_lines')
    .select('id, product_code_snapshot, product_name_snapshot, qty_arbitrated, qty_invoiced, unit_arbitrated, request_reason')
    .eq('sav_id', savId)
    .order('position', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true })

  if (error) throw new Error(`sav_lines load error: ${error.message}`)

  return (data ?? []).map((row) => ({
    id: row.id,
    productCodeSnapshot: row.product_code_snapshot,
    productNameSnapshot: row.product_name_snapshot,
    qtyArbitrated: row.qty_arbitrated,
    qtyInvoiced: row.qty_invoiced,
    unitArbitrated: row.unit_arbitrated,
    cause: row.request_reason,
  }))
}

// ---------------------------------------------------------------------------
// Helper : charger motifMap depuis validation_lists
// ---------------------------------------------------------------------------

async function loadMotifMap(admin: SupabaseClient): Promise<Map<string, string | null>> {
  const { data, error } = await admin
    .from('validation_lists')
    .select('value, value_es')
    .eq('list_code', 'sav_cause')
    .eq('is_active', true)

  if (error) throw new Error(`validation_lists load error: ${error.message}`)

  const map = new Map<string, string | null>()
  for (const row of data ?? []) {
    if (typeof row.value === 'string') {
      map.set(normalizeCauseKey(row.value), row.value_es ?? null)
    }
  }
  return map
}

// ===========================================================================
// Tests vraie-DB
// ===========================================================================

describe.skipIf(!HAS_DB)('INT-8.6 — courgette 3115-2K vraie-DB (PATTERN-H15-A)', () => {
  let admin: SupabaseClient

  beforeAll(() => {
    admin = createClient(SUPABASE_URL!, SERVICE_ROLE!, {
      auth: { persistSession: false },
    })
  })

  it(
    'INT-8.6-01: ligne courgette 3115-2K via moteur reconcile → importe=3.38 ' +
    '[RED: donne 1.69 aujourd\'hui — fixe par story 8.6]',
    async () => {
      // Charger les vraies sav_lines depuis la DB preview
      const savLines = await loadSavLines(admin, SAV_ID)

      // Filtrer sur la ligne courgette (3115-2K)
      const courgetteLine = savLines.find((l) =>
        l.productCodeSnapshot?.includes('3115')
      )

      if (!courgetteLine) {
        // Si la ligne n'existe pas encore sur la DB preview, on utilise la fixture connue
        console.warn('[INT-8.6-01] ligne 3115-2K non trouvée dans sav_lines — test avec fixture')
        // On court-circuite avec une fixture réaliste plutôt que de skip
        const motifMap = await loadMotifMap(admin)
        const input: ReconcileInput = {
          savId: SAV_ID,
          savLines: [{
            id: 'fixture-3115',
            productCodeSnapshot: '3115-2K COURGETTE VERTE',
            productNameSnapshot: 'Courgette verte cagette 2kg',
            qtyArbitrated: 1,
            qtyInvoiced: null,
            unitArbitrated: 'PIECE',
            cause: 'manquant',
          }],
          parsed: {
            metadata: { reference: '505_25S25_30', albaran: 1, fechaAlbaran: null, warnings: [] },
            factureGroupe: { rows: [buildCourgetteRealFgRow()], skippedRows: 0, warnings: [] },
            bdd: { rows: [], skippedRows: 0, warnings: [] },
            fileMeta: { filename: '505_25S25_30.xlsx', sizeBytes: 1000, sheetsDetected: [], parser: 'xlsx' },
          },
          motifMap,
        }
        const result = reconcile(input)
        const line = result.claimLines[0]!
        // POST-FIX: 3.38
        expect(line.importe).toBeCloseTo(3.38, 2)  // FAILS TODAY: 1.69
        return
      }

      // Utiliser la vraie ligne + fixture FG (le fichier parsé n'est pas persisté en DB)
      const motifMap = await loadMotifMap(admin)
      const input: ReconcileInput = {
        savId: SAV_ID,
        savLines: [courgetteLine],
        parsed: {
          metadata: { reference: '505_25S25_30', albaran: 1, fechaAlbaran: null, warnings: [] },
          factureGroupe: { rows: [buildCourgetteRealFgRow()], skippedRows: 0, warnings: [] },
          bdd: { rows: [], skippedRows: 0, warnings: [] },
          fileMeta: { filename: '505_25S25_30.xlsx', sizeBytes: 1000, sheetsDetected: [], parser: 'xlsx' },
        },
        motifMap,
      }

      const result = reconcile(input)
      const matched = result.claimLines.find((l) => l.codeFr === '3115-2K')

      expect(matched).toBeDefined()
      // POST-FIX: importe = 2 kg × 1.69 = 3.38 €
      expect(matched!.importe).toBeCloseTo(3.38, 2)  // FAILS TODAY: 1.69

      // qty post-conversion en kg
      expect(matched!.qty).toBeCloseTo(2, 2)  // FAILS TODAY: 1 (pièce non convertie)

      // Pas bloquant (résolue)
      expect(matched!.blockingForGeneration).toBe(false)  // FAILS TODAY: true
    }
  )

  it(
    'INT-8.6-02: evidence DN-Q6 — valeurs réelles unit_arbitrated sur 3115-2K (courgette) ' +
    '[lecture seule — pour graver DN-Q6 dans AC #1]',
    async () => {
      // Ce test est READ-ONLY : il charge les vraies valeurs de unit_arbitrated/unit_invoiced/unit_requested
      // pour permettre au dev de trancher DN-Q6 (AC #1 PRÉ-REQUIS BLOQUANT)
      const { data, error } = await admin
        .from('sav_lines')
        .select('id, product_code_snapshot, unit_arbitrated, unit_invoiced, request_reason')
        .eq('sav_id', SAV_ID)
        .ilike('product_code_snapshot', '3115%')
        .limit(5)

      if (error) {
        console.warn(`[INT-8.6-02] Error reading sav_lines: ${error.message}`)
        return  // skip gracefully si erreur DB
      }

      // Log pour investigation DN-Q6 (visible dans test output)
      console.info('[INT-8.6-02] unit_arbitrated values pour 3115-2K (evidence DN-Q6):', JSON.stringify(data, null, 2))

      // Assertion minimale : la ligne existe ou non (information pour le dev)
      // Si data.length === 0 → ligne pas encore en DB preview → info suffisante
      // Le contenu exact dépend de l'état de la DB au moment du test
      expect(Array.isArray(data)).toBe(true)

      // Documentation de l'evidence pour DN-Q6 :
      // Si unit_arbitrated IS NULL pour une ligne légitime → COALESCE requis (Scénario B)
      // Si unit_arbitrated='PIECE' → unit_arbitrated brut suffisant (Scénario A)
      // Le résultat de ce test DOIT être lu et gravé dans DN-Q6 par le dev (AC #1)
    }
  )

  it(
    'INT-8.6-03: evidence DN-Q6 — valeurs réelles sur 3104-2K (pêche — contre-exemple Q6) ' +
    '[lecture seule — expliquer le flag ATTENTION observé sur ligne kg]',
    async () => {
      // La pêche avait le flag ATTENTION A CONVERTIR en UAT malgré unit_requested=KG
      // Ce test récupère les valeurs réelles pour identifier si c'est dû à unit_arbitrated!=unit_requested
      const { data: linesData, error: linesError } = await admin
        .from('sav_lines')
        .select('id, product_code_snapshot, unit_arbitrated, request_reason, qty_arbitrated')
        .eq('sav_id', SAV_ID)
        .ilike('product_code_snapshot', '3104%')
        .limit(5)

      if (linesError) {
        console.warn(`[INT-8.6-03] Error reading sav_lines 3104-2K: ${linesError.message}`)
        return
      }

      console.info('[INT-8.6-03] Ligne 3104-2K (pêche) — evidence DN-Q6:', JSON.stringify(linesData, null, 2))

      // Même logique que INT-8.6-02 : ce test est read-only pour investigation AC #1
      expect(Array.isArray(linesData)).toBe(true)

      // NOTE AU DEV (AC #1 Task 1.3) :
      //   Si unit_arbitrated = NULL alors que unit_requested = 'KG' →
      //     Le handler lit unit_arbitrated brut → normalizeUnit(null) → 'Unité non reconnue' → ATTENTION A CONVERTIR
      //     C'est LA cause du flag inattendu sur la pêche.
      //     → DN-Q6 Option B recommandée (COALESCE) pour aligner sur les triggers pricing
      //   Si unit_arbitrated = 'KG' → chercher autre cause
    }
  )

  it(
    'INT-8.6-04: sav_supplier_claims = 0 ligne — rien à régénérer (AC #8 Q4) ' +
    '[lecture seule — confirme Q4 (0 claim persisté)]',
    async () => {
      // Vérifier que la DB preview n'a pas de claims persistés (Q4 = aucun claim à régénérer)
      const { count, error } = await admin
        .from('sav_supplier_claims')
        .select('id', { count: 'exact', head: true })
        .eq('sav_id', SAV_ID)

      if (error && error.code === '42P01') {
        // Table n'existe pas encore → 0 claim évident
        console.info('[INT-8.6-04] sav_supplier_claims table not found — 0 claims (as expected)')
        return
      }

      if (error) {
        console.warn(`[INT-8.6-04] Error reading sav_supplier_claims: ${error.message}`)
        return
      }

      // Q4 : 0 claim persisté → rien à régénérer
      expect(count ?? 0).toBe(0)
    }
  )
})
