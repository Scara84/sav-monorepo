import type { ApiRequest, ApiResponse } from '../../../../api/_lib/types'

export interface MockResponse extends ApiResponse {
  statusCode: number
  jsonBody: unknown
  headers: Record<string, string | number | string[]>
  ended: boolean
}

export function mockRes(): MockResponse {
  const res: MockResponse = {
    statusCode: 200,
    jsonBody: undefined,
    headers: {},
    ended: false,
    status(code: number) {
      res.statusCode = code
      return res
    },
    json(data: unknown) {
      res.jsonBody = data
      res.ended = true
      return res
    },
    setHeader(name: string, value: string | number) {
      res.headers[name.toLowerCase()] = value
      return res
    },
    appendHeader(name: string, value: string | readonly string[]) {
      const key = name.toLowerCase()
      const prev = res.headers[key]
      const next = Array.isArray(value) ? [...value] : [value as string]
      if (prev === undefined) {
        res.headers[key] = next.length === 1 ? (next[0] as string) : next
      } else {
        const prevArr = Array.isArray(prev) ? prev : [String(prev)]
        res.headers[key] = [...prevArr, ...next]
      }
      return res
    },
    end() {
      res.ended = true
    },
    getHeader(name: string) {
      const v = res.headers[name.toLowerCase()]
      if (typeof v === 'number') return v
      return v
    },
  }
  return res
}

export function mockReq(partial: Partial<ApiRequest> = {}): ApiRequest {
  return {
    method: 'POST',
    headers: {},
    body: {},
    cookies: {},
    query: {},
    ...partial,
  }
}
