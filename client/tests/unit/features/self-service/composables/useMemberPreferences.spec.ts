import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMemberPreferences } from '../../../../../src/features/self-service/composables/useMemberPreferences'

const profile = { user: { isGroupManager: true } }
const choices = { status_updates: false, weekly_recap: true }
const response = { data: { notificationPrefs: choices } }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('Lecture des préférences', () => {
  it.each([
    [new Response(null, { status: 403 }), Response.json(response)],
    [Response.json(profile), new Response(null, { status: 503 })],
    [Response.json({ user: {} }), Response.json(response)],
    [Response.json(profile), Response.json({ data: {} })],
  ])('permet une nouvelle lecture après une réponse inutilisable', async (me, preferences) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(me)
        .mockResolvedValueOnce(preferences)
        .mockResolvedValueOnce(Response.json(profile))
        .mockResolvedValueOnce(Response.json(response))
    )
    const state = useMemberPreferences()
    await state.load()
    expect(state.error.value).toBe('load')
    expect(state.prefs.value).toBeNull()
    await state.load()
    expect(state.error.value).toBeNull()
    expect(state.isManager.value).toBe(true)
    expect(state.prefs.value).toEqual(choices)
  })

  it('retire la confirmation précédente lors d’un nouvel enregistrement refusé', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(response))
        .mockResolvedValueOnce(new Response(null, { status: 403 }))
    )
    const state = useMemberPreferences()
    await state.save(choices)
    expect(state.toastMsg.value).toBe('Préférences enregistrées')
    await state.save(choices)
    expect(state.error.value).toBe('save')
    expect(state.toastMsg.value).toBeNull()
  })
})
