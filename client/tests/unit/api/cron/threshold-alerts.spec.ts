import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Story 5.5 AC #12 — tests Vitest du runner threshold-alerts (post CR).
 *
 * Architecture après CR adversarial 2026-04-28 :
 *   - INSERT trace + INSERT batch outbox sont fusionnés dans la RPC
 *     transactionnelle `enqueue_threshold_alert` (Decision 1 CR).
 *   - Les échecs par produit sont isolés (try/catch + `alerts_failed`)
 *     plutôt que de throw (résilience cron).
 *   - Validation/normalisation `recipient_email` (CRLF strip + regex).
 *   - NaN/SafeInteger guards sur les valeurs RPC.
 *
 * Le mock expose un client supabaseAdmin minimal qui simule :
 *   - settings : `from('settings').select().eq().is().order().limit().maybeSingle()`
 *   - operators : `from('operators').select().eq().in().order()`
 *   - rpc('report_products_over_threshold')
 *   - rpc('enqueue_threshold_alert') → renvoie {trace_id, alerts_enqueued}
 *   - dedup query : `from('threshold_alert_sent').select().eq().gte().limit().maybeSingle()`
 *   - product : `from('products').select().eq().maybeSingle()`
 *   - refs : `from('sav_lines').select().eq().gte().order().limit()`
 */

interface State {
  settingsValue: unknown
  settingsError: { message: string } | null
  operators: Array<{ email: string }>
  operatorsError: { message: string } | null
  rpcRows: Array<{ product_id: number | string; sav_count: number | string }>
  rpcError: { message: string } | null
  /** Map productId → already-sent within dedup window? */
  dedupHits: Set<number>
  productsById: Map<number, { id: number; code: string; name_fr: string }>
  refsByProduct: Map<number, Array<{ sav: { id: number; reference: string; received_at: string } }>>
  enqueueCalls: Array<Record<string, unknown>>
  enqueueError: { message: string } | null
  /** trace id sequence */
  nextTraceId: number
}

const state = vi.hoisted(
  () =>
    ({
      settingsValue: { count: 5, days: 7, dedup_hours: 24 },
      settingsError: null,
      operators: [{ email: 'admin@example.com' }, { email: 'op@example.com' }],
      operatorsError: null,
      rpcRows: [],
      rpcError: null,
      dedupHits: new Set<number>(),
      productsById: new Map(),
      refsByProduct: new Map(),
      enqueueCalls: [],
      enqueueError: null,
      nextTraceId: 1000,
    }) as State
)

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  function buildSettingsBuilder(): unknown {
    const out = {
      select: () => out,
      eq: () => out,
      is: () => out,
      order: () => out,
      limit: () => out,
      maybeSingle: () =>
        Promise.resolve({
          data:
            state.settingsValue === null || state.settingsValue === undefined
              ? null
              : { value: state.settingsValue },
          error: state.settingsError,
        }),
    }
    return out
  }

  function buildOperatorsBuilder(): unknown {
    const out = {
      select: () => out,
      eq: () => out,
      in: () => out,
      order: () =>
        Promise.resolve({
          data: state.operators,
          error: state.operatorsError,
        }),
    }
    return out
  }

  function buildDedupBuilder(): unknown {
    let pid = 0
    const out = {
      select: () => out,
      eq: (col: string, val: unknown) => {
        if (col === 'product_id') pid = val as number
        return out
      },
      gte: () => out,
      limit: () => out,
      maybeSingle: () => {
        const hit = state.dedupHits.has(pid)
        return Promise.resolve({
          data: hit ? { id: 1 } : null,
          error: null,
        })
      },
    }
    return out
  }

  function buildProductBuilder(): unknown {
    let pid = 0
    const out = {
      select: () => out,
      eq: (_col: string, val: unknown) => {
        pid = val as number
        return out
      },
      maybeSingle: () => {
        const product = state.productsById.get(pid) ?? null
        return Promise.resolve({ data: product, error: null })
      },
    }
    return out
  }

  function buildRefsBuilder(): unknown {
    let pid = 0
    const out = {
      select: () => out,
      eq: (_col: string, val: unknown) => {
        pid = val as number
        return out
      },
      gte: () => out,
      order: () => out,
      limit: () => Promise.resolve({ data: state.refsByProduct.get(pid) ?? [], error: null }),
    }
    return out
  }

  function from(table: string): unknown {
    if (table === 'settings') return buildSettingsBuilder()
    if (table === 'operators') return buildOperatorsBuilder()
    if (table === 'products') return buildProductBuilder()
    if (table === 'sav_lines') return buildRefsBuilder()
    if (table === 'threshold_alert_sent') return buildDedupBuilder()
    throw new Error(`Unmocked table: ${table}`)
  }

  function rpc(fn: string, args: Record<string, unknown>): unknown {
    if (fn === 'report_products_over_threshold') {
      return Promise.resolve({ data: state.rpcRows, error: state.rpcError })
    }
    if (fn === 'enqueue_threshold_alert') {
      // L'appelant chaîne `.single<...>()` → on retourne un thenable
      // qui expose aussi `single()`.
      const trace_id = state.nextTraceId++
      const recipients = (args['p_recipients'] as string[]) ?? []
      const result = {
        trace_id,
        alerts_enqueued: recipients.length,
      }
      state.enqueueCalls.push({ ...args, _trace_id: trace_id })
      const err = state.enqueueError
      const built = {
        single: () => Promise.resolve({ data: err ? null : result, error: err }),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: err ? null : result, error: err }).then(resolve),
      }
      return built
    }
    return Promise.resolve({ data: [], error: null })
  }

  const client = { from, rpc }
  return { supabaseAdmin: () => client, __resetSupabaseAdminForTests: () => undefined }
})

