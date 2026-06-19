import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

interface CreditNoteRow {
  id: number
  sav_id: number
  member_id: number
  total_ttc_cents: number
  number_formatted: string
  pdf_web_url: string | null
}

interface MemberRow {
  id: number
  external_customer_id: string | null
  pennylane_customer_id: string | null
}

interface SavRow {
  id: number
  reference: string
}

interface WalletEventRow {
  id: number
  sav_id: number
  credit_note_id: number
  member_id: number
  outbox_id: number | null
  wallet_customer_id: string | null
  amount_ttc_cents: number
  transaction_detail: string
  smtp_message_id: string | null
  status: 'pending' | 'sent' | 'failed'
  attempts: number
  last_error: string | null
  wallet_response_status: number | null
  wallet_response_body: string | null
  sent_at: string | null
}

interface State {
  creditNotes: CreditNoteRow[]
  membersById: Map<number, MemberRow>
  savById: Map<number, SavRow>
  events: WalletEventRow[]
  existingCreditNoteIds: Set<number>
  existingEventStatusByCreditNoteId: Map<number, WalletEventRow['status']>
  fetchCalls: Array<{ url: string; init?: RequestInit }>
  fetchResponse: { ok: boolean; status: number; body: string }
  fetchThrows: Error | null
}

const state = vi.hoisted(
  () =>
    ({
      creditNotes: [],
      membersById: new Map(),
      savById: new Map(),
      events: [],
      existingCreditNoteIds: new Set(),
      existingEventStatusByCreditNoteId: new Map(),
      fetchCalls: [],
      fetchResponse: { ok: true, status: 200, body: '{"ok":true}' },
      fetchThrows: null,
    }) as State
)

vi.mock('../../../../../api/_lib/clients/supabase-admin', () => {
  function buildCreditNotesBuilder(): Record<string, unknown> {
    let savIdFilter: number | null = null
    const out: Record<string, unknown> = {}
    out['select'] = () => out
    out['eq'] = (col: string, val: unknown) => {
      if (col === 'sav_id') savIdFilter = val as number
      return out
    }
    out['order'] = () => out
    out['limit'] = () => {
      const rows = state.creditNotes
        .filter((row) => (savIdFilter === null ? true : row.sav_id === savIdFilter))
        .slice(0, 1)
      return Promise.resolve({ data: rows, error: null })
    }
    return out
  }

  function buildMembersBuilder(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    out['select'] = () => out
    out['eq'] = (_col: string, val: unknown) => {
      const row = state.membersById.get(val as number) ?? null
      return {
        single: () => Promise.resolve({ data: row, error: row ? null : { message: 'not found' } }),
      }
    }
    return out
  }

  function buildSavBuilder(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    out['select'] = () => out
    out['eq'] = (_col: string, val: unknown) => {
      const row = state.savById.get(val as number) ?? null
      return {
        single: () => Promise.resolve({ data: row, error: row ? null : { message: 'not found' } }),
      }
    }
    return out
  }

  function buildWalletEventsBuilder(): Record<string, unknown> {
    let updatePatch: Record<string, unknown> | null = null
    let selectedStatus = false
    let creditNoteIdFilter: number | null = null
    const out: Record<string, unknown> = {}
    out['select'] = (columns?: string) => {
      selectedStatus = columns === 'status'
      return out
    }
    out['insert'] = (payload: Record<string, unknown>) => {
      const creditNoteId = payload['credit_note_id'] as number
      if (state.existingCreditNoteIds.has(creditNoteId)) {
        return {
          select: () => ({
            single: () =>
              Promise.resolve({
                data: null,
                error: { code: '23505', message: 'duplicate key value violates unique constraint' },
              }),
          }),
        }
      }
      state.existingCreditNoteIds.add(creditNoteId)
      const id = state.events.length + 1
      state.events.push({
        id,
        sav_id: payload['sav_id'] as number,
        credit_note_id: creditNoteId,
        member_id: payload['member_id'] as number,
        outbox_id: (payload['outbox_id'] as number | null) ?? null,
        wallet_customer_id: (payload['wallet_customer_id'] as string | null) ?? null,
        amount_ttc_cents: payload['amount_ttc_cents'] as number,
        transaction_detail: payload['transaction_detail'] as string,
        smtp_message_id: (payload['smtp_message_id'] as string | null) ?? null,
        status: (payload['status'] as 'pending') ?? 'pending',
        attempts: 0,
        last_error: null,
        wallet_response_status: null,
        wallet_response_body: null,
        sent_at: null,
      })
      return {
        select: () => ({
          single: () => Promise.resolve({ data: { id }, error: null }),
        }),
      }
    }
    out['update'] = (patch: Record<string, unknown>) => {
      updatePatch = patch
      return out
    }
    out['eq'] = (_col: string, val: unknown) => {
      if (updatePatch !== null) {
        const target = state.events.find((event) => event.id === (val as number))
        if (target) {
          for (const [key, value] of Object.entries(updatePatch)) {
            ;(target as unknown as Record<string, unknown>)[key] = value
          }
        }
        updatePatch = null
        return Promise.resolve({ error: null })
      }
      if (selectedStatus && _col === 'credit_note_id') {
        creditNoteIdFilter = val as number
        return out
      }
      return out
    }
    out['maybeSingle'] = () => {
      const status =
        creditNoteIdFilter === null
          ? undefined
          : state.existingEventStatusByCreditNoteId.get(creditNoteIdFilter)
      return Promise.resolve({
        data: status ? { status } : null,
        error: null,
      })
    }
    return out
  }

  const client = {
    from: (table: string) => {
      if (table === 'credit_notes') return buildCreditNotesBuilder()
      if (table === 'members') return buildMembersBuilder()
      if (table === 'sav') return buildSavBuilder()
      if (table === 'wallet_credit_events') return buildWalletEventsBuilder()
      return {}
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  }

  return {
    supabaseAdmin: () => client,
    __resetSupabaseAdminForTests: () => undefined,
  }
})

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      state.fetchCalls.push({ url: String(url), ...(init ? { init } : {}) })
      if (state.fetchThrows) throw state.fetchThrows
      return {
        ok: state.fetchResponse.ok,
        status: state.fetchResponse.status,
        text: async () => state.fetchResponse.body,
      } as unknown as Response
    })
  )
}

