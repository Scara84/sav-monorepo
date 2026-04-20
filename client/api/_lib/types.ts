// Types minimaux pour les fonctions serverless Vercel.
// Évite la dépendance @vercel/node tout en permettant le typecheck strict.

export interface SessionUser {
  /** operator.id ou member.id selon `type` */
  sub: number
  type: 'operator' | 'member'
  role?: 'admin' | 'sav-operator' | 'member' | 'group-manager'
  email?: string
  /** scope self-service (member uniquement) */
  scope?: 'self' | 'group'
  groupId?: number
  /** exp en secondes epoch (standard JWT) */
  exp: number
}

export interface ApiRequest {
  method?: string
  headers: Record<string, string | string[] | undefined>
  body?: unknown
  cookies?: Record<string, string | undefined>
  query?: Record<string, string | string[] | undefined>
  /** positionné par withAuth */
  user?: SessionUser
  /** positionné par request-id */
  requestId?: string
  /** IP source (lu depuis X-Forwarded-For ou req.socket) */
  ip?: string
}

export interface ApiResponse {
  status: (code: number) => ApiResponse
  json: (data: unknown) => ApiResponse
  setHeader: (name: string, value: string | number) => ApiResponse
  end: (chunk?: string) => void
  getHeader: (name: string) => string | number | string[] | undefined
}

export type ApiHandler = (req: ApiRequest, res: ApiResponse) => Promise<unknown> | unknown
