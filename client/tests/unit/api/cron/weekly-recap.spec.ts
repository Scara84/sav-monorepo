import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Story 6.7 AC #9 — RED-PHASE scaffold du runner `runWeeklyRecap`.
 *
 * Pattern référence : `retry-emails.spec.ts` (Story 6.6) + `threshold-alerts.spec.ts`
 * (Story 5.5) — mock supabaseAdmin via `vi.hoisted` + `vi.mock`, fake timers
 * pour piloter `new Date().getUTCDay()`.
 *
 * Couvre les 10 cas listés AC #9 :
 *   (a) jour ≠ vendredi → skipped no-op
 *   (b) vendredi avec 0 manager opt-in → no-op
 *   (c) 1 manager + 0 SAV (semaine vide) → skip silencieux, pas d'enqueue
 *   (d) 1 manager + 5 SAV → 1 INSERT outbox kind='weekly_recap'
 *   (e) 3 managers groupes différents → 3 enqueues
 *   (f) manager sans email (anonymized_at filtré côté query — défense en profondeur)
 *   (g) manager opt-out (notification_prefs.weekly_recap=false) → exclu côté SELECT
 *   (h) dédup unique index : INSERT same week → unique_violation → ON CONFLICT DO NOTHING
 *   (i) per-row try/catch : 1 erreur sur manager #2 n'abandonne pas managers #1 et #3
 *   (j) template_data JSONB structurée : memberId, memberFirstName, groupName, recap[], periodStart, periodEnd
 *
 * NOTE RED-PHASE : ce spec importe `runWeeklyRecap` qui n'existe pas encore.
 * L'import lui-même fera échouer le suite — c'est attendu (TDD red).
 */

interface ManagerRow {
  id: number
  email: string | null
  first_name: string
  last_name: string
  group_id: number
  group_name: string
  notification_prefs?: Record<string, unknown>
  anonymized_at?: string | null
}

interface SavRecapRow {
  id: number
  reference: string
  status: string
  received_at: string
  total_amount_cents: number
  first_name: string
  last_name: string
  /**
   * HARDENING B1 (CR Step 4) — un SAV créé par un member RGPD-anonymized ne
   * doit PAS apparaître dans le récap. Le mock SAV builder filtre les rows
   * où `anonymized_at !== null` pour simuler le `.is('member.anonymized_at',
   * null)` côté PostgREST inner-join.
   */
  anonymized_at?: string | null
}

interface OutboxInsertCall {
  kind: string
  recipient_email: string
  recipient_member_id: number | null
  subject: string
  html_body: string
  template_data: Record<string, unknown> | null
  account: string
  scheduled_at: string | null
}

interface State {
  /** Managers retournés par le SELECT eligible (déjà filtrés côté DB). */
  managers: ManagerRow[]
  /** Map group_id → SAV récents rendus par la query 7-jours. */
  recapByGroupId: Map<number, SavRecapRow[]>
  /** Calls accumulés sur INSERT email_outbox. */
  outboxInserts: OutboxInsertCall[]
  /** Si true, le prochain INSERT outbox simule un unique_violation (dédup index). */
  outboxUniqueViolationOnInsert: boolean
  /** Set de manager.id pour lesquels la query recap doit throw (per-row error). */
  recapErrorForManagerIds: Set<number>
  /** Date courante mockée (pour useFakeTimers). null = real time. */
  mockedNowIso: string | null
}

