import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  withRateLimit,
  checkAndIncrement,
} from '../../../../../api/_lib/middleware/with-rate-limit'
import { mockReq, mockRes } from '../test-helpers'

function makeClient() {
  const rpc = vi.fn()
  return { client: { rpc }, rpc }
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

  it('autorise la requête si le RPC retourne allowed=true', async () => {
    api.rpc.mockResolvedValue({ data: [{ allowed: true, retry_after: 3600 }], error: null })
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
    expect(api.rpc).toHaveBeenCalledWith(
      'increment_rate_limit',
      expect.objectContaining({
        p_key: expect.stringMatching(/^mlink:email:[a-f0-9]{64}$/),
        p_max: 5,
        p_window_sec: 3600,
      })
    )
  })

  it('retourne 429 RATE_LIMITED si quota atteint', async () => {
    api.rpc.mockResolvedValue({ data: [{ allowed: false, retry_after: 900 }], error: null })
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
    expect(res.headers['retry-after']).toBe(900)
    expect(handler).not.toHaveBeenCalled()
  })

  it('fail-closed : 500 si le RPC retourne une erreur', async () => {
    api.rpc.mockResolvedValue({ data: null, error: new Error('connection refused') })
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

  it('fail-closed : 500 si le RPC retourne un tableau vide', async () => {
    api.rpc.mockResolvedValue({ data: [], error: null })
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
  })

  it('supporte skipHash=true (clé déjà hashée)', async () => {
    api.rpc.mockResolvedValue({ data: [{ allowed: true, retry_after: 60 }], error: null })
    const handler = vi.fn()
    const wrapped = withRateLimit({
      bucketPrefix: 'verify:ip',
      keyFrom: () => 'abc123',
      skipHash: true,
      max: 20,
      window: '1h',
      getClient: () => api.client,
    })(handler)
    await wrapped(mockReq(), mockRes())
    expect(api.rpc).toHaveBeenCalledWith(
      'increment_rate_limit',
      expect.objectContaining({ p_key: 'verify:ip:abc123' })
    )
  })
})

describe('checkAndIncrement (directly)', () => {
  it('retourne allowed=true si le RPC dit true', async () => {
    const { client, rpc } = makeClient()
    rpc.mockResolvedValue({ data: [{ allowed: true, retry_after: 3600 }], error: null })
    const result = await checkAndIncrement(client, 'k:test', 3, 3600)
    expect(result).toEqual({ allowed: true, retryAfter: 3600 })
  })

  it('retourne allowed=false si le RPC dit false', async () => {
    const { client, rpc } = makeClient()
    rpc.mockResolvedValue({ data: [{ allowed: false, retry_after: 42 }], error: null })
    const result = await checkAndIncrement(client, 'k:test', 3, 3600)
    expect(result).toEqual({ allowed: false, retryAfter: 42 })
  })

  it('throw si le RPC retourne une erreur', async () => {
    const { client, rpc } = makeClient()
    rpc.mockResolvedValue({ data: null, error: new Error('DB down') })
    await expect(checkAndIncrement(client, 'k', 3, 60)).rejects.toThrow('DB down')
  })

  it('throw si le RPC retourne un résultat vide', async () => {
    const { client, rpc } = makeClient()
    rpc.mockResolvedValue({ data: null, error: null })
    await expect(checkAndIncrement(client, 'k', 3, 60)).rejects.toThrow(/empty result/)
  })
})
