import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let cachedAdmin: SupabaseClient | null = null

/**
 * Retourne un client Supabase en mode service_role (bypass RLS).
 * **Usage exclusivement côté serverless**, jamais dans le bundle frontend.
 *
 * Requiert les env vars :
 *   - VITE_SUPABASE_URL (ou SUPABASE_URL)
 *   - SUPABASE_SERVICE_ROLE_KEY
 */
export function supabaseAdmin(): SupabaseClient {
  if (cachedAdmin) return cachedAdmin
  const url = process.env['SUPABASE_URL'] || process.env['VITE_SUPABASE_URL']
  const key = process.env['SUPABASE_SERVICE_ROLE_KEY']
  if (!url) throw new Error('SUPABASE_URL / VITE_SUPABASE_URL manquant')
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY manquant')
  cachedAdmin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return cachedAdmin
}

/** Uniquement pour les tests : permet de resetter le singleton */
export function __resetSupabaseAdminForTests(): void {
  cachedAdmin = null
}
