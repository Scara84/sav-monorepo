import type { ApiRequest, ApiResponse } from '../../../../api/_lib/types'

export interface MockResponse extends ApiResponse {
  statusCode: number
  jsonBody: unknown
  headers: Record<string, string | number>
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
    end() {
      res.ended = true
    },
    getHeader(name: string) {
      return res.headers[name.toLowerCase()]
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
