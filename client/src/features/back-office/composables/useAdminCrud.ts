import { ref, type Ref } from 'vue'

/**
 * Story 7-3a AC #5 / D-11 — Composable générique CRUD admin.
 *
 * Signature :
 *   useAdminCrud<TItem, TCreate, TUpdate>(
 *     resource: 'operators' | 'products' | 'validation-lists'
 *   ): { items, total, loading, error, list, create, update, remove }
 *
 * Endpoints consommés :
 *   GET    /api/admin/{resource}            → list
 *   POST   /api/admin/{resource}            → create
 *   PATCH  /api/admin/{resource}/:id        → update
 *   DELETE /api/admin/{resource}/:id        → remove
 *
 * Note Story 7-3a : pour `operators`, `remove()` n'est pas câblé V1 (la
 * désactivation soft-delete passe par `update(id, { is_active: false })`).
 * Story 7-3b consumera `remove()` pour catalog DELETE physique.
 *
 * Réponses serveur (cohérentes pilotage.ts) :
 *   list   → { data: { items: TItem[], total: number, hasMore: boolean } }
 *   create → { data: { operator: TItem } } (ou autre nom selon resource)
 *   update → { data: { operator: TItem } } (idem)
 *
 * V1 : on accepte les wrappers `{operator}`, `{product}`, `{item}` ou
 * directement `data: TItem` — le composable extrait via fallback.
 */

export type AdminResource = 'operators' | 'products' | 'validation-lists'

export interface UseAdminCrudApi<TItem, TCreate, TUpdate> {
  items: Ref<TItem[]>
  total: Ref<number>
  loading: Ref<boolean>
  error: Ref<string | null>
  list: (params?: Record<string, unknown>) => Promise<void>
  create: (payload: TCreate) => Promise<TItem>
  update: (id: number, patch: TUpdate) => Promise<TItem>
  remove: (id: number) => Promise<void>
}

interface ApiErrorShape {
  error?: {
    code?: string
    message?: string
    details?: { code?: string } & Record<string, unknown>
  }
}

const errorMessages: Record<string, string> = {
  INVALID_BODY: 'Données invalides.',
  INVALID_PARAMS: 'Paramètres invalides.',
  ROLE_NOT_ALLOWED: 'Réservé aux administrateurs.',
  EMAIL_ALREADY_EXISTS: 'Email déjà utilisé.',
  AZURE_OID_ALREADY_EXISTS: 'azure_oid déjà utilisé.',
  CANNOT_DEACTIVATE_SELF: 'Vous ne pouvez pas vous désactiver vous-même.',
  CANNOT_DEMOTE_SELF: 'Vous ne pouvez pas vous rétrograder vous-même.',
  LAST_ADMIN_PROTECTION: 'Au moins un admin actif est requis.',
  PERSIST_FAILED: 'Enregistrement impossible.',
  QUERY_FAILED: 'Lecture impossible.',
  RATE_LIMITED: 'Trop de tentatives.',
  FORBIDDEN: 'Accès refusé.',
  UNAUTHENTICATED: 'Session expirée.',
  NETWORK: 'Erreur réseau.',
  UNKNOWN: 'Erreur inattendue.',
}

function extractErrorCode(body: ApiErrorShape, fallback: string): string {
  const detailsCode = body.error?.details?.code
  if (typeof detailsCode === 'string' && detailsCode.length > 0) return detailsCode
  const topCode = body.error?.code
  if (typeof topCode === 'string' && topCode.length > 0) return topCode
  return fallback
}

function classifyHttpError(status: number, body: ApiErrorShape): string {
  const code = extractErrorCode(body, '')
  if (code) return code
  if (status >= 500 && status < 600) return 'NETWORK'
  return 'UNKNOWN'
}

function translate(code: string): string {
  return errorMessages[code] ?? errorMessages['UNKNOWN']!
}

function extractItem<T>(payload: unknown): T | null {
  if (payload === null || typeof payload !== 'object') return null
  const obj = payload as Record<string, unknown>
  // Cas 1 : { data: { operator: T } } ou { data: { product: T } } etc.
  if (typeof obj['data'] === 'object' && obj['data'] !== null) {
    const data = obj['data'] as Record<string, unknown>
    for (const key of ['operator', 'product', 'item', 'validation_list']) {
      if (key in data) return data[key] as T
    }
    // Cas 2 : { data: T } direct
    return data as T
  }
  return null
}

function buildQuery(params: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  }
  return parts.length === 0 ? '' : `?${parts.join('&')}`
}

export function useAdminCrud<TItem, TCreate, TUpdate>(
  resource: AdminResource
): UseAdminCrudApi<TItem, TCreate, TUpdate> {
  const items = ref<TItem[]>([]) as Ref<TItem[]>
  const total = ref(0)
  const loading = ref(false)
  const error = ref<string | null>(null)

  const baseUrl = `/api/admin/${resource}`

  async function list(params: Record<string, unknown> = {}): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const url = baseUrl + buildQuery(params)
      const res = await fetch(url, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      })
      const body = (await res.json().catch(() => ({}))) as ApiErrorShape & {
        data?: { items?: TItem[]; total?: number; hasMore?: boolean }
      }
      if (!res.ok) {
        const msg = translate(classifyHttpError(res.status, body))
        error.value = msg
        throw new Error(msg)
      }
      items.value = body.data?.items ?? []
      total.value = body.data?.total ?? 0
    } finally {
      loading.value = false
    }
  }

  async function create(payload: TCreate): Promise<TItem> {
    loading.value = true
    error.value = null
    try {
      const res = await fetch(baseUrl, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      })
      const body = (await res.json().catch(() => ({}))) as ApiErrorShape
      if (!res.ok) {
        const msg = translate(classifyHttpError(res.status, body))
        error.value = msg
        throw new Error(msg)
      }
      const item = extractItem<TItem>(body)
      if (item === null) {
        error.value = translate('UNKNOWN')
        throw new Error(error.value)
      }
      return item
    } finally {
      loading.value = false
    }
  }

  async function update(id: number, patch: TUpdate): Promise<TItem> {
    loading.value = true
    error.value = null
    try {
      const url = `${baseUrl}/${encodeURIComponent(String(id))}`
      const res = await fetch(url, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(patch),
      })
      const body = (await res.json().catch(() => ({}))) as ApiErrorShape
      if (!res.ok) {
        const msg = translate(classifyHttpError(res.status, body))
        error.value = msg
        throw new Error(msg)
      }
      const item = extractItem<TItem>(body)
      if (item === null) {
        error.value = translate('UNKNOWN')
        throw new Error(error.value)
      }
      return item
    } finally {
      loading.value = false
    }
  }

  async function remove(id: number): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const url = `${baseUrl}/${encodeURIComponent(String(id))}`
      const res = await fetch(url, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as ApiErrorShape
        const msg = translate(classifyHttpError(res.status, body))
        error.value = msg
        throw new Error(msg)
      }
    } finally {
      loading.value = false
    }
  }

  return { items, total, loading, error, list, create, update, remove }
}
