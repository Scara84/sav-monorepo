import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Story V1.13 AC#2 + AC#5 + AC#6 + AC#9 + AC#12 — Tests Vitest du runner
 * scopable + branche PJ rebranchée sur `sav_validated`.
 *
 * Pattern : additif à `retry-emails.spec.ts` (Story 6.6 + V1.10), même style
 * de mock supabase-admin chainable + smtp + attachment resolver.
 *
 * NOTE — RENAME : V1.10 mécanisme PJ → `credit-note-attachment.ts` (AC#5).
 *   - module renommé `sav-closed-attachment.ts` → `credit-note-attachment.ts`
 *   - export `resolveSavClosedAttachment` → `resolveCreditNoteAttachment`
 *   - clés log `email.sav_closed.attachment.*` → `email.credit_note.attachment.*`
 *
 * Couvre :
 *   AC#2 (a) savId présent → RPC claim_outbox_batch appelée avec p_sav_id (et p_limit).
 *   AC#2 (b) savId absent → strictement le même chemin que cron actuel (p_sav_id null/absent).
 *   AC#2 (c) savId présent + claim RPC échoue → NO fallback SELECT direct
 *            → retour {scanned:0}, log error.
 *   AC#5 (d) branche PJ déclenchée sur kind='sav_validated' (et plus sav_closed).
 *   AC#5 (e) flags template pdfFallback / noCreditNote injectés sur sav_validated.
 *   AC#6 (f) une row kind='sav_closed' dans le batch → renderer encore appelé
 *            (case CONSERVÉ V1, dette V2 — D-3=a) mais aucune PJ résolue.
 *   AC#9 (g) chemin scopé ignore next_attempt_at (parité runner ↔ RPC scopée).
 *   AC#9 (h) cron (savId absent) NE bypass PAS next_attempt_at — row backoff invisible.
 *
 * Statut ATDD : RED attendu avant impl Step 2/Step 4 (param savId absent, branche
 * PJ encore sur sav_closed, garde anti-fallback absente).
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
    account?: string
    attachments?: Array<{ filename: string; content: Buffer }>
  }>
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>
  /** Si non-null, claim_outbox_batch retourne cette erreur (test AC#2c). */
  claimRpcError: { message: string } | null
  /** Filtrage que le mock RPC applique pour simuler le scoping côté DB. */
  scopedRpcFiltering: boolean
  /** Resolver attachment : injecté par les tests (V1.10 contrat). */
  attachmentResolver:
    | { kind: 'no_credit_note' }
    | { kind: 'unavailable' }
    | { kind: 'attachment'; filename: string; content: Buffer }
    | 'throw'
  attachmentResolverCalls: Array<number>
}

const state = vi.hoisted(
  () =>
    ({
      outboxRows: [],
      outboxUpdates: [],
      membersById: new Map(),
      sendMailCalls: [],
      rpcCalls: [],
      claimRpcError: null,
      scopedRpcFiltering: true,
      attachmentResolver: { kind: 'no_credit_note' },
      attachmentResolverCalls: [],
    }) as State
)

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  function buildEmailOutboxBuilder(): unknown {
    let updatePatch: Record<string, unknown> | null = null
    const out: Record<string, unknown> = {}
    out['select'] = () => out
    out['or'] = () => out
    out['lt'] = () => out
    out['lte'] = () => out
    out['gte'] = () => out
    out['gt'] = () => out
    out['is'] = () => out
    out['order'] = () => out
    out['limit'] = () => Promise.resolve({ data: [], error: null })
    out['single'] = () => Promise.resolve({ data: null, error: null })
    out['update'] = (patch: Record<string, unknown>) => {
      updatePatch = patch
      return out
    }
    out['eq'] = (_col: string, val: unknown) => {
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
        if (state.claimRpcError) {
          return Promise.resolve({ data: null, error: state.claimRpcError })
        }
        // Simule la RPC réelle : filtre par sav_id si présent, sinon honore
        // next_attempt_at. Le mock n'est pas exhaustif — il sert juste à
        // distinguer les chemins scopé vs cron pour assertions AC#9.
        const savId = (args['p_sav_id'] as number | null | undefined) ?? null
        let rows = state.outboxRows.filter(
          (r) => r.status === 'pending' || (r.status === 'failed' && (r.attempts ?? 0) < 5)
        )
        if (savId !== null) {
          // Scopé : filtre sav_id, IGNORE next_attempt_at.
          rows = rows.filter((r) => r.sav_id === savId)
        } else {
          // Cron : honore next_attempt_at (NULL ou échu).
          rows = rows.filter(
            (r) => r.next_attempt_at === null || new Date(r.next_attempt_at).getTime() <= Date.now()
          )
        }
        return Promise.resolve({ data: rows, error: null })
      }
      if (fn === 'mark_outbox_sent') {
        const target = state.outboxRows.find((r) => r.id === args['p_id'])
        if (target) target.status = 'sent'
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
    account?: string
    attachments?: Array<{ filename: string; content: Buffer }>
  }) => {
    const idx = state.sendMailCalls.length
    state.sendMailCalls.push({
      to: input.to,
      subject: input.subject,
      html: input.html,
      ...(input.account !== undefined ? { account: input.account } : {}),
      ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
    })
    return { messageId: `<msg-${idx}@x>`, accepted: [input.to], rejected: [] }
  },
  __resetSmtpTransporterForTests: () => undefined,
}))

