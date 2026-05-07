import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'

/**
 * Story 3.7b — AC #14 — SavTagsBar.vue component tests
 *
 * SB-01: Rendu chips avec role="button" et aria-label="Retirer le tag {tag}"
 * SB-02: Suppression optimistic + rollback sur 409 VERSION_CONFLICT
 * SB-03: Ajout via input + datalist suggestions fetched via debounce 250ms
 * SB-04: Regex client rejette tag contenant <script> → no fetch, error alert
 * SB-05: Toast role="alert" sur 422 TAGS_LIMIT
 */

// ---------------------------------------------------------------------------
// Stub SavTagsBar before it's created — test-driven scaffold
// The real component must implement these behaviors to make these tests pass.
// ---------------------------------------------------------------------------

// Since the component doesn't exist yet, we define the expected interface
// and test it as a RED-phase spec.
// The stub simulates the contract — real implementation must satisfy it.

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

// Import the real component once it exists
// RED phase: component not yet created → will fail until Task 5.1 is done
let SavTagsBar: ReturnType<typeof defineComponent>
try {
  // Dynamic import deferred to test body
} catch {
  // Component doesn't exist yet — tests will fail (RED)
}

async function importComponent() {
  return (await import('../../../../../src/features/back-office/components/SavTagsBar.vue')).default
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('SavTagsBar.vue (Story 3.7b AC#14)', () => {
  it('SB-01: rendu chips avec role="button" et aria-label correct pour chaque tag', async () => {
    SavTagsBar = await importComponent()
    const wrapper = mount(SavTagsBar, {
      props: { savId: 1, tags: ['urgent', 'livraison'], version: 2 },
      global: {
        stubs: { teleport: true },
      },
    })

    const chips = wrapper.findAll('[role="button"]')
    expect(chips.length).toBeGreaterThanOrEqual(2)

    const urgentChip = chips.find((c) => c.attributes('aria-label') === 'Retirer le tag urgent')
    const livraisonChip = chips.find(
      (c) => c.attributes('aria-label') === 'Retirer le tag livraison'
    )
    expect(urgentChip).toBeTruthy()
    expect(livraisonChip).toBeTruthy()
  })

  it('SB-02: suppression optimistic + rollback sur 409 VERSION_CONFLICT', async () => {
    SavTagsBar = await importComponent()
    const fetchMock = vi.fn(async () =>
      jsonResponse(409, {
        error: { code: 'CONFLICT', details: { code: 'VERSION_CONFLICT', currentVersion: 5 } },
      })
    )
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

    const wrapper = mount(SavTagsBar, {
      props: { savId: 1, tags: ['urgent', 'livraison'], version: 2 },
    })

    // Click the 'urgent' chip remove button
    const urgentChip = wrapper.find('[aria-label="Retirer le tag urgent"]')
    await urgentChip.trigger('click')

    // Optimistic: tag should disappear immediately before fetch returns
    // (In a real implementation, the chip is removed optimistically)

    await flushPromises()

    // After 409: rollback — tag should reappear
    const chipsAfterRollback = wrapper.findAll('[role="button"]')
    const hasUrgentBack = chipsAfterRollback.some(
      (c) => c.attributes('aria-label') === 'Retirer le tag urgent'
    )
    expect(hasUrgentBack).toBe(true)

    // Toast role="alert" must be visible
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
  })

  it('SB-03: ajout via input avec debounce 250ms pour suggestions', async () => {
    SavTagsBar = await importComponent()
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('suggestions')) {
        return jsonResponse(200, {
          data: {
            suggestions: [
              { tag: 'urgent', usage: 5 },
              { tag: 'urgence', usage: 2 },
            ],
          },
        })
      }
      return jsonResponse(200, { data: { tags: ['urgent', 'newtag'], version: 3 } })
    })
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

    const wrapper = mount(SavTagsBar, {
      props: { savId: 1, tags: [], version: 1 },
    })

    const input = wrapper.find('[aria-label="Ajouter un tag"]')
    expect(input.exists()).toBe(true)

    // Type 'urge' — should trigger debounce
    await input.setValue('urge')
    await input.trigger('input')

    // Before 250ms: no fetch for suggestions
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('suggestions'))

    // Advance 250ms
    await vi.advanceTimersByTimeAsync(250)
    await flushPromises()

    // After 250ms: suggestions fetch called
    const suggestionsCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('suggestions')
    )
    expect(suggestionsCalls.length).toBeGreaterThanOrEqual(1)
  })

  it('SB-04: regex client rejette tag contenant < → no fetch, error alert visible', async () => {
    SavTagsBar = await importComponent()
    const fetchMock = vi.fn()
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

    const wrapper = mount(SavTagsBar, {
      props: { savId: 1, tags: [], version: 1 },
    })

    const input = wrapper.find('[aria-label="Ajouter un tag"]')
    await input.setValue('<script>alert(1)</script>')
    // Simulate Enter key to submit
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    // No fetch must have been called (invalid tag rejected before network)
    const patchCalls = fetchMock.mock.calls.filter(
      ([url, init]) => (init as RequestInit | undefined)?.method === 'PATCH'
    )
    expect(patchCalls).toHaveLength(0)

    // Error alert visible
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
  })

  it('SB-05: toast role="alert" sur 422 TAGS_LIMIT', async () => {
    SavTagsBar = await importComponent()
    const fetchMock = vi.fn(async () =>
      jsonResponse(422, {
        error: {
          code: 'BUSINESS_RULE',
          details: { code: 'TAGS_LIMIT', count: 31, max: 30 },
        },
      })
    )
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

    const wrapper = mount(SavTagsBar, {
      props: { savId: 1, tags: Array.from({ length: 30 }, (_, i) => `tag-${i}`), version: 1 },
    })

    // Try to add one more tag
    const input = wrapper.find('[aria-label="Ajouter un tag"]')
    await input.setValue('newtag')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    const alertText = wrapper.find('[role="alert"]').text()
    expect(alertText.toLowerCase()).toMatch(/tag|limit/)
  })
})
