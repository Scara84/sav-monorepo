import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

describe('graph lib', () => {
  let graphLib
  const envBackup = { ...process.env }

  beforeEach(async () => {
    process.env.MICROSOFT_CLIENT_ID = 'client-id'
    process.env.MICROSOFT_TENANT_ID = 'tenant-id'
    process.env.MICROSOFT_CLIENT_SECRET = 'secret'
    graphLib = await import('../../../api/_lib/graph.js')
    graphLib.__resetForTests()
  })

  afterEach(() => {
    process.env = { ...envBackup }
    if (graphLib) graphLib.__resetForTests()
  })

  it('lève une erreur explicite si MICROSOFT_CLIENT_ID manquant', () => {
    delete process.env.MICROSOFT_CLIENT_ID
    expect(() => graphLib.getMsalClient()).toThrow(/MICROSOFT_CLIENT_ID/)
  })

  it('lève une erreur explicite si MICROSOFT_TENANT_ID manquant', () => {
    delete process.env.MICROSOFT_TENANT_ID
    expect(() => graphLib.getMsalClient()).toThrow(/MICROSOFT_TENANT_ID/)
  })

  it('lève une erreur explicite si MICROSOFT_CLIENT_SECRET manquant', () => {
    delete process.env.MICROSOFT_CLIENT_SECRET
    expect(() => graphLib.getMsalClient()).toThrow(/MICROSOFT_CLIENT_SECRET/)
  })

  it('crée un singleton MSAL', () => {
    const a = graphLib.getMsalClient()
    const b = graphLib.getMsalClient()
    expect(a).toBe(b)
  })

  it('getGraphClient est un singleton', () => {
    const a = graphLib.getGraphClient()
    const b = graphLib.getGraphClient()
    expect(a).toBe(b)
  })

  it('getAccessToken retourne le token MSAL avec les bons scopes', async () => {
    const msalClient = graphLib.getMsalClient()
    const spy = vi
      .spyOn(msalClient, 'acquireTokenByClientCredential')
      .mockResolvedValue({ accessToken: 'mock-token-123' })

    const token = await graphLib.getAccessToken()

    expect(token).toBe('mock-token-123')
    expect(spy).toHaveBeenCalledWith({ scopes: ['https://graph.microsoft.com/.default'] })
    spy.mockRestore()
  })

  it('getAccessToken lève si MSAL retourne une réponse sans accessToken', async () => {
    const msalClient = graphLib.getMsalClient()
    const spy = vi
      .spyOn(msalClient, 'acquireTokenByClientCredential')
      .mockResolvedValue(null)

    await expect(graphLib.getAccessToken()).rejects.toThrow(/Aucun token/)
    spy.mockRestore()
  })
})
