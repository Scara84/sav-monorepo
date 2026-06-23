import { randomUUID } from 'node:crypto'
import type { ApiRequest } from './types'

const HEADER = 'x-request-id'

export function ensureRequestId(req: ApiRequest): string {
  if (req.requestId) return req.requestId
  const fromHeader = req.headers[HEADER]
  const existing = Array.isArray(fromHeader) ? fromHeader[0] : fromHeader
  const id = existing && /^[-_a-zA-Z0-9]{8,128}$/.test(existing) ? existing : randomUUID()
  req.requestId = id
  return id
}