const state = vi.hoisted(
  () =>
    ({
      managers: [],
      recapByGroupId: new Map(),
      outboxInserts: [],
      outboxUniqueViolationOnInsert: false,
      recapErrorForManagerIds: new Set<number>(),
      mockedNowIso: null,
    }) as State
)

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  /**
   * Builder pour SELECT managers éligibles (AC #2).
   * Pattern attendu : from('members').select(...).eq('is_group_manager', true)
   *   .is('anonymized_at', null).eq(...weekly_recap=true).not('email', 'is', null)
   */
  function buildMembersBuilder(): unknown {
    const out: Record<string, unknown> = {}
    out['select'] = () => out
    out['eq'] = () => out
    out['is'] = () => out
    out['not'] = () => out
    out['order'] = () => out
    // Termine la chaîne : la query résout les managers éligibles.
    out['limit'] = () =>
      Promise.resolve({
        data: state.managers.map((m) => ({
          id: m.id,
          email: m.email,
          first_name: m.first_name,
          last_name: m.last_name,
          group_id: m.group_id,
          group_name: m.group_name,
        })),
        error: null,
      })
    // Certains code-paths pourraient juste resolve sur la chaîne sans .limit().
    out['then'] = (resolve: (v: unknown) => void) =>
      resolve({
        data: state.managers.map((m) => ({
          id: m.id,
          email: m.email,
          first_name: m.first_name,
          last_name: m.last_name,
          group_id: m.group_id,
          group_name: m.group_name,
        })),
        error: null,
      })
    return out
  }

  /**
   * Builder pour SELECT recap 7-jours (AC #3).
   * Pattern attendu : from('sav').select(...).eq('group_id', N).gte('received_at', ...).lt(...).order(...).limit(100)
   * État : `recapByGroupId` permet de simuler 0 SAV vs N SAV par groupe.
   */
  function buildSavBuilder(): unknown {
    let groupId = 0
    let filterAnonymizedNull = false
    const out: Record<string, unknown> = {}
    out['select'] = () => out
    out['eq'] = (col: string, val: unknown) => {
      if (col === 'group_id') groupId = val as number
      return out
    }
    out['gte'] = () => out
    out['lt'] = () => out
    out['is'] = (col: string, val: unknown) => {
      // HARDENING B1 (CR Step 4) — capture `.is('member.anonymized_at', null)`
      // côté embed inner-join pour exclure les SAV liés à un member anonymized.
      if (col === 'member.anonymized_at' && val === null) {
        filterAnonymizedNull = true
      }
      return out
    }
    out['order'] = () => out
    out['limit'] = () => {
      // Per-row error simulation (cas i).
      // On ne peut pas cibler par manager_id ici (la query est par group_id),
      // donc on convertit via state : si un manager mappé sur ce group est dans
      // `recapErrorForManagerIds`, on throw.
      const managerForGroup = state.managers.find((m) => m.group_id === groupId)
      if (managerForGroup && state.recapErrorForManagerIds.has(managerForGroup.id)) {
        return Promise.resolve({
          data: null,
          error: { message: 'simulated query failure for per-row try/catch' },
        })
      }
      // HARDENING B1+B2 (CR Step 4) — shape PostgREST production : embed
      // `member:members!inner(first_name, last_name, anonymized_at)`. Le mock
      // applique le filtre `anonymized_at IS NULL` côté inner-join PostgREST
      // (member.anonymized_at != null → SAV exclu).
      const rows = state.recapByGroupId.get(groupId) ?? []
      const filtered = filterAnonymizedNull
        ? rows.filter((r) => r.anonymized_at === null || r.anonymized_at === undefined)
        : rows
      const data = filtered.map((r) => ({
        id: r.id,
        reference: r.reference,
        status: r.status,
        received_at: r.received_at,
        total_amount_cents: r.total_amount_cents,
        member: {
          first_name: r.first_name,
          last_name: r.last_name,
          anonymized_at: r.anonymized_at ?? null,
        },
      }))
      return Promise.resolve({
        data,
        error: null,
      })
    }
    return out
  }

  /**
   * Builder pour INSERT email_outbox (AC #5).
   * Pattern attendu : from('email_outbox').insert(payload).select('id').single()
   * — ou .upsert(...).onConflict('idx_email_outbox_weekly_recap_unique').
   * Cas (h) dédup : si `outboxUniqueViolationOnInsert`, simule unique_violation.
   */
  function buildEmailOutboxBuilder(): unknown {
    const out: Record<string, unknown> = {}
    out['insert'] = (payload: Record<string, unknown> | Record<string, unknown>[]) => {
      const rows = Array.isArray(payload) ? payload : [payload]
      if (state.outboxUniqueViolationOnInsert) {
        return Promise.resolve({
          data: null,
          error: { code: '23505', message: 'duplicate key value violates unique constraint' },
        })
      }
      for (const r of rows) {
        state.outboxInserts.push({
          kind: r['kind'] as string,
          recipient_email: r['recipient_email'] as string,
          recipient_member_id: (r['recipient_member_id'] as number | null) ?? null,
          subject: r['subject'] as string,
          html_body: (r['html_body'] as string) ?? '',
          template_data: (r['template_data'] as Record<string, unknown>) ?? null,
          account: (r['account'] as string) ?? 'sav',
          scheduled_at: (r['scheduled_at'] as string) ?? null,
        })
      }
      return Promise.resolve({ data: rows.map((_, i) => ({ id: i + 1 })), error: null })
    }
    // Pattern .upsert() compatible (si l'implémentation utilise ON CONFLICT DO NOTHING).
    out['upsert'] = (payload: Record<string, unknown> | Record<string, unknown>[]) => {
      return (out['insert'] as (p: unknown) => unknown)(payload)
    }
    out['select'] = () => out
    out['single'] = () => Promise.resolve({ data: { id: 1 }, error: null })
    return out
  }

  const client = {
    from: (table: string) => {
      if (table === 'members') return buildMembersBuilder()
      if (table === 'sav') return buildSavBuilder()
      if (table === 'email_outbox') return buildEmailOutboxBuilder()
      return {}
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  }
  return { supabaseAdmin: () => client, __resetSupabaseAdminForTests: () => undefined }
})

