import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Story 6.6 AC #11 — tests Vitest du runner retry-emails.
 *
 * Pattern référence : `threshold-alerts.spec.ts` (Story 5.5).
 *   - mock supabaseAdmin via `vi.hoisted` + `vi.mock`
 *   - mock `client/api/_lib/clients/smtp.ts` (sendMail)
 *
 * Couvre :
 *   - AC #3 : SELECT batch + status='pending'|'failed'+attempts<5
 *   - AC #4 : backoff exponentiel + cap 5 attempts
 *   - AC #6 : try/catch per-row, concurrency=5, timeout 10s, retour {scanned,sent,failed,...}
 *   - AC #7 : account routing 'sav' vs 'noreply'
 *   - AC #9 : SMTP KO simulé (ECONNREFUSED) → attempts++, last_error
 *   - AC #10 : escapeHtml dans templates (test indirect via render)
 *   - AC #3 + Story 6.4 contrat : opt-out → status='cancelled', last_error='member_opt_out'
 */

interface OutboxRow {
  id: number
  kind: string
  recipient_email: string
  recipient_member_id: number | null
  recipient_operator_id: number | null
  subject: string
  template_data: Record<string, unknown> | null
  account: 'sav' | 'noreply'
  status: 'pending' | 'failed' | 'sent' | 'cancelled'
  // HARDENING P0-6 : autorise NULL/undefined pour tester la défense NaN cascade.
  attempts: number | null
  scheduled_at: string
  next_attempt_at: string | null
  sav_id: number | null
}

interface State {
  outboxRows: OutboxRow[]
  outboxUpdates: Array<{ id: number; patch: Record<string, unknown> }>
  membersById: Map<number, { id: number; notification_prefs: Record<string, unknown> }>
  sendMailCalls: Array<{
    to: string
    subject: string
    html: string
    text?: string
    account?: string
  }>
  sendMailFailIndices: Set<number>
  /** Index → ms hang (pour timeout test). */
  sendMailHangIndices: Map<number, number>
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>
  /** Si non-null, simule un échec sur mark_outbox_sent. */
  markSentError: string | null
  /** Si true, claim_outbox_batch RPC retourne les rows (P0-7). Sinon fallback SELECT. */
  claimRpcEnabled: boolean
  /** Pour P0-2 verify path : valeur smtp_message_id retournée par SELECT verif. */
  verifySmtpMessageId: string | null
}

