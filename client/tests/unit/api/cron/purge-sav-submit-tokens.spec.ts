import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Story H-02 / AC#2 + AC#5(a) — Tests Vitest unit : runPurgeSavSubmitTokens
 *
 * Type : unit (mock supabaseAdmin — pattern dispatcher.spec.ts / threshold-alerts.spec.ts)
 * Rationale : runner TS minimal (.rpc() + log) — test focus sur :
 *   (1) shape de la réponse { deleted } depuis mock RPC
 *   (2) propagation error → throw (bubble-up vers safeRun)
 *   (3) normalisation data bigint string → number (Number(data ?? 0))
 *   (4) RPC name exact : 'purge_expired_sav_submit_tokens' (mitigation R-1 typo)
 *   (5) log structuré : event 'cron.purge_sav_submit_tokens.success' avec { requestId, deleted }
 *
 * vi.setSystemTime non nécessaire : le cutoff 7j est calculé côté SQL dans la RPC,
 * le runner TS ne manipule pas de date (D-3 Option C — pattern PATTERN-H02-CRON-RUNNER-PURGE-VIA-RPC-SECURITY-DEFINER).
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
  }
  return { supabaseAdmin: () => client, __resetSupabaseAdminForTests: () => undefined }
})

// Logger mock — capture les appels logger.info pour vérifier l'event name
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

import { runPurgeSavSubmitTokens } from '../../../../api/_lib/cron-runners/purge-sav-submit-tokens'

function resetState(): void {
  state.rpcResult = { data: 0, error: null }
  state.rpcCallArgs = []
  loggerCalls.info = []
}

describe('runPurgeSavSubmitTokens (Story H-02 / AC#2 / W78)', () => {
  beforeEach(() => {
    resetState()
  })

  // ── AC#5(a).1 — RPC retourne count → { deleted: N } ─────────────────────

  it('AC#5(a).1 — RPC retourne data=3 → { deleted: 3 }', async () => {
    state.rpcResult = { data: 3, error: null }

    const result = await runPurgeSavSubmitTokens({ requestId: 'req-h02-sav-1' })

    expect(result).toEqual({ deleted: 3 })
  })

  it('AC#5(a).1 — log structuré cron.purge_sav_submit_tokens.success avec { requestId, deleted }', async () => {
    state.rpcResult = { data: 3, error: null }

    await runPurgeSavSubmitTokens({ requestId: 'req-h02-sav-1' })

    expect(loggerCalls.info).toHaveLength(1)
    expect(loggerCalls.info[0]!.event).toBe('cron.purge_sav_submit_tokens.success')
    expect(loggerCalls.info[0]!.payload).toMatchObject({
      requestId: 'req-h02-sav-1',
      deleted: 3,
    })
  })

  // ── AC#5(a).2 — Throw sur erreur Supabase ────────────────────────────────

  it('AC#5(a).2 — error non-null → throw (bubble-up vers safeRun dispatcher)', async () => {
    state.rpcResult = { data: null, error: { message: 'rpc kaboom' } }

    await expect(runPurgeSavSubmitTokens({ requestId: 'req-h02-sav-2' })).rejects.toThrow()
  })

  it('AC#5(a).2 — error non-null → aucun logger.info (pas de success log sur erreur)', async () => {
    state.rpcResult = { data: null, error: { message: 'rpc kaboom' } }

    try {
      await runPurgeSavSubmitTokens({ requestId: 'req-h02-sav-2' })
    } catch {
      // expected
    }

    expect(loggerCalls.info).toHaveLength(0)
  })

  // ── AC#5(a).3 — Normalise data string en number ──────────────────────────
  // Defense-in-depth bigint serialization : supabase-js peut retourner string
  // sur les très grands counts (PG bigint → JSON string). Number(data ?? 0) normalise.

  it("AC#5(a).3 — data='42' (string bigint) → { deleted: 42 } (normalisation Number())", async () => {
    state.rpcResult = { data: '42', error: null }

    const result = await runPurgeSavSubmitTokens({ requestId: 'req-h02-sav-3' })

    expect(result).toEqual({ deleted: 42 })
  })

  it('AC#5(a).3 — data=null → { deleted: 0 } (guard ?? 0)', async () => {
    state.rpcResult = { data: null, error: null }

    const result = await runPurgeSavSubmitTokens({ requestId: 'req-h02-sav-3b' })

    expect(result).toEqual({ deleted: 0 })
  })

  // ── AC#5(a) RPC name exact ────────────────────────────────────────────────
  // Mitigation R-1 typo : intercept l'argument passé à .rpc()
  // assert string === 'purge_expired_sav_submit_tokens'

  it("AC#5(a) RPC name exact : rpc() appelée avec 'purge_expired_sav_submit_tokens' (mitigation R-1 typo)", async () => {
    state.rpcResult = { data: 0, error: null }

    await runPurgeSavSubmitTokens({ requestId: 'req-h02-sav-4' })

    expect(state.rpcCallArgs).toHaveLength(1)
    expect(state.rpcCallArgs[0]).toBe('purge_expired_sav_submit_tokens')
  })

  // ── AC#2 — Signature contractuelle ──────────────────────────────────────
  // ({ requestId: string }) => Promise<{ deleted: number }>

  it('AC#2 — retour shape { deleted: number } (type contractuel)', async () => {
    state.rpcResult = { data: 7, error: null }

    const result = await runPurgeSavSubmitTokens({ requestId: 'req-h02-sav-5' })

    expect(result).toHaveProperty('deleted')
    expect(typeof result.deleted).toBe('number')
  })

  it('AC#2 — data=0 → { deleted: 0 } (aucune row purgée)', async () => {
    state.rpcResult = { data: 0, error: null }

    const result = await runPurgeSavSubmitTokens({ requestId: 'req-h02-sav-6' })

    expect(result).toEqual({ deleted: 0 })
    expect(loggerCalls.info[0]!.payload['deleted']).toBe(0)
  })
})
