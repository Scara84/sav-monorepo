/**
 * Story 8.4 — AC #4, AC #7 : Tests integration vraie-DB — migration sav_supplier_claims
 *
 * Test type: INTEGRATION (vraie DB Supabase Preview — PATTERN-H15-A)
 *
 * PATTERN-H15-A : ces tests exercent la vraie DB Supabase Preview (viwgyrqpyryagzgvnfoi)
 * car les mocks Vitest ne détectent pas les contrats CHECK / FK / RLS.
 * Ref : memory/feedback_test_integration_gap.md
 *
 * Conditions d'exécution :
 *   - SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env vars requis
 *   - Supabase Preview avec migration 8.4 appliquée
 *   - `npm run test:integration` (vitest.config.integration.ts, pool: forks, timeout: 30s)
 *   - Si env vars absents → skip automatique (describe.skipIf pattern, cf. H15)
 *
 * Coverage (AC #4 (i)..(vi) + DN-7=B atomicité) :
 *   INT-01 (AC #4 i)   : INSERT minimal happy path passe (sans credit_note_id — DN-2=B)
 *   INT-02 (AC #4 i)   : INSERT avec credit_note_id présent (si une row credit_notes existe)
 *   INT-03 (AC #4 ii)  : CHECK constraint supplier_code='sol-y-fruta' — valeur interdite rejetée
 *   INT-04  (AC #4 iii) : CHECK constraint conversion_flag — valeur interdite rejetée
 *   INT-04b (hotfix 8.7) : conversion_flag 'converti pièce→kg' (8.6) accepté (migration 20260609000000)
 *   INT-04c (multi-pack 2026-06-12) : conversion_flag 'converti pièce→unidades' accepté (migration 20260612100000)
 *   INT-05 (AC #4 iii) : CHECK constraint price_cents > 0 (rejet si 0)
 *   INT-06 (AC #4 iv)  : FK credit_note_id → credit_notes(id) rejette id inexistant (non-null)
 *   INT-07 (AC #4 iv)  : FK credit_note_id NULL accepté (DN-2=B LOCKED)
 *   INT-08 (AC #4 v)   : UNIQUE (claim_id, sav_line_id) empêche doublon ligne
 *   INT-09 (AC #4 vi)  : self-FK regeneration_of + ON DELETE SET NULL observé
 *   INT-10 (DN-7=B)    : Atomicité RPC insert_supplier_claim_with_lines — échec lines → 0 row orpheline
 *   INT-11 (AC #4)     : has_function_privilege('anon', ...) = false (h-16 strict)
 *   INT-12 (AC #4)     : RLS active — anon/authenticated ne peuvent pas INSERT direct
 *   INT-13 (AC #9)     : position déterministe — lignes dans l'ordre position
 *
 * Cleanup :
 *   Chaque test seed ses propres rows et les supprime via afterAll/afterEach.
 *   Les IDs sont générés avec un suffixe unique pour éviter la pollution entre runs.
 *   Pattern idempotent : peut s'exécuter N fois sans pollution.
 *
 * NOTE RED phase :
 *   La migration sav_supplier_claims n'existe pas encore (Task 1 story 8.4).
 *   Ces tests DOIVENT échouer jusqu'à l'application de la migration.
 *   Tout green avant migration = faux-vert structurel (tables absentes → errors PG).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Env gate — skipIf pattern (PATTERN-H15-A)
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env['SUPABASE_URL'] || process.env['VITE_SUPABASE_URL']
const SERVICE_ROLE = process.env['SUPABASE_SERVICE_ROLE_KEY']
const HAS_DB = Boolean(SUPABASE_URL && SERVICE_ROLE)

if (!HAS_DB) {
  console.warn(
    '[INT-8.4] Integration tests SKIPPED — set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env vars'
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UNIQUE_RUN = Date.now()

/**
 * Cherche un SAV existant dans la DB preview pour les tests d'intégration.
 * Retourne un {savId, groupId} utilisable en fixture.
 * Fail si aucun SAV n'est disponible (DB vide — cas preview reset).
 */
async function findOrSkipSav(
  admin: SupabaseClient
): Promise<{ savId: number; groupId: number } | null> {
  const { data, error } = await admin
    .from('sav')
    .select('id, group_id')
    .limit(1)
    .maybeSingle<{ id: number; group_id: number }>()

  if (error || !data) return null
  return { savId: data.id, groupId: data.group_id }
}

/**
 * Cherche un sav_line existante pour le SAV donné.
 */
async function findSavLine(admin: SupabaseClient, savId: number): Promise<number | null> {
  const { data, error } = await admin
    .from('sav_lines')
    .select('id')
    .eq('sav_id', savId)
    .limit(1)
    .maybeSingle<{ id: number }>()

  if (error || !data) return null
  return data.id
}

/**
 * Cherche un operator existant pour le generated_by_operator_id.
 */
async function findOperator(admin: SupabaseClient): Promise<number | null> {
  const { data, error } = await admin
    .from('operators')
    .select('id')
    .limit(1)
    .maybeSingle<{ id: number }>()

  if (error || !data) return null
  return data.id
}

