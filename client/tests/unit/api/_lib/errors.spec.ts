import { describe, it, expect } from 'vitest'
import { errorEnvelope, httpStatus, sendError } from '../../../../api/_lib/errors'
import { mockRes } from './test-helpers'

describe('errors', () => {
  describe('httpStatus', () => {
    const cases: Array<[Parameters<typeof httpStatus>[0], number]> = [
      ['UNAUTHENTICATED', 401],
      ['FORBIDDEN', 403],
      ['RATE_LIMITED', 429],
      ['VALIDATION_FAILED', 400],
      ['NOT_FOUND', 404],
      ['CONFLICT', 409],
      ['LINK_CONSUMED', 410],
      ['LINK_EXPIRED', 401],
      ['BUSINESS_RULE', 422],
      ['SERVER_ERROR', 500],
      ['DEPENDENCY_DOWN', 503],
    ]
    it.each(cases)('mappe %s → %d', (code, status) => {
      expect(httpStatus(code)).toBe(status)
    })
  })

  describe('errorEnvelope', () => {
    it('retourne la structure standard sans details', () => {
      const env = errorEnvelope('FORBIDDEN', 'nope', 'req-42')
      expect(env).toEqual({
        error: { code: 'FORBIDDEN', message: 'nope', requestId: 'req-42' },
      })
    })

    it('inclut details quand fourni', () => {
      const env = errorEnvelope('VALIDATION_FAILED', 'bad', 'r1', [
        { field: 'x', message: 'required' },
      ])
      expect(env.error.details).toEqual([{ field: 'x', message: 'required' }])
    })
  })

  describe('sendError', () => {
    it('positionne status + json + enveloppe', () => {
      const res = mockRes()
      sendError(res, 'RATE_LIMITED', 'too many', 'req-99', { retryAfterSeconds: 60 })
      expect(res.statusCode).toBe(429)
      expect(res.jsonBody).toEqual({
        error: {
          code: 'RATE_LIMITED',
          message: 'too many',
          requestId: 'req-99',
          details: { retryAfterSeconds: 60 },
        },
      })
    })
  })
})
