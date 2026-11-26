import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { defineComponent } from 'vue'

/**
 * Story 6.4 — TDD RED PHASE — `MemberPreferencesView.vue`.
 *
 * Cible AC #6, #7, #9, #11 :
 *   - 2 toggles : status_updates (défaut true) + weekly_recap (défaut false)
 *   - GET /api/self-service/preferences au mount → état initial
 *   - PATCH /api/self-service/preferences à la soumission → toast succès
 *   - Si erreur PATCH → message + bouton retry
 *   - Si non-manager (`isGroupManager === false`) → toggle weekly_recap masqué
 *     ou disabled + tooltip
 *
 * Tous les cas DOIVENT échouer tant que :
 *   - `client/src/features/self-service/views/MemberPreferencesView.vue` n'existe pas
 *   - `client/src/features/self-service/composables/useMemberPreferences.ts` non créé
 *
 * 5 cas listés Story 6.4 AC #13 :
 *   1. load initial state
 *   2. toggle status_updates
 *   3. save success → toast
 *   4. save error → retry visible
 *   5. weekly_recap disabled si non-manager
 */

const StubLayout = defineComponent({ template: '<div><slot /></div>' })

function makeRouter(component: ReturnType<typeof defineComponent>) {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/monespace', name: 'member-sav-list', component: StubLayout },
      { path: '/monespace/preferences', name: 'member-preferences', component },
    ],
  })
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    headers: new Headers(),
  } as unknown as Response
}

const originalFetch = globalThis.fetch

const PREFS_INITIAL_RESPONSE = {
  data: {
    notificationPrefs: {
      status_updates: true,
      weekly_recap: false,
    },
  },
}

const ME_RESPONSE_MANAGER = {
  user: { sub: 42, type: 'member', isGroupManager: true },
}

const ME_RESPONSE_NON_MANAGER = {
  user: { sub: 42, type: 'member', isGroupManager: false },
}

// Vite-static-analyzer friendly : la vue n'existe pas encore (RED phase),
// on évite que la collecte échoue en passant par une string variable.
const VIEW_PATH = '../../../../src/features/self-service/views/MemberPreferencesView.vue'
async function mountView() {
  // Import dynamique — DOIT throw tant que la vue n'existe pas
  const mod = (await import(/* @vite-ignore */ VIEW_PATH)) as {
    default: ReturnType<typeof defineComponent>
  }
  const MemberPreferencesView = mod.default
  const router = makeRouter(MemberPreferencesView)
  await router.push('/monespace/preferences')
  await router.isReady()
  return mount(MemberPreferencesView, {
    global: { plugins: [router] },
  })
}

