import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Story 6.5 Task 5 — `requireActiveManager(memberId)`.
 *
 * Defense-in-depth Layer 2 : check DB que `members.is_group_manager = true`
 * AVANT d'appliquer un filtre `scope=group`. Bloque les managers révoqués
 * dont le JWT (24h cookie) reste valide post-révocation.
 */

const db = vi.hoisted(() => ({
  row: null as null | {
    is_group_manager: boolean | null
    anonymized_at: string | null
    group_id: number | null
  },
  error: null as null | { code?: string },
}))

vi.mock('../../../../../api/_lib/clients/supabase-admin', () => {
  const client = {
    from: (table: string) => {
      if (table !== 'members') return {} as unknown
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: db.row, error: db.error }),
          }),
        }),
      }
    },
  }
  return {
    supabaseAdmin: () => client,
    __resetSupabaseAdminForTests: () => undefined,
  }
})

describe('requireActiveManager (Story 6.5)', () => {
  beforeEach(() => {
    db.row = null
    db.error = null
  })

  it('member actif manager → { active:true, groupId:N }', async () => {
    db.row = { is_group_manager: true, anonymized_at: null, group_id: 5 }
    const { requireActiveManager } = await import('../../../../../api/_lib/auth/manager-check')
    expect(await requireActiveManager(42)).toEqual({ active: true, groupId: 5 })
  })

  it('member actif manager sans group_id → { active:true, groupId:null }', async () => {
    db.row = { is_group_manager: true, anonymized_at: null, group_id: null }
    const { requireActiveManager } = await import('../../../../../api/_lib/auth/manager-check')
    expect(await requireActiveManager(42)).toEqual({ active: true, groupId: null })
  })

  it('member révoqué (is_group_manager=false) → { active:false, groupId:null }', async () => {
    db.row = { is_group_manager: false, anonymized_at: null, group_id: 5 }
    const { requireActiveManager } = await import('../../../../../api/_lib/auth/manager-check')
    expect(await requireActiveManager(42)).toEqual({ active: false, groupId: null })
  })

  it('member anonymisé → { active:false } (même si flag manager)', async () => {
    db.row = {
      is_group_manager: true,
      anonymized_at: '2026-04-01T00:00:00Z',
      group_id: 5,
    }
    const { requireActiveManager } = await import('../../../../../api/_lib/auth/manager-check')
    expect(await requireActiveManager(42)).toEqual({ active: false, groupId: null })
  })

  it('member inexistant (data null) → { active:false }', async () => {
    db.row = null
    const { requireActiveManager } = await import('../../../../../api/_lib/auth/manager-check')
    expect(await requireActiveManager(42)).toEqual({ active: false, groupId: null })
  })

  it('erreur Supabase → { active:false } (fail-closed)', async () => {
    db.row = null
    db.error = { code: 'PGRST500' }
    const { requireActiveManager } = await import('../../../../../api/_lib/auth/manager-check')
    expect(await requireActiveManager(42)).toEqual({ active: false, groupId: null })
  })

  it('memberId non-positif → { active:false } (sans appel DB)', async () => {
    const { requireActiveManager } = await import('../../../../../api/_lib/auth/manager-check')
    expect(await requireActiveManager(0)).toEqual({ active: false, groupId: null })
    expect(await requireActiveManager(-1)).toEqual({ active: false, groupId: null })
    expect(await requireActiveManager(Number.NaN)).toEqual({ active: false, groupId: null })
  })
})
