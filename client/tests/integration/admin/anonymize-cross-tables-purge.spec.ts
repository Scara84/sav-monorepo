import { describe, it, expect, beforeAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Story 7-6 AC #3 + AC #6 D-11 — INTEGRATION RED-PHASE :
 *   purge cross-tables exhaustive dans la RPC `admin_anonymize_member`,
 *   exécutée en 1 TX MVCC unique. Q-6 RÉSOLU → D-11 (5 actions au total).
 *
 * 5 cas (cohérent story spec Sub-7 D-11) :
 *   (a) D-11.1 — `magic_link_tokens` DELETE (sécurité sessions actives)
 *   (b) D-11.2 — `sav_drafts` DELETE (raw PII jsonb)
 *   (c) D-11.3a — `email_outbox` status='pending' DELETE
 *   (d) D-11.3b — `email_outbox` status IN ('sent','failed') UPDATE
 *                  recipient_email='anon+<hash8>@fruitstock.invalid'
 *   (e) D-11.4 — `members.notification_prefs` reset `'{}'::jsonb`
 *
 * **Conservation comptable NFR-D10** : chaque cas asserte aussi que
 *   `sav`, `sav_lines`, `credit_notes`, `sav_comments`, `sav_files`,
 *   `auth_events` count restent INCHANGÉS (KEEP justifié rétention 10 ans).
 *
 * Requiert env Supabase (cohérent anonymize-race.spec.ts) +
 * migration `20260512130000_admin_anonymize_member_rpc.sql` appliquée +
 * GUC `app.rgpd_anonymize_salt` configurable côté DB.
 *
 * RED tant que :
 *   - migration RPC absente, OU
 *   - RPC ne purge pas les 4 tables D-11, OU
 *   - RPC ne reset pas notification_prefs, OU
 *   - RPC supprime ACCIDENTELLEMENT des rows comptables (KEEP violé).
 *
 * **Skip auto** si env Supabase absent.
 */

const SUPABASE_URL = process.env['SUPABASE_URL'] || process.env['VITE_SUPABASE_URL']
const SERVICE_ROLE = process.env['SUPABASE_SERVICE_ROLE_KEY']
const HAS_DB = Boolean(SUPABASE_URL && SERVICE_ROLE)

interface CountSnapshot {
  sav: number
  sav_lines: number
  credit_notes: number
  sav_comments: number
  sav_files: number
  auth_events: number
}

async function snapshotComptable(admin: SupabaseClient, memberId: number): Promise<CountSnapshot> {
  // Comptes par jointure sav_id ∈ (SELECT id FROM sav WHERE member_id=...)
  const savRes = await admin
    .from('sav')
    .select('id', { count: 'exact', head: false })
    .eq('member_id', memberId)
  const savIds = ((savRes.data as Array<{ id: number }>) ?? []).map((r) => r.id)

  const linesRes = savIds.length
    ? await admin
        .from('sav_lines')
        .select('id', { count: 'exact', head: true })
        .in('sav_id', savIds)
    : { count: 0 }
  const filesRes = savIds.length
    ? await admin
        .from('sav_files')
        .select('id', { count: 'exact', head: true })
        .in('sav_id', savIds)
    : { count: 0 }
  const commentsRes = savIds.length
    ? await admin
        .from('sav_comments')
        .select('id', { count: 'exact', head: true })
        .in('sav_id', savIds)
    : { count: 0 }
  const creditRes = await admin
    .from('credit_notes')
    .select('id', { count: 'exact', head: true })
    .eq('member_id', memberId)
  const authRes = await admin
    .from('auth_events')
    .select('id', { count: 'exact', head: true })
    .eq('member_id', memberId)

  return {
    sav: savIds.length,
    sav_lines: (linesRes as { count: number | null }).count ?? 0,
    credit_notes: (creditRes as { count: number | null }).count ?? 0,
    sav_comments: (commentsRes as { count: number | null }).count ?? 0,
    sav_files: (filesRes as { count: number | null }).count ?? 0,
    auth_events: (authRes as { count: number | null }).count ?? 0,
  }
}

async function seedMember(admin: SupabaseClient, suffix: string): Promise<number> {
  const ts = Date.now()
  const { data, error } = await admin
    .from('members')
    .insert({
      email: `purge-${suffix}-${ts}@fruitstock.test`,
      first_name: 'Purge',
      last_name: 'Test',
      notification_prefs: { weekly_recap: true } as unknown as Record<string, unknown>,
      anonymized_at: null,
    })
    .select('id')
    .single()
  if (error) throw new Error(`seed member [${suffix}] failed: ${error.message}`)
  return (data as { id: number }).id
}

describe.skipIf(!HAS_DB)(
  'Story 7-6 AC #3 + #6 D-11 — anonymize purge cross-tables (integration DB réelle)',
  () => {
    let admin: SupabaseClient

    beforeAll(() => {
      admin = createClient(SUPABASE_URL!, SERVICE_ROLE!, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    })

    it('(a) D-11.1 — magic_link_tokens DELETE après anonymize ; comptable inchangé', async () => {
      const memberId = await seedMember(admin, 'tokens')
      // Seed 2 magic_link_tokens. Schema réel (Story 1.2) : jti uuid PK, member_id, expires_at.
      const expFuture = new Date(Date.now() + 3600_000).toISOString()
      const tokensInsert = await admin.from('magic_link_tokens').insert([
        { jti: crypto.randomUUID(), member_id: memberId, expires_at: expFuture },
        { jti: crypto.randomUUID(), member_id: memberId, expires_at: expFuture },
      ])
      expect(tokensInsert.error).toBeNull()

      const before = await snapshotComptable(admin, memberId)

      const { error: rpcErr } = await admin.rpc('admin_anonymize_member', {
        p_member_id: memberId,
        p_actor_operator_id: 9,
      })
      expect(rpcErr).toBeNull()

      const { count: tokensAfter } = await admin
        .from('magic_link_tokens')
        .select('id', { count: 'exact', head: true })
        .eq('member_id', memberId)
      expect(tokensAfter ?? 0).toBe(0)

      const after = await snapshotComptable(admin, memberId)
      expect(after).toEqual(before)
    })

    it('(b) D-11.2 — sav_drafts DELETE (raw PII jsonb purgé) ; comptable inchangé', async () => {
      const memberId = await seedMember(admin, 'drafts')
      const draftsInsert = await admin.from('sav_drafts').insert({
        member_id: memberId,
        data: {
          email: 'real.member@example.com',
          phone: '+33611223344',
          notes: 'note libre PII',
        },
      })
      expect(draftsInsert.error).toBeNull()

      const before = await snapshotComptable(admin, memberId)

      const { error: rpcErr } = await admin.rpc('admin_anonymize_member', {
        p_member_id: memberId,
        p_actor_operator_id: 9,
      })
      expect(rpcErr).toBeNull()

      const { count: draftsAfter } = await admin
        .from('sav_drafts')
        .select('id', { count: 'exact', head: true })
        .eq('member_id', memberId)
      expect(draftsAfter ?? 0).toBe(0)

      const after = await snapshotComptable(admin, memberId)
      expect(after).toEqual(before)
    })

    it("(c) D-11.3a — email_outbox status='pending' DELETE ; comptable inchangé", async () => {
      const memberId = await seedMember(admin, 'outbox-pending')
      const outboxInsert = await admin.from('email_outbox').insert([
        {
          recipient_member_id: memberId,
          recipient_email: 'real.member@example.com',
          subject: 'pending-1',
          status: 'pending',
        },
        {
          recipient_member_id: memberId,
          recipient_email: 'real.member@example.com',
          subject: 'pending-2',
          status: 'pending',
        },
      ])
      expect(outboxInsert.error).toBeNull()

      const before = await snapshotComptable(admin, memberId)

      const { error: rpcErr } = await admin.rpc('admin_anonymize_member', {
        p_member_id: memberId,
        p_actor_operator_id: 9,
      })
      expect(rpcErr).toBeNull()

      const { count: pendingAfter } = await admin
        .from('email_outbox')
        .select('id', { count: 'exact', head: true })
        .eq('recipient_member_id', memberId)
        .eq('status', 'pending')
      expect(pendingAfter ?? 0).toBe(0)

      const after = await snapshotComptable(admin, memberId)
      expect(after).toEqual(before)
    })

    it("(d) D-11.3b — email_outbox status IN ('sent','failed') UPDATE recipient_email anonymisé ; row préservée ; comptable inchangé", async () => {
      const memberId = await seedMember(admin, 'outbox-sent')
      const outboxInsert = await admin.from('email_outbox').insert([
        {
          recipient_member_id: memberId,
          recipient_email: 'real.member@example.com',
          subject: 'sent-1',
          status: 'sent',
        },
        {
          recipient_member_id: memberId,
          recipient_email: 'real.member@example.com',
          subject: 'failed-1',
          status: 'failed',
        },
      ])
      expect(outboxInsert.error).toBeNull()

      const before = await snapshotComptable(admin, memberId)

      const { error: rpcErr } = await admin.rpc('admin_anonymize_member', {
        p_member_id: memberId,
        p_actor_operator_id: 9,
      })
      expect(rpcErr).toBeNull()

      // Rows préservées (rétention historique transactionnel).
      const { data: outboxAfter, error: outErr } = await admin
        .from('email_outbox')
        .select('id, recipient_email, status')
        .eq('recipient_member_id', memberId)
        .in('status', ['sent', 'failed'])
      expect(outErr).toBeNull()
      expect((outboxAfter ?? []).length).toBe(2)
      // Tous les recipient_email anonymisés `anon+<hash8>@fruitstock.invalid`.
      for (const row of outboxAfter ?? []) {
        expect((row as { recipient_email: string }).recipient_email).toMatch(
          /^anon\+[0-9a-f]{8}@fruitstock\.invalid$/
        )
      }

      const after = await snapshotComptable(admin, memberId)
      expect(after).toEqual(before)
    })

    it("(e) D-11.4 — members.notification_prefs reset '{}'::jsonb ; comptable inchangé", async () => {
      const memberId = await seedMember(admin, 'notif-prefs')
      // Vérifie pré-condition : notification_prefs={weekly_recap:true} au seed.
      const { data: before } = await admin
        .from('members')
        .select('notification_prefs')
        .eq('id', memberId)
        .single()
      expect(
        (before as { notification_prefs: Record<string, unknown> }).notification_prefs
      ).toEqual({
        weekly_recap: true,
      })

      const beforeSnap = await snapshotComptable(admin, memberId)

      const { error: rpcErr } = await admin.rpc('admin_anonymize_member', {
        p_member_id: memberId,
        p_actor_operator_id: 9,
      })
      expect(rpcErr).toBeNull()

      const { data: after } = await admin
        .from('members')
        .select('notification_prefs')
        .eq('id', memberId)
        .single()
      expect((after as { notification_prefs: Record<string, unknown> }).notification_prefs).toEqual(
        {}
      )

      const afterSnap = await snapshotComptable(admin, memberId)
      expect(afterSnap).toEqual(beforeSnap)
    })
  }
)
