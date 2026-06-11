import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * spec credit-note-force-regenerate-pdf — tests vraie-DB (PATTERN-H15-A).
 *
 * Couvre les 5 garanties non-mockables (trigger PG, GUC, audit, privilèges) :
 *   (a) RPC happy path → 4 totaux mutés + ligne audit_trail action='credit_note_force_regenerated'.
 *   (b) UPDATE SQL direct des 4 totaux hors RPC (sans GUC) → rejeté par le trigger
 *       `trg_credit_notes_prevent_immutable_columns`.
 *   (c) RPC sur SAV non-in_progress (validated/closed/cancelled/received/draft) →
 *       SAV_STATUS_FROZEN, aucune mutation.
 *   (d) Fingerprint divergent (ligne attendue ≠ état courant) → LINES_CHANGED,
 *       aucune mutation.
 *   (e) has_function_privilege('anon', ..., 'EXECUTE') = false — leçon h-16 + CR V1.13.
 *
 * Pré-requis : DB locale ou preview avec la migration 20260611150000_credit_note_force_regenerate.sql
 * appliquée. Skip auto si SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY absents.
 *
 * Isolation : email unique par run, cleanup par sav_id. Les credit_notes et
 * audit_trail liés sont supprimés via CASCADE / cleanup explicite.
 */

const SUPABASE_URL = process.env['SUPABASE_URL'] || process.env['VITE_SUPABASE_URL']
const SERVICE_ROLE = process.env['SUPABASE_SERVICE_ROLE_KEY']
// Clé anon/publishable (locale: sb_publishable_*, preview: VITE_SUPABASE_ANON_KEY
// historique). Sert au cas (e) — vérifie qu'un client sans service_role est
// rejeté par les REVOKE EXECUTE (h-16 + CR V1.13 HIGH-1).
const ANON_KEY =
  process.env['SUPABASE_ANON_KEY'] ||
  process.env['SUPABASE_PUBLISHABLE_KEY'] ||
  process.env['VITE_SUPABASE_PUBLISHABLE_KEY'] ||
  process.env['VITE_SUPABASE_ANON_KEY']
const HAS_DB = Boolean(SUPABASE_URL && SERVICE_ROLE)
const HAS_ANON = Boolean(SUPABASE_URL && ANON_KEY)

if (!HAS_DB) {
  console.warn(
    '[CN-FORCE-INT] Integration tests SKIPPED — set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env vars'
  )
}
if (HAS_DB && !HAS_ANON) {
  console.warn(
    '[CN-FORCE-INT] case (e) anon-execution SKIPPED — set SUPABASE_ANON_KEY or VITE_SUPABASE_PUBLISHABLE_KEY to exercise the REVOKE check via real client'
  )
}

interface SeedResult {
  savId: number
  memberId: number
  operatorId: number
  creditNoteId: number
  lineIds: number[]
  initialCredits: number[]
}

/**
 * Crée un SAV émis avec 2 lignes ok + un avoir factice :
 *   - 1 member, 1 operator, 1 sav status='in_progress' (allowlist).
 *   - 2 sav_lines validation_status='ok' avec credit_amount_cents définis.
 *   - 1 credit_note avec totaux initiaux + pdf_web_url + pdf_onedrive_item_id.
 *
 * Renvoie tous les ids utiles pour assertions + cleanup.
 */
