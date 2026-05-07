import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { isAllowedOrigin, readOrigin } from '../../../../../api/_lib/auth/origin-check'
import type { ApiRequest } from '../../../../../api/_lib/types'

function makeReq(overrides: { origin?: string; referer?: string; host?: string }): ApiRequest {
  const headers: Record<string, string | string[] | undefined> = {}
  if (overrides.origin !== undefined) headers['origin'] = overrides.origin
  if (overrides.referer !== undefined) headers['referer'] = overrides.referer
  if (overrides.host !== undefined) headers['host'] = overrides.host
  return { headers, method: 'POST', query: {} } as unknown as ApiRequest
}

describe('isAllowedOrigin (multi-source CSRF check)', () => {
  const APP_BASE = 'https://canonical.example.com'

  beforeEach(() => {
    delete process.env['NODE_ENV']
    delete process.env['VITEST']
    delete process.env['ALLOWED_ORIGINS']
  })

  afterEach(() => {
    process.env['VITEST'] = '1' // restore default for other suites
  })

  describe('readOrigin', () => {
    it('lit Origin si présent', () => {
      expect(readOrigin(makeReq({ origin: 'https://a.test' }))).toBe('https://a.test')
    })

    it('fallback Referer si Origin absent', () => {
      expect(readOrigin(makeReq({ referer: 'https://b.test/page' }))).toBe('https://b.test/page')
    })

    it('retourne undefined si ni Origin ni Referer', () => {
      expect(readOrigin(makeReq({}))).toBeUndefined()
    })
  })

  it('skip check en environnement test (NODE_ENV=test)', () => {
    process.env['NODE_ENV'] = 'test'
    expect(isAllowedOrigin(makeReq({}), APP_BASE)).toBe(true)
  })

  it('skip check en environnement Vitest (VITEST=1)', () => {
    process.env['VITEST'] = '1'
    expect(isAllowedOrigin(makeReq({ origin: 'https://evil.com' }), APP_BASE)).toBe(true)
  })

  it("refuse si pas d'Origin ni Referer (production)", () => {
    expect(isAllowedOrigin(makeReq({}), APP_BASE)).toBe(false)
  })

  it('accepte si Origin matche APP_BASE_URL canonique', () => {
    const req = makeReq({ origin: 'https://canonical.example.com' })
    expect(isAllowedOrigin(req, APP_BASE)).toBe(true)
  })

  it('accepte si Origin matche le Host de la requête (Vercel alias)', () => {
    // Cas du bug initial : APP_BASE = git-branch URL, requête arrive sur alias.
    const req = makeReq({
      origin: 'https://sav-monorepo-client-scara84-ants-projects.vercel.app',
      host: 'sav-monorepo-client-scara84-ants-projects.vercel.app',
    })
    expect(
      isAllowedOrigin(req, 'https://sav-monorepo-client-git-branch-ants-projects.vercel.app')
    ).toBe(true)
  })

  it('accepte si Origin est dans ALLOWED_ORIGINS env', () => {
    process.env['ALLOWED_ORIGINS'] = 'https://staging.example.com, https://other.example.com'
    const req = makeReq({ origin: 'https://staging.example.com' })
    expect(isAllowedOrigin(req, APP_BASE)).toBe(true)
  })

  it('refuse Origin hors-allowlist (CSRF malicieux)', () => {
    process.env['ALLOWED_ORIGINS'] = 'https://staging.example.com'
    const req = makeReq({
      origin: 'https://evil.com',
      host: 'canonical.example.com',
    })
    expect(isAllowedOrigin(req, APP_BASE)).toBe(false)
  })

  it('refuse Origin malformé (URL invalide)', () => {
    const req = makeReq({ origin: 'not-a-url' })
    expect(isAllowedOrigin(req, APP_BASE)).toBe(false)
  })

  it('continue les autres checks si APP_BASE est mal-formé (defense-in-depth)', () => {
    const req = makeReq({
      origin: 'https://other.example.com',
      host: 'other.example.com',
    })
    // appBase mal formé → on ignore et on tombe sur le check Host
    expect(isAllowedOrigin(req, 'not-a-url')).toBe(true)
  })

  it('ALLOWED_ORIGINS gère espaces et entrées vides', () => {
    process.env['ALLOWED_ORIGINS'] = ' https://a.test , , https://b.test ,'
    expect(isAllowedOrigin(makeReq({ origin: 'https://b.test' }), APP_BASE)).toBe(true)
  })
})
