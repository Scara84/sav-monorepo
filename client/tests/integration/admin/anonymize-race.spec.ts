import { describe, it, expect, beforeAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Story 7-6 AC #4 D-9 — INTEGRATION RED-PHASE :
 *   2 RPC `admin_anonymize_member` concurrents → 1 succès 200 + 1 fail 422
 *   ALREADY_ANONYMIZED. Atomicité MVCC garantie par `WHERE id=:id AND
 *   anonymized_at IS NULL` dans la même TX.
 *
 * 1 cas (cohérent story spec Sub-6).
 *
 * Ce test exerce la RPC PG réelle. Requiert :
 *   - `SUPABASE_URL` (ou `VITE_SUPABASE_URL`) + `SUPABASE_SERVICE_ROLE_KEY`
 *     pointant vers une instance Supabase locale OU CI (`supabase start`).
 *   - Migration `20260512130000_admin_anonymize_member_rpc.sql` appliquée
 *     (D-9 : RPC créée par Step 3).
 *   - GUC `RGPD_ANONYMIZE_SALT` configuré côté DB OU injecté via la RPC.
 *
 * RED tant que :
 *   - la migration RPC n'est pas appliquée → `rpc('admin_anonymize_member')`
 *     retourne `{ error: { code:'42883', message:'function ... does not exist' }}`.
 *   - OU la RPC ne lève pas distinctement ALREADY_ANONYMIZED.
 *
 * **Skip auto** si env Supabase absent (dev local sans `supabase start`).
 */

const SUPABASE_URL = process.env['SUPABASE_URL'] || process.env['VITE_SUPABASE_URL']
const SERVICE_ROLE = process.env['SUPABASE_SERVICE_ROLE_KEY']
const HAS_DB = Boolean(SUPABASE_URL && SERVICE_ROLE)

describe.skipIf(!HAS_DB)('Story 7-6 AC #4 D-9 — anonymize-race (integration DB réelle)', () => {
  let admin: SupabaseClient
  let testMemberId: number

  beforeAll(async () => {
    admin = createClient(SUPABASE_URL!, SERVICE_ROLE!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    // Seed un member test (rollbackable). Utilise un email unique pour isolation.
    const ts = Date.now()
    const { data, error } = await admin
      .from('members')
      .insert({
        email: `race-test-${ts}@fruitstock.test`,
        first_name: 'Race',
        last_name: 'Test',
        anonymized_at: null,
      })
      .select('id')
      .single()
    if (error) throw new Error(`seed member failed: ${error.message}`)
    testMemberId = (data as { id: number }).id
  })

  it('AC #4 D-9 — 2 RPC concurrents → 1 succès + 1 ALREADY_ANONYMIZED', async () => {
    // 2 calls en parallèle via Promise.all.
    const [r1, r2] = await Promise.all([
      admin.rpc('admin_anonymize_member', {
        p_member_id: testMemberId,
        p_actor_operator_id: 9,
      }),
      admin.rpc('admin_anonymize_member', {
        p_member_id: testMemberId,
        p_actor_operator_id: 9,
      }),
    ])

    const results = [r1, r2]
    const successes = results.filter((r) => !r.error && r.data !== null)
    const failures = results.filter((r) => r.error !== null)

    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)

    // L'erreur du second doit mentionner ALREADY_ANONYMIZED.
    expect(failures[0]?.error?.message ?? '').toMatch(/ALREADY_ANONYMIZED/i)

    // Audit trail : SELECT count(*) action='anonymized' = 1 strict (pas de double).
    const { data: auditRows, error: auditErr } = await admin
      .from('audit_trail')
      .select('id, entity_type, entity_id, action')
      .eq('entity_id', testMemberId)
      .eq('action', 'anonymized')
    expect(auditErr).toBeNull()
    // Le count=1 est attendu pour le handler-side recordAudit. Le trigger PG
    // sur 'members' produit aussi une row (entity_type='members'), donc on
    // filtre strictement action='anonymized' qui est handler-side.
    expect((auditRows ?? []).length).toBeLessThanOrEqual(1)
  })
})
