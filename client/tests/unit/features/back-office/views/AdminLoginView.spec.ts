import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

type LocationQueryValue = string | null
type LocationQuery = Record<string, LocationQueryValue | LocationQueryValue[]>
const routeMock: { query: LocationQuery } = { query: {} }
const replaceMock = vi.fn()

vi.mock('vue-router', () => ({
  useRoute: () => routeMock,
  useRouter: () => ({ replace: replaceMock }),
}))

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    headers: new Headers(),
    statusText: '',
    redirected: false,
    type: 'basic',
    url: '',
    clone: () => {
      throw new Error('not impl')
    },
  } as unknown as Response
}

const originalFetch = globalThis.fetch

import AdminLoginView from '../../../../../src/features/back-office/views/AdminLoginView.vue'

describe('AdminLoginView — login password (H-19)', () => {
  beforeEach(() => {
    routeMock.query = {}
    replaceMock.mockReset()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('affiche email + mot de passe, sans wording magic-link', () => {
    const wrapper = mount(AdminLoginView)
    expect(wrapper.find('input[type="email"]').exists()).toBe(true)
    expect(wrapper.find('input[type="password"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Se connecter')
    expect(wrapper.text()).not.toContain('lien de connexion')
    expect(wrapper.text()).not.toContain('15 minutes')
  })

  it('submit -> POST /api/auth/operator/login avec returnTo encodé puis redirect', async () => {
    routeMock.query = { returnTo: '/admin/sav/123' }
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { ok: true, redirectTo: '/admin/sav/123' })
    )
    globalThis.fetch = fetchMock

    const wrapper = mount(AdminLoginView)
    await wrapper.find('input[type="email"]').setValue('alice@fruitstock.eu')
    await wrapper.find('input[type="password"]').setValue('secret')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`/api/auth/operator/login?returnTo=${encodeURIComponent('/admin/sav/123')}`)
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(JSON.parse(String(init.body))).toEqual({
      email: 'alice@fruitstock.eu',
      password: 'secret',
    })
    expect(replaceMock).toHaveBeenCalledWith('/admin/sav/123')
  })

  it('401 -> message neutre', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(401, { error: { code: 'UNAUTHENTICATED' } }))

    const wrapper = mount(AdminLoginView)
    await wrapper.find('input[type="email"]').setValue('alice@fruitstock.eu')
    await wrapper.find('input[type="password"]').setValue('bad')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(wrapper.text()).toContain('Identifiants invalides.')
    expect(replaceMock).not.toHaveBeenCalled()
  })
})