import { runThresholdAlerts } from '../../../../api/_lib/cron-runners/threshold-alerts'

function resetState(): void {
  state.settingsValue = { count: 5, days: 7, dedup_hours: 24 }
  state.settingsError = null
  state.operators = [{ email: 'admin@example.com' }, { email: 'op@example.com' }]
  state.operatorsError = null
  state.rpcRows = []
  state.rpcError = null
  state.dedupHits = new Set<number>()
  state.productsById = new Map()
  state.refsByProduct = new Map()
  state.enqueueCalls = []
  state.enqueueError = null
  state.nextTraceId = 1000
}

describe('runThresholdAlerts', () => {
  beforeEach(() => {
    resetState()
  })

  it('happy path : 1 produit dépassant → 1 RPC enqueue avec 2 destinataires', async () => {
    state.rpcRows = [{ product_id: 42, sav_count: 6 }]
    state.productsById.set(42, { id: 42, code: 'P42', name_fr: 'Pomme golden' })

    const result = await runThresholdAlerts({ requestId: 'req-1' })
    expect(result.products_over_threshold).toBe(1)
    expect(result.alerts_enqueued).toBe(2)
    expect(result.alerts_skipped_dedup).toBe(0)
    expect(result.alerts_failed).toBe(0)
    expect(result.settings_used).toEqual({ count: 5, days: 7, dedup_hours: 24 })
    expect(state.enqueueCalls).toHaveLength(1)
    expect(state.enqueueCalls[0]).toMatchObject({
      p_product_id: 42,
      p_count_at_trigger: 6,
      p_settings_count: 5,
      p_settings_days: 7,
      p_recipients: ['admin@example.com', 'op@example.com'],
    })
  })

  it('happy path : 0 produit dépassant → aucun appel enqueue', async () => {
    state.rpcRows = []
    const result = await runThresholdAlerts({ requestId: 'req-2' })
    expect(result.products_over_threshold).toBe(0)
    expect(result.alerts_enqueued).toBe(0)
    expect(state.enqueueCalls).toHaveLength(0)
  })

  it('dédup : 1 trace récente → skip + alerts_skipped_dedup', async () => {
    state.rpcRows = [{ product_id: 42, sav_count: 6 }]
    state.productsById.set(42, { id: 42, code: 'P42', name_fr: 'Pomme golden' })
    state.dedupHits.add(42)
    const result = await runThresholdAlerts({ requestId: 'req-3' })
    expect(result.alerts_enqueued).toBe(0)
    expect(result.alerts_skipped_dedup).toBe(1)
    expect(state.enqueueCalls).toHaveLength(0)
  })

  it('multi-produits : 3 produits × 2 operators = 6 emails enqueues (3 RPC calls)', async () => {
    state.rpcRows = [
      { product_id: 10, sav_count: 8 },
      { product_id: 20, sav_count: 7 },
      { product_id: 30, sav_count: 6 },
    ]
    state.productsById.set(10, { id: 10, code: 'P10', name_fr: 'Citron' })
    state.productsById.set(20, { id: 20, code: 'P20', name_fr: 'Banane' })
    state.productsById.set(30, { id: 30, code: 'P30', name_fr: 'Pêche' })
    const result = await runThresholdAlerts({ requestId: 'req-4' })
    expect(result.products_over_threshold).toBe(3)
    expect(result.alerts_enqueued).toBe(6)
    expect(state.enqueueCalls).toHaveLength(3)
  })

  it('aucun operator actif : RPC enqueue appelé avec recipients=[] (audit trace préservée)', async () => {
    state.rpcRows = [{ product_id: 42, sav_count: 6 }]
    state.productsById.set(42, { id: 42, code: 'P42', name_fr: 'Pomme golden' })
    state.operators = []
    const result = await runThresholdAlerts({ requestId: 'req-5' })
    expect(result.alerts_enqueued).toBe(0)
    expect(result.products_over_threshold).toBe(1)
    expect(state.enqueueCalls).toHaveLength(1)
    expect(state.enqueueCalls[0]?.['p_recipients']).toEqual([])
  })

  it('settings absent → throw SETTINGS_MISSING_THRESHOLD_ALERT', async () => {
    state.settingsValue = null
    await expect(runThresholdAlerts({ requestId: 'req-6' })).rejects.toThrow(
      /SETTINGS_MISSING_THRESHOLD_ALERT/
    )
  })

  it('settings corrompu (count=0) → throw SETTINGS_INVALID_THRESHOLD_ALERT', async () => {
    state.settingsValue = { count: 0, days: 7, dedup_hours: 24 }
    await expect(runThresholdAlerts({ requestId: 'req-7' })).rejects.toThrow(
      /SETTINGS_INVALID_THRESHOLD_ALERT/
    )
  })

  it('idempotence : 2 runs successifs → dédup bloque le 2e via dedupHits', async () => {
    state.rpcRows = [{ product_id: 42, sav_count: 6 }]
    state.productsById.set(42, { id: 42, code: 'P42', name_fr: 'Pomme golden' })

    const r1 = await runThresholdAlerts({ requestId: 'req-8a' })
    expect(r1.alerts_enqueued).toBe(2)
    expect(state.enqueueCalls).toHaveLength(1)

    state.dedupHits.add(42)
    const r2 = await runThresholdAlerts({ requestId: 'req-8b' })
    expect(r2.alerts_enqueued).toBe(0)
    expect(r2.alerts_skipped_dedup).toBe(1)
  })

  it('CR T3 — RPC enqueue échoue → alerts_failed incrémenté, pas de throw global', async () => {
    state.rpcRows = [
      { product_id: 42, sav_count: 6 },
      { product_id: 43, sav_count: 7 },
    ]
    state.productsById.set(42, { id: 42, code: 'P42', name_fr: 'Pomme' })
    state.productsById.set(43, { id: 43, code: 'P43', name_fr: 'Poire' })
    state.enqueueError = { message: 'db down' }
    const result = await runThresholdAlerts({ requestId: 'req-9' })
    expect(result.alerts_failed).toBe(2)
    expect(result.alerts_enqueued).toBe(0)
    // 2 produits → 2 tentatives d'enqueue (résilience per-product), pas d'abandon.
    expect(state.enqueueCalls).toHaveLength(2)
  })

  it('settings limites Zod : days=400 rejeté', async () => {
    state.settingsValue = { count: 5, days: 400, dedup_hours: 24 }
    await expect(runThresholdAlerts({ requestId: 'req-10' })).rejects.toThrow(
      /SETTINGS_INVALID_THRESHOLD_ALERT/
    )
  })

  it('CR R16 — RPC renvoie sav_count NaN/non-numeric → produit comptabilisé alerts_failed', async () => {
    state.rpcRows = [
      { product_id: 42, sav_count: 'abc' },
      { product_id: 43, sav_count: 7 },
    ]
    state.productsById.set(43, { id: 43, code: 'P43', name_fr: 'Poire' })
    const result = await runThresholdAlerts({ requestId: 'req-11' })
    expect(result.alerts_failed).toBe(1) // 42 invalid
    expect(result.alerts_enqueued).toBe(2) // 43 OK × 2 ops
    expect(state.enqueueCalls).toHaveLength(1)
    expect(state.enqueueCalls[0]).toMatchObject({ p_product_id: 43 })
  })

  it('CR S3 — emails operators avec CRLF/uppercase/whitespace sont normalisés et dédupés', async () => {
    state.operators = [
      { email: '  Admin@Example.com  ' },
      { email: 'admin@example.com' }, // dup post normalize
      { email: 'op@example.com\r\n' }, // CRLF strip
      { email: 'invalid-no-at' }, // rejeté
    ]
    state.rpcRows = [{ product_id: 42, sav_count: 6 }]
    state.productsById.set(42, { id: 42, code: 'P42', name_fr: 'Pomme' })
    const result = await runThresholdAlerts({ requestId: 'req-12' })
    // 2 emails uniques valides : admin@example.com + op@example.com
    expect(result.alerts_enqueued).toBe(2)
    expect(state.enqueueCalls[0]?.['p_recipients']).toEqual(['admin@example.com', 'op@example.com'])
  })
})
