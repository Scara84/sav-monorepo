import { supabaseAdmin } from '../clients/supabase-admin'

export async function supplierClaimSavExists(savId: number): Promise<boolean> {
  const { data, error } = await supabaseAdmin().from('sav').select('id').eq('id', savId).maybeSingle()
  if (error) throw error
  return data !== null
}