async function seedScenario(admin: SupabaseClient, suffix: string): Promise<SeedResult> {
  // Member
  const memberEmail = `test+${suffix}@cn-force.local`
  const { data: m, error: mErr } = await admin
    .from('members')
    .upsert(
      { email: memberEmail, first_name: 'CNForce', last_name: `Test-${suffix}` },
      { onConflict: 'email' }
    )
    .select('id')
    .single()
  if (mErr || !m) throw new Error(`seed member: ${mErr?.message ?? 'no row'}`)
  const memberId = (m as { id: number }).id

  // Operator (display_name + role mandatory ; pas de `full_name` dans le schéma).
  const opEmail = `op+${suffix}@cn-force.local`
  const { data: o, error: oErr } = await admin
    .from('operators')
    .upsert(
      { email: opEmail, display_name: `Op ${suffix}`, role: 'sav-operator' },
      { onConflict: 'email' }
    )
    .select('id')
    .single()
  if (oErr || !o) throw new Error(`seed operator: ${oErr?.message ?? 'no row'}`)
  const operatorId = (o as { id: number }).id

  // SAV in_progress (reference NOT NULL — on génère un slug unique).
  const reference = `SAV-2026-CN${suffix.slice(-7)}`
  const { data: s, error: sErr } = await admin
    .from('sav')
    .insert({ member_id: memberId, status: 'in_progress', reference, metadata: {} })
    .select('id')
    .single()
  if (sErr || !s) throw new Error(`seed sav: ${sErr?.message ?? 'no row'}`)
  const savId = (s as { id: number }).id

  // 2 sav_lines OK avec credit_amount_cents définis + vat_rate_bp_snapshot.
  const linesPayload = [
    {
      sav_id: savId,
      position: 1,
      line_number: 1,
      product_code_snapshot: `CN-FORCE-${suffix}-1`,
      product_name_snapshot: 'Produit 1',
      qty_requested: 1,
      unit_requested: 'kg',
      qty_invoiced: 1,
      unit_invoiced: 'kg',
      // V1.9-B : sans qty_arbitrated, le trigger compute_sav_line_credit
      // force validation_status='awaiting_arbitration' (et le credit_amount
      // calculé devient NULL). On force l'arbitrage à 1 kg pour conserver
      // un état 'ok' avec credit_amount_cents recalculé par le trigger.
      qty_arbitrated: 1,
      unit_arbitrated: 'kg',
      unit_price_ttc_cents: 1000,
      vat_rate_bp_snapshot: 550,
      credit_coefficient: 1,
      credit_amount_cents: 10000,
      validation_status: 'ok',
    },
    {
      sav_id: savId,
      position: 2,
      line_number: 2,
      product_code_snapshot: `CN-FORCE-${suffix}-2`,
      product_name_snapshot: 'Produit 2',
      qty_requested: 1,
      unit_requested: 'kg',
      qty_invoiced: 1,
      unit_invoiced: 'kg',
      // V1.9-B : sans qty_arbitrated, le trigger compute_sav_line_credit
      // force validation_status='awaiting_arbitration' (et le credit_amount
      // calculé devient NULL). On force l'arbitrage à 1 kg pour conserver
      // un état 'ok' avec credit_amount_cents recalculé par le trigger.
      qty_arbitrated: 1,
      unit_arbitrated: 'kg',
      unit_price_ttc_cents: 500,
      vat_rate_bp_snapshot: 550,
      credit_coefficient: 1,
      credit_amount_cents: 5000,
      validation_status: 'ok',
    },
  ]
  const { data: ls, error: lsErr } = await admin
    .from('sav_lines')
    .insert(linesPayload)
    .select('id, credit_amount_cents')
  if (lsErr || !ls) throw new Error(`seed sav_lines: ${lsErr?.message ?? 'no rows'}`)
  const lineIds = (ls as Array<{ id: number; credit_amount_cents: number }>).map((l) => l.id)
  const initialCredits = (ls as Array<{ id: number; credit_amount_cents: number }>).map(
    (l) => l.credit_amount_cents
  )

  // Credit note avec totaux figés + PDF "old" simulé.
  const { data: cn, error: cnErr } = await admin
    .from('credit_notes')
    .insert({
      number: 999000 + Number(suffix.replace(/\D/g, '').slice(-5) || '0'),
      sav_id: savId,
      member_id: memberId,
      total_ht_cents: 15000,
      discount_cents: 0,
      vat_cents: 825,
      total_ttc_cents: 15825,
      bon_type: 'AVOIR',
      issued_by_operator_id: operatorId,
      pdf_web_url: `https://onedrive.example/old-${suffix}.pdf`,
      pdf_onedrive_item_id: `old-item-${suffix}`,
    })
    .select('id')
    .single()
  if (cnErr || !cn) throw new Error(`seed credit_note: ${cnErr?.message ?? 'no row'}`)
  const creditNoteId = (cn as { id: number }).id

  return { savId, memberId, operatorId, creditNoteId, lineIds, initialCredits }
}

async function cleanupScenario(admin: SupabaseClient, seed: SeedResult): Promise<void> {
  // audit_trail : suppression explicite par entity_id (pas de CASCADE).
  await admin
    .from('audit_trail')
    .delete()
    .eq('entity_type', 'credit_notes')
    .eq('entity_id', seed.creditNoteId)
  // credit_notes → manual (UNIQUE sav_id).
  await admin.from('credit_notes').delete().eq('id', seed.creditNoteId)
  // sav → CASCADE sur sav_lines, sav_files.
  await admin.from('sav').delete().eq('id', seed.savId)
  // member et operator : nettoyage explicite.
  await admin.from('members').delete().eq('id', seed.memberId)
  await admin.from('operators').delete().eq('id', seed.operatorId)
}

