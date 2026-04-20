import { createHash, randomBytes } from 'node:crypto'
import {
  ConfidentialClientApplication,
  type Configuration,
  type AuthenticationResult,
} from '@azure/msal-node'

let cachedCca: ConfidentialClientApplication | null = null

function buildConfig(): Configuration {
  // Réutilise l'app registration Epic 1 (MICROSOFT_*). Fallback AZURE_* pour flexibilité future.
  const tenantId = process.env['MICROSOFT_TENANT_ID'] ?? process.env['AZURE_TENANT_ID']
  const clientId = process.env['MICROSOFT_CLIENT_ID'] ?? process.env['AZURE_CLIENT_ID']
  const clientSecret = process.env['MICROSOFT_CLIENT_SECRET'] ?? process.env['AZURE_CLIENT_SECRET']
  if (!tenantId) throw new Error('MICROSOFT_TENANT_ID manquant')
  if (!clientId) throw new Error('MICROSOFT_CLIENT_ID manquant')
  if (!clientSecret) throw new Error('MICROSOFT_CLIENT_SECRET manquant')
  return {
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
      clientSecret,
    },
  }
}

export function msalClient(): ConfidentialClientApplication {
  if (cachedCca) return cachedCca
  cachedCca = new ConfidentialClientApplication(buildConfig())
  return cachedCca
}

export function __resetMsalClientForTests(): void {
  cachedCca = null
}

export function getRedirectUriBase(): string {
  const base = process.env['APP_BASE_URL']
  if (!base) throw new Error('APP_BASE_URL manquant')
  return base.replace(/\/$/, '')
}

const SCOPES = ['openid', 'profile', 'email', 'User.Read']

export interface PkcePair {
  verifier: string
  challenge: string
}

export function generatePkce(): PkcePair {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function generateState(): string {
  return randomBytes(24).toString('base64url')
}

export interface BuildAuthUrlArgs {
  redirectUri: string
  state: string
  pkceChallenge: string
}

export async function buildAuthUrl(args: BuildAuthUrlArgs): Promise<string> {
  return msalClient().getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: args.redirectUri,
    state: args.state,
    codeChallenge: args.pkceChallenge,
    codeChallengeMethod: 'S256',
    prompt: 'select_account',
  })
}

export interface ExchangeArgs {
  code: string
  redirectUri: string
  pkceVerifier: string
}

export async function exchangeCode(args: ExchangeArgs): Promise<AuthenticationResult> {
  const result = await msalClient().acquireTokenByCode({
    code: args.code,
    scopes: SCOPES,
    redirectUri: args.redirectUri,
    codeVerifier: args.pkceVerifier,
  })
  if (!result) throw new Error('MSAL: acquireTokenByCode returned null')
  return result
}

/**
 * Extrait l'azure_oid (objectId immuable) + email depuis un AuthenticationResult MSAL.
 * `oid` est le champ stable ; `preferred_username` est généralement l'email.
 */
export interface MsalIdentity {
  azureOid: string
  email: string
  displayName: string
}

export function extractIdentity(result: AuthenticationResult): MsalIdentity {
  const account = result.account
  if (!account) throw new Error('MSAL: account absent du résultat')
  const claims = (account.idTokenClaims ?? {}) as Record<string, unknown>
  const oid =
    typeof claims['oid'] === 'string' ? claims['oid'] : account.homeAccountId.split('.')[0]
  const email =
    (typeof claims['email'] === 'string' && claims['email']) ||
    (typeof claims['preferred_username'] === 'string' && claims['preferred_username']) ||
    account.username
  const displayName = account.name ?? email ?? 'Inconnu'
  if (!oid) throw new Error('MSAL: oid introuvable')
  if (!email) throw new Error('MSAL: email introuvable')
  return { azureOid: oid, email, displayName }
}