// V1.13 AC#5 — module renommé `credit-note-attachment.ts` avec export
// `resolveCreditNoteAttachment`. Le mock couvre les 2 noms pour permettre une
// transition douce (si le dev applique le rename d'abord ou la branche d'abord).
vi.mock('../../../../api/_lib/emails/credit-note-attachment', () => ({
  resolveCreditNoteAttachment: async (savId: number) => {
    state.attachmentResolverCalls.push(savId)
    if (state.attachmentResolver === 'throw') {
      throw new Error('UNEXPECTED|attachment resolver bug')
    }
    return state.attachmentResolver
  },
}))

import { runRetryEmails } from '../../../../api/_lib/cron-runners/retry-emails'

function makeRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 1,
    kind: 'sav_validated',
    recipient_email: 'marie@example.com',
    recipient_member_id: 100,
    recipient_operator_id: null,
    subject: 'SAV X : validated',
    template_data: {
      savReference: 'SAV-2026-V113',
      savId: 12,
      memberFirstName: 'Marie',
      memberLastName: 'Dupont',
      newStatus: 'validated',
      previousStatus: 'in_progress',
      totalAmountCents: 4567,
    },
    account: 'sav',
    status: 'pending',
    attempts: 0,
    scheduled_at: '2026-06-11T10:00:00Z',
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
  state.rpcCalls = []
  state.claimRpcError = null
  state.scopedRpcFiltering = true
  state.attachmentResolver = { kind: 'no_credit_note' }
  state.attachmentResolverCalls = []
}