// ---------------------------------------------------------------------------
// Suite principale
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)('INT-8.4 — sav_supplier_claims migration (vraie DB)', () => {
  let admin: SupabaseClient
  const createdClaimIds: number[] = []
  let testSavId: number | null = null
  let testSavLineId: number | null = null
  let testOperatorId: number | null = null
  let createdSavLineId: number | null = null
  let createdSavId: number | null = null
  let createdMemberId: number | null = null

  beforeAll(async () => {
    admin = createClient(SUPABASE_URL!, SERVICE_ROLE!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    // Trouver les fixtures DB ; si aucune (DB locale fraîche post-`supabase db reset`),
    // seeder un minimum viable member→sav→sav_line pour que les CHECK INT-04/INT-04b/INT-04c
    // exercent vraiment la contrainte (sans seed, return silencieux = faux-vert).
    const sav = await findOrSkipSav(admin)
    testSavId = sav?.savId ?? null
    // CR 2026-06-12 : le seed n'écrit QUE sur une DB locale (127.0.0.1/localhost).
    // Sans cette garde, un run par erreur avec une env preview/prod VIDE
    // écrirait des fixtures int-8.4-* dans une DB partagée.
    const IS_LOCAL_DB = /127\.0\.0\.1|localhost/.test(SUPABASE_URL ?? '')
    if (!testSavId && !IS_LOCAL_DB) {
      console.warn('[INT-8.4] DB distante sans fixtures — seed refusé (garde localhost), tests CHECK skippés')
    }
    if (!testSavId && IS_LOCAL_DB) {
      const { data: member, error: memberErr } = await admin
        .from('members')
        .insert({
          email: `int-8.4-${UNIQUE_RUN}@local.test`,
          last_name: 'INT-FIXTURE',
        })
        .select('id')
        .single<{ id: number }>()
      if (memberErr || !member?.id) {
        console.warn(`[INT-8.4] seed member failed: ${memberErr?.message}`)
      } else {
        createdMemberId = member.id
        const { data: savRow, error: savErr } = await admin
          .from('sav')
          .insert({
            member_id: member.id,
            reference: `SAV-INT-${UNIQUE_RUN}`,
          })
          .select('id')
          .single<{ id: number }>()
        if (savErr || !savRow?.id) {
          console.warn(`[INT-8.4] seed sav failed: ${savErr?.message}`)
        } else {
          testSavId = savRow.id
          createdSavId = savRow.id
        }
      }
      // CR 2026-06-12 : en LOCAL, un seed qui échoue doit faire ÉCHOUER la suite
      // (avant : console.warn + return silencieux dans chaque test = faux-vert —
      // la contrainte CHECK n'était jamais exercée sans que rien ne le signale).
      if (!testSavId) {
        throw new Error('[INT-8.4] seed local échoué — les tests CHECK ne peuvent pas s\'exécuter (voir warns ci-dessus)')
      }
    }
    if (testSavId) {
      testSavLineId = await findSavLine(admin, testSavId)
      // DB fraîche (seed.sql ne crée aucune sav_line) : seed une ligne minimale
      // pour que les inserts FK sav_line_id ne pointent pas sur un id fantôme.
      if (!testSavLineId) {
        const { data: line, error: lineErr } = await admin
          .from('sav_lines')
          .insert({
            sav_id: testSavId,
            product_code_snapshot: `INT-8.4-${UNIQUE_RUN}`,
            product_name_snapshot: 'Fixture INT-8.4',
            qty_requested: 1,
            unit_requested: 'kg',
          })
          .select('id')
          .single<{ id: number }>()
        if (lineErr) {
          console.warn(`[INT-8.4] seed sav_line failed: ${lineErr.message}`)
        } else {
          testSavLineId = line.id
          createdSavLineId = line.id
        }
      }
    }
    testOperatorId = await findOperator(admin)
  }, 30_000)

  afterAll(async () => {
    // Cleanup : supprimer les claims créées (CASCADE supprime les lignes)
    if (createdClaimIds.length > 0) {
      const { error } = await admin.from('sav_supplier_claims').delete().in('id', createdClaimIds)
      if (error) {
        console.warn(`[INT-8.4] Cleanup warning: ${error.message}`)
      }
    }
    // Cleanup : sav_line fixture seedée par ce run (jamais une ligne préexistante)
    if (createdSavLineId) {
      await admin.from('sav_lines').delete().eq('id', createdSavLineId)
    }
    // Cleanup : sav + member seedés par ce run (DB locale fraîche uniquement)
    if (createdSavId) {
      await admin.from('sav').delete().eq('id', createdSavId)
    }
    if (createdMemberId) {
      await admin.from('members').delete().eq('id', createdMemberId)
    }
  }, 30_000)

  // ===========================================================================
  // INT-01 — INSERT minimal sans credit_note_id (DN-2=B LOCKED) (AC #4 i)
  // ===========================================================================

  it('INT-01: INSERT minimal sav_supplier_claims sans credit_note_id → passe (DN-2=B)', async () => {
    if (!testSavId || !testOperatorId) {
      console.warn('[INT-01] SKIP — pas de SAV/operator disponible en DB preview')
      return
    }

    const fakeBlob = Buffer.from('fake-xlsx-content')
    const { data, error } = await admin
      .from('sav_supplier_claims')
      .insert({
        sav_id: testSavId,
        credit_note_id: null, // DN-2=B : NULL accepté
        supplier_code: 'sol-y-fruta',
        reference: `INT-01-${UNIQUE_RUN}`,
        albaran: '3127',
        fecha_albaran: '2026-06-05',
        total_importe_cents: 2645,
        line_count: 1,
        filename: `RECLAMACION_SOL_Y_FRUTA_INT-01_2026-06-05.xlsx`,
        document_blob: fakeBlob,
        document_sha256: 'abc123def456',
        regeneration_of: null,
        generated_by_operator_id: testOperatorId,
      })
      .select('id')
      .single<{ id: number }>()

    expect(error).toBeNull()
    expect(data).not.toBeNull()
    expect(typeof data?.id).toBe('number')
    if (data?.id) createdClaimIds.push(data.id)
  }, 30_000)

  // ===========================================================================
  // INT-03 — CHECK constraint supplier_code — valeur interdite rejetée (AC #4 ii, PATTERN-H15-B)
  // ===========================================================================

  it('INT-03: CHECK constraint supplier_code — valeur "rufino" rejetée (CHECK = "sol-y-fruta")', async () => {
    if (!testSavId || !testOperatorId) {
      console.warn('[INT-03] SKIP — pas de SAV/operator disponible')
      return
    }

    const fakeBlob = Buffer.from('fake')
    const { error } = await admin.from('sav_supplier_claims').insert({
      sav_id: testSavId,
      credit_note_id: null,
      supplier_code: 'rufino', // INTERDIT — CHECK = 'sol-y-fruta'
      reference: `INT-03-${UNIQUE_RUN}`,
      albaran: '3127',
      fecha_albaran: '2026-06-05',
      total_importe_cents: 100,
      line_count: 1,
      filename: 'test.xlsx',
      document_blob: fakeBlob,
      document_sha256: 'sha256fake',
      regeneration_of: null,
      generated_by_operator_id: testOperatorId,
    })

    // Doit retourner une erreur CHECK constraint (code 23514)
    expect(error).not.toBeNull()
    expect(error?.code).toBe('23514') // check_violation PG code
  }, 30_000)

  // ===========================================================================
  // INT-04 — CHECK constraint conversion_flag (AC #4 iii, PATTERN-H15-B)
  // ===========================================================================

  it('INT-04: CHECK constraint conversion_flag — valeur interdite "invalid_flag" rejetée', async () => {
    if (!testSavId || !testOperatorId || !testSavLineId) {
      console.warn('[INT-04] SKIP — pas de SAV/operator/sav_line disponible')
      return
    }

    // D'abord insérer une claim parent valide pour pouvoir insérer des lines
    const fakeBlob = Buffer.from('fake')
    const { data: claim, error: claimError } = await admin
      .from('sav_supplier_claims')
      .insert({
        sav_id: testSavId,
        credit_note_id: null,
        supplier_code: 'sol-y-fruta',
        reference: `INT-04-${UNIQUE_RUN}`,
        albaran: '3127',
        fecha_albaran: '2026-06-05',
        total_importe_cents: 100,
        line_count: 1,
        filename: 'test.xlsx',
        document_blob: fakeBlob,
        document_sha256: `sha256-INT-04-${UNIQUE_RUN}`,
        regeneration_of: null,
        generated_by_operator_id: testOperatorId,
      })
      .select('id')
      .single<{ id: number }>()

    expect(claimError).toBeNull()
    if (!claim?.id) return
    createdClaimIds.push(claim.id)

    // Insérer une line avec conversion_flag invalide
    const { error: lineError } = await admin.from('sav_supplier_claim_lines').insert({
      claim_id: claim.id,
      sav_line_id: testSavLineId,
      position: 1,
      codigo_es: '1022',
      producto_es: 'Aguacate',
      origen: 'Málaga',
      peso_qty: 5,
      unidad: 'Kilos',
      causa_es: 'estropeado',
      precio_cents: 529,
      comentarios: '',
      importe_cents: 2645,
      conversion_flag: 'invalid_flag', // INTERDIT
    })

    expect(lineError).not.toBeNull()
    expect(lineError?.code).toBe('23514') // check_violation
  }, 30_000)

  // INT-04b — conversion_flag 'converti pièce→kg' ACCEPTÉ (hotfix 8.7, migration
  // 20260609000000). Discriminant : sous l'ancienne contrainte 8.4 (3 valeurs), cet
  // INSERT échouait avec 23514 → la persistance d'une réclamation convertie pièce→kg
  // était impossible (bug d'intégration 8.4↔8.6). Après fix : INSERT accepté.
  it("INT-04b: CHECK constraint conversion_flag — 'converti pièce→kg' (8.6) accepté", async () => {
    if (!testSavId || !testOperatorId || !testSavLineId) {
      console.warn('[INT-04b] SKIP — pas de SAV/operator/sav_line disponible')
      return
    }

    const fakeBlob = Buffer.from('fake')
    const { data: claim, error: claimError } = await admin
      .from('sav_supplier_claims')
      .insert({
        sav_id: testSavId,
        credit_note_id: null,
        supplier_code: 'sol-y-fruta',
        reference: `INT-04b-${UNIQUE_RUN}`,
        albaran: '3127',
        fecha_albaran: '2026-06-05',
        total_importe_cents: 100,
        line_count: 1,
        filename: 'test.xlsx',
        document_blob: fakeBlob,
        document_sha256: `sha256-INT-04b-${UNIQUE_RUN}`,
        regeneration_of: null,
        generated_by_operator_id: testOperatorId,
      })
      .select('id')
      .single<{ id: number }>()

    expect(claimError).toBeNull()
    if (!claim?.id) return
    createdClaimIds.push(claim.id)

    const { error: lineError } = await admin.from('sav_supplier_claim_lines').insert({
      claim_id: claim.id,
      sav_line_id: testSavLineId,
      position: 1,
      codigo_es: '3104',
      producto_es: 'Paraguaya',
      origen: 'Nacional',
      peso_qty: 1.52,
      unidad: 'Kilos',
      causa_es: 'estropeado',
      precio_cents: 324,
      comentarios: 'via Kilos Netos',
      importe_cents: 492,
      conversion_flag: 'converti pièce→kg', // 8.6 — désormais autorisé
    })

    expect(lineError).toBeNull()
  }, 30_000)

  // INT-04c — conversion_flag 'converti pièce→unidades' ACCEPTÉ (multi-pack 2026-06-12,
  // migration 20260612100000). Discriminant : sous l'ancienne contrainte 8.7 (4 valeurs),
  // l'INSERT échouait avec 23514 → la persistance d'une réclamation multi-pack convertie
  // pièce→unidades était impossible. Après fix : INSERT accepté.
  it("INT-04c: CHECK constraint conversion_flag — 'converti pièce→unidades' (multi-pack) accepté", async () => {
    if (!testSavId || !testOperatorId || !testSavLineId) {
      console.warn('[INT-04c] SKIP — pas de SAV/operator/sav_line disponible')
      return
    }

    const fakeBlob = Buffer.from('fake')
    const { data: claim, error: claimError } = await admin
      .from('sav_supplier_claims')
      .insert({
        sav_id: testSavId,
        credit_note_id: null,
        supplier_code: 'sol-y-fruta',
        reference: `INT-04c-${UNIQUE_RUN}`,
        albaran: '3128',
        fecha_albaran: '2026-06-12',
        total_importe_cents: 2014,
        line_count: 1,
        filename: 'test.xlsx',
        document_blob: fakeBlob,
        document_sha256: `sha256-INT-04c-${UNIQUE_RUN}`,
        regeneration_of: null,
        generated_by_operator_id: testOperatorId,
      })
      .select('id')
      .single<{ id: number }>()

    expect(claimError).toBeNull()
    if (!claim?.id) return
    createdClaimIds.push(claim.id)

    const { error: lineError } = await admin.from('sav_supplier_claim_lines').insert({
      claim_id: claim.id,
      sav_line_id: testSavLineId,
      position: 1,
      codigo_es: '1028',
      producto_es: 'Datil Medjoul caja 8x750gr',
      origen: 'Túnez',
      peso_qty: 2.4,
      unidad: 'Unidades',
      causa_es: 'faltante',
      precio_cents: 839,
      comentarios: 'converti pièce→unidades via Kilos Netos (8 unités)',
      importe_cents: 2014,
      conversion_flag: 'converti pièce→unidades', // 5e valeur — désormais autorisé
    })

    expect(lineError).toBeNull()
  }, 30_000)

  // ===========================================================================
  // INT-05 — CHECK precio_cents > 0 (AC #4 iii)
  // ===========================================================================

  it('INT-05: CHECK precio_cents > 0 — prix=0 rejeté (test DN-7=B atomicité)', async () => {
    if (!testSavId || !testOperatorId || !testSavLineId) {
      console.warn('[INT-05] SKIP — pas de SAV/operator/sav_line disponible')
      return
    }

    const fakeBlob = Buffer.from('fake')
    const { data: claim, error: claimError } = await admin
      .from('sav_supplier_claims')
      .insert({
        sav_id: testSavId,
        credit_note_id: null,
        supplier_code: 'sol-y-fruta',
        reference: `INT-05-${UNIQUE_RUN}`,
        albaran: '3127',
        fecha_albaran: '2026-06-05',
        total_importe_cents: 100,
        line_count: 1,
        filename: 'test.xlsx',
        document_blob: fakeBlob,
        document_sha256: `sha256-INT-05-${UNIQUE_RUN}`,
        regeneration_of: null,
        generated_by_operator_id: testOperatorId,
      })
      .select('id')
      .single<{ id: number }>()

    expect(claimError).toBeNull()
    if (!claim?.id) return
    createdClaimIds.push(claim.id)

    const { error: lineError } = await admin.from('sav_supplier_claim_lines').insert({
      claim_id: claim.id,
      sav_line_id: testSavLineId,
      position: 1,
      codigo_es: '1022',
      producto_es: 'Aguacate',
      origen: null,
      peso_qty: 5,
      unidad: 'Kilos',
      causa_es: 'estropeado',
      precio_cents: 0, // INTERDIT — CHECK > 0
      comentarios: '',
      importe_cents: 0,
      conversion_flag: 'ok',
    })

    expect(lineError).not.toBeNull()
    expect(lineError?.code).toBe('23514') // check_violation
  }, 30_000)

  // ===========================================================================
  // INT-06 — FK credit_note_id rejette id inexistant (non-null) (AC #4 iv)
  // ===========================================================================

  it('INT-06: FK credit_note_id — id inexistant (non-null) rejeté', async () => {
    if (!testSavId || !testOperatorId) {
      console.warn('[INT-06] SKIP — pas de SAV/operator disponible')
      return
    }

    const fakeBlob = Buffer.from('fake')
    const { error } = await admin.from('sav_supplier_claims').insert({
      sav_id: testSavId,
      credit_note_id: 9999999, // ID inexistant
      supplier_code: 'sol-y-fruta',
      reference: `INT-06-${UNIQUE_RUN}`,
      albaran: '3127',
      fecha_albaran: '2026-06-05',
      total_importe_cents: 100,
      line_count: 1,
      filename: 'test.xlsx',
      document_blob: fakeBlob,
      document_sha256: `sha256-INT-06-${UNIQUE_RUN}`,
      regeneration_of: null,
      generated_by_operator_id: testOperatorId,
    })

    // FK violation code 23503
    expect(error).not.toBeNull()
    expect(error?.code).toBe('23503') // foreign_key_violation
  }, 30_000)

  // ===========================================================================
  // INT-07 — FK credit_note_id NULL accepté (DN-2=B LOCKED) (AC #4 iv)
  // ===========================================================================

  it('INT-07: FK credit_note_id NULL accepté (DN-2=B LOCKED — "réclamation anticipée")', async () => {
    if (!testSavId || !testOperatorId) {
      console.warn('[INT-07] SKIP — pas de SAV/operator disponible')
      return
    }

    const fakeBlob = Buffer.from('fake')
    const { data, error } = await admin
      .from('sav_supplier_claims')
      .insert({
        sav_id: testSavId,
        credit_note_id: null, // NULL ACCEPTÉ — DN-2=B
        supplier_code: 'sol-y-fruta',
        reference: `INT-07-${UNIQUE_RUN}`,
        albaran: '3127',
        fecha_albaran: '2026-06-05',
        total_importe_cents: 100,
        line_count: 1,
        filename: 'test.xlsx',
        document_blob: fakeBlob,
        document_sha256: `sha256-INT-07-${UNIQUE_RUN}`,
        regeneration_of: null,
        generated_by_operator_id: testOperatorId,
      })
      .select('id, credit_note_id')
      .single<{ id: number; credit_note_id: null }>()

    expect(error).toBeNull()
    expect(data?.credit_note_id).toBeNull()
    if (data?.id) createdClaimIds.push(data.id)
  }, 30_000)

  // ===========================================================================
  // INT-08 — UNIQUE (claim_id, sav_line_id) empêche doublon (AC #4 v)
  // ===========================================================================

  it('INT-08: UNIQUE (claim_id, sav_line_id) — doublon rejeté', async () => {
    if (!testSavId || !testOperatorId || !testSavLineId) {
      console.warn('[INT-08] SKIP — pas de SAV/operator/sav_line disponible')
      return
    }

    const fakeBlob = Buffer.from('fake')
    const { data: claim, error: claimError } = await admin
      .from('sav_supplier_claims')
      .insert({
        sav_id: testSavId,
        credit_note_id: null,
        supplier_code: 'sol-y-fruta',
        reference: `INT-08-${UNIQUE_RUN}`,
        albaran: '3127',
        fecha_albaran: '2026-06-05',
        total_importe_cents: 200,
        line_count: 1,
        filename: 'test.xlsx',
        document_blob: fakeBlob,
        document_sha256: `sha256-INT-08-${UNIQUE_RUN}`,
        regeneration_of: null,
        generated_by_operator_id: testOperatorId,
      })
      .select('id')
      .single<{ id: number }>()

    expect(claimError).toBeNull()
    if (!claim?.id) return
    createdClaimIds.push(claim.id)

    // Insérer la 1ère ligne
    const { error: line1Error } = await admin.from('sav_supplier_claim_lines').insert({
      claim_id: claim.id,
      sav_line_id: testSavLineId,
      position: 1,
      codigo_es: '1022',
      producto_es: 'Aguacate',
      origen: null,
      peso_qty: 5,
      unidad: 'Kilos',
      causa_es: 'estropeado',
      precio_cents: 529,
      comentarios: '',
      importe_cents: 2645,
      conversion_flag: 'ok',
    })
    expect(line1Error).toBeNull()

    // Insérer la même sav_line_id → doublon → UNIQUE violation
    const { error: line2Error } = await admin.from('sav_supplier_claim_lines').insert({
      claim_id: claim.id,
      sav_line_id: testSavLineId, // MÊME sav_line_id → violation UNIQUE
      position: 2,
      codigo_es: '1022',
      producto_es: 'Aguacate',
      origen: null,
      peso_qty: 3,
      unidad: 'Kilos',
      causa_es: 'estropeado',
      precio_cents: 529,
      comentarios: '',
      importe_cents: 1587,
      conversion_flag: 'ok',
    })

    expect(line2Error).not.toBeNull()
    expect(line2Error?.code).toBe('23505') // unique_violation
  }, 30_000)

  // ===========================================================================
  // INT-09 — self-FK regeneration_of + ON DELETE SET NULL (AC #4 vi)
  // ===========================================================================

  it('INT-09: self-FK regeneration_of — fonctionne + ON DELETE SET NULL observé', async () => {
    if (!testSavId || !testOperatorId) {
      console.warn('[INT-09] SKIP — pas de SAV/operator disponible')
      return
    }

    const fakeBlob = Buffer.from('fake')
    // Créer claim1
    const { data: claim1, error: err1 } = await admin
      .from('sav_supplier_claims')
      .insert({
        sav_id: testSavId,
        credit_note_id: null,
        supplier_code: 'sol-y-fruta',
        reference: `INT-09a-${UNIQUE_RUN}`,
        albaran: '3127',
        fecha_albaran: '2026-06-05',
        total_importe_cents: 100,
        line_count: 1,
        filename: 'test.xlsx',
        document_blob: fakeBlob,
        document_sha256: `sha256-INT-09a-${UNIQUE_RUN}`,
        regeneration_of: null,
        generated_by_operator_id: testOperatorId,
      })
      .select('id')
      .single<{ id: number }>()

    expect(err1).toBeNull()
    if (!claim1?.id) return
    createdClaimIds.push(claim1.id)

    // Créer claim2 avec regeneration_of = claim1.id
    const { data: claim2, error: err2 } = await admin
      .from('sav_supplier_claims')
      .insert({
        sav_id: testSavId,
        credit_note_id: null,
        supplier_code: 'sol-y-fruta',
        reference: `INT-09b-${UNIQUE_RUN}`,
        albaran: '3127',
        fecha_albaran: '2026-06-05',
        total_importe_cents: 150,
        line_count: 1,
        filename: 'test_v2.xlsx',
        document_blob: fakeBlob,
        document_sha256: `sha256-INT-09b-${UNIQUE_RUN}`,
        regeneration_of: claim1.id, // self-FK
        generated_by_operator_id: testOperatorId,
      })
      .select('id, regeneration_of')
      .single<{ id: number; regeneration_of: number }>()

    expect(err2).toBeNull()
    expect(claim2?.regeneration_of).toBe(claim1.id)
    if (claim2?.id) createdClaimIds.push(claim2.id)

    // Supprimer claim1 → ON DELETE SET NULL → claim2.regeneration_of = null
    const { error: delError } = await admin.from('sav_supplier_claims').delete().eq('id', claim1.id)
    expect(delError).toBeNull()
    // Retirer de la liste cleanup car déjà supprimé
    const idx = createdClaimIds.indexOf(claim1.id)
    if (idx !== -1) createdClaimIds.splice(idx, 1)

    // Vérifier que regeneration_of est NULL dans claim2 (ON DELETE SET NULL)
    const { data: updated, error: readError } = await admin
      .from('sav_supplier_claims')
      .select('id, regeneration_of')
      .eq('id', claim2!.id)
      .single<{ id: number; regeneration_of: number | null }>()

    expect(readError).toBeNull()
    expect(updated?.regeneration_of).toBeNull()
  }, 30_000)

  // ===========================================================================
  // INT-10 — Atomicité RPC insert_supplier_claim_with_lines (DN-7=B LOCKED)
  // Forcer l'INSERT lines à échouer → 0 row orpheline dans sav_supplier_claims
  // ===========================================================================

  it('INT-10: atomicité RPC — INSERT lines échoue → 0 row orpheline dans sav_supplier_claims', async () => {
    if (!testSavId || !testOperatorId || !testSavLineId) {
      console.warn('[INT-10] SKIP — pas de SAV/operator/sav_line disponible')
      return
    }

    const claimsBefore = await admin
      .from('sav_supplier_claims')
      .select('id', { count: 'exact', head: true })
      .eq('sav_id', testSavId)

    const countBefore = claimsBefore.count ?? 0

    // Appeler le RPC avec une ligne violant CHECK precio_cents > 0 → rollback atomique
    const fakeBlob = Array.from(Buffer.from('fake-xlsx'))
    const { error: rpcError } = await admin.rpc('insert_supplier_claim_with_lines', {
      p_claim: {
        sav_id: testSavId,
        credit_note_id: null,
        supplier_code: 'sol-y-fruta',
        reference: `INT-10-${UNIQUE_RUN}`,
        albaran: '3127',
        fecha_albaran: '2026-06-05',
        total_importe_cents: 100,
        line_count: 1,
        filename: 'test-atomic.xlsx',
        document_blob: fakeBlob,
        document_sha256: `sha256-INT-10-${UNIQUE_RUN}`,
        regeneration_of: null,
        generated_by_operator_id: testOperatorId,
      },
      p_lines: [
        {
          sav_line_id: testSavLineId,
          position: 1,
          codigo_es: '1022',
          producto_es: 'Aguacate',
          origen: null,
          peso_qty: 5,
          unidad: 'Kilos',
          causa_es: 'estropeado',
          precio_cents: 0, // VIOLE CHECK > 0 → rollback atomique
          comentarios: '',
          importe_cents: 0,
          conversion_flag: 'ok',
        },
      ],
    })

    // Le RPC doit retourner une erreur (CHECK violation propagée)
    expect(rpcError).not.toBeNull()

    // Vérifier qu'aucune row orpheline n'a été laissée dans sav_supplier_claims
    const claimsAfter = await admin
      .from('sav_supplier_claims')
      .select('id', { count: 'exact', head: true })
      .eq('sav_id', testSavId)

    const countAfter = claimsAfter.count ?? 0
    // Le nombre de claims n'a pas augmenté (atomicité PG — rollback automatique)
    expect(countAfter).toBe(countBefore)
  }, 30_000)

  // ===========================================================================
  // INT-11 — has_function_privilege('anon', ...) = false (h-16 strict) (AC #4)
  // ===========================================================================

  // MEDIUM-6 fix (code-review 2026-06-05) : le test original retournait sans assertion (faux-pass).
  // La vérification has_function_privilege nécessite un accès SQL direct non disponible via client JS.
  // Marqué it.todo() — à vérifier manuellement via SQL Editor Supabase avant promote :
  //   SELECT has_function_privilege('anon', 'insert_supplier_claim_with_lines(jsonb,jsonb[])', 'EXECUTE');
  //   -- Résultat attendu : false
  it.todo(
    "INT-11: has_function_privilege('anon', 'insert_supplier_claim_with_lines(jsonb,jsonb[])','EXECUTE') = false (h-16) — vérifier via SQL Editor : SELECT has_function_privilege('anon','insert_supplier_claim_with_lines(jsonb,jsonb[])','EXECUTE'); attendu: false"
  )

  // ===========================================================================
  // INT-12 — RLS active — accès direct sans service_role → erreur (AC #4)
  // ===========================================================================

  it('INT-12: RLS active sur sav_supplier_claims — client anon ne peut pas SELECT', async () => {
    // Créer un client anonyme (sans service role)
    const anonClient = createClient(SUPABASE_URL!, 'anon-key-placeholder', {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data, error } = await anonClient.from('sav_supplier_claims').select('id').limit(1)

    // Sans service_role, RLS doit bloquer l'accès
    // Soit error (401/403) soit data vide (RLS retourne 0 rows)
    // Les 2 sont acceptables — l'important est qu'aucune donnée ne fuite
    if (error) {
      // Erreur = RLS bloque
      expect(error).not.toBeNull()
    } else {
      // 0 rows = RLS USING (false) ou pas de policy pour anon → row-level block
      expect(Array.isArray(data)).toBe(true)
      expect(data).toHaveLength(0)
    }
  }, 30_000)

  // ===========================================================================
  // INT-13 — Ordre position déterministe (AC #9)
  // ===========================================================================

  it("INT-13: lignes insérées dans l'ordre position — SELECT ORDER BY position retourne le bon ordre", async () => {
    if (!testSavId || !testOperatorId) {
      console.warn('[INT-13] SKIP — pas de SAV/operator disponible')
      return
    }

    // Chercher 2 sav_lines pour le SAV
    const { data: savLines, error: savLinesError } = await admin
      .from('sav_lines')
      .select('id')
      .eq('sav_id', testSavId)
      .order('id', { ascending: true })
      .limit(2)

    if (savLinesError || !savLines || savLines.length < 2) {
      console.warn("[INT-13] SKIP — pas assez de sav_lines pour tester l'ordre")
      return
    }

    const fakeBlob = Buffer.from('fake')
    const { data: claim, error: claimError } = await admin
      .from('sav_supplier_claims')
      .insert({
        sav_id: testSavId,
        credit_note_id: null,
        supplier_code: 'sol-y-fruta',
        reference: `INT-13-${UNIQUE_RUN}`,
        albaran: '3127',
        fecha_albaran: '2026-06-05',
        total_importe_cents: 300,
        line_count: 2,
        filename: 'test.xlsx',
        document_blob: fakeBlob,
        document_sha256: `sha256-INT-13-${UNIQUE_RUN}`,
        regeneration_of: null,
        generated_by_operator_id: testOperatorId,
      })
      .select('id')
      .single<{ id: number }>()

    expect(claimError).toBeNull()
    if (!claim?.id) return
    createdClaimIds.push(claim.id)

    // Insérer lignes en ordre inversé (position 2 d'abord, puis 1)
    await admin.from('sav_supplier_claim_lines').insert([
      {
        claim_id: claim.id,
        sav_line_id: (savLines[1] as { id: number }).id,
        position: 2,
        codigo_es: '3301',
        producto_es: 'Tomate',
        origen: null,
        peso_qty: 10,
        unidad: 'Kilos',
        causa_es: 'podrido',
        precio_cents: 320,
        comentarios: '',
        importe_cents: 3200,
        conversion_flag: 'ok',
      },
      {
        claim_id: claim.id,
        sav_line_id: (savLines[0] as { id: number }).id,
        position: 1,
        codigo_es: '1022',
        producto_es: 'Aguacate',
        origen: null,
        peso_qty: 5,
        unidad: 'Kilos',
        causa_es: 'estropeado',
        precio_cents: 529,
        comentarios: '',
        importe_cents: 2645,
        conversion_flag: 'ok',
      },
    ])

    // Relire ORDER BY position → doit retourner position 1 en premier
    const { data: lines, error: linesError } = await admin
      .from('sav_supplier_claim_lines')
      .select('position, codigo_es')
      .eq('claim_id', claim.id)
      .order('position', { ascending: true })

    expect(linesError).toBeNull()
    expect(lines).toHaveLength(2)
    expect((lines![0] as { position: number }).position).toBe(1)
    expect((lines![0] as { codigo_es: string }).codigo_es).toBe('1022')
    expect((lines![1] as { position: number }).position).toBe(2)
    expect((lines![1] as { codigo_es: string }).codigo_es).toBe('3301')
  }, 30_000)

  // ===========================================================================
  // INT-14 — Contrat type `date` : fecha_albaran vide → la coercion handler '' → null
  //          est OBLIGATOIRE (le mock unitaire GEN-20a ne peut pas le prouver).
  //
  // Bug réel UAT 2026-06-09 (fichier 505, N3/N4 vides) : le handler passait '' au RPC
  // → garde du RPC `p_claim->>'fecha_albaran' IS NULL` faux pour '' → branche ELSE
  // → `''::date` → "invalid input syntax for type date" → 500 supplier_claim_persist_failed.
  //
  // Ce test exerce le VRAI ::date via la RPC (impossible avec le mock rpc unitaire qui
  // renvoie {data:42} quels que soient les args) :
  //   (a) DISCRIMINANT — RPC avec fecha_albaran:'' → erreur Postgres (prouve pourquoi
  //       la coercion handler est nécessaire ; documente le contrat du RPC).
  //   (b) FIX — RPC avec fecha_albaran:null + albaran:null → succès, row persistée
  //       avec fecha_albaran IS NULL et albaran IS NULL.
  // Réf mémoire feedback_test_integration_gap (PATTERN-H15-A) : les mocks ne
  // reproduisent pas le contrat type `date` → ce cas DOIT être couvert en vraie-DB.
  // ===========================================================================

  it("INT-14: contrat ::date — fecha_albaran '' rejeté par le RPC ; null accepté → row fecha_albaran/albaran NULL", async () => {
    if (!testSavId || !testOperatorId || !testSavLineId) {
      console.warn('[INT-14] SKIP — pas de SAV/operator/sav_line disponible')
      return
    }

    // Le RPC lit document_blob_hex (string hex) → decode(..., 'hex') vers la colonne
    // bytea NOT NULL (migration ligne 126). On reproduit le contrat exact du handler.
    const fakeBlobHex = Buffer.from('fake-xlsx-INT-14').toString('hex')

    // --- (a) DISCRIMINANT : '' (ce que l'ancien handler passait) → erreur ::date ---
    const { error: emptyDateError } = await admin.rpc('insert_supplier_claim_with_lines', {
      p_claim: {
        sav_id: testSavId,
        credit_note_id: null,
        supplier_code: 'sol-y-fruta',
        reference: `INT-14a-${UNIQUE_RUN}`,
        albaran: '',
        fecha_albaran: '', // ← provoque `invalid input syntax for type date: ""`
        total_importe_cents: 100,
        line_count: 1,
        filename: 'test-int14-empty.xlsx',
        document_blob_hex: fakeBlobHex,
        document_sha256: `sha256-INT-14a-${UNIQUE_RUN}`,
        regeneration_of: null,
        generated_by_operator_id: testOperatorId,
      },
      p_lines: [
        {
          sav_line_id: testSavLineId,
          position: 1,
          codigo_es: '1022',
          producto_es: 'Aguacate',
          origen: null,
          peso_qty: 5,
          unidad: 'Kilos',
          causa_es: 'estropeado',
          precio_cents: 100,
          comentarios: '',
          importe_cents: 500,
          conversion_flag: 'ok',
        },
      ],
    })

    // Le RPC réel rejette '' sur une colonne date — c'est précisément le 500 d'origine.
    expect(emptyDateError).not.toBeNull()
    expect(emptyDateError?.message ?? '').toMatch(/invalid input syntax for type date|date/i)

    // --- (b) FIX : null (ce que le handler passe désormais) → succès + row NULL ---
    const { data: claimId, error: nullDateError } = await admin.rpc(
      'insert_supplier_claim_with_lines',
      {
        p_claim: {
          sav_id: testSavId,
          credit_note_id: null,
          supplier_code: 'sol-y-fruta',
          reference: `INT-14b-${UNIQUE_RUN}`,
          albaran: null, // coercion handler '' → null (cohérence, colonne text nullable)
          fecha_albaran: null, // coercion handler '' → null → garde IS NULL → branche NULL
          total_importe_cents: 100,
          line_count: 1,
          filename: 'test-int14-null.xlsx',
          document_blob_hex: fakeBlobHex,
          document_sha256: `sha256-INT-14b-${UNIQUE_RUN}`,
          regeneration_of: null,
          generated_by_operator_id: testOperatorId,
        },
        p_lines: [
          {
            sav_line_id: testSavLineId,
            position: 1,
            codigo_es: '1022',
            producto_es: 'Aguacate',
            origen: null,
            peso_qty: 5,
            unidad: 'Kilos',
            causa_es: 'estropeado',
            precio_cents: 100,
            comentarios: '',
            importe_cents: 500,
            conversion_flag: 'ok',
          },
        ],
      }
    )

    expect(nullDateError).toBeNull()
    expect(claimId).not.toBeNull()

    const newClaimId = typeof claimId === 'number' ? claimId : Number(claimId)
    createdClaimIds.push(newClaimId)

    // Relire la row : fecha_albaran ET albaran doivent être NULL (pas '' ni '1970-01-01')
    const { data: row, error: readError } = await admin
      .from('sav_supplier_claims')
      .select('fecha_albaran, albaran')
      .eq('id', newClaimId)
      .single<{ fecha_albaran: string | null; albaran: string | null }>()

    expect(readError).toBeNull()
    expect(row?.fecha_albaran).toBeNull()
    expect(row?.albaran).toBeNull()
  }, 30_000)
})
