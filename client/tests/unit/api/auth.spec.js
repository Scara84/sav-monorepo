import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { requireApiKey } from '../../../api/_lib/auth.js'

describe('requireApiKey', () => {
  const originalKey = process.env.API_KEY

  beforeEach(() => {
    process.env.API_KEY = 'secret-test-key'
  })

  afterEach(() => {
    if (originalKey === undefined) delete process.env.API_KEY
    else process.env.API_KEY = originalKey
  })

  it('accepte X-API-Key valide', () => {
    const req = { headers: { 'x-api-key': 'secret-test-key' } }
    expect(requireApiKey(req)).toBe(true)
  })

  it('accepte Authorization: Bearer valide', () => {
    const req = { headers: { authorization: 'Bearer secret-test-key' } }
    expect(requireApiKey(req)).toBe(true)
  })

  it('refuse une clé invalide', () => {
    const req = { headers: { 'x-api-key': 'wrong-key' } }
    expect(requireApiKey(req)).toBe(false)
  })

  it('refuse une absence de clé', () => {
    const req = { headers: {} }
    expect(requireApiKey(req)).toBe(false)
  })

  it('refuse un Bearer sans préfixe', () => {
    const req = { headers: { authorization: 'secret-test-key' } }
    expect(requireApiKey(req)).toBe(false)
  })

  it('refuse si API_KEY env absente', () => {
    delete process.env.API_KEY
    const req = { headers: { 'x-api-key': 'n-importe-quoi' } }
    expect(requireApiKey(req)).toBe(false)
  })

  it('gère headers absents sans planter', () => {
    expect(requireApiKey({})).toBe(false)
    expect(requireApiKey(null)).toBe(false)
  })
})
