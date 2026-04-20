import type { ApiResponse } from './types'

export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'LINK_CONSUMED'
  | 'LINK_EXPIRED'
  | 'BUSINESS_RULE'
  | 'SERVER_ERROR'
  | 'DEPENDENCY_DOWN'

export interface ErrorEnvelope {
  error: {
    code: ErrorCode
    message: string
    details?: unknown
    requestId: string
  }
}

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  LINK_CONSUMED: 410,
  LINK_EXPIRED: 401,
  BUSINESS_RULE: 422,
  SERVER_ERROR: 500,
  DEPENDENCY_DOWN: 503,
}

export function httpStatus(code: ErrorCode): number {
  return STATUS_BY_CODE[code]
}

export function errorEnvelope(
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: unknown
): ErrorEnvelope {
  const base: ErrorEnvelope['error'] = { code, message, requestId }
  if (details !== undefined) base.details = details
  return { error: base }
}

export function sendError(
  res: ApiResponse,
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: unknown
): void {
  const status = httpStatus(code)
  const body = errorEnvelope(code, message, requestId, details)
  res.status(status).json(body)
}
