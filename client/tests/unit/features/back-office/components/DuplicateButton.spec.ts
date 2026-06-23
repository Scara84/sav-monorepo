import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { defineComponent } from 'vue'

/**
 * Story 3.7b — AC #14 — DuplicateButton.vue component tests
 *
 * DB-01: Confirm dialog ouvre avec role="dialog" aria-modal="true", Escape ferme
 * DB-02: Succès → router.push('/admin/sav/'+newSavId)
 * DB-03: Erreur 5xx → toast role="alert", dialog reste ouvert
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

async function importComponent() {
  return (await import('../../../../../src/features/back-office/components/DuplicateButton.vue'))
    .default
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DuplicateButton.vue (Story 3.7b AC#14)', () => {
  it('DB-01: clic ouvre dialog role="dialog" aria-modal="true", Escape ferme', async () => {
    const DuplicateButton = await importComponent()
    const fetchMock = vi.fn()
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

    const router = makeRouter()
    await router.push('/admin/sav/1')
    await router.isReady()

    const wrapper = mount(DuplicateButton, {
      props: { savId: 1 },
      global: { plugins: [router] },
    })

    // Initially dialog should not be visible / open
    const dialogBefore = wrapper.find('[role="dialog"]')
    const isOpenBefore =
      !dialogBefore.exists() || (dialogBefore.element as HTMLDialogElement).open === false

    // Click duplicate button
    const duplicateBtn = wrapper.find('button')
    await duplicateBtn.trigger('click')
    await flushPromises()

    // Dialog must appear
    const dialog = wrapper.find('[role="dialog"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.attributes('aria-modal')).toBe('true')

    // Escape closes dialog
    await wrapper.trigger('keydown', { key: 'Escape' })
    await flushPromises()

    // Dialog should be closed
    const dialogAfterEscape = wrapper.find('[role="dialog"]')
    // Either not present or not open
    const isClosed =
      !dialogAfterEscape.exists() ||
      (dialogAfterEscape.element as HTMLDialogElement).open === false ||
      dialogAfterEscape.isVisible() === false

    expect(isClosed).toBe(true)
  })

  it('DB-02: confirm → POST /api/sav/:id/duplicate → router.push /admin/sav/newSavId', async () => {
    const DuplicateButton = await importComponent()
    const fetchMock = vi.fn(async () =>
      jsonResponse(201, { data: { newSavId: 500, newReference: 'SAV-2026-00100' } })
    )
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

    const router = makeRouter()
    const pushSpy = vi.spyOn(router, 'push')
    await router.push('/admin/sav/1')
    await router.isReady()

    const wrapper = mount(DuplicateButton, {
      props: { savId: 1 },
      global: { plugins: [router] },
    })

    // Open dialog
    await wrapper.find('button').trigger('click')
    await flushPromises()

    // Click confirm button in dialog
    const confirmBtn =
      wrapper.find('[role="dialog"] button[data-confirm]') ||
      wrapper.findAll('[role="dialog"] button').find((b) => {
        const text = b.text().toLowerCase()
        return (
          text.includes('confirm') ||
          text.includes('créer') ||
          text.includes('dupliquer') ||
          text.includes('oui')
        )
      })

    if (!confirmBtn) {
      // Fallback: find any confirm-looking button
      const buttons = wrapper.findAll('button')
      const confirmButton = buttons.find((b) => {
        const text = b.text().toLowerCase()
        return text.includes('créer') || text.includes('confirm') || text.includes('dupliquer')
      })
      if (confirmButton) await confirmButton.trigger('click')
    } else {
      await confirmBtn.trigger('click')
    }

    await flushPromises()

    // router.push must have been called with the new SAV URL
    expect(pushSpy).toHaveBeenCalledWith('/admin/sav/500')
  })

  it('DB-03: erreur 5xx → toast role="alert" visible, dialog reste ouvert', async () => {
    const DuplicateButton = await importComponent()
    const fetchMock = vi.fn(async () =>
      jsonResponse(500, { error: { code: 'SERVER_ERROR', message: 'Internal error' } })
    )
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchMock

    const router = makeRouter()
    await router.push('/admin/sav/1')
    await router.isReady()

    const wrapper = mount(DuplicateButton, {
      props: { savId: 1 },
      global: { plugins: [router] },
    })

    // Open dialog
    await wrapper.find('button').trigger('click')
    await flushPromises()

    // Click confirm — target [data-confirm] directly to avoid DOM-order coupling
    // (the trigger button text "Dupliquer" would otherwise match the same heuristic
    //  as the confirm button and be picked first by findAll order).
    const confirmBtn = wrapper.find('[role="dialog"] button[data-confirm]')
    expect(confirmBtn.exists()).toBe(true)
    await confirmBtn.trigger('click')

    await flushPromises()

    // Toast error must appear
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)

    // Dialog must remain open (not closed on error)
    const dialog = wrapper.find('[role="dialog"]')
    expect(dialog.exists()).toBe(true)
  })
})