const state = vi.hoisted(
  () =>
    ({
      outboxRows: [],
      outboxUpdates: [],
      membersById: new Map(),
      sendMailCalls: [],
      sendMailFailIndices: new Set<number>(),
      sendMailHangIndices: new Map<number, number>(),
      rpcCalls: [],
      markSentError: null,
      claimRpcEnabled: false,
      verifySmtpMessageId: null,
    }) as State
)

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  function buildEmailOutboxBuilder(): unknown {
    let updatePatch: Record<string, unknown> | null = null
    let selectingVerify: { column: string } | null = null
    let verifyTargetId: number | null = null
    const out: Record<string, unknown> = {}
    out['select'] = (cols?: string) => {
      // P0-2 verify path : SELECT smtp_message_id, status .eq('id', N).single()
      if (typeof cols === 'string' && cols.includes('smtp_message_id')) {
        selectingVerify = { column: cols }
      }
      return out
    }
    out['or'] = () => out
    out['lt'] = () => out
    out['lte'] = () => out
    out['gte'] = () => out
    out['gt'] = () => out
    out['is'] = () => out
    out['order'] = () => out
    out['limit'] = (_n: number) => {
      // Termine la chaîne SELECT — résout la promise.
      return Promise.resolve({
        data: state.outboxRows.filter((r) => r.status === 'pending' || r.status === 'failed'),
        error: null,
      })
    }
    out['single'] = () => {
      // Fin de chaîne select(verify).eq('id', N).single() pour P0-2.
      if (selectingVerify && verifyTargetId !== null) {
        const target = state.outboxRows.find((r) => r.id === verifyTargetId)
        const data = target
          ? {
              smtp_message_id: state.verifySmtpMessageId,
              status: target.status,
            }
          : null
        selectingVerify = null
        verifyTargetId = null
        return Promise.resolve({ data, error: null })
      }
      return Promise.resolve({ data: null, error: null })
    }
    out['update'] = (patch: Record<string, unknown>) => {
      updatePatch = patch
      return out
    }
    out['eq'] = (_col: string, val: unknown) => {
      // Branche P0-2 verify (select chain).
      if (selectingVerify) {
        verifyTargetId = val as number
        return out
      }
      // Fin de chaîne update().eq('id', N) → applique patch en state.
      if (updatePatch !== null) {
        state.outboxUpdates.push({ id: val as number, patch: { ...updatePatch } })
        const target = state.outboxRows.find((r) => r.id === val)
        if (target) {
          for (const [k, v] of Object.entries(updatePatch)) {
            ;(target as unknown as Record<string, unknown>)[k] = v
          }
        }
        updatePatch = null
        return Promise.resolve({ error: null })
      }
      return out
    }
    return out
  }

  function buildMembersBuilder(): unknown {
    const out: Record<string, unknown> = {}
    out['select'] = () => out
    out['in'] = (_col: string, ids: number[]) => {
      const data = ids
        .map((id) => state.membersById.get(id))
        .filter(
          (m): m is { id: number; notification_prefs: Record<string, unknown> } => m !== undefined
        )
      return Promise.resolve({ data, error: null })
    }
    return out
  }

  const client = {
    from: (table: string) => {
      if (table === 'email_outbox') return buildEmailOutboxBuilder()
      if (table === 'members') return buildMembersBuilder()
      return {}
    },
    rpc: (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args })
      if (fn === 'claim_outbox_batch') {
        // HARDENING P0-7 mock — par défaut, simule "RPC absente" pour
        // préserver le path fallback SELECT direct. Si state.claimRpcEnabled
        // est true, retourne les rows comme la vraie RPC.
        if (state.claimRpcEnabled) {
          return Promise.resolve({
            data: state.outboxRows.filter((r) => r.status === 'pending' || r.status === 'failed'),
            error: null,
          })
        }
        return Promise.resolve({
          data: null,
          error: { message: 'function not found (mock fallback)' },
        })
      }
      if (fn === 'mark_outbox_sent') {
        if (state.markSentError !== null) {
          return {
            single: () => Promise.resolve({ data: null, error: { message: state.markSentError } }),
          }
        }
        // Apply state mutation pour cohérence.
        const target = state.outboxRows.find((r) => r.id === args['p_id'])
        if (target) {
          target.status = 'sent'
        }
        return {
          single: () => Promise.resolve({ data: { updated: true }, error: null }),
        }
      }
      if (fn === 'mark_outbox_failed') {
        const target = state.outboxRows.find((r) => r.id === args['p_id'])
        if (target) {
          const cur = typeof target.attempts === 'number' ? target.attempts : 0
          target.attempts = cur + 1
          if (args['p_definitive'] === true) target.status = 'failed'
        }
        return Promise.resolve({ data: null, error: null })
      }
      return Promise.resolve({ data: null, error: null })
    },
  }
  return { supabaseAdmin: () => client, __resetSupabaseAdminForTests: () => undefined }
})

vi.mock('../../../../api/_lib/clients/smtp', () => ({
  sendMail: async (input: {
    to: string
    subject: string
    html: string
    text?: string
    account?: string
  }) => {
    const idx = state.sendMailCalls.length
    state.sendMailCalls.push({
      to: input.to,
      subject: input.subject,
      html: input.html,
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.account !== undefined ? { account: input.account } : {}),
    })
    if (state.sendMailHangIndices.has(idx)) {
      const ms = state.sendMailHangIndices.get(idx) as number
      await new Promise<void>((r) => setTimeout(r, ms))
    }
    if (state.sendMailFailIndices.has(idx)) {
      throw new Error('ECONNREFUSED')
    }
    return { messageId: `<msg-${idx}@x>`, accepted: [input.to], rejected: [] }
  },
  __resetSmtpTransporterForTests: () => undefined,
}))

import { runRetryEmails, __testables } from '../../../../api/_lib/cron-runners/retry-emails'

function makeRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 1,
    kind: 'sav_in_progress',
    recipient_email: 'marie@example.com',
    recipient_member_id: 100,
    recipient_operator_id: null,
    subject: 'SAV X : in_progress',
    template_data: {
      savReference: 'SAV-2026-00012',
      memberFirstName: 'Marie',
      memberLastName: 'Dupont',
      newStatus: 'in_progress',
      previousStatus: 'received',
      totalAmountCents: 4567,
    },
    account: 'sav',
    status: 'pending',
    attempts: 0,
    scheduled_at: '2026-05-10T02:00:00Z',
    next_attempt_at: null,
    sav_id: 12,
    ...overrides,
  }
}

