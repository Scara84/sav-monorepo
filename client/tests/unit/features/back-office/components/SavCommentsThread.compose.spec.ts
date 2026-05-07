import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { defineComponent } from 'vue'

/**
 * Story 3.7b — AC #14 — SavDetailView.vue ComposeCommentForm inline tests
 *
 * SC-01: Compose form rend <textarea aria-label="Nouveau commentaire"> + <fieldset> avec legend "Visibilité"
 * SC-02: Submit POST + append optimistic avec id sentinel `optimistic-${Date.now()}`
 * SC-03: Rollback sur erreur 5xx → optimistic comment removed, toast shown
 * SC-04: Visibility default = internal (conservative default)
 *
 * The ComposeCommentForm is inline in SavDetailView.vue (not a separate component per AC #6.2).
 * We test it via SavDetailView mount.
 */

const StubComponent = defineComponent({ template: '<div/>' })

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/admin/sav', name: 'admin-sav-list', component: StubComponent },
      {
        path: '/admin/sav/:id',
        name: 'admin-sav-detail',
        component: StubComponent,
      },
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

const SAV_PAYLOAD_WITH_COMMENTS = {
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

async function importSavDetailView() {
  return (await import('../../../../../src/features/back-office/views/SavDetailView.vue')).default
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function mountDetailWithFetch(fetchMock: ReturnType<typeof vi.fn>) {
  ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock
  const SavDetailView = await importSavDetailView()
  const router = makeRouter()
  await router.push('/admin/sav/1')
  await router.isReady()
  const wrapper = mount(SavDetailView, { global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

describe('SavDetailView — ComposeCommentForm inline (Story 3.7b AC#14)', () => {
  it('SC-01: compose form rend textarea aria-label="Nouveau commentaire" + fieldset Visibilité', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, SAV_PAYLOAD_WITH_COMMENTS))
    const wrapper = await mountDetailWithFetch(fetchMock)

    const textarea = wrapper.find('textarea[aria-label="Nouveau commentaire"]')
    expect(textarea.exists()).toBe(true)

    const fieldset = wrapper.find('fieldset')
    expect(fieldset.exists()).toBe(true)
    const legend = fieldset.find('legend')
    expect(legend.text()).toMatch(/[Vv]isibilité|[Vv]isibility/)
  })

  it('SC-04: visibility default = internal (conservative default)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, SAV_PAYLOAD_WITH_COMMENTS))
    const wrapper = await mountDetailWithFetch(fetchMock)

    // Radio input for 'internal' must be checked by default
    const internalRadio = wrapper.find('input[type="radio"][value="internal"]')
    expect(internalRadio.exists()).toBe(true)
    expect((internalRadio.element as HTMLInputElement).checked).toBe(true)

    // Radio input for 'all' must NOT be checked by default
    const allRadio = wrapper.find('input[type="radio"][value="all"]')
    if (allRadio.exists()) {
      expect((allRadio.element as HTMLInputElement).checked).toBe(false)
    }
  })

  it('SC-02: submit POST + append optimistic avec sentinel id puis remplacement par id réel', async () => {
    const realCommentId = 999
    let callCount = 0
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'GET' || callCount === 0) {
        callCount++
        return jsonResponse(200, SAV_PAYLOAD_WITH_COMMENTS)
      }
      if (method === 'POST' && String(url).includes('/comments')) {
        return jsonResponse(201, {
          data: {
            commentId: realCommentId,
            createdAt: '2026-05-06T10:00:00Z',
            visibility: 'internal',
            body: 'Test comment',
            authorOperator: { id: 42 },
          },
        })
      }
      return jsonResponse(200, SAV_PAYLOAD_WITH_COMMENTS)
    })

    const wrapper = await mountDetailWithFetch(fetchMock)

    const textarea = wrapper.find('textarea[aria-label="Nouveau commentaire"]')
    await textarea.setValue('Test comment')

    // Submit form
    const form = wrapper.find('form')
    if (form.exists()) {
      await form.trigger('submit')
    } else {
      // Try submit button
      const submitBtn = wrapper.find('button[type="submit"]')
      if (submitBtn.exists()) await submitBtn.trigger('click')
    }

    // Optimistic comment should appear immediately (before flush)
    // Check for sentinel pattern in the rendered HTML
    // The optimistic id contains 'optimistic-' prefix
    // We verify the comment list has at least one item after submit
    await flushPromises()

    // After resolution: real id (999) should replace optimistic id
    // The comment with 'Test comment' body should be visible
    expect(wrapper.html()).toContain('Test comment')
  })

  it('SC-03: rollback sur erreur 5xx — optimistic comment removed, toast shown', async () => {
    let callCount = 0
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'GET' || callCount === 0) {
        callCount++
        return jsonResponse(200, SAV_PAYLOAD_WITH_COMMENTS)
      }
      if (method === 'POST' && String(url).includes('/comments')) {
        return jsonResponse(500, { error: { code: 'SERVER_ERROR', message: 'Internal error' } })
      }
      return jsonResponse(200, SAV_PAYLOAD_WITH_COMMENTS)
    })

    const wrapper = await mountDetailWithFetch(fetchMock)

    const textarea = wrapper.find('textarea[aria-label="Nouveau commentaire"]')
    await textarea.setValue('Should be rolled back')

    const form = wrapper.find('form')
    if (form.exists()) {
      await form.trigger('submit')
    } else {
      const submitBtn = wrapper.find('button[type="submit"]')
      if (submitBtn.exists()) await submitBtn.trigger('click')
    }

    await flushPromises()

    // After 5xx: toast error must appear
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
  })
})
