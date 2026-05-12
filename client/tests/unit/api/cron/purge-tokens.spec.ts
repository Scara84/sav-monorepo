import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Story H-02 / AC#4 + AC#5(b) — Tests Vitest unit : runPurgeTokens (post-update D-2)
 *
 * Type : unit (mock supabaseAdmin — pattern dispatcher.spec.ts / threshold-alerts.spec.ts)
 * Rationale : runner TS réécrit H-02 D-2 — appelle désormais la RPC
 *   `purge_expired_magic_link_tokens()` (vs PostgREST .or(...) pré-H-02).
 *   Tests focalisés sur :
 *   (1) RPC name exact : 'purge_expired_magic_link_tokens' (mitigation R-1 typo)
 *   (2) shape retour { deleted: N } depuis mock RPC
 *   (3) propagation error → throw (bubble-up vers safeRun)
 *   (4) normalisation bigint string → number
 *   (5) log structuré 'cron.purge_tokens.success' INCHANGÉ (continuité métriques)
 *
 * Note : vi.setSystemTime non nécessaire — le cutoff est côté SQL (D-3 Option C).
 *   Pas de assert sur les colonnes .from()/.delete()/.or() — le runner n'utilise
 *   plus PostgREST mais uniquement .rpc() (body simplifié H-02 D-2).
 *
 * Signature runPurgeTokens inchangée : ({ requestId: string }) => Promise<{ deleted: number }>
 *   → 0 impact dispatcher.spec.ts mocks existants (AC#3 non-régression).
 */

// ── State hoisted pour les mocks ────────────────────────────────────────────

interface RpcResult {
  data: number | string | null
  error: { message: string } | null
}

const state = vi.hoisted(() => ({
  rpcResult: { data: 0 as number | string | null, error: null as { message: string } | null },
  rpcCallArgs: [] as string[],
}))

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  const client = {
    rpc: (name: string) => {
      state.rpcCallArgs.push(name)
      return Promise.resolve(state.rpcResult as RpcResult)
    },
    // from() est présent pour ne pas casser si le code essaie de l'appeler
    // (regression guard : post-H-02, runPurgeTokens NE DOIT PAS appeler .from())
    from: (table: string) => {
      throw new Error(
        `H-02 regression: runPurgeTokens ne doit plus appeler .from('${table}') post-D-2. Utiliser .rpc() uniquement.`
      )
    },
  }
  return { supabaseAdmin: () => client, __resetSupabaseAdminForTests: () => undefined }
})

// Logger mock
const loggerCalls = vi.hoisted(() => ({
  info: [] as Array<{ event: string; payload: Record<string, unknown> }>,
}))

vi.mock('../../../../api/_lib/logger', () => ({
  logger: {
    info: (event: string, payload: Record<string, unknown>) => {
      loggerCalls.info.push({ event, payload })
    },
    error: vi.fn(),
    warn: vi.fn(),
  },
}))

import { runPurgeTokens } from '../../../../api/_lib/cron-runners/purge-tokens'

function resetState(): void {
  state.rpcResult = { data: 0, error: null }
  state.rpcCallArgs = []
  loggerCalls.info = []
}

describe('runPurgeTokens (Story H-02 / AC#4 / W40 — update 24h → 7j via RPC D-2)', () => {
  beforeEach(() => {
    resetState()
  })

  // ── AC#5(b).1 — RPC retourne count → { deleted: N } ─────────────────────

  it('AC#5(b).1 — RPC purge_expired_magic_link_tokens retourne data=5 → { deleted: 5 }', async () => {
    state.rpcResult = { data: 5, error: null }

    const result = await runPurgeTokens({ requestId: 'req-h02-tok-1' })

    expect(result).toEqual({ deleted: 5 })
  })

  it('AC#5(b).1 — log structuré cron.purge_tokens.success INCHANGÉ avec { requestId, deleted }', async () => {
    state.rpcResult = { data: 5, error: null }

    await runPurgeTokens({ requestId: 'req-h02-tok-1' })

    expect(loggerCalls.info).toHaveLength(1)
    // Event name INCHANGÉ (continuité métriques Datadog/Vercel Logs — AC#4 (c))
    expect(loggerCalls.info[0]!.event).toBe('cron.purge_tokens.success')
    expect(loggerCalls.info[0]!.payload).toMatchObject({
      requestId: 'req-h02-tok-1',
      deleted: 5,
    })
  })

  // ── AC#5(b).2 — Throw sur erreur RPC ─────────────────────────────────────

  it('AC#5(b).2 — error non-null → throw (bubble-up vers safeRun)', async () => {
    state.rpcResult = { data: null, error: { message: 'rpc magic link kaboom' } }

    await expect(runPurgeTokens({ requestId: 'req-h02-tok-2' })).rejects.toThrow()
  })

  it('AC#5(b).2 — error non-null → aucun success log', async () => {
    state.rpcResult = { data: null, error: { message: 'rpc magic link kaboom' } }

    try {
      await runPurgeTokens({ requestId: 'req-h02-tok-2' })
    } catch {
      // expected
    }

    expect(loggerCalls.info).toHaveLength(0)
  })

  // ── AC#5(b).3 — RPC name exact (mitigation R-1 typo) ─────────────────────
  // Defense-in-depth : intercept l'argument passé à .rpc()
  // assert string === 'purge_expired_magic_link_tokens'

  it("AC#5(b).3 — RPC name exact : rpc() appelée avec 'purge_expired_magic_link_tokens' (mitigation R-1 typo)", async () => {
    state.rpcResult = { data: 0, error: null }

    await runPurgeTokens({ requestId: 'req-h02-tok-3' })

    expect(state.rpcCallArgs).toHaveLength(1)
    expect(state.rpcCallArgs[0]).toBe('purge_expired_magic_link_tokens')
  })

  // ── Normalisation bigint string → number ──────────────────────────────────

  it("data='99' (string bigint) → { deleted: 99 } (normalisation Number())", async () => {
    state.rpcResult = { data: '99', error: null }

    const result = await runPurgeTokens({ requestId: 'req-h02-tok-4' })

    expect(result).toEqual({ deleted: 99 })
  })

  it('data=null → { deleted: 0 } (guard ?? 0)', async () => {
    state.rpcResult = { data: null, error: null }

    const result = await runPurgeTokens({ requestId: 'req-h02-tok-4b' })

    expect(result).toEqual({ deleted: 0 })
  })

  // ── Non-régression : pas de .from() PostgREST ────────────────────────────
  // Post-D-2, le runner ne doit plus construire de chaîne .from().delete().or()
  // Le mock jette une erreur si .from() est appelé.

  it('non-régression D-2 — runPurgeTokens ne doit plus appeler .from() PostgREST post-H-02', async () => {
    state.rpcResult = { data: 0, error: null }

    // Si .from() est appelé, le mock throw → test fail via rejects
    await expect(runPurgeTokens({ requestId: 'req-h02-tok-5' })).resolves.not.toThrow()
  })

  // ── Signature contractuelle inchangée ─────────────────────────────────────

  it('AC#4 (b) — signature ({ requestId }) → Promise<{ deleted: number }> inchangée', async () => {
    state.rpcResult = { data: 12, error: null }

    const result = await runPurgeTokens({ requestId: 'req-h02-tok-6' })

    expect(result).toHaveProperty('deleted')
    expect(typeof result.deleted).toBe('number')
    expect(result.deleted).toBe(12)
  })
})