// Mock du dispatcher render — on ne teste pas le contenu HTML ici (couvert par
// `transactional/weekly-recap.spec.ts`). On vérifie juste que le runner appelle
// le render et passe template_data correctement à l'outbox.
vi.mock('../../../../api/_lib/emails/transactional/render', () => ({
  renderEmailTemplate: (kind: string, data: Record<string, unknown>) => ({
    subject: `Récap SAV — Groupe ${data['groupName'] ?? '?'}`,
    html: `<html>recap stub for ${kind}</html>`,
    text: `recap stub text for ${kind}`,
  }),
}))

// ── IMPORT RED-PHASE — runWeeklyRecap n'existe pas encore (Task 1 Sub-1). ──
// Une fois implémenté : `client/api/_lib/cron-runners/weekly-recap.ts`
import { runWeeklyRecap } from '../../../../api/_lib/cron-runners/weekly-recap'

function makeManager(overrides: Partial<ManagerRow> = {}): ManagerRow {
  return {
    id: 100,
    email: 'manager@example.com',
    first_name: 'Alice',
    last_name: 'Manager',
    group_id: 5,
    group_name: 'Groupe Aix',
    ...overrides,
  }
}

function makeRecapRow(overrides: Partial<SavRecapRow> = {}): SavRecapRow {
  return {
    id: 1001,
    reference: 'SAV-2026-01001',
    status: 'in_progress',
    received_at: '2026-04-28T10:00:00Z',
    total_amount_cents: 4567,
    first_name: 'Marie',
    last_name: 'Dupont',
    anonymized_at: null,
    ...overrides,
  }
}

function resetState(): void {
  state.managers = []
  state.recapByGroupId = new Map()
  state.outboxInserts = []
  state.outboxUniqueViolationOnInsert = false
  state.recapErrorForManagerIds = new Set()
  state.mockedNowIso = null
}

/**
 * Pin `Date` à une instance fixe via fake timers — permet de contrôler
 * `getUTCDay()` (5 = vendredi UTC).
 */
function pinDate(iso: string): void {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(iso))
}

const FRIDAY_UTC_ISO = '2026-05-01T03:00:00Z' // vendredi 1 mai 2026, 03:00 UTC
const MONDAY_UTC_ISO = '2026-04-27T03:00:00Z' // lundi 27 avril 2026, 03:00 UTC

