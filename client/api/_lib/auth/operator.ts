import { supabaseAdmin } from '../clients/supabase-admin'
import type { SessionUser } from '../types'

export interface OperatorRow {
  id: number
  azure_oid: string
  email: string
  display_name: string
  role: 'admin' | 'sav-operator'
  is_active: boolean
}

/** Retourne l'operator actif matchant l'azure_oid, ou null sinon. */
export async function findActiveOperator(azureOid: string): Promise<OperatorRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('operators')
    .select('id, azure_oid, email, display_name, role, is_active')
    .eq('azure_oid', azureOid)
    .eq('is_active', true)
    .maybeSingle()
  if (error) throw error
  return (data as OperatorRow | null) ?? null
}

/** Convertit une ligne operator en SessionUser (sans exp — positionné par issueSessionCookie). */
export function operatorToSessionUser(op: OperatorRow): Omit<SessionUser, 'exp'> {
  return {
    sub: op.id,
    type: 'operator',
    role: op.role,
    email: op.email,
  }
}

/**
 * Écrit un événement auth (denied ou login) dans auth_events.
 * Les hashs IP + email sont optionnels ; remplir via le handler.
 */
export interface AuthEventInput {
  eventType:
    | 'msal_login'
    | 'msal_denied'
    | 'magic_link_issued'
    | 'magic_link_verified'
    | 'magic_link_failed'
    | 'magic_link_rate_limited'
  operatorId?: number
  memberId?: number
  emailHash?: string
  ipHash?: string
  userAgent?: string
  metadata?: Record<string, unknown>
}

export async function logAuthEvent(input: AuthEventInput): Promise<void> {
  const row: Record<string, unknown> = { event_type: input.eventType }
  if (input.operatorId !== undefined) row['operator_id'] = input.operatorId
  if (input.memberId !== undefined) row['member_id'] = input.memberId
  if (input.emailHash !== undefined) row['email_hash'] = input.emailHash
  if (input.ipHash !== undefined) row['ip_hash'] = input.ipHash
  if (input.userAgent !== undefined) row['user_agent'] = input.userAgent
  if (input.metadata !== undefined) row['metadata'] = input.metadata
  const { error } = await supabaseAdmin().from('auth_events').insert(row)
  if (error) throw error
}
