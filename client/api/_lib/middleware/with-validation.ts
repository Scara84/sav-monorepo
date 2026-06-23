import type { ZodError, ZodType } from 'zod'
import { sendError } from '../errors'
import { ensureRequestId } from '../request-id'
import type { ApiHandler, ApiRequest, ApiResponse } from '../types'

export interface WithValidationOptions<T> {
  body?: ZodType<T>
  query?: ZodType<Record<string, unknown>>
}

/**
 * Valide req.body et/ou req.query contre des schémas Zod.
 * - 400 VALIDATION_FAILED avec `details: [{ field, message, received }]` si KO.
 * - Attache `req.body` / `req.query` transformés (parsed) si OK.
 */
export function withValidation<T>(options: WithValidationOptions<T>) {
  return (handler: ApiHandler): ApiHandler =>
    async (req: ApiRequest, res: ApiResponse) => {
      const requestId = ensureRequestId(req)

      if (options.body) {
        const result = options.body.safeParse(req.body)
        if (!result.success) {
          sendError(
            res,
            'VALIDATION_FAILED',
            'Validation body échouée',
            requestId,
            formatErrors(result.error)
          )
          return
        }
        req.body = result.data
      }

      if (options.query) {
        const result = options.query.safeParse(req.query)
        if (!result.success) {
          sendError(
            res,
            'VALIDATION_FAILED',
            'Validation query échouée',
            requestId,
            formatErrors(result.error)
          )
          return
        }
        req.query = result.data as Record<string, string | string[] | undefined>
      }

      return handler(req, res)
    }
}

export function formatErrors(
  err: ZodError
): Array<{ field: string; message: string; received?: unknown }> {
  return err.issues.map((issue) => {
    const out: { field: string; message: string; received?: unknown } = {
      field: issue.path.length > 0 ? issue.path.join('.') : '(root)',
      message: issue.message,
    }
    if ('received' in issue) out.received = (issue as { received: unknown }).received
    return out
  })
}