describe('MemberPreferencesView (Story 6.4)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.useRealTimers()
  })

  it("AC#6 (1) charge l'état initial via GET /api/self-service/preferences", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (typeof url === 'string' && url.includes('/api/auth/me')) {
        return Promise.resolve(jsonResponse(200, ME_RESPONSE_MANAGER))
      }
      return Promise.resolve(jsonResponse(200, PREFS_INITIAL_RESPONSE))
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    const wrapper = await mountView()
    await flushPromises()
    expect(fetchMock).toHaveBeenCalled()
    const calledPrefsGet = fetchMock.mock.calls.some(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('/api/self-service/preferences')
    )
    expect(calledPrefsGet).toBe(true)
    // Toggles refletent l'état initial
    const statusToggle = wrapper.find('[data-testid="toggle-status-updates"]')
    expect(statusToggle.exists()).toBe(true)
    expect((statusToggle.element as HTMLInputElement).checked).toBe(true)
    const weeklyToggle = wrapper.find('[data-testid="toggle-weekly-recap"]')
    expect(weeklyToggle.exists()).toBe(true)
    expect((weeklyToggle.element as HTMLInputElement).checked).toBe(false)
  })

  it("AC#7 (2) toggle status_updates change l'état local du formulaire", async () => {
    globalThis.fetch = vi.fn((url: string) => {
      if (typeof url === 'string' && url.includes('/api/auth/me')) {
        return Promise.resolve(jsonResponse(200, ME_RESPONSE_MANAGER))
      }
      return Promise.resolve(jsonResponse(200, PREFS_INITIAL_RESPONSE))
    }) as unknown as typeof globalThis.fetch
    const wrapper = await mountView()
    await flushPromises()
    const statusToggle = wrapper.find('[data-testid="toggle-status-updates"]')
    expect((statusToggle.element as HTMLInputElement).checked).toBe(true)
    await statusToggle.setValue(false)
    expect((statusToggle.element as HTMLInputElement).checked).toBe(false)
  })

  it('AC#7 (3) submit appelle PATCH + affiche toast "Préférences enregistrées" 3s', async () => {
    const fetchMock = vi.fn((url: string, opts?: { method?: string; body?: string }) => {
      if (typeof url === 'string' && url.includes('/api/auth/me')) {
        return Promise.resolve(jsonResponse(200, ME_RESPONSE_MANAGER))
      }
      if ((opts?.method ?? 'GET') === 'PATCH') {
        return Promise.resolve(
          jsonResponse(200, {
            data: {
              notificationPrefs: { status_updates: false, weekly_recap: false },
            },
          })
        )
      }
      return Promise.resolve(jsonResponse(200, PREFS_INITIAL_RESPONSE))
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    const wrapper = await mountView()
    await flushPromises()
    expect(wrapper.get<HTMLButtonElement>('button[type="submit"]').element.disabled).toBe(true)
    await wrapper.get('form').trigger('submit')
    expect(fetchMock.mock.calls.filter(([, opts]) => opts?.method === 'PATCH')).toHaveLength(0)
    expect(wrapper.find('[data-testid="toast-success"]').exists()).toBe(false)
    await wrapper.find('[data-testid="toggle-status-updates"]').setValue(false)
    await wrapper.find('[data-testid="preferences-form"]').trigger('submit.prevent')
    await flushPromises()
    const patchCall = fetchMock.mock.calls.find(
      (c) => (c[1] as { method?: string } | undefined)?.method === 'PATCH'
    )
    expect(patchCall).toBeDefined()
    expect(patchCall![0]).toContain('/api/self-service/preferences')
    const body = JSON.parse((patchCall![1] as { body: string }).body) as Record<string, unknown>
    expect(body).toEqual({ status_updates: false })
    expect(wrapper.find('[data-testid="toast-success"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="toast-success"]').text()).toContain(
      'Préférences enregistrées'
    )
    await wrapper.get('[data-testid="toggle-weekly-recap"]').setValue(true)
    expect(wrapper.find('[data-testid="toast-success"]').exists()).toBe(false)
  })

  it("AC#7 (4) si PATCH échoue → message d'erreur + bouton retry visible", async () => {
    const fetchMock = vi.fn((url: string, opts?: { method?: string }) => {
      if (typeof url === 'string' && url.includes('/api/auth/me')) {
        return Promise.resolve(jsonResponse(200, ME_RESPONSE_MANAGER))
      }
      if ((opts?.method ?? 'GET') === 'PATCH') {
        return Promise.resolve(jsonResponse(500, { error: { code: 'SERVER_ERROR' } }))
      }
      return Promise.resolve(jsonResponse(200, PREFS_INITIAL_RESPONSE))
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    const wrapper = await mountView()
    await flushPromises()
    await wrapper.find('[data-testid="toggle-status-updates"]').setValue(false)
    await wrapper.find('[data-testid="preferences-form"]').trigger('submit.prevent')
    await flushPromises()
    expect(wrapper.find('[data-testid="preferences-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="retry-button"]').exists()).toBe(true)
  })

  it('AC#9 (5) si non-manager → toggle weekly_recap disabled + tooltip "Réservé aux responsables"', async () => {
    globalThis.fetch = vi.fn((url: string) => {
      if (typeof url === 'string' && url.includes('/api/auth/me')) {
        return Promise.resolve(jsonResponse(200, ME_RESPONSE_NON_MANAGER))
      }
      return Promise.resolve(jsonResponse(200, PREFS_INITIAL_RESPONSE))
    }) as unknown as typeof globalThis.fetch
    const wrapper = await mountView()
    await flushPromises()
    const weeklyToggle = wrapper.find('[data-testid="toggle-weekly-recap"]')
    // Soit disabled, soit absent (selon l'option d'implémentation choisie)
    if (weeklyToggle.exists()) {
      expect((weeklyToggle.element as HTMLInputElement).disabled).toBe(true)
      // Le tooltip / label adjacent doit mentionner la restriction.
      const html = wrapper.html()
      expect(html).toMatch(/Réservé aux responsables/i)
    } else {
      // Implémentation alternative : la toggle est complètement masquée
      expect(weeklyToggle.exists()).toBe(false)
    }
  })
  it.each([true, false])(
    'réessaie puis relit les choix persistés (responsable=%s)',
    async (manager) => {
      let persisted = { status_updates: true, weekly_recap: false }
      const patches: Record<string, boolean>[] = []
      globalThis.fetch = vi.fn(
        async (url: string, options?: { method?: string; body?: string }) => {
          if (url === '/api/auth/me')
            return jsonResponse(200, { user: { isGroupManager: manager } })
          if (options?.method === 'PATCH') {
            const patch = JSON.parse(options.body!)
            patches.push(patch)
            if (patches.length === 1) return jsonResponse(403, {})
            persisted = { ...persisted, ...patch }
          }
          return jsonResponse(200, { data: { notificationPrefs: persisted } })
        }
      ) as typeof globalThis.fetch

      const wrapper = await mountView()
      await flushPromises()
      await wrapper.get('[data-testid="toggle-status-updates"]').setValue(false)
      if (manager) await wrapper.get('[data-testid="toggle-weekly-recap"]').setValue(true)
      await wrapper.get('form').trigger('submit')
      await flushPromises()
      expect(wrapper.get('[role="alert"]').text()).toContain('échoué')
      const retry = wrapper.get('[data-testid="retry-button"]')
      expect(retry.text()).toBe('Réessayer l’enregistrement')
      expect(retry.attributes('type')).toBe('submit')
      await wrapper.get('form').trigger('submit')
      await flushPromises()
      const expected = manager
        ? { status_updates: false, weekly_recap: true }
        : { status_updates: false }
      expect(patches).toEqual([expected, expected])
      expect(wrapper.get('[role="status"]').text()).toBe('Préférences enregistrées')
      wrapper.unmount()
      const reopened = await mountView()
      await flushPromises()
      expect(
        reopened.get<HTMLInputElement>('[data-testid="toggle-status-updates"]').element.checked
      ).toBe(false)
      expect(
        reopened.get<HTMLInputElement>('[data-testid="toggle-weekly-recap"]').element.checked
      ).toBe(manager)
    }
  )

  it('propose de relancer la lecture du profil depuis la vue', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(403, {}))
      .mockResolvedValueOnce(jsonResponse(200, PREFS_INITIAL_RESPONSE))
      .mockResolvedValueOnce(jsonResponse(200, ME_RESPONSE_MANAGER))
      .mockResolvedValueOnce(jsonResponse(200, PREFS_INITIAL_RESPONSE))
    const wrapper = await mountView()
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Impossible de charger')
    expect(wrapper.find('form').exists()).toBe(false)
    const retry = wrapper.get('[data-testid="retry-button"]')
    expect(retry.text()).toBe('Réessayer le chargement')
    await retry.trigger('click')
    await flushPromises()
    expect(
      wrapper.get<HTMLInputElement>('[data-testid="toggle-weekly-recap"]').element.disabled
    ).toBe(false)
  })
})