function resetState(): void {
  state.outboxRows = []
  state.outboxUpdates = []
  state.membersById = new Map()
  state.sendMailCalls = []
  state.sendMailFailIndices = new Set()
  state.sendMailHangIndices = new Map()
  state.rpcCalls = []
  state.markSentError = null
  state.claimRpcEnabled = false
  state.verifySmtpMessageId = null
}

describe('runRetryEmails (Story 6.6)', () => {
  beforeEach(() => {
    resetState()
    process.env['APP_BASE_URL'] = 'https://sav.fruitstock.fr'
  })

  // HARDENING I6 (CR Story 6.6) : reset propre des fake timers + mocks pour
  // éviter les fuites entre tests (un useFakeTimers oublié d'un test
  // précédent perturbe les `setTimeout` du test suivant).
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  // ── AC #3 — batch consumer logic ────────────────────────────────────────
  it('AC#3 (a) batch vide → no-op : { scanned:0, sent:0, failed:0 }', async () => {
    const r = await runRetryEmails({ requestId: 'req-1' })
    expect(r.scanned).toBe(0)
    expect(r.sent).toBe(0)
    expect(r.failed).toBe(0)
    expect(r.skipped_optout).toBe(0)
    expect(state.sendMailCalls).toHaveLength(0)
  })

  it('AC#3 (b) 3 lignes pending → 3 sent, mark_outbox_sent appelé 3×', async () => {
    state.outboxRows = [makeRow({ id: 1 }), makeRow({ id: 2 }), makeRow({ id: 3 })]
    state.membersById.set(100, { id: 100, notification_prefs: { status_updates: true } })
    const r = await runRetryEmails({ requestId: 'req-1' })
    expect(r.scanned).toBe(3)
    expect(r.sent).toBe(3)
    expect(r.failed).toBe(0)
    const markSentCalls = state.rpcCalls.filter((c) => c.fn === 'mark_outbox_sent')
    expect(markSentCalls).toHaveLength(3)
  })

  // ── AC #4 — backoff exponentiel ─────────────────────────────────────────
  it('AC#4 backoff formula : 2^attemptsAfter × 60s, capé à 24h', () => {
    expect(__testables.computeBackoffMs(1)).toBe(120_000) // 2 min
    expect(__testables.computeBackoffMs(2)).toBe(240_000) // 4 min
    expect(__testables.computeBackoffMs(3)).toBe(480_000) // 8 min
    expect(__testables.computeBackoffMs(4)).toBe(960_000) // 16 min
    // cap 24h = 86_400_000ms : 2^11 * 60_000 = 122_880_000 > cap
    expect(__testables.computeBackoffMs(11)).toBe(24 * 3600 * 1000)
  })

  it('AC#4 (c) attempts=2 + SMTP KO → mark_outbox_failed avec next_attempt_at ~+8min', async () => {
    state.outboxRows = [makeRow({ id: 1, attempts: 2 })]
    state.membersById.set(100, { id: 100, notification_prefs: { status_updates: true } })
    state.sendMailFailIndices.add(0)
    const before = Date.now()
    await runRetryEmails({ requestId: 'req-1' })
    const failCall = state.rpcCalls.find((c) => c.fn === 'mark_outbox_failed')
    expect(failCall).toBeDefined()
    expect(failCall!.args['p_definitive']).toBe(false)
    const nextAtIso = failCall!.args['p_next_attempt_at'] as string
    const nextAt = new Date(nextAtIso).getTime()
    // 2^3 * 60_000 = 480_000ms (8 min)
    expect(nextAt - before).toBeGreaterThanOrEqual(480_000 - 1000)
    expect(nextAt - before).toBeLessThanOrEqual(480_000 + 5000)
  })

  it('AC#4 (d) attempts=4 + SMTP KO → p_definitive=true (cap 5 attempts)', async () => {
    state.outboxRows = [makeRow({ id: 1, attempts: 4 })]
    state.membersById.set(100, { id: 100, notification_prefs: { status_updates: true } })
    state.sendMailFailIndices.add(0)
    await runRetryEmails({ requestId: 'req-1' })
    const failCall = state.rpcCalls.find((c) => c.fn === 'mark_outbox_failed')
    expect(failCall).toBeDefined()
    expect(failCall!.args['p_definitive']).toBe(true)
    expect(failCall!.args['p_next_attempt_at']).toBeNull()
  })

  // ── AC #3 + Story 6.4 — opt-out adhérent ────────────────────────────────
  it('AC#3 (e) member.status_updates=false + kind adhérent → status=cancelled, last_error=member_opt_out', async () => {
    state.outboxRows = [makeRow({ id: 1, kind: 'sav_in_progress', recipient_member_id: 100 })]
    state.membersById.set(100, { id: 100, notification_prefs: { status_updates: false } })
    const r = await runRetryEmails({ requestId: 'req-1' })
    expect(r.skipped_optout).toBe(1)
    expect(r.sent).toBe(0)
    expect(state.sendMailCalls).toHaveLength(0)
    const update = state.outboxUpdates.find((u) => u.id === 1)
    expect(update).toBeDefined()
    expect(update!.patch['status']).toBe('cancelled')
    expect(update!.patch['last_error']).toBe('member_opt_out')
  })

  it('AC#3 (f) opt-out IGNORÉ pour kinds opérateur (sav_received_operator)', async () => {
    state.outboxRows = [
      makeRow({
        id: 1,
        kind: 'sav_received_operator',
        recipient_member_id: null,
        recipient_operator_id: 200,
        recipient_email: 'op@example.com',
      }),
    ]
    const r = await runRetryEmails({ requestId: 'req-1' })
    expect(r.skipped_optout).toBe(0)
    expect(r.sent).toBe(1)
    expect(state.sendMailCalls).toHaveLength(1)
  })

  // ── AC #9 — SMTP KO simulé ──────────────────────────────────────────────
  it('AC#9 (g) sendMail throw ECONNREFUSED × 3 → 3× mark_outbox_failed, attempts++, last_error', async () => {
    state.outboxRows = [makeRow({ id: 1 }), makeRow({ id: 2 }), makeRow({ id: 3 })]
    state.membersById.set(100, { id: 100, notification_prefs: { status_updates: true } })
    state.sendMailFailIndices = new Set([0, 1, 2])
    const r = await runRetryEmails({ requestId: 'req-1' })
    expect(r.failed).toBe(3)
    const failCalls = state.rpcCalls.filter((c) => c.fn === 'mark_outbox_failed')
    expect(failCalls).toHaveLength(3)
    for (const c of failCalls) {
      expect(c.args['p_error']).toContain('ECONNREFUSED')
    }
  })

  // ── AC #6 — résilience runner ───────────────────────────────────────────
  it('AC#6 (h) concurrency=5 : 10 lignes pending, max 5 sendMail en vol simultanés', async () => {
    state.outboxRows = Array.from({ length: 10 }, (_, i) => makeRow({ id: i + 1 }))
    state.membersById.set(100, { id: 100, notification_prefs: { status_updates: true } })
    // Hang chaque envoi 50ms — observe la concurrence.
    for (let i = 0; i < 10; i++) state.sendMailHangIndices.set(i, 50)
    const start = Date.now()
    await runRetryEmails({ requestId: 'req-1' })
    const elapsed = Date.now() - start
    // 10 envois × 50ms / concurrency=5 = ~100ms minimum (si série pure : 500ms).
    expect(elapsed).toBeGreaterThanOrEqual(80)
    expect(elapsed).toBeLessThanOrEqual(450)
  })

  it('AC#6 (i) timeout 10s : sendMail qui hang > 10s → reject, attempts++', async () => {
    state.outboxRows = [makeRow({ id: 1 })]
    state.membersById.set(100, { id: 100, notification_prefs: { status_updates: true } })
    // Hang 11s (> 10s timeout). Vitest fakeTimers pour accélérer.
    vi.useFakeTimers()
    state.sendMailHangIndices.set(0, 11_000)
    const promise = runRetryEmails({ requestId: 'req-1' })
    // Avance le temps : timeout 10s.
    await vi.advanceTimersByTimeAsync(10_500)
    const r = await promise
    expect(r.failed).toBe(1)
    const failCall = state.rpcCalls.find((c) => c.fn === 'mark_outbox_failed')
    expect(failCall!.args['p_error']).toContain('TIMEOUT')
    vi.useRealTimers()
  })

  it('AC#6 (j) per-row try/catch isolation : 1 ligne throw inattendu → autres continuent', async () => {
    state.outboxRows = Array.from({ length: 3 }, (_, i) => makeRow({ id: i + 1 }))
    state.membersById.set(100, { id: 100, notification_prefs: { status_updates: true } })
    state.sendMailFailIndices.add(0)
    const r = await runRetryEmails({ requestId: 'req-1' })
    expect(r.scanned).toBe(3)
    expect(r.sent).toBe(2)
    expect(r.failed).toBe(1)
  })

  it('AC#6 retour structuré : { scanned, sent, failed, skipped_optout, durationMs }', async () => {
    const r = await runRetryEmails({ requestId: 'req-1' })
    expect(r).toHaveProperty('scanned')
    expect(r).toHaveProperty('sent')
    expect(r).toHaveProperty('failed')
    expect(r).toHaveProperty('skipped_optout')
    expect(r).toHaveProperty('durationMs')
    expect(typeof r.durationMs).toBe('number')
  })

  // ── AC #7 — account routing SMTP ────────────────────────────────────────
  it('AC#7 (k) row.account="sav" → sendMail({ account: "sav" })', async () => {
    state.outboxRows = [makeRow({ id: 1, account: 'sav' })]
    state.membersById.set(100, { id: 100, notification_prefs: { status_updates: true } })
    await runRetryEmails({ requestId: 'req-1' })
    expect(state.sendMailCalls[0]?.account).toBe('sav')
  })

  it('AC#7 row.account="noreply" → sendMail({ account: "noreply" })', async () => {
    state.outboxRows = [makeRow({ id: 1, account: 'noreply' })]
    state.membersById.set(100, { id: 100, notification_prefs: { status_updates: true } })
    await runRetryEmails({ requestId: 'req-1' })
    expect(state.sendMailCalls[0]?.account).toBe('noreply')
  })

  // ── AC #10 — escape HTML & subject sanitize (test indirect via render) ─
  it('AC#10 (l) template_data.firstName="<script>" → html escape', async () => {
    state.outboxRows = [
      makeRow({
        id: 1,
        template_data: {
          savReference: 'SAV-2026-00012',
          memberFirstName: '<script>alert(1)</script>',
          totalAmountCents: 1000,
        },
      }),
    ]
    state.membersById.set(100, { id: 100, notification_prefs: { status_updates: true } })
    await runRetryEmails({ requestId: 'req-1' })
    const html = state.sendMailCalls[0]?.html ?? ''
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('AC#10 subject CRLF strip dans render template', async () => {
    state.outboxRows = [
      makeRow({
        id: 1,
        template_data: {
          savReference: 'X\r\nBcc: leak',
          memberFirstName: 'Marie',
          totalAmountCents: 100,
        },
      }),
    ]
    state.membersById.set(100, { id: 100, notification_prefs: { status_updates: true } })
    await runRetryEmails({ requestId: 'req-1' })
    expect(state.sendMailCalls[0]?.subject).not.toMatch(/[\r\n]/)
  })

  // ── HARDENING P0-6 — attempts NULL/undefined/-1 → traité comme 0 ────────
  it('HARDENING P0-6 — attempts=null + SMTP KO → attemptsAfter=1, pas de NaN cascade', async () => {
    state.outboxRows = [makeRow({ id: 1, attempts: null })]
    state.membersById.set(100, { id: 100, notification_prefs: { status_updates: true } })
    state.sendMailFailIndices.add(0)
    const r = await runRetryEmails({ requestId: 'req-1' })
    expect(r.failed).toBe(1)
    const failCall = state.rpcCalls.find((c) => c.fn === 'mark_outbox_failed')
    expect(failCall).toBeDefined()
    // attempts=null → attemptsBefore=0 → attemptsAfter=1 → next_attempt_at NON NULL
    expect(failCall!.args['p_definitive']).toBe(false)
    expect(failCall!.args['p_next_attempt_at']).not.toBeNull()
    // Pas de "Invalid Date" dans la chaîne ISO.
    const iso = failCall!.args['p_next_attempt_at'] as string
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('HARDENING P0-6 — attempts=undefined → traité comme 0', async () => {
    state.outboxRows = [makeRow({ id: 1, attempts: undefined as unknown as number })]
    state.membersById.set(100, { id: 100, notification_prefs: { status_updates: true } })
    state.sendMailFailIndices.add(0)
    const r = await runRetryEmails({ requestId: 'req-1' })
    expect(r.failed).toBe(1)
    const failCall = state.rpcCalls.find((c) => c.fn === 'mark_outbox_failed')
    expect(failCall!.args['p_definitive']).toBe(false)
  })

  it('HARDENING P0-6 — attempts=-1 (invalide) → traité comme 0', async () => {
    state.outboxRows = [makeRow({ id: 1, attempts: -1 })]
    state.membersById.set(100, { id: 100, notification_prefs: { status_updates: true } })
    state.sendMailFailIndices.add(0)
    const r = await runRetryEmails({ requestId: 'req-1' })
    expect(r.failed).toBe(1)
    const failCall = state.rpcCalls.find((c) => c.fn === 'mark_outbox_failed')
    expect(failCall!.args['p_definitive']).toBe(false)
  })

  // ── HARDENING P0-2 — markErr verify SELECT path ──────────────────────────
  it('HARDENING P0-2 — markErr + smtp_message_id présent → sent +1 (verified)', async () => {
    expect.assertions(3)
    state.outboxRows = [makeRow({ id: 1 })]
    state.membersById.set(100, { id: 100, notification_prefs: { status_updates: true } })
    state.markSentError = 'transient supabase err'
    state.verifySmtpMessageId = '<msg-already-saved@x>'
    const r = await runRetryEmails({ requestId: 'req-1' })
    expect(r.sent).toBe(1)
    expect(r.failed).toBe(0)
    // Pas de mark_outbox_failed déclenché (l'email est verified sent).
    const failCall = state.rpcCalls.find((c) => c.fn === 'mark_outbox_failed')
    expect(failCall).toBeUndefined()
  })

  it('HARDENING P0-2 — markErr + smtp_message_id NULL → mark failed-définitif', async () => {
    expect.assertions(3)
    state.outboxRows = [makeRow({ id: 1 })]
    state.membersById.set(100, { id: 100, notification_prefs: { status_updates: true } })
    state.markSentError = 'transient supabase err'
    state.verifySmtpMessageId = null
    const r = await runRetryEmails({ requestId: 'req-1' })
    expect(r.sent).toBe(0)
    expect(r.failed).toBe(1)
    const failCall = state.rpcCalls.find(
      (c) => c.fn === 'mark_outbox_failed' && c.args['p_error'] === 'mark_sent_failed_unverified'
    )
    expect(failCall).toBeDefined()
  })

  // ── HARDENING I2 — member_not_found → cancelled ─────────────────────────
  it('HARDENING I2 — member.id introuvable (anonymized) → cancelled, last_error=member_not_found', async () => {
    state.outboxRows = [makeRow({ id: 1, recipient_member_id: 999 })]
    // Volontairement : pas de set sur 999 → membersById n'a pas l'entrée.
    const r = await runRetryEmails({ requestId: 'req-1' })
    expect(r.skipped_optout).toBe(1)
    expect(r.sent).toBe(0)
    const update = state.outboxUpdates.find((u) => u.id === 1)
    expect(update?.patch['status']).toBe('cancelled')
    expect(update?.patch['last_error']).toBe('member_not_found')
  })

  // ── HARDENING P0-7 — claim_outbox_batch RPC happy-path ──────────────────
  it('HARDENING P0-7 — claim_outbox_batch RPC active → utilisé en priorité', async () => {
    state.claimRpcEnabled = true
    state.outboxRows = [makeRow({ id: 1 })]
    state.membersById.set(100, { id: 100, notification_prefs: { status_updates: true } })
    const r = await runRetryEmails({ requestId: 'req-1' })
    expect(r.sent).toBe(1)
    const claimCall = state.rpcCalls.find((c) => c.fn === 'claim_outbox_batch')
    expect(claimCall).toBeDefined()
    expect(claimCall!.args['p_limit']).toBe(100)
  })

  it('HARDENING P0-7 — claim RPC absente → fallback SELECT (compat preview)', async () => {
    state.claimRpcEnabled = false
    state.outboxRows = [makeRow({ id: 1 })]
    state.membersById.set(100, { id: 100, notification_prefs: { status_updates: true } })
    const r = await runRetryEmails({ requestId: 'req-1' })
    expect(r.sent).toBe(1)
    // claim_outbox_batch a été appelé une fois, mais retour error → fallback.
    const claimCall = state.rpcCalls.find((c) => c.fn === 'claim_outbox_batch')
    expect(claimCall).toBeDefined()
  })
})
