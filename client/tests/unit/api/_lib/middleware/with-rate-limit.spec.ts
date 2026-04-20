import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  withRateLimit,
  checkAndIncrement,
} from '../../../../../api/_lib/middleware/with-rate-limit'
import { mockReq, mockRes } from '../test-helpers'

function makeClient() {
  const maybeSingle = vi.fn()
  const eqSelect = vi.fn(() => ({ maybeSingle }))
  const select = vi.fn(() => ({ eq: eqSelect }))
  const upsert = vi.fn(() => Promise.resolve({ error: null }))
  const eqUpdate = vi.fn(() => Promise.resolve({ error: null }))
  const update = vi.fn(() => ({ eq: eqUpdate }))
  const from = vi.fn(() => ({ select, upsert, update }))
  return { client: { from }, maybeSingle, upsert, update, eqUpdate }
}

describe('withRateLimit', () => {
  let api: ReturnType<typeof makeClient>

  beforeEach(() => {
    api = makeClient()
  })

  it('retourne 400 si keyFrom retourne undefined', async () => {
    const handler = vi.fn()
    const wrapped = withRateLimit({
      bucketPrefix: 'test',
      keyFrom: () => undefined,
      max: 5,
      window: '1h',
      getClient: () => api.client,
    })(handler)
    const res = mockRes()
    await wrapped(mockReq(), res)
    expect(res.statusCode).toBe(400)
    expect(handler).not.toHaveBeenCalled()
  })

  it('autorise la 1ère requête (bucket inexistant) et crée le bucket', async () => {
    api.maybeSingle.mockResolvedValue({ data: null, error: null })
    const handler = vi.fn()
    const wrapped = withRateLimit({
      bucketPrefix: 'mlink:email',
      keyFrom: () => 'antho@ex.com',
      max: 5,
      window: '1h',
      getClient: () => api.client,
    })(handler)
    const res = mockRes()
    await wrapped(mockReq(), res)
    expect(handler).toHaveBeenCalledOnce()
    expect(api.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        key: expect.stringMatching(/^mlink:email:[a-f0-9]{64}$/),
        count: 1,
      })
    )
  })

  it('autorise si compteur sous quota et incrémente', async () => {
    api.maybeSingle.mockResolvedValue({
      data: { key: 'mlink:email:abc', count: 2, window_from: new Date().toISOString() },
      error: null,
    })
    const handler = vi.fn()
    const wrapped = withRateLimit({
      bucketPrefix: 'mlink:email',
      keyFrom: () => 'x@y.fr',
      max: 5,
      window: '1h',
      getClient: () => api.client,
    })(handler)
    const res = mockRes()
    await wrapped(mockReq(), res)
    expect(handler).toHaveBeenCalledOnce()
    expect(api.update).toHaveBeenCalledWith(expect.objectContaining({ count: 3 }))
  })

  it('retourne 429 RATE_LIMITED si quota atteint', async () => {
    api.maybeSingle.mockResolvedValue({
      data: { key: 'mlink:email:abc', count: 5, window_from: new Date().toISOString() },
      error: null,
    })
    const handler = vi.fn()
    const wrapped = withRateLimit({
      bucketPrefix: 'mlink:email',
      keyFrom: () => 'x@y.fr',
      max: 5,
      window: '1h',
      getClient: () => api.client,
    })(handler)
    const res = mockRes()
    await wrapped(mockReq(), res)
    expect(res.statusCode).toBe(429)
    expect(res.jsonBody).toMatchObject({ error: { code: 'RATE_LIMITED' } })
    expect(res.headers['retry-after']).toBeDefined()
    expect(handler).not.toHaveBeenCalled()
  })

  it('réinitialise le bucket si la fenêtre est expirée', async () => {
    api.maybeSingle.mockResolvedValue({
      data: {
        key: 'mlink:email:abc',
        count: 5,
        window_from: new Date(Date.now() - 7200 * 1000).toISOString(),
      },
      error: null,
    })
    const handler = vi.fn()
    const wrapped = withRateLimit({
      bucketPrefix: 'mlink:email',
      keyFrom: () => 'x@y.fr',
      max: 5,
      window: '1h',
      getClient: () => api.client,
    })(handler)
    const res = mockRes()
    await wrapped(mockReq(), res)
    expect(handler).toHaveBeenCalledOnce()
    expect(api.upsert).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }))
  })

  it('fail-closed : 500 si Supabase retourne une erreur', async () => {
    api.maybeSingle.mockResolvedValue({ data: null, error: new Error('connection refused') })
    const handler = vi.fn()
    const wrapped = withRateLimit({
      bucketPrefix: 'test',
      keyFrom: () => 'k',
      max: 5,
      window: '1h',
      getClient: () => api.client,
    })(handler)
    const res = mockRes()
    await wrapped(mockReq(), res)
    expect(res.statusCode).toBe(500)
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('checkAndIncrement (directly)', () => {
  it('retourne allowed=true et crée un bucket si inexistant', async () => {
    const { client, maybeSingle, upsert } = makeClient()
    maybeSingle.mockResolvedValue({ data: null, error: null })
    const result = await checkAndIncrement(client, 'k:test', 3, 3600)
    expect(result.allowed).toBe(true)
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }))
  })
})
