/**
 * Story 3.7b — PATTERN-D — Server-side upload-session→savId binding.
 *
 * Expose `verifyUploadSessionBinding()` pour valider qu'un uploadSessionId
 * correspond bien au savId + operatorId attendus (défense-en-profondeur).
 *
 * Le handler upload-complete appelle `verifyUploadSessionBinding()` AVANT la
 * whitelist webUrl et AVANT tout autre traitement — mismatch ou expiré →
 * 403 UPLOAD_SESSION_SAV_MISMATCH (défense-en-profondeur PATTERN-D).
 *
 * Note: le binding initial (INSERT dans sav_upload_sessions) est réalisé
 * directement dans admin-upload-handlers.ts via supabaseAdmin().from(...).insert()
 * pour éviter un double-INSERT.
 *
 * Table-backed (pas de cache mémoire) : survit aux redéploys serverless Vercel,
 * auditable, cohérent avec l'architecture existante (supabaseAdmin).
 */

import { supabaseAdmin } from '../clients/supabase-admin'

export interface BindingRow {
  sav_id: number
  operator_id: number
  expires_at: Date
}

export interface BindResult {
  valid: boolean
  reason?: string
}

/**
 * Vérifie que le binding sessionId → savId est valide et non-expiré.
 * Returns { valid: true } si OK, { valid: false, reason } sinon.
 */
export async function verifyUploadSessionBinding({
  sessionId,
  savId,
  operatorId,
}: {
  sessionId: string
  savId: number
  operatorId: number
}): Promise<BindResult> {
  const { data, error } = await supabaseAdmin()
    .from('sav_upload_sessions')
    .select('sav_id, operator_id, expires_at')
    .eq('id', sessionId)
    .maybeSingle<BindingRow>()

  if (error || !data) {
    return { valid: false, reason: 'SESSION_NOT_FOUND' }
  }

  const expiresAt = new Date(data.expires_at)
  if (expiresAt < new Date()) {
    return { valid: false, reason: 'SESSION_EXPIRED' }
  }

  if (data.sav_id !== savId) {
    return { valid: false, reason: 'SAV_MISMATCH' }
  }

  if (data.operator_id !== operatorId) {
    return { valid: false, reason: 'OPERATOR_MISMATCH' }
  }

  return { valid: true }
}
