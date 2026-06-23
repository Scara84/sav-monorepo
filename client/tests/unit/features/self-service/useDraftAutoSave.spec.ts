import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, nextTick } from 'vue'
import { useDraftAutoSave } from '@features/self-service/composables/useDraftAutoSave'

function mockFetch(
  impls: Array<(url: string, init?: RequestInit) => Response | Promise<Response>>
) {
  let i = 0
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const impl = impls[i] ?? impls[impls.length - 1]
    i++
    const url = typeof input === 'string' ? input : input.toString()
    return impl ? impl(url, init) : new Response(null, { status: 500 })
  })
  return fn as unknown as typeof fetch & { mock: { calls: Array<[string, RequestInit]> } }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('useDraftAutoSave', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('hydrate formState depuis GET au mount', async () => {
    const formState = ref<Record<string, unknown>>({})
    const fetchImpl = mockFetch([
      () =>
        jsonResponse(200, {
          data: { data: { step: 3, items: [1, 2] }, lastSavedAt: '2026-04-21T10:00:00.000Z' },
        }),
    ])
    const { hydrated, lastSavedAt } = useDraftAutoSave(formState, { fetchImpl })

    await vi.runAllTimersAsync()
    expect(hydrated.value).toBe(true)
    expect(formState.value).toEqual({ step: 3, items: [1, 2] })
    expect(lastSavedAt.value?.toISOString()).toBe('2026-04-21T10:00:00.000Z')
  })

  it('debounce : 5 modifs en rafale → 1 PUT après 800 ms', async () => {
    const formState = ref<Record<string, unknown>>({})
    const fetchImpl = mockFetch([
      () => jsonResponse(200, { data: null }), // GET initial
      () => jsonResponse(200, { data: { lastSavedAt: '2026-04-21T10:00:00.000Z' } }),
    ])
    const { hydrated } = useDraftAutoSave(formState, { fetchImpl, debounceMs: 800 })

    // laisser l'hydratation finir
    await vi.runAllTimersAsync()
    expect(hydrated.value).toBe(true)

    // 5 modifs successives
    for (let i = 1; i <= 5; i++) {
      formState.value = { ...formState.value, step: i }
      await nextTick()
    }

    // Avant 800 ms : pas de PUT
    expect(fetchImpl).toHaveBeenCalledTimes(1) // uniquement le GET

    // Après 800 ms : 1 seul PUT
    await vi.advanceTimersByTimeAsync(900)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const [putUrl, putInit] = fetchImpl.mock.calls[1] as [string, RequestInit]
    expect(putInit.method).toBe('PUT')
    expect(JSON.parse(putInit.body as string)).toEqual({ data: { step: 5 } })
    expect(putUrl).toBe('/api/self-service/draft')
  })

  it('retry exponentiel sur 503 (2 tentatives)', async () => {
    const formState = ref<Record<string, unknown>>({})
    const fetchImpl = mockFetch([
      () => jsonResponse(200, { data: null }), // GET
      () => new Response(null, { status: 503 }), // PUT #1 KO
      () => new Response(null, { status: 503 }), // PUT #2 KO
      () => jsonResponse(200, { data: { lastSavedAt: '2026-04-21T10:00:01.000Z' } }), // PUT #3 OK
    ])
    const { hydrated, error, lastSavedAt } = useDraftAutoSave(formState, {
      fetchImpl,
      debounceMs: 0,
    })
    await vi.runAllTimersAsync()
    expect(hydrated.value).toBe(true)

    formState.value = { x: 1 }
    await vi.advanceTimersByTimeAsync(10) // debounce=0 + nextTick
    await vi.advanceTimersByTimeAsync(1100) // wait retry delay 1
    await vi.advanceTimersByTimeAsync(3100) // wait retry delay 2
    await vi.runAllTimersAsync()

    expect(fetchImpl).toHaveBeenCalledTimes(4) // GET + 3 PUT
    expect(error.value).toBeNull()
    expect(lastSavedAt.value?.toISOString()).toBe('2026-04-21T10:00:01.000Z')
  })

  it('échec final après 3 tentatives → error ref posée', async () => {
    const formState = ref<Record<string, unknown>>({})
    const fetchImpl = mockFetch([
      () => jsonResponse(200, { data: null }),
      () => new Response(null, { status: 503 }),
      () => new Response(null, { status: 503 }),
      () => new Response(null, { status: 503 }),
    ])
    const { hydrated, error, lastSavedAt } = useDraftAutoSave(formState, {
      fetchImpl,
      debounceMs: 0,
    })
    await vi.runAllTimersAsync()
    expect(hydrated.value).toBe(true)

    formState.value = { x: 1 }
    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(5000)
    await vi.runAllTimersAsync()

    expect(error.value).toMatch(/PUT.*503/)
    expect(lastSavedAt.value).toBeNull()
  })

  it('400 VALIDATION_FAILED → pas de retry (erreur client)', async () => {
    const formState = ref<Record<string, unknown>>({})
    const fetchImpl = mockFetch([
      () => jsonResponse(200, { data: null }),
      () => new Response(null, { status: 400 }),
    ])
    const { hydrated, error } = useDraftAutoSave(formState, { fetchImpl, debounceMs: 0 })
    await vi.runAllTimersAsync()
    expect(hydrated.value).toBe(true)

    formState.value = { x: 1 }
    await vi.advanceTimersByTimeAsync(10)
    await vi.runAllTimersAsync()

    expect(fetchImpl).toHaveBeenCalledTimes(2) // GET + 1 seul PUT
    expect(error.value).toMatch(/PUT.*400/)
  })
})