describe.skipIf(!HAS_DB)(
  'CN-FORCE-INT — force_regenerate_credit_note RPC + trigger (real DB)',
  () => {
    let admin: SupabaseClient
    const seeds: SeedResult[] = []

    beforeAll(() => {
      admin = createClient(SUPABASE_URL!, SERVICE_ROLE!, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    })

    afterAll(async () => {
      for (const seed of seeds) {
        try {
          await cleanupScenario(admin, seed)
        } catch (e) {
          console.warn(`[CN-FORCE-INT] cleanup warning: ${String(e)}`)
        }
      }
    })

    it('(a) RPC happy path → totaux mutés + ligne audit_trail credit_note_force_regenerated', async () => {
      const suffix = `a${Date.now()}`
      const seed = await seedScenario(admin, suffix)
      seeds.push(seed)

      const { data: rpcData, error: rpcError } = await admin.rpc(
        'force_regenerate_credit_note',
        {
          p_credit_note_id: seed.creditNoteId,
          p_expected_lines: seed.lineIds.map((id, i) => ({
            id,
            credit_amount_cents: seed.initialCredits[i],
            // Le seed plante les lignes avec vat_rate_bp_snapshot=550. Le
            // fingerprint compare ce champ NULL-safe — on doit le matcher.
            vat_rate_bp_snapshot: 550,
          })),
          p_new_totals: {
            total_ht_cents: 12345,
            discount_cents: 0,
            vat_cents: 679,
            total_ttc_cents: 13024,
          },
          p_actor_operator_id: seed.operatorId,
        }
      )

      expect(rpcError).toBeNull()
      expect(rpcData).not.toBeNull()
      const result = rpcData as {
        old_total_ht_cents: number
        old_total_ttc_cents: number
        old_pdf_onedrive_item_id: string | null
      }
      expect(result.old_total_ht_cents).toBe(15000)
      expect(result.old_total_ttc_cents).toBe(15825)
      expect(result.old_pdf_onedrive_item_id).toBe(`old-item-${suffix}`)

      // Vérif post-RPC : totaux mutés, pdf_web_url et pdf_onedrive_item_id NULL.
      const { data: after, error: afterErr } = await admin
        .from('credit_notes')
        .select('total_ht_cents, vat_cents, total_ttc_cents, pdf_web_url, pdf_onedrive_item_id')
        .eq('id', seed.creditNoteId)
        .single()
      expect(afterErr).toBeNull()
      const a = after as {
        total_ht_cents: number
        vat_cents: number
        total_ttc_cents: number
        pdf_web_url: string | null
        pdf_onedrive_item_id: string | null
      }
      expect(a.total_ht_cents).toBe(12345)
      expect(a.vat_cents).toBe(679)
      expect(a.total_ttc_cents).toBe(13024)
      expect(a.pdf_web_url).toBeNull()
      expect(a.pdf_onedrive_item_id).toBeNull()

      // Audit présent.
      const { data: audit, error: auditErr } = await admin
        .from('audit_trail')
        .select('action, actor_operator_id, diff')
        .eq('entity_type', 'credit_notes')
        .eq('entity_id', seed.creditNoteId)
        .eq('action', 'credit_note_force_regenerated')
      expect(auditErr).toBeNull()
      expect((audit ?? []).length).toBeGreaterThan(0)
      const auditRow = (audit as Array<{
        action: string
        actor_operator_id: number
        diff: { before: Record<string, unknown>; after: Record<string, unknown> }
      }>)[0]
      expect(auditRow.actor_operator_id).toBe(seed.operatorId)
      expect(auditRow.diff.before).toMatchObject({
        total_ht_cents: 15000,
        total_ttc_cents: 15825,
      })
      expect(auditRow.diff.after).toMatchObject({
        total_ht_cents: 12345,
        total_ttc_cents: 13024,
      })
    }, 30_000)

    it('(b) UPDATE SQL direct des 4 totaux (sans GUC) → rejeté par le trigger', async () => {
      const suffix = `b${Date.now()}`
      const seed = await seedScenario(admin, suffix)
      seeds.push(seed)

      // Tentative UPDATE direct : doit échouer avec CREDIT_NOTE_IMMUTABLE.
      const { error: updateErr } = await admin
        .from('credit_notes')
        .update({ total_ht_cents: 99999 })
        .eq('id', seed.creditNoteId)

      expect(updateErr).not.toBeNull()
      const pgErr = updateErr as { code?: string; message?: string }
      // P0001 = RAISE EXCEPTION custom (trigger).
      expect(pgErr.code).toBe('P0001')
      expect(pgErr.message ?? '').toContain('CREDIT_NOTE_IMMUTABLE')
      expect(pgErr.message ?? '').toContain('total_ht_cents')

      // Confirme : la valeur n'a pas bougé.
      const { data: row } = await admin
        .from('credit_notes')
        .select('total_ht_cents')
        .eq('id', seed.creditNoteId)
        .single()
      expect((row as { total_ht_cents: number }).total_ht_cents).toBe(15000)
    }, 30_000)

    it('(c) RPC sur SAV non-in_progress → SAV_STATUS_FROZEN, aucune mutation', async () => {
      const suffix = `c${Date.now()}`
      const seed = await seedScenario(admin, suffix)
      seeds.push(seed)

      // Bascule le SAV en validated.
      const { error: updErr } = await admin
        .from('sav')
        .update({ status: 'validated' })
        .eq('id', seed.savId)
      expect(updErr).toBeNull()

      const { error: rpcError } = await admin.rpc('force_regenerate_credit_note', {
        p_credit_note_id: seed.creditNoteId,
        p_expected_lines: seed.lineIds.map((id, i) => ({
          id,
          credit_amount_cents: seed.initialCredits[i],
          vat_rate_bp_snapshot: 550,
        })),
        p_new_totals: {
          total_ht_cents: 11111,
          discount_cents: 0,
          vat_cents: 611,
          total_ttc_cents: 11722,
        },
        p_actor_operator_id: seed.operatorId,
      })

      expect(rpcError).not.toBeNull()
      const pgErr = rpcError as { code?: string; message?: string }
      expect(pgErr.message ?? '').toContain('SAV_STATUS_FROZEN')
      expect(pgErr.message ?? '').toContain('status=validated')

      // Aucune mutation.
      const { data: row } = await admin
        .from('credit_notes')
        .select('total_ht_cents, pdf_web_url')
        .eq('id', seed.creditNoteId)
        .single()
      const r = row as { total_ht_cents: number; pdf_web_url: string | null }
      expect(r.total_ht_cents).toBe(15000)
      expect(r.pdf_web_url).toBe(`https://onedrive.example/old-${suffix}.pdf`)
    }, 30_000)

    it('(d) Fingerprint divergent → LINES_CHANGED, aucune mutation', async () => {
      const suffix = `d${Date.now()}`
      const seed = await seedScenario(admin, suffix)
      seeds.push(seed)

      // Fingerprint MAUVAIS : on déclare des credit_amount_cents qui ne matchent
      // PAS l'état courant.
      const { error: rpcError } = await admin.rpc('force_regenerate_credit_note', {
        p_credit_note_id: seed.creditNoteId,
        p_expected_lines: seed.lineIds.map((id) => ({
          id,
          credit_amount_cents: 99999, // divergence
        })),
        p_new_totals: {
          total_ht_cents: 11111,
          discount_cents: 0,
          vat_cents: 611,
          total_ttc_cents: 11722,
        },
        p_actor_operator_id: seed.operatorId,
      })

      expect(rpcError).not.toBeNull()
      const pgErr = rpcError as { message?: string }
      expect(pgErr.message ?? '').toContain('LINES_CHANGED')

      // Aucune mutation.
      const { data: row } = await admin
        .from('credit_notes')
        .select('total_ht_cents, pdf_web_url')
        .eq('id', seed.creditNoteId)
        .single()
      const r = row as { total_ht_cents: number; pdf_web_url: string | null }
      expect(r.total_ht_cents).toBe(15000)
      expect(r.pdf_web_url).toBe(`https://onedrive.example/old-${suffix}.pdf`)
    }, 30_000)

    it.skipIf(!HAS_ANON)(
      "(e) appel RPC via client anon → erreur 401/403/404 (REVOKE EXECUTE FROM anon)",
      async () => {
        // Leçon h-16 + CR V1.13 HIGH-1 : Supabase default privileges re-grantent
        // anon/authenticated sur CREATE — REVOKE FROM PUBLIC seul est insuffisant.
        // On exerce le chemin réel : créer un client avec la clé anon/publishable
        // et tenter d'appeler la RPC. Doit échouer (permission denied ou not
        // found PostgREST). Si HAS_ANON est false → skip explicite (visible),
        // jamais un pass à vide.
        const anonClient = createClient(SUPABASE_URL!, ANON_KEY!, {
          auth: { persistSession: false, autoRefreshToken: false },
        })

        const { data, error } = await anonClient.rpc('force_regenerate_credit_note', {
          p_credit_note_id: 1,
          p_expected_lines: [],
          p_new_totals: {
            total_ht_cents: 0,
            discount_cents: 0,
            vat_cents: 0,
            total_ttc_cents: 0,
          },
          p_actor_operator_id: 1,
        })

        // Le client anon DOIT être rejeté. PostgREST renvoie typiquement 404
        // (function not found in exposed API) ou 401/403 (permission denied).
        expect(error).not.toBeNull()
        expect(data).toBeNull()
        const pgErr = error as { code?: string; status?: number; message?: string }
        // 42501 = permission denied (PG), PGRST202 = function not found in
        // schema cache (PostgREST). On accepte les deux sémantiques.
        const code = pgErr.code ?? ''
        const status = pgErr.status ?? 0
        const isPermissionDenied = code === '42501' || status === 401 || status === 403
        const isNotFound = code === 'PGRST202' || status === 404
        expect(isPermissionDenied || isNotFound).toBe(true)
      },
      30_000
    )
  }
)
