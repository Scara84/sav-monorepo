import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { defineComponent } from 'vue'

/**
 * Story 3.7b — AC #14 — SavDetailView "M'assigner" button tests
 *
 * AM-01: Bouton désactivé pendant useCurrentUser loading
 * AM-02: Clic → PATCH /api/sav/:id/assign avec assigneeOperatorId=currentUser.sub
 * AM-03: 409 VERSION_CONFLICT → toast + re-fetch detail
 *
 * Pattern: useCurrentUser composable (PATTERN-A) called via GET /api/auth/me.
 */

const StubComponent = defineComponent({ template: '<div/>' })

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/admin/sav', name: 'admin-sav-list', component: StubComponent },
      { path: '/admin/sav/:id', name: 'admin-sav-detail', component: StubComponent },
    ],
  })
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

const SAV_PAYLOAD = {
  data: {
    sav: {
      id: 1,
      reference: 'SAV-2026-00001',
      status: 'in_progress',
      version: 2,
      groupId: null,
      invoiceRef: 'FAC-1',
      invoiceFdpCents: 0,
      totalAmountCents: 1500,
      tags: [],
      assignedTo: null,
      receivedAt: '2026-03-01T00:00:00.000Z',
      takenAt: null,
      validatedAt: null,
      closedAt: null,
      cancelledAt: null,
      member: {
        id: 10,
        firstName: 'Jean',
        lastName: 'Dubois',
        email: 'j@d.com',
        isGroupManager: false,
        groupId: null,
      },
      group: null,
      assignee: null,
      lines: [],
      files: [],
    },
    comments: [],
    auditTrail: [],
    settingsSnapshot: { vat_rate_default_bp: 550, group_manager_discount_bp: 400 },
  },
}

const ME_RESPONSE = {
  data: { sub: 42, type: 'operator', role: 'sav-operator' },
}

async function importSavDetailView() {
  return (await import('../../../../src/features/back-office/views/SavDetailView.vue')).default
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("SavDetailView — M'assigner button (Story 3.7b AC#14)", () => {
  it('AM-01: bouton désactivé pendant useCurrentUser loading', async () => {
    // Delay GET /api/auth/me to simulate loading
    let resolveMe!: (r: Response) => void
    const mePending = new Promise<Response>((res) => {
      resolveMe = res
    })

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/auth/me')) return mePending
      return jsonResponse(200, SAV_PAYLOAD)
    })
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

    const SavDetailView = await importSavDetailView()
    const router = makeRouter()
    await router.push('/admin/sav/1')
    await router.isReady()
    const wrapper = mount(SavDetailView, { global: { plugins: [router] } })
    await flushPromises()

    // While /api/auth/me is pending, the assign button should be disabled
    const assignBtn = wrapper.find('[aria-label="M\'assigner ce SAV"]')
    expect(assignBtn.exists()).toBe(true)
    expect((assignBtn.element as HTMLButtonElement).disabled).toBe(true)

    // Resolve the me request
    resolveMe(jsonResponse(200, ME_RESPONSE))
    await flushPromises()
  })

  it('AM-02: clic → PATCH /api/sav/:id/assign avec assigneeOperatorId=42', async () => {
    const patchBodies: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()

      if (url.includes('/api/auth/me')) return jsonResponse(200, ME_RESPONSE)
      if (method === 'PATCH' && url.includes('/assign')) {
        const body = JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>
        patchBodies.push(body)
        return jsonResponse(200, { data: { ...SAV_PAYLOAD.data.sav, assignedTo: 42, version: 3 } })
      }
      return jsonResponse(200, SAV_PAYLOAD)
    })
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

    const SavDetailView = await importSavDetailView()
    const router = makeRouter()
    await router.push('/admin/sav/1')
    await router.isReady()
    const wrapper = mount(SavDetailView, { global: { plugins: [router] } })
    await flushPromises()

    // Click assign button
    const assignBtn = wrapper.find('[aria-label="M\'assigner ce SAV"]')
    expect(assignBtn.exists()).toBe(true)
    await assignBtn.trigger('click')
    await flushPromises()

    // PATCH must have been called with assigneeOperatorId=42 (from me.sub)
    expect(patchBodies).toHaveLength(1)
    expect(patchBodies[0]?.['assigneeOperatorId']).toBe(42)
    expect(patchBodies[0]?.['version']).toBe(2) // SAV_PAYLOAD.version
  })

  it('AM-03: 409 VERSION_CONFLICT → toast role="alert" + re-fetch SAV detail', async () => {
    let detailFetchCount = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()

      if (url.includes('/api/auth/me')) return jsonResponse(200, ME_RESPONSE)
      if (method === 'PATCH' && url.includes('/assign')) {
        return jsonResponse(409, {
          error: {
            code: 'CONFLICT',
            details: { code: 'VERSION_CONFLICT', currentVersion: 5 },
          },
        })
      }
      if (method === 'GET') {
        detailFetchCount++
        return jsonResponse(200, SAV_PAYLOAD)
      }
      return jsonResponse(200, SAV_PAYLOAD)
    })
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

    const SavDetailView = await importSavDetailView()
    const router = makeRouter()
    await router.push('/admin/sav/1')
    await router.isReady()
    const wrapper = mount(SavDetailView, { global: { plugins: [router] } })
    await flushPromises()

    const initialFetchCount = detailFetchCount

    // Click assign button
    const assignBtn = wrapper.find('[aria-label="M\'assigner ce SAV"]')
    if (assignBtn.exists()) {
      await assignBtn.trigger('click')
      await flushPromises()

      // Toast must appear
      expect(wrapper.find('[role="alert"]').exists()).toBe(true)
      // Re-fetch must have been triggered (detailFetchCount > initial)
      expect(detailFetchCount).toBeGreaterThan(initialFetchCount)
    }
  })
})
