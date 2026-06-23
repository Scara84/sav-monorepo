import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Story 7-3a AC #5 — RED-PHASE tests pour le composable générique
 * `useAdminCrud<TItem, TCreate, TUpdate>(resource)`. Composable attendu :
 *   client/src/features/back-office/composables/useAdminCrud.ts
 *
 * Signature :
 *   function useAdminCrud<TItem, TCreate, TUpdate>(
 *     resource: 'operators' | 'products' | 'validation-lists'
 *   ): {
 *     items: Ref<TItem[]>
 *     total: Ref<number>
 *     loading: Ref<boolean>
 *     error: Ref<string | null>
 *     list(params?: Record<string, unknown>): Promise<void>
 *     create(payload: TCreate): Promise<TItem>
 *     update(id: number, patch: TUpdate): Promise<TItem>
 *     remove(id: number): Promise<void>
 *   }
 */

const originalFetch = globalThis.fetch

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    headers: new Headers(),
    statusText: '',
    redirected: false,
    type: 'basic',
    url: '',
    clone: () => {
      throw new Error('not impl')
    },
  } as unknown as Response
}

// RED — module n'existe pas encore.
import { useAdminCrud } from './useAdminCrud'

interface OperatorItem {
  id: number
  email: string
  display_name: string
  role: string
  is_active: boolean
}
interface OperatorCreate {
  email: string
  display_name: string
  role: string
}
interface OperatorUpdate {
  is_active?: boolean
  role?: string
}

describe('useAdminCrud<T> (composable générique D-11)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('list("operators") → GET /api/admin/operators et remplit items/total', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        data: {
          items: [{ id: 9, email: 'admin@x', display_name: 'A', role: 'admin', is_active: true }],
          total: 1,
          hasMore: false,
        },
      })
    )
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const crud = useAdminCrud<OperatorItem, OperatorCreate, OperatorUpdate>('operators')
    await crud.list({ limit: 50 })
    const url = String((mockFetch.mock.calls[0] as [string])[0])
    expect(url).toContain('/api/admin/operators')
    expect(crud.items.value).toHaveLength(1)
    expect(crud.total.value).toBe(1)
    expect(crud.loading.value).toBe(false)
    expect(crud.error.value).toBeNull()
  })

  it('create() → POST avec body JSON et retourne TItem', async () => {
    const created: OperatorItem = {
      id: 100,
      email: 'new@x',
      display_name: 'New',
      role: 'sav-operator',
      is_active: true,
    }
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(201, { data: { operator: created } }))
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const crud = useAdminCrud<OperatorItem, OperatorCreate, OperatorUpdate>('operators')
    const out = await crud.create({ email: 'new@x', display_name: 'New', role: 'sav-operator' })
    expect(out.id).toBe(100)
    const call = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(call[1].method).toBe('POST')
    expect(JSON.parse(String(call[1].body))).toMatchObject({ email: 'new@x' })
  })

  it('update(id, patch) → PATCH /:id avec patch JSON', async () => {
    const updated: OperatorItem = {
      id: 100,
      email: 'new@x',
      display_name: 'New',
      role: 'sav-operator',
      is_active: false,
    }
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(200, { data: { operator: updated } }))
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const crud = useAdminCrud<OperatorItem, OperatorCreate, OperatorUpdate>('operators')
    const out = await crud.update(100, { is_active: false })
    expect(out.is_active).toBe(false)
    const call = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(call[0]).toContain('/api/admin/operators/100')
    expect(call[1].method).toBe('PATCH')
  })

  it('error 4xx → error.value renseigné, loading repassé à false', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(403, { error: { code: 'FORBIDDEN', details: { code: 'ROLE_NOT_ALLOWED' } } })
      )
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const crud = useAdminCrud<OperatorItem, OperatorCreate, OperatorUpdate>('operators')
    await expect(crud.list()).rejects.toThrow()
    expect(crud.error.value).not.toBeNull()
    expect(crud.loading.value).toBe(false)
  })
})