describe('runRetryEmails — V1.13 scopable + PJ rebranchée sav_validated', () => {
  beforeEach(() => {
    resetState()
    process.env['APP_BASE_URL'] = 'https://sav.fruitstock.fr'
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // ── AC#2 : savId optionnel ──────────────────────────────────────────────
  it('AC#2 (a) savId présent → claim_outbox_batch reçoit p_sav_id', async () => {
    state.outboxRows = [
      makeRow({ id: 1, sav_id: 12 }),
      makeRow({ id: 2, sav_id: 13 }), // autre SAV → ne doit PAS être traité
    ]
    state.membersById.set(100, { id: 100, notification_prefs: { status_updates: true } })

    const r = await runRetryEmails({ requestId: 'req-scoped', savId: 12 })

    const claimCall = state.rpcCalls.find((c) => c.fn === 'claim_outbox_batch')
    expect(claimCall).toBeDefined()
    expect(claimCall!.args['p_sav_id']).toBe(12)
    // Une seule row traitée → la row sav_id=13 ne doit PAS leaker.
    expect(r.sent).toBe(1)
    expect(state.sendMailCalls).toHaveLength(1)
  })

  it('AC#2 (b) savId absent → claim_outbox_batch reçoit p_sav_id null/absent (parité cron)', async () => {
    state.outboxRows = [makeRow({ id: 1 })]
    state.membersById.set(100, { id: 100, notification_prefs: { status_updates: true } })

    await runRetryEmails({ requestId: 'req-cron' })

    const claimCall = state.rpcCalls.find((c) => c.fn === 'claim_outbox_batch')
    expect(claimCall).toBeDefined()
    // Accepte 2 contrats — la story décrit p_sav_id DEFAULT NULL côté DB :
    // soit le runner omet p_sav_id, soit il passe null explicite. Les 2 sont OK.
    const p = claimCall!.args['p_sav_id']
    expect(p === undefined || p === null).toBe(true)
  })

  it('AC#2 (c) savId présent + claim RPC error → PAS de fallback, scanned=0, log error', async () => {
    state.outboxRows = [makeRow({ id: 1, sav_id: 12 })]
    state.claimRpcError = { message: 'function claim_outbox_batch(int, bigint) does not exist' }
    state.membersById.set(100, { id: 100, notification_prefs: { status_updates: true } })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const r = await runRetryEmails({ requestId: 'req-scope-fail', savId: 12 })

    expect(r.scanned).toBe(0)
    expect(r.sent).toBe(0)
    expect(r.failed).toBe(0)
    // Aucun sendMail — le runner refuse le fallback SELECT en mode scopé.
    expect(state.sendMailCalls).toHaveLength(0)
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  // ── AC#5 : branche PJ migrée de sav_closed → sav_validated ──────────────
  it('AC#5 (d) kind=sav_validated + resolver=attachment → sendMail reçoit attachments=[PDF]', async () => {
    state.outboxRows = [makeRow({ id: 1, kind: 'sav_validated', sav_id: 12 })]
    state.membersById.set(100, { id: 100, notification_prefs: { status_updates: true } })
    const pdf = Buffer.from('%PDF-1.4 v1-13 fake-credit-note')
    state.attachmentResolver = { kind: 'attachment', filename: 'AV-2026-V113.pdf', content: pdf }

    const r = await runRetryEmails({ requestId: 'req-pj', savId: 12 })

    expect(r.sent).toBe(1)
    expect(state.attachmentResolverCalls).toContain(12)
    const mail = state.sendMailCalls[0]!
    expect(mail.attachments).toBeDefined()
    expect(mail.attachments).toHaveLength(1)
    expect(mail.attachments![0]!.content).toBe(pdf)
  })

  it('AC#5 (e) kind=sav_validated + resolver=unavailable → mail html mentionne « disponible dans votre espace »', async () => {
    state.outboxRows = [makeRow({ id: 1, kind: 'sav_validated', sav_id: 12 })]
    state.membersById.set(100, { id: 100, notification_prefs: { status_updates: true } })
    state.attachmentResolver = { kind: 'unavailable' }

    const r = await runRetryEmails({ requestId: 'req-pj-fb', savId: 12 })
    expect(r.sent).toBe(1)
    const mail = state.sendMailCalls[0]!
    expect(mail.attachments === undefined || mail.attachments.length === 0).toBe(true)
    expect(mail.html.toLowerCase()).toContain('disponible dans votre espace')
  })

  it('AC#5 (e) kind=sav_validated + resolver=no_credit_note → aucune mention bon SAV (anti-mensonge)', async () => {
    state.outboxRows = [makeRow({ id: 1, kind: 'sav_validated', sav_id: 12 })]
    state.membersById.set(100, { id: 100, notification_prefs: { status_updates: true } })
    state.attachmentResolver = { kind: 'no_credit_note' }

    const r = await runRetryEmails({ requestId: 'req-pj-no', savId: 12 })
    expect(r.sent).toBe(1)
    const mail = state.sendMailCalls[0]!
    expect(mail.attachments === undefined || mail.attachments.length === 0).toBe(true)
    expect(mail.html.toLowerCase()).not.toContain('disponible dans votre espace')
    expect(mail.html.toLowerCase()).not.toMatch(/en pi[èe]ce jointe|ci-joint/i)
  })

  // ── AC#6 : sav_closed conservé pour rows mid-flight (D-3=a) ─────────────
  // Une row sav_closed claimée pendant la fenêtre de deploy doit s'envoyer
  // sans crasher — pas de branche PJ (rebranchée sur sav_validated) mais le
  // renderer reste mappé.
  it("AC#6 (f) kind=sav_closed legacy row → s'envoie sans PJ, resolver NON appelé", async () => {
    state.outboxRows = [makeRow({ id: 1, kind: 'sav_closed', sav_id: 13 })]
    state.membersById.set(100, { id: 100, notification_prefs: { status_updates: true } })
    // Même si on configure attachment, le resolver ne doit pas être appelé.
    state.attachmentResolver = {
      kind: 'attachment',
      filename: 'AV.pdf',
      content: Buffer.from('%PDF'),
    }

    const r = await runRetryEmails({ requestId: 'req-legacy', savId: 13 })
    expect(r.sent).toBe(1)
    // Le resolver n'est PLUS lié à sav_closed (rebranché sur sav_validated).
    expect(state.attachmentResolverCalls).not.toContain(13)
    const mail = state.sendMailCalls[0]!
    expect(mail.attachments === undefined || mail.attachments.length === 0).toBe(true)
  })

  // ── AC#9 : bypass next_attempt_at en scopé, respecté en cron ────────────
  it('AC#9 (g) scopé : row backoff (next_attempt_at futur) → visible et envoyée', async () => {
    const futureBackoff = new Date(Date.now() + 5 * 60_000).toISOString()
    state.outboxRows = [
      makeRow({
        id: 1,
        kind: 'sav_validated',
        sav_id: 12,
        status: 'failed',
        attempts: 2,
        next_attempt_at: futureBackoff,
      }),
    ]
    state.membersById.set(100, { id: 100, notification_prefs: { status_updates: true } })

    const r = await runRetryEmails({ requestId: 'req-bypass', savId: 12 })
    expect(r.sent).toBe(1)
    expect(state.sendMailCalls).toHaveLength(1)
  })

  it('AC#9 (h) cron : row backoff (next_attempt_at futur) → INVISIBLE', async () => {
    const futureBackoff = new Date(Date.now() + 5 * 60_000).toISOString()
    state.outboxRows = [
      makeRow({
        id: 1,
        kind: 'sav_validated',
        sav_id: 12,
        status: 'failed',
        attempts: 2,
        next_attempt_at: futureBackoff,
      }),
    ]
    state.membersById.set(100, { id: 100, notification_prefs: { status_updates: true } })

    const r = await runRetryEmails({ requestId: 'req-cron' })
    // Le cron honore next_attempt_at → row pas claimée → rien envoyé.
    expect(r.scanned).toBe(0)
    expect(r.sent).toBe(0)
    expect(state.sendMailCalls).toHaveLength(0)
  })

  // ── AC#9 : cap attempts<5 conservé en scopé ─────────────────────────────
  // ── AC#7 : sav_comment_from_operator (fix bug latent) ────────────────────
  // CR HIGH-3 V1.13 — Reproduit la SHAPE réelle posée par le producer
  // `enqueueOperatorCommentOutbox` (outbox-helpers.ts L66-73) :
  //   { savReference, commentExcerpt, operatorDisplayName, memberEmail,
  //     memberFirstName, savId }
  // PUIS asserte qu'avec ce payload exact, le mail part en SMTP (pas
  // d'unknown_kind failed) ET que le body du commentaire (texte de
  // l'opérateur, ici via `commentExcerpt`) apparaît bien dans mail.html.
  // C'est l'assertion-liaison qui aurait attrapé le mapping cassé HIGH-2
  // (le spread shape→template laissait `commentBody` undefined).
  it("AC#7 : sav_comment_from_operator (shape producer réel) → SMTP envoyé + mail.html contient le commentaire", async () => {
    state.outboxRows = [
      makeRow({
        id: 42,
        kind: 'sav_comment_from_operator',
        sav_id: 77,
        recipient_email: 'adherent@example.com',
        recipient_member_id: 100,
        subject: 'Nouveau commentaire SAV — SAV-2026-V113C',
        template_data: {
          savReference: 'SAV-2026-V113C',
          savId: 77,
          // Shape produite par enqueueOperatorCommentOutbox (outbox-helpers.ts) :
          //   - commentExcerpt = commentBody.slice(0, 140)
          //   - PAS de commentBody (le producer ne pose que l'excerpt).
          //   - memberFirstName ajouté par CR HIGH-2.
          commentExcerpt:
            'Bonjour, nous avons bien reçu votre dossier et nous le traitons cette semaine.',
          operatorDisplayName: 'Alice (SAV)',
          memberEmail: 'adherent@example.com',
          memberFirstName: 'Marie',
        },
      }),
    ]
    state.membersById.set(100, { id: 100, notification_prefs: { status_updates: true } })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const r = await runRetryEmails({ requestId: 'req-comment-op', savId: 77 })

    // 1) Le mail est parti — pas de unknown_kind, pas de failed définitif.
    expect(r.sent).toBe(1)
    expect(r.failed).toBe(0)
    expect(state.sendMailCalls).toHaveLength(1)

    // 2) Le mock RPC ne reçoit AUCUN mark_outbox_failed pour cette row.
    const failCalls = state.rpcCalls.filter(
      (c) => c.fn === 'mark_outbox_failed' && c.args['p_id'] === 42
    )
    expect(failCalls).toHaveLength(0)

    // 3) ASSERTION-LIAISON HIGH-3 : le body du commentaire (mappé depuis
    //    `commentExcerpt`) apparaît bien dans mail.html. Sans le mapping
    //    `commentBody = commentExcerpt` de render.ts, le template
    //    renderSavCommentAdded renvoie un bloc citation vide → cette
    //    assertion fail (faux-vert masqué par le spread).
    const mail = state.sendMailCalls[0]!
    expect(mail.html).toContain('bien reçu votre dossier')

    // 4) Greeting personnalisé membre (Bonjour Marie,) — confirme que
    //    `memberFirstName` est aussi propagé jusqu'au template (CR HIGH-2).
    expect(mail.html).toContain('Bonjour Marie')

    errorSpy.mockRestore()
  })

  it('AC#9 cap : scopé NE dépasse PAS attempts >= 5', async () => {
    state.outboxRows = [
      makeRow({
        id: 1,
        kind: 'sav_validated',
        sav_id: 12,
        status: 'failed',
        attempts: 5,
      }),
    ]
    state.membersById.set(100, { id: 100, notification_prefs: { status_updates: true } })

    const r = await runRetryEmails({ requestId: 'req-cap', savId: 12 })
    expect(r.scanned).toBe(0)
    expect(r.sent).toBe(0)
  })
})