describe('runWeeklyRecap (Story 6.7) — RED PHASE', () => {
  beforeEach(() => {
    resetState()
    process.env['APP_BASE_URL'] = 'https://sav.fruitstock.fr'
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  // ── (a) AC #1 — guard jour ≠ vendredi ──────────────────────────────────
  it('AC#1 (a) jour != vendredi (lundi) → return { skipped: "not_friday" }, no-op DB', async () => {
    pinDate(MONDAY_UTC_ISO)
    state.managers = [makeManager()]
    state.recapByGroupId.set(5, [makeRecapRow()])

    const r = await runWeeklyRecap({ requestId: 'req-1' })
    expect(r.skipped).toBe('not_friday')
    expect(state.outboxInserts).toHaveLength(0)
  })

  // ── (b) AC #2 — vendredi sans manager opt-in ───────────────────────────
  it("AC#2 (b) vendredi + 0 manager opt-in → scanned=0, enqueued=0, pas d'INSERT", async () => {
    pinDate(FRIDAY_UTC_ISO)
    state.managers = [] // SELECT renvoie 0 row (déjà filtré DB)

    const r = await runWeeklyRecap({ requestId: 'req-1' })
    expect(r.scanned).toBe(0)
    expect(r.enqueued).toBe(0)
    expect(state.outboxInserts).toHaveLength(0)
  })

  // ── (c) AC #3 — 1 manager + 0 SAV → skip silencieux ────────────────────
  it("AC#3 (c) 1 manager opt-in + groupe avec 0 SAV cette semaine → skip silencieux, pas d'enqueue", async () => {
    pinDate(FRIDAY_UTC_ISO)
    state.managers = [makeManager({ id: 100, group_id: 5 })]
    state.recapByGroupId.set(5, []) // 0 SAV → skip silencieux

    const r = await runWeeklyRecap({ requestId: 'req-1' })
    expect(r.scanned).toBe(1)
    expect(r.enqueued).toBe(0)
    expect(r.skipped_no_data).toBe(1)
    expect(state.outboxInserts).toHaveLength(0)
  })

  // ── (d) AC #5 — 1 manager + 5 SAV → 1 INSERT outbox ────────────────────
  it('AC#5 (d) 1 manager + 5 SAV → 1 INSERT outbox kind="weekly_recap"', async () => {
    pinDate(FRIDAY_UTC_ISO)
    state.managers = [makeManager({ id: 100, email: 'alice@example.com', group_id: 5 })]
    state.recapByGroupId.set(
      5,
      Array.from({ length: 5 }, (_, i) =>
        makeRecapRow({ id: 2000 + i, reference: `SAV-2026-0200${i}` })
      )
    )

    const r = await runWeeklyRecap({ requestId: 'req-1' })
    expect(r.scanned).toBe(1)
    expect(r.enqueued).toBe(1)
    expect(state.outboxInserts).toHaveLength(1)
    const ins = state.outboxInserts[0]!
    expect(ins.kind).toBe('weekly_recap')
    expect(ins.recipient_email).toBe('alice@example.com')
    expect(ins.recipient_member_id).toBe(100)
    expect(ins.account).toBe('sav')
  })

  // ── (e) — 3 managers groupes différents → 3 enqueues ──────────────────
  it('AC#5 (e) 3 managers groupes distincts avec SAV → 3 INSERTs outbox indépendants', async () => {
    pinDate(FRIDAY_UTC_ISO)
    state.managers = [
      makeManager({ id: 100, email: 'a@example.com', group_id: 1, group_name: 'G1' }),
      makeManager({ id: 101, email: 'b@example.com', group_id: 2, group_name: 'G2' }),
      makeManager({ id: 102, email: 'c@example.com', group_id: 3, group_name: 'G3' }),
    ]
    state.recapByGroupId.set(1, [makeRecapRow()])
    state.recapByGroupId.set(2, [makeRecapRow(), makeRecapRow()])
    state.recapByGroupId.set(3, [makeRecapRow()])

    const r = await runWeeklyRecap({ requestId: 'req-1' })
    expect(r.scanned).toBe(3)
    expect(r.enqueued).toBe(3)
    expect(state.outboxInserts).toHaveLength(3)
    const recipients = state.outboxInserts.map((i) => i.recipient_email).sort()
    expect(recipients).toEqual(['a@example.com', 'b@example.com', 'c@example.com'])
  })

  // ── (f) AC #2 — manager sans email / anonymized exclu côté SELECT ──────
  it('AC#2 (f) manager.email NULL ou anonymized_at != NULL → exclu côté SELECT, 0 INSERT', async () => {
    pinDate(FRIDAY_UTC_ISO)
    // Le mock du builder simule la DB qui a déjà filtré ces rows. On vérifie
    // qu'aucun manager dont email serait NULL n'arrive jamais dans le runner.
    // Le runner reçoit donc une liste vide.
    state.managers = [] // simulate DB filter excluding anonymized + null email

    const r = await runWeeklyRecap({ requestId: 'req-1' })
    expect(r.scanned).toBe(0)
    expect(state.outboxInserts).toHaveLength(0)
    // Défense en profondeur côté code : si un manager passait avec email=null,
    // le runner doit log et skip (vérification post-implémentation).
  })

  // ── (g) AC #7 — manager opt-out exclu côté SELECT ──────────────────────
  it('AC#7 (g) manager passant weekly_recap=false → exclu côté SELECT (filtre DB), 0 INSERT', async () => {
    pinDate(FRIDAY_UTC_ISO)
    // SELECT WHERE notification_prefs->>weekly_recap=true exclut les opt-out
    // donc state.managers = [] simule la DB qui a déjà filtré.
    state.managers = []

    const r = await runWeeklyRecap({ requestId: 'req-1' })
    expect(r.scanned).toBe(0)
    expect(r.enqueued).toBe(0)
    expect(state.outboxInserts).toHaveLength(0)
  })

  // ── (h) AC #5 dédup — re-run même semaine → unique_violation absorbé ──
  it('AC#5 (h) dédup unique index respecté : re-run même semaine → 0 nouvel INSERT (ON CONFLICT DO NOTHING)', async () => {
    pinDate(FRIDAY_UTC_ISO)
    state.managers = [makeManager({ id: 100, group_id: 5 })]
    state.recapByGroupId.set(5, [makeRecapRow()])
    state.outboxUniqueViolationOnInsert = true // simule un row déjà présent cette semaine

    const r = await runWeeklyRecap({ requestId: 'req-1' })
    expect(r.scanned).toBe(1)
    // Le runner doit absorber le 23505 unique_violation comme un skip
    // (clé idempotence). Pas d'INSERT effectif → enqueued=0, errors=0.
    expect(r.enqueued).toBe(0)
    expect(r.errors ?? 0).toBe(0)
    // HARDENING H3 (CR Step 4) — compteur skipped_dedup dédié.
    expect(r.skipped_dedup).toBe(1)
    expect(state.outboxInserts).toHaveLength(0)
  })

  // ── (i) AC #6 résilience — per-row try/catch ──────────────────────────
  it("AC#6 (i) per-row try/catch : erreur SELECT recap manager #2 n'abandonne pas managers #1 et #3", async () => {
    pinDate(FRIDAY_UTC_ISO)
    state.managers = [
      makeManager({ id: 100, email: 'a@example.com', group_id: 1, group_name: 'G1' }),
      makeManager({ id: 101, email: 'b@example.com', group_id: 2, group_name: 'G2' }),
      makeManager({ id: 102, email: 'c@example.com', group_id: 3, group_name: 'G3' }),
    ]
    state.recapByGroupId.set(1, [makeRecapRow()])
    state.recapByGroupId.set(3, [makeRecapRow()])
    // Manager #2 (id=101, group=2) : la query recap throw.
    state.recapErrorForManagerIds.add(101)

    const r = await runWeeklyRecap({ requestId: 'req-1' })
    expect(r.scanned).toBe(3)
    expect(r.enqueued).toBe(2) // managers 100 + 102
    expect(r.errors).toBe(1) // manager 101
    const recipients = state.outboxInserts.map((i) => i.recipient_email).sort()
    expect(recipients).toEqual(['a@example.com', 'c@example.com'])
  })

  // ── (j) AC #5 — template_data JSONB structurée correcte ───────────────
  it('AC#5 (j) template_data JSONB contient memberId, memberFirstName, groupName, recap[], periodStart, periodEnd', async () => {
    pinDate(FRIDAY_UTC_ISO)
    state.managers = [
      makeManager({
        id: 100,
        email: 'alice@example.com',
        first_name: 'Alice',
        group_id: 5,
        group_name: 'Groupe Aix',
      }),
    ]
    state.recapByGroupId.set(5, [
      makeRecapRow({ id: 2001, reference: 'SAV-2026-02001' }),
      makeRecapRow({ id: 2002, reference: 'SAV-2026-02002' }),
    ])

    await runWeeklyRecap({ requestId: 'req-1' })
    expect(state.outboxInserts).toHaveLength(1)
    const td = state.outboxInserts[0]!.template_data
    expect(td).not.toBeNull()
    expect(td!['memberId']).toBe(100)
    expect(td!['memberFirstName']).toBe('Alice')
    expect(td!['groupName']).toBe('Groupe Aix')
    expect(Array.isArray(td!['recap'])).toBe(true)
    expect((td!['recap'] as unknown[]).length).toBe(2)
    expect(typeof td!['periodStart']).toBe('string')
    expect(typeof td!['periodEnd']).toBe('string')
    // HARDENING H1 (CR Step 4) — fenêtre alignée semaine ISO (lundi 00:00 UTC
    // → maintenant). FRIDAY_UTC_ISO = vendredi 1 mai 2026 03:00 → lundi
    // 27 avril 2026 00:00. Différence ≈ 4 jours + 3h.
    const start = new Date(td!['periodStart'] as string).getTime()
    const end = new Date(td!['periodEnd'] as string).getTime()
    expect(end).toBeGreaterThan(start)
    expect(td!['periodStart']).toBe('2026-04-27T00:00:00.000Z')
    expect(td!['periodEnd']).toBe('2026-05-01T03:00:00.000Z')
  })

  // ── (k) HARDENING B1 (CR Step 4) — leak RGPD anonymized member ──────────
  it('B1 (k) SAV créé par member anonymized → exclu du récap (filtre member.anonymized_at IS NULL)', async () => {
    pinDate(FRIDAY_UTC_ISO)
    state.managers = [makeManager({ id: 100, email: 'alice@example.com', group_id: 5 })]
    // 2 SAV : l'un par member valide, l'autre par member anonymized RGPD.
    state.recapByGroupId.set(5, [
      makeRecapRow({ id: 3001, reference: 'SAV-2026-03001' }),
      makeRecapRow({
        id: 3002,
        reference: 'SAV-2026-03002',
        anonymized_at: '2026-04-15T10:00:00Z',
      }),
    ])

    const r = await runWeeklyRecap({ requestId: 'req-1' })
    expect(r.scanned).toBe(1)
    expect(r.enqueued).toBe(1)
    expect(state.outboxInserts).toHaveLength(1)
    const td = state.outboxInserts[0]!.template_data
    expect(td).not.toBeNull()
    const recap = td!['recap'] as Array<Record<string, unknown>>
    expect(recap).toHaveLength(1)
    // Seul SAV-2026-03001 est inclus ; le SAV par member anonymized est exclu.
    expect(recap[0]!['reference']).toBe('SAV-2026-03001')
  })

  // ── (l) HARDENING M1 (CR Step 4) — bypass interdit en production ────────
  it("M1 (l) NODE_ENV=production + WEEKLY_RECAP_BYPASS_FRIDAY=true → throw, runner ne s'exécute pas", async () => {
    // Pas besoin de pinDate : l'exception doit être levée avant le guard jour.
    const prevEnv = process.env['NODE_ENV']
    const prevBypass = process.env['WEEKLY_RECAP_BYPASS_FRIDAY']
    process.env['NODE_ENV'] = 'production'
    process.env['WEEKLY_RECAP_BYPASS_FRIDAY'] = 'true'
    try {
      state.managers = [makeManager()]
      state.recapByGroupId.set(5, [makeRecapRow()])
      await expect(runWeeklyRecap({ requestId: 'req-1' })).rejects.toThrow(
        /WEEKLY_RECAP_BYPASS_FRIDAY not allowed in production/
      )
      // Aucun INSERT outbox déclenché.
      expect(state.outboxInserts).toHaveLength(0)
    } finally {
      if (prevEnv === undefined) delete process.env['NODE_ENV']
      else process.env['NODE_ENV'] = prevEnv
      if (prevBypass === undefined) delete process.env['WEEKLY_RECAP_BYPASS_FRIDAY']
      else process.env['WEEKLY_RECAP_BYPASS_FRIDAY'] = prevBypass
    }
  })

  // ── HARDENING H3 (CR Step 4) — compteur skipped_dedup ──────────────────
  it('H3 (h-bis) skipped_dedup incrémenté à chaque unique_violation absorbée', async () => {
    pinDate(FRIDAY_UTC_ISO)
    state.managers = [makeManager({ id: 100, group_id: 5 })]
    state.recapByGroupId.set(5, [makeRecapRow()])
    state.outboxUniqueViolationOnInsert = true

    const r = await runWeeklyRecap({ requestId: 'req-1' })
    expect(r.scanned).toBe(1)
    expect(r.enqueued).toBe(0)
    expect(r.errors).toBe(0)
    expect(r.skipped_dedup).toBe(1)
  })
})
