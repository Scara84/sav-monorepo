import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { defineComponent } from 'vue'
import MemberSavDetailView from '../../../../src/features/self-service/views/MemberSavDetailView.vue'

/**
 * Story 6.4 — TDD RED PHASE — extension `MemberSavDetailView.vue` (Story 6.3
 * GREEN existante) avec bouton « Télécharger bon SAV ».
 *
 * Cible AC #1 :
 *   - Si `data.creditNote.hasPdf === true` → bouton visible avec href
 *     `/api/credit-notes/{number}/pdf`, target=_blank, rel=noopener.
 *   - Si `creditNote && !hasPdf` → état « PDF en cours de génération »
 *     (auto-refresh évoqué — pas testé ici, scope unitaire).
 *   - Si `creditNote === null` → AUCUN bouton.
 *
 * On crée un spec-soeur dédié 6-4 plutôt que de modifier
 * `MemberSavDetailView.spec.ts` (Story 6.3 GREEN) pour ne pas casser la
 * suite régression existante en attendant l'implémentation.
 */

const StubList = defineComponent({ template: '<div>list</div>' })

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/monespace', name: 'member-sav-list', component: StubList },
      {
        path: '/monespace/sav/:id',
        name: 'member-sav-detail',
        component: MemberSavDetailView,
      },
    ],
  })
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    headers: new Headers(),
  } as unknown as Response
}

const BASE_DETAIL = {
  id: 123,
  reference: 'SAV-2026-00123',
  status: 'closed',
  version: 3,
  receivedAt: '2026-04-25T10:00:00Z',
  takenAt: '2026-04-25T11:00:00Z',
  validatedAt: '2026-04-26T10:00:00Z',
  closedAt: '2026-04-27T10:00:00Z',
  cancelledAt: null,
  totalAmountCents: 12500,
  lines: [],
  files: [],
  comments: [],
  creditNote: null as null | {
    number: string
    issuedAt: string
    totalTtcCents: number
    hasPdf: boolean
  },
}

const originalFetch = globalThis.fetch

async function mountAt(savId: string) {
  const router = makeRouter()
  await router.push(`/monespace/sav/${savId}`)
  await router.isReady()
  return mount(MemberSavDetailView, {
    global: { plugins: [router] },
  })
}

describe('MemberSavDetailView — bouton Télécharger PDF (Story 6.4)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('AC#1 (a) creditNote.hasPdf=true → bouton "Télécharger bon SAV" avec href /api/credit-notes/{number}/pdf', async () => {
    const detail = {
      ...BASE_DETAIL,
      creditNote: {
        number: 'AV-2026-00042',
        issuedAt: '2026-04-26T15:00:00Z',
        totalTtcCents: 9900,
        hasPdf: true,
      },
    }
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { data: detail }))
    ) as unknown as typeof globalThis.fetch
    const wrapper = await mountAt('123')
    await flushPromises()
    const btn = wrapper.find('[data-testid="download-credit-note-pdf"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('href')).toBe('/api/credit-notes/AV-2026-00042/pdf')
    expect(btn.attributes('target')).toBe('_blank')
    expect(btn.attributes('rel')).toContain('noopener')
    expect(btn.text()).toMatch(/Télécharger bon SAV/i)
  })

  it('AC#1 (b) creditNote présent mais hasPdf=false → état "PDF en cours de génération", PAS le bouton', async () => {
    const detail = {
      ...BASE_DETAIL,
      creditNote: {
        number: 'AV-2026-00042',
        issuedAt: '2026-04-26T15:00:00Z',
        totalTtcCents: 9900,
        hasPdf: false,
      },
    }
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { data: detail }))
    ) as unknown as typeof globalThis.fetch
    const wrapper = await mountAt('123')
    await flushPromises()
    expect(wrapper.find('[data-testid="download-credit-note-pdf"]').exists()).toBe(false)
    const pending = wrapper.find('[data-testid="credit-note-pdf-pending"]')
    expect(pending.exists()).toBe(true)
    expect(pending.text()).toMatch(/en cours de génération/i)
  })

  it('AC#1 (c) creditNote=null → aucun bouton ni état "en cours"', async () => {
    const detail = { ...BASE_DETAIL, creditNote: null }
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { data: detail }))
    ) as unknown as typeof globalThis.fetch
    const wrapper = await mountAt('123')
    await flushPromises()
    expect(wrapper.find('[data-testid="download-credit-note-pdf"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="credit-note-pdf-pending"]').exists()).toBe(false)
  })
})