async function loadModule(): Promise<{
  creditSavWalletAfterEmail: (input: {
    requestId: string
    outboxId: number
    savId: number | null
    smtpMessageId: string | null
  }) => Promise<unknown>
}> {
  return (await import('../../../../../api/_lib/clients/wallet-credit')) as unknown as {
    creditSavWalletAfterEmail: (input: {
      requestId: string
      outboxId: number
      savId: number | null
      smtpMessageId: string | null
    }) => Promise<unknown>
  }
}

function resetState(): void {
  state.creditNotes = []
  state.membersById = new Map()
  state.savById = new Map()
  state.events = []
  state.existingCreditNoteIds = new Set()
  state.existingEventStatusByCreditNoteId = new Map()
  state.fetchCalls = []
  state.fetchResponse = { ok: true, status: 200, body: '{"ok":true}' }
  state.fetchThrows = null
}

describe('creditSavWalletAfterEmail', () => {
  beforeEach(() => {
    resetState()
    process.env['WALLET_API_BASE_URL'] = 'https://wallet.example.test/api'
    process.env['WALLET_CONSUMER_KEY'] = 'consumer-key'
    process.env['WALLET_CONSUMER_SECRET'] = 'consumer-secret'
    stubFetch()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('happy path : insère l’événement et appelle le wallet avec la bonne charge utile', async () => {
    state.creditNotes = [
      {
        id: 11,
        sav_id: 12,
        member_id: 77,
        total_ttc_cents: 4567,
        number_formatted: 'AV-2026-00011',
        pdf_web_url: 'https://x/av.pdf',
      },
    ]
    state.membersById.set(77, {
      id: 77,
      external_customer_id: '9373',
      pennylane_customer_id: 'pn-cust-42',
    })
    state.savById.set(12, { id: 12, reference: 'SAV-2026-00012' })

    const { creditSavWalletAfterEmail } = await loadModule()
    await creditSavWalletAfterEmail({
      requestId: 'req-1',
      outboxId: 9001,
      savId: 12,
      smtpMessageId: null,
    })

    expect(state.events).toHaveLength(1)
    expect(state.events[0]).toMatchObject({
      credit_note_id: 11,
      status: 'sent',
      attempts: 1,
      wallet_customer_id: '9373',
      transaction_detail: 'SAV-2026-00012',
      smtp_message_id: null,
    })

    expect(state.fetchCalls).toHaveLength(1)
    expect(state.events[0]?.smtp_message_id).toBeNull()
    const call = state.fetchCalls[0]!
    expect(call.url).toBe('https://wallet.example.test/api/wallet/9373')
    expect(call.init?.method).toBe('POST')
    const body = JSON.parse(String(call.init?.body))
    expect(body).toMatchObject({
      amount: '45.67',
      action: 'credit',
      consumer_key: 'consumer-key',
      consumer_secret: 'consumer-secret',
      transaction_detail: 'SAV-2026-00012',
      payment_method: 'SAV Credit',
    })
  })

  it('wallet_customer_id manquant : journalise l’échec et ne contacte pas le wallet', async () => {
    state.creditNotes = [
      {
        id: 11,
        sav_id: 12,
        member_id: 77,
        total_ttc_cents: 4567,
        number_formatted: 'AV-2026-00011',
        pdf_web_url: 'https://x/av.pdf',
      },
    ]
    state.membersById.set(77, {
      id: 77,
      external_customer_id: null,
      pennylane_customer_id: null,
    })
    state.savById.set(12, { id: 12, reference: 'SAV-2026-00012' })

    const { creditSavWalletAfterEmail } = await loadModule()
    await creditSavWalletAfterEmail({
      requestId: 'req-2',
      outboxId: 9002,
      savId: 12,
      smtpMessageId: '<msg-2@x>',
    })

    expect(state.fetchCalls).toHaveLength(0)
    expect(state.events).toHaveLength(1)
    expect(state.events[0]).toMatchObject({
      status: 'failed',
      last_error: 'wallet_customer_id_missing',
    })
  })

  it('idempotence : un event déjà sent confirme le crédit sans recontacter le wallet', async () => {
    state.creditNotes = [
      {
        id: 11,
        sav_id: 12,
        member_id: 77,
        total_ttc_cents: 4567,
        number_formatted: 'AV-2026-00011',
        pdf_web_url: 'https://x/av.pdf',
      },
    ]
    state.membersById.set(77, {
      id: 77,
      external_customer_id: '9373',
      pennylane_customer_id: 'pn-cust-42',
    })
    state.savById.set(12, { id: 12, reference: 'SAV-2026-00012' })
    state.existingCreditNoteIds.add(11)
    state.existingEventStatusByCreditNoteId.set(11, 'sent')

    const { creditSavWalletAfterEmail } = await loadModule()
    const result = await creditSavWalletAfterEmail({
      requestId: 'req-3',
      outboxId: 9003,
      savId: 12,
      smtpMessageId: '<msg-3@x>',
    })

    expect(state.fetchCalls).toHaveLength(0)
    expect(state.events).toHaveLength(0)
    expect(result).toEqual({ ok: true })
  })

  it.each(['failed', 'pending'] as const)(
    'idempotence : un event %s ne confirme jamais le crédit',
    async (status) => {
      state.creditNotes = [
        {
          id: 11,
          sav_id: 12,
          member_id: 77,
          total_ttc_cents: 4567,
          number_formatted: 'AV-2026-00011',
          pdf_web_url: 'https://x/av.pdf',
        },
      ]
      state.membersById.set(77, {
        id: 77,
        external_customer_id: '9373',
        pennylane_customer_id: null,
      })
      state.savById.set(12, { id: 12, reference: 'SAV-2026-00012' })
      state.existingCreditNoteIds.add(11)
      state.existingEventStatusByCreditNoteId.set(11, status)

      const { creditSavWalletAfterEmail } = await loadModule()
      const result = await creditSavWalletAfterEmail({
        requestId: 'req-duplicate',
        outboxId: 9003,
        savId: 12,
        smtpMessageId: null,
      })

      expect(result).toMatchObject({
        ok: false,
        warning: { code: 'WALLET_DUPLICATE_NOT_CONFIRMED' },
      })
      expect(state.fetchCalls).toHaveLength(0)
    }
  )

  it('échec HTTP : marque failed avec le status et le body de réponse', async () => {
    state.creditNotes = [
      {
        id: 11,
        sav_id: 12,
        member_id: 77,
        total_ttc_cents: 4567,
        number_formatted: 'AV-2026-00011',
        pdf_web_url: 'https://x/av.pdf',
      },
    ]
    state.membersById.set(77, {
      id: 77,
      external_customer_id: '9373',
      pennylane_customer_id: 'pn-cust-42',
    })
    state.savById.set(12, { id: 12, reference: 'SAV-2026-00012' })
    state.fetchResponse = { ok: false, status: 502, body: '{"error":"bad gateway"}' }

    const { creditSavWalletAfterEmail } = await loadModule()
    await creditSavWalletAfterEmail({
      requestId: 'req-4',
      outboxId: 9004,
      savId: 12,
      smtpMessageId: '<msg-4@x>',
    })

    expect(state.events).toHaveLength(1)
    expect(state.events[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
      last_error: 'wallet_http_502',
      wallet_response_status: 502,
      wallet_response_body: '{"error":"bad gateway"}',
    })
  })

  it("faux succès métier : HTTP 200 + 'User does not exist' => failed", async () => {
    state.creditNotes = [
      {
        id: 11,
        sav_id: 12,
        member_id: 77,
        total_ttc_cents: 4567,
        number_formatted: 'AV-2026-00011',
        pdf_web_url: 'https://x/av.pdf',
      },
    ]
    state.membersById.set(77, {
      id: 77,
      external_customer_id: '9373',
      pennylane_customer_id: 'pn-cust-42',
    })
    state.savById.set(12, { id: 12, reference: 'SAV-2026-00012' })
    state.fetchResponse = { ok: true, status: 200, body: '"User does not exist"' }

    const { creditSavWalletAfterEmail } = await loadModule()
    const result = (await creditSavWalletAfterEmail({
      requestId: 'req-5',
      outboxId: 9005,
      savId: 12,
      smtpMessageId: '<msg-5@x>',
    })) as { ok?: boolean; warning?: { code?: string } }

    expect(result).toMatchObject({
      ok: false,
      warning: { code: 'WALLET_BUSINESS_FAILED' },
    })
    expect(state.events).toHaveLength(1)
    expect(state.events[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
      last_error: 'wallet_business_error:user_does_not_exist',
      wallet_response_status: 200,
      wallet_response_body: '"User does not exist"',
    })
  })
})
