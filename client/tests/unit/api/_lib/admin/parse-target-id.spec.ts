import { describe, it, expect } from 'vitest'
import { parseTargetId, PG_INT4_MAX } from '../../../../../api/_lib/admin/parse-target-id'
import type { ApiRequest } from '../../../../../api/_lib/types'

/**
 * Story 7-3b Hardening Round 1 — W-7-3b-3 régression `parseTargetId` DRY
 * helper partagé. Couvre les cas frontière INTEGER bound (cf. CR W-7-3b-3
 * qui consolide W-7-3a-2 + B2 7-3b).
 */

function fakeReq(idValue: unknown): ApiRequest {
  return { query: { id: idValue } } as unknown as ApiRequest
}

describe('parseTargetId helper', () => {
  it('retourne id valide pour entier positif', () => {
    expect(parseTargetId(fakeReq('500'))).toBe(500)
  })

  it('retourne null si id absent', () => {
    expect(parseTargetId({ query: {} } as unknown as ApiRequest)).toBeNull()
  })

  it('retourne null si id vide', () => {
    expect(parseTargetId(fakeReq(''))).toBeNull()
  })

  it('retourne null si id non-entier', () => {
    expect(parseTargetId(fakeReq('abc'))).toBeNull()
    expect(parseTargetId(fakeReq('1.5'))).toBeNull()
  })

  it('retourne null si id <= 0', () => {
    expect(parseTargetId(fakeReq('0'))).toBeNull()
    expect(parseTargetId(fakeReq('-5'))).toBeNull()
  })

  it('retourne null si id dépasse PG INTEGER max (W-7-3b-3 bound check)', () => {
    // PG int4 max = 2_147_483_647. Au-dessus → null.
    expect(parseTargetId(fakeReq(String(PG_INT4_MAX + 1)))).toBeNull()
    expect(parseTargetId(fakeReq('9999999999'))).toBeNull()
  })

  it('retourne PG_INT4_MAX exact (boundary inclusive)', () => {
    expect(parseTargetId(fakeReq(String(PG_INT4_MAX)))).toBe(PG_INT4_MAX)
  })

  it('trim les espaces autour de la string', () => {
    expect(parseTargetId(fakeReq('  500  '))).toBe(500)
  })
})
