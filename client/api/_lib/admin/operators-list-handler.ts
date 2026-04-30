import { ensureRequestId } from '../request-id'
import { sendError } from '../errors'
import { logger } from '../logger'
import { supabaseAdmin } from '../clients/supabase-admin'
import { operatorListQuerySchema, type OperatorRow } from './operators-schema'
import type { ApiHandler } from '../types'

/**
 * Story 7-3a AC #1 — `GET /api/admin/operators` (op `admin-operators-list`).
 *
 * Pagination offset/limit (range), recherche `q` ILIKE substring sur
 * `email|display_name`, filtre `role` (admin / sav-operator / all).
 *
 * Auth : router `pilotage.ts` applique `withAuth({ types: ['operator'] })`
 * + check role admin via Set `ADMIN_ONLY_OPS` + helper `requireAdminRole`.
 * Le handler ré-applique le check (defense-in-depth — Story 5.5 pattern).
 *
 * Réponse 200 :
 *   { data: { items: OperatorRow[], total: number, hasMore: boolean } }
 *
 * Erreurs :
 *   400 INVALID_PARAMS (Zod) — limit > 50, role invalide, etc.
 *   403 ROLE_NOT_ALLOWED (defense-in-depth)
 *   500 QUERY_FAILED
 */

export const adminOperatorsListHandler: ApiHandler = async (req, res) => {
  const requestId = ensureRequestId(req)
  const user = req.user
  if (!user || user.type !== 'operator') {
    sendError(res, 'FORBIDDEN', 'Session opérateur requise', requestId)
    return
  }
  if (user.role !== 'admin') {
    sendError(res, 'FORBIDDEN', 'Rôle admin requis', requestId, {
      code: 'ROLE_NOT_ALLOWED',
    })
    return
  }

  const parsed = operatorListQuerySchema.safeParse(req.query ?? {})
  if (!parsed.success) {
    sendError(res, 'VALIDATION_FAILED', 'Paramètres invalides', requestId, {
      code: 'INVALID_PARAMS',
      issues: parsed.error.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      })),
    })
    return
  }
  const { q, role, is_active, limit, offset } = parsed.data

  const admin = supabaseAdmin()
  let query = admin
    .from('operators')
    .select('id, email, display_name, role, is_active, azure_oid, created_at', {
      count: 'exact',
    })
    .order('created_at', { ascending: false })

  if (typeof q === 'string' && q.length > 0) {
    // Hardening W-7-3a-1 (CR E1 + G-6 challenge) : neutraliser à la fois
    // - les caractères structurels PostgREST `(`, `)`, `,` qui briseraient
    //   l'expression `.or()` ;
    // - les wildcards SQL ILIKE `%` (match-any), `_` (match-1) qui
    //   permettraient à un attaquant d'élargir arbitrairement le filtre
    //   substring (info-disclosure scope, pas RLS leak — admin déjà
    //   autorisé à lire tous les opérateurs, mais comportement déterministe
    //   attendu par le contrat AC #1 « substring email|display_name »).
    // On remplace par `_` (le wildcard 1-char est ensuite neutralisé par
    // ce même remplacement — idempotent : `_` → `_` reste neutre puisque
    // tous les `_` originaux sont déjà devenus des wildcards-substitués
    // équivalents). Pour un display_name légitime contenant `%` ou `_`,
    // la recherche dégrade vers un match plus large mais déterministe,
    // documenté dans le runbook admin.
    const safe = q.replace(/[(),%_]/g, '_')
    query = query.or(`email.ilike.%${safe}%,display_name.ilike.%${safe}%`)
  }
  if (role !== undefined && role !== 'all') {
    query = query.eq('role', role)
  }
  if (is_active !== undefined) {
    query = query.eq('is_active', is_active === 'true')
  }

  const from = offset
  const to = offset + limit - 1
  const { data, error, count } = await query.range(from, to)

  if (error) {
    logger.error('admin.operators.list.query_failed', {
      requestId,
      code: error.code,
      message: error.message,
    })
    sendError(res, 'SERVER_ERROR', 'Lecture impossible', requestId, {
      code: 'QUERY_FAILED',
    })
    return
  }

  const items = (data ?? []) as OperatorRow[]
  const total = typeof count === 'number' ? count : items.length
  const hasMore = offset + items.length < total

  res.status(200).json({ data: { items, total, hasMore } })
}
