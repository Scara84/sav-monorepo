import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useAdminSettings } from './useAdminSettings'

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

describe('useAdminSettings (composable)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('loadHistory GET /api/admin/settings/threshold_alert/history?limit=10', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        data: {
          items: [
            {
              id: 1,
              value: { count: 5, days: 7, dedup_hours: 24 },
              valid_from: '2026-04-20T10:00:00Z',
              valid_to: null,
              notes: null,
              created_at: '2026-04-20T10:00:00Z',
              updated_by: { id: 9, email_display_short: 'admin' },
            },
          ],
        },
      })
    )
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const settings = useAdminSettings()
    await settings.loadHistory('threshold_alert', 10)
    expect(settings.history.value).toHaveLength(1)
    const url = (mockFetch.mock.calls[0] as [string])[0]
    expect(url).toBe('/api/admin/settings/threshold_alert/history?limit=10')
  })

  it("loadCurrent dérive la valeur active depuis l'historique", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        data: {
          items: [
            {
              id: 2,
              value: { count: 7, days: 14, dedup_hours: 48 },
              valid_from: '2026-04-25T10:00:00Z',
              valid_to: null,
              notes: 'tighten',
              created_at: '2026-04-25T10:00:00Z',
              updated_by: { id: 9, email_display_short: 'admin' },
            },
            {
              id: 1,
              value: { count: 5, days: 7, dedup_hours: 24 },
              valid_from: '2026-04-20T10:00:00Z',
              valid_to: '2026-04-25T10:00:00Z',
              notes: null,
              created_at: '2026-04-20T10:00:00Z',
              updated_by: null,
            },
          ],
        },
      })
    )
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const settings = useAdminSettings()
    await settings.loadCurrent('threshold_alert')
    expect(settings.current.value).not.toBeNull()
    expect(settings.current.value?.id).toBe(2)
    expect(settings.current.value?.value).toEqual({ count: 7, days: 14, dedup_hours: 48 })
  })

  it('updateThreshold appelle PATCH avec body JSON', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        data: {
          id: 5,
          key: 'threshold_alert',
          value: { count: 10, days: 30, dedup_hours: 12 },
          valid_from: '2026-04-28T10:00:00Z',
          valid_to: null,
          updated_by: 9,
          notes: 'spec',
          created_at: '2026-04-28T10:00:00Z',
        },
      })
    )
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const settings = useAdminSettings()
    const out = await settings.updateThreshold({
      count: 10,
      days: 30,
      dedup_hours: 12,
      notes: 'spec',
    })
    expect(out.id).toBe(5)
    const call = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(call[0]).toBe('/api/admin/settings/threshold_alert')
    expect(call[1].method).toBe('PATCH')
    const body = JSON.parse(String(call[1].body)) as { count: number; notes: string }
    expect(body.count).toBe(10)
    expect(body.notes).toBe('spec')
    expect(settings.current.value?.id).toBe(5)
  })

  it('updateThreshold traduit ROLE_NOT_ALLOWED en message FR', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse(403, {
        error: { code: 'FORBIDDEN', details: { code: 'ROLE_NOT_ALLOWED' } },
      })
    )
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const settings = useAdminSettings()
    await expect(settings.updateThreshold({ count: 5, days: 7, dedup_hours: 24 })).rejects.toThrow()
    expect(settings.saveError.value).toBe('Réservé aux administrateurs.')
  })

  it('updateThreshold mappe 5xx → GATEWAY message', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(503, {}))
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const settings = useAdminSettings()
    await expect(settings.updateThreshold({ count: 5, days: 7, dedup_hours: 24 })).rejects.toThrow()
    expect(settings.saveError.value).toBe('Service indisponible, réessayez dans quelques instants.')
  })

  it('loadHistory échec → loadError = "Erreur réseau."', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError('network down'))
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const settings = useAdminSettings()
    await expect(settings.loadHistory('threshold_alert')).rejects.toThrow()
    expect(settings.loadError.value).toBe('Erreur réseau.')
  })
})
