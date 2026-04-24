import { sendError } from '../errors'
import { logger } from '../logger'
import type { ApiResponse } from '../types'

/**
 * Story 3.6b — helper partagé PATCH/POST/DELETE ligne SAV.
 *
 * Factorisation du mapping erreur PG → HTTP des 3 handlers (update/create/delete).
 * Les 3 RPCs lèvent les mêmes codes via `RAISE EXCEPTION 'CODE|key=value'`.
 */

export interface PgRpcError {
  code?: string
  message?: string
}

export interface ParsedException {
  code: string
  payload: Record<string, string>
}

export function parseExceptionMessage(msg: string): ParsedException {
  const [code, ...rest] = msg.split('|')
  const payload: Record<string, string> = {}
  for (const part of rest) {
    const eq = part.indexOf('=')
    if (eq > 0) payload[part.slice(0, eq)] = part.slice(eq + 1)
  }
  return { code: code ?? 'UNKNOWN', payload }
}

export interface MapLineRpcErrorContext {
  requestId: string
  savId: number
  lineId?: number | null
  expectedVersion: number
  actorOperatorId: number
  logTag: string // ex. 'sav.line.create' / 'sav.line.delete' / 'sav.line.edit'
}

/**
 * Mappe les erreurs RPC des 3 fonctions ligne sur HTTP + écrit la réponse.
 * Retourne `true` si l'erreur a été traitée (handler doit `return`), `false`
 * si l'erreur est inconnue et doit faire l'objet d'un 500.
 */
export function mapLineRpcError(
  res: ApiResponse,
  err: PgRpcError,
  ctx: MapLineRpcErrorContext
): boolean {
  const { code, payload } = parseExceptionMessage(err.message ?? '')

  if (code === 'NOT_FOUND') {
    sendError(res, 'NOT_FOUND', 'SAV ou ligne introuvable', ctx.requestId)
    return true
  }
  if (code === 'VERSION_CONFLICT') {
    const currentVersion = Number(payload['current'])
    logger.warn(`${ctx.logTag}.conflict`, {
      requestId: ctx.requestId,
      savId: ctx.savId,
      lineId: ctx.lineId ?? null,
      expectedVersion: ctx.expectedVersion,
      currentVersion,
    })
    sendError(res, 'CONFLICT', 'Version périmée', ctx.requestId, {
      code: 'VERSION_CONFLICT',
      expectedVersion: ctx.expectedVersion,
      currentVersion,
    })
    return true
  }
  if (code === 'SAV_LOCKED') {
    sendError(res, 'BUSINESS_RULE', 'SAV verrouillé', ctx.requestId, {
      code: 'SAV_LOCKED',
      status: payload['status'] ?? null,
    })
    return true
  }
  if (code === 'ACTOR_NOT_FOUND') {
    logger.error(`${ctx.logTag}.actor_not_found`, {
      requestId: ctx.requestId,
      savId: ctx.savId,
      actorOperatorId: ctx.actorOperatorId,
    })
    sendError(res, 'FORBIDDEN', 'Acteur inconnu', ctx.requestId)
    return true
  }
  if (code === 'PRODUCT_NOT_FOUND') {
    sendError(res, 'BUSINESS_RULE', 'Produit introuvable ou archivé', ctx.requestId, {
      code: 'PRODUCT_NOT_FOUND',
      productId: payload['id'] ?? null,
    })
    return true
  }

  // Inconnu : laisse l'appelant logger en error + renvoyer 500.
  return false
}
