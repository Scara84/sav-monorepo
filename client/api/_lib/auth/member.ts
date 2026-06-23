import { supabaseAdmin } from '../clients/supabase-admin'

export interface MemberRow {
  id: number
  email: string
  first_name: string | null
  last_name: string
  group_id: number | null
  is_group_manager: boolean
}

export async function findActiveMemberByEmail(email: string): Promise<MemberRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('members')
    .select('id, email, first_name, last_name, group_id, is_group_manager')
    .eq('email', email)
    .is('anonymized_at', null)
    .maybeSingle()
  if (error) throw error
  return (data as MemberRow | null) ?? null
}
