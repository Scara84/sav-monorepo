import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { withValidation, formatErrors } from '../../../../../api/_lib/middleware/with-validation'
import { mockReq, mockRes } from '../test-helpers'

describe('withValidation', () => {
  const schema = z.object({
    email: z.string().email(),
    age: z.number().int().min(18),
  })

  it('retourne 400 VALIDATION_FAILED avec details si body invalide', async () => {
    const handler = vi.fn()
    const wrapped = withValidation({ body: schema })(handler)
    const res = mockRes()
    await wrapped(mockReq({ body: { email: 'not-email', age: 10 } }), res)
    expect(res.statusCode).toBe(400)
    expect(res.jsonBody).toMatchObject({ error: { code: 'VALIDATION_FAILED' } })
    const body = res.jsonBody as { error: { details: Array<{ field: string }> } }
    const fields = body.error.details.map((d) => d.field).sort()
    expect(fields).toContain('email')
    expect(fields).toContain('age')
    expect(handler).not.toHaveBeenCalled()
  })

  it('laisse passer et attache req.body parsé si valide', async () => {
    const handler = vi.fn(async (req) => {
      expect(req.body).toEqual({ email: 'a@b.fr', age: 25 })
    })
    const wrapped = withValidation({ body: schema })(handler)
    const res = mockRes()
    await wrapped(mockReq({ body: { email: 'a@b.fr', age: 25 } }), res)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('valide aussi query string', async () => {
    const handler = vi.fn()
    const qSchema = z.object({ page: z.string().regex(/^\d+$/) })
    const wrapped = withValidation({ query: qSchema })(handler)
    const res = mockRes()
    await wrapped(mockReq({ query: { page: 'abc' } }), res)
    expect(res.statusCode).toBe(400)
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('formatErrors', () => {
  it('aplatit les issues Zod avec field/message', () => {
    const schema = z.object({ nested: z.object({ count: z.number() }) })
    const result = schema.safeParse({ nested: { count: 'abc' } })
    expect(result.success).toBe(false)
    if (result.success) return
    const formatted = formatErrors(result.error)
    expect(formatted[0]).toMatchObject({ field: 'nested.count', message: expect.any(String) })
  })
})
