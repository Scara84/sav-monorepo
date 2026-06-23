import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  insert: vi.fn(),
  from: vi.fn(),
}))

vi.mock('../../../../../api/_lib/clients/supabase-admin', () => ({
  supabaseAdmin: () => ({ from: state.from }),
}))

import { recordAudit } from '../../../../../api/_lib/audit/record'

describe('recordAudit', () => {
  beforeEach(() => {
    state.insert.mockReset().mockResolvedValue({ error: null })
    state.from.mockReset().mockImplementation(() => ({ insert: state.insert }))
  })

  it('insère une ligne audit_trail avec les champs requis', async () => {
    await recordAudit({
      entityType: 'sav',
      entityId: 42,
      action: 'status_changed',
      actorOperatorId: 7,
      diff: { before: { status: 'received' }, after: { status: 'in_progress' } },
    })
    expect(state.from).toHaveBeenCalledWith('audit_trail')
    expect(state.insert).toHaveBeenCalledWith({
      entity_type: 'sav',
      entity_id: 42,
      action: 'status_changed',
      actor_operator_id: 7,
      diff: { before: { status: 'received' }, after: { status: 'in_progress' } },
    })
  })

  it('omet les champs optionnels absents (exactOptionalPropertyTypes)', async () => {
    await recordAudit({ entityType: 'members', entityId: 1, action: 'anonymized' })
    expect(state.insert).toHaveBeenCalledWith({
      entity_type: 'members',
      entity_id: 1,
      action: 'anonymized',
    })
  })

  it('propage les erreurs Supabase', async () => {
    state.insert.mockResolvedValueOnce({ error: new Error('rls blocked') })
    await expect(
      recordAudit({ entityType: 'sav', entityId: 1, action: 'created' })
    ).rejects.toThrow('rls blocked')
  })
})
