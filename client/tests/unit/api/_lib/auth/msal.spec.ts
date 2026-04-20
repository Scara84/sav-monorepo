import { describe, it, expect } from 'vitest'
import { generatePkce, generateState, extractIdentity } from '../../../../../api/_lib/auth/msal'
import type { AuthenticationResult } from '@azure/msal-node'

describe('generatePkce', () => {
  it('retourne un verifier base64url ≥ 43 chars et un challenge SHA-256 base64url', () => {
    const { verifier, challenge } = generatePkce()
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(challenge.length).toBeGreaterThanOrEqual(43)
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(challenge).not.toBe(verifier)
  })

  it('produit des paires uniques', () => {
    const p1 = generatePkce()
    const p2 = generatePkce()
    expect(p1.verifier).not.toBe(p2.verifier)
    expect(p1.challenge).not.toBe(p2.challenge)
  })
})

describe('generateState', () => {
  it('produit une string base64url 32+ chars', () => {
    const s = generateState()
    expect(s.length).toBeGreaterThanOrEqual(32)
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('est unique entre deux appels', () => {
    expect(generateState()).not.toBe(generateState())
  })
})

describe('extractIdentity', () => {
  const baseAccount = {
    homeAccountId: 'oid-from-home.tenant',
    environment: 'login.microsoftonline.com',
    tenantId: 'tenant',
    username: 'user@fruitstock.fr',
    localAccountId: 'oid-from-local',
    name: 'Antho Fruitstock',
  }

  it('extrait oid depuis idTokenClaims.oid en priorité', () => {
    const result = {
      account: {
        ...baseAccount,
        idTokenClaims: {
          oid: '11111111-2222-3333-4444-555555555555',
          email: 'antho@fruitstock.fr',
          preferred_username: 'antho@fruitstock.fr',
        },
      },
    } as unknown as AuthenticationResult
    const id = extractIdentity(result)
    expect(id.azureOid).toBe('11111111-2222-3333-4444-555555555555')
    expect(id.email).toBe('antho@fruitstock.fr')
    expect(id.displayName).toBe('Antho Fruitstock')
  })

  it('fallback sur preferred_username si email absent', () => {
    const result = {
      account: {
        ...baseAccount,
        idTokenClaims: {
          oid: '11111111-2222-3333-4444-555555555555',
          preferred_username: 'backup@fruitstock.fr',
        },
      },
    } as unknown as AuthenticationResult
    const id = extractIdentity(result)
    expect(id.email).toBe('backup@fruitstock.fr')
  })

  it('throw si account absent', () => {
    expect(() => extractIdentity({} as AuthenticationResult)).toThrow(/account/)
  })
})
