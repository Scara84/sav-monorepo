import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { defineComponent } from 'vue'
import MemberSavDetailView from '../../../../src/features/self-service/views/MemberSavDetailView.vue'

/**
 * Story 6.3 — GREEN PHASE — `MemberSavDetailView.vue` + sous-composants.
 *
 * Couvre AC #1, #2, #3, #4, #6, #7, #8, #10, #15.
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

const DETAIL_RESPONSE = {
  data: {
    id: 123,
    reference: 'SAV-2026-00123',
    status: 'in_progress',
    version: 2,
    receivedAt: '2026-04-25T10:00:00Z',
    takenAt: '2026-04-25T11:00:00Z',
    validatedAt: null,
    closedAt: null,
    cancelledAt: null,
    totalAmountCents: 12500,
    lines: [
      {
        id: 11,
        description: 'Pomme Bio',
        qty: 5,
        qtyUnit: 'kg',
        motif: 'Non conforme',
        validationStatus: 'ok',
        validationStatusLabel: 'Vérifié OK',
        validationMessage: null,
      },
    ],
    files: [
      {
        id: 50,
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 12345,
        oneDriveWebUrl: 'https://example.sharepoint.com/photo',
        uploadedByMember: true,
      },
      {
        id: 51,
        filename: 'reponse.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 5500,
        oneDriveWebUrl: 'https://example.sharepoint.com/reponse',
        uploadedByMember: false,
      },
    ],
    comments: [
      {
        id: 1,
        body: 'Ma question',
        createdAt: '2026-04-26T10:00:00Z',
        authorLabel: 'Vous',
      },
      {
        id: 2,
        body: 'Réponse opérateur',
        createdAt: '2026-04-26T11:00:00Z',
        authorLabel: 'Équipe Fruitstock',
      },
    ],
    creditNote: null,
  },
}

const originalFetch = globalThis.fetch

async function mountAt(savId: string) {
  const router = makeRouter()
  await router.push(`/monespace/sav/${savId}`)
  await router.isReady()
  return mount(MemberSavDetailView, {
    global: {
      plugins: [router],
    },
  })
}

describe('MemberSavDetailView (Story 6.3)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('AC#1 monte le composant et appelle GET /api/self-service/sav/:id', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, DETAIL_RESPONSE)))
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    const wrapper = await mountAt('123')
    await flushPromises()
    expect(fetchMock).toHaveBeenCalled()
    const firstCall = fetchMock.mock.calls[0] as unknown as [string, unknown]
    expect(firstCall[0]).toContain('/api/self-service/sav/123')
    void wrapper
  })

  it('AC#15 rend les 5 sous-composants après chargement', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse(200, DETAIL_RESPONSE))
    ) as unknown as typeof globalThis.fetch
    const wrapper = await mountAt('123')
    await flushPromises()
    expect(wrapper.find('[data-testid="sav-summary"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="sav-lines"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="sav-files-list"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="sav-comments-thread"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="sav-status-history"]').exists()).toBe(true)
  })

  it('affiche loading state pendant que la requête est en cours', async () => {
    let resolveFn: (v: Response) => void = () => undefined
    globalThis.fetch = vi.fn(
      () =>
        new Promise<Response>((r) => {
          resolveFn = r
        })
    ) as unknown as typeof globalThis.fetch
    const wrapper = await mountAt('123')
    expect(wrapper.find('[data-testid="loading-state"]').exists()).toBe(true)
    resolveFn(jsonResponse(200, DETAIL_RESPONSE))
    await flushPromises()
    expect(wrapper.find('[data-testid="loading-state"]').exists()).toBe(false)
  })

  it("affiche un message d'erreur 404 (sav d'un autre member) + bouton retry", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse(404, { error: { code: 'NOT_FOUND' } }))
    ) as unknown as typeof globalThis.fetch
    const wrapper = await mountAt('999')
    await flushPromises()
    expect(wrapper.find('[data-testid="error-404"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="retry-button"]').exists()).toBe(true)
  })

  it('bouton "Réessayer" relance la requête en cas d\'erreur', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, { error: { code: 'SERVER_ERROR' } }))
      .mockResolvedValueOnce(jsonResponse(200, DETAIL_RESPONSE))
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    const wrapper = await mountAt('123')
    await flushPromises()
    expect(wrapper.find('[data-testid="error-generic"]').exists()).toBe(true)
    await wrapper.find('[data-testid="retry-button"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="sav-summary"]').exists()).toBe(true)
  })

  it('AC#2 MemberSavLines rend description, qté, motif, validationStatusLabel FR', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse(200, DETAIL_RESPONSE))
    ) as unknown as typeof globalThis.fetch
    const wrapper = await mountAt('123')
    await flushPromises()
    const lines = wrapper.find('[data-testid="sav-lines"]')
    expect(lines.text()).toContain('Pomme Bio')
    expect(lines.text()).toContain('Non conforme')
    expect(lines.text()).toContain('Vérifié OK')
  })

  it('AC#2 lines NE rendent PAS credit_coefficient ni totaux', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse(200, DETAIL_RESPONSE))
    ) as unknown as typeof globalThis.fetch
    const wrapper = await mountAt('123')
    await flushPromises()
    const text = wrapper.find('[data-testid="sav-lines"]').text()
    expect(text).not.toMatch(/credit_coefficient/i)
    expect(text).not.toMatch(/pieceKg/i)
  })

  it('AC#4 MemberSavFilesList rend liens target=_blank rel=noopener', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse(200, DETAIL_RESPONSE))
    ) as unknown as typeof globalThis.fetch
    const wrapper = await mountAt('123')
    await flushPromises()
    const links = wrapper.findAll('[data-testid="file-link"]')
    expect(links.length).toBeGreaterThan(0)
    const link = links[0]!
    expect(link.attributes('href')).toContain('https://example.sharepoint.com')
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toContain('noopener')
  })

  it('AC#4 affiche badge "Ajouté par l\'équipe" si uploadedByMember=false', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse(200, DETAIL_RESPONSE))
    ) as unknown as typeof globalThis.fetch
    const wrapper = await mountAt('123')
    await flushPromises()
    const badges = wrapper.findAll('[data-testid="file-badge-team"]')
    expect(badges.length).toBe(1) // un seul des 2 fichiers a uploadedByMember=false
    expect(badges[0]!.text()).toContain("Ajouté par l'équipe")
  })

  it('AC#3 SECURITÉ — body XSS rendu littéralement (interpolation Vue, pas v-html)', async () => {
    const xssPayload = {
      ...DETAIL_RESPONSE,
      data: {
        ...DETAIL_RESPONSE.data,
        comments: [
          {
            id: 1,
            body: '<script>alert(1)</script>',
            createdAt: '2026-04-26T10:00:00Z',
            authorLabel: 'Vous',
          },
        ],
      },
    }
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse(200, xssPayload))
    ) as unknown as typeof globalThis.fetch
    const wrapper = await mountAt('123')
    await flushPromises()
    const html = wrapper.html()
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('AC#3 affiche authorLabel "Vous" / "Équipe Fruitstock" selon API', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse(200, DETAIL_RESPONSE))
    ) as unknown as typeof globalThis.fetch
    const wrapper = await mountAt('123')
    await flushPromises()
    const labels = wrapper.findAll('[data-testid="comment-author-label"]')
    const texts = labels.map((l) => l.text())
    expect(texts).toContain('Vous')
    expect(texts).toContain('Équipe Fruitstock')
  })

  it('AC#6 form ajout commentaire — soumission appelle POST avec body', async () => {
    const fetchMock = vi.fn(
      (url: string, opts?: { method?: string; body?: string }): Promise<Response> => {
        if ((opts?.method ?? 'GET') === 'POST') {
          return Promise.resolve(
            jsonResponse(201, {
              data: {
                id: 999,
                body: JSON.parse(opts!.body!).body as string,
                createdAt: '2026-04-29T10:00:00Z',
                authorLabel: 'Vous',
              },
            })
          )
        }
        return Promise.resolve(jsonResponse(200, DETAIL_RESPONSE))
      }
    )
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    const wrapper = await mountAt('123')
    await flushPromises()

    await wrapper.find('[data-testid="comment-body-input"]').setValue('Mon nouveau commentaire')
    await wrapper.find('[data-testid="comment-form"]').trigger('submit.prevent')
    await flushPromises()

    const postCall = fetchMock.mock.calls.find(
      (c) => (c[1] as { method?: string } | undefined)?.method === 'POST'
    )
    expect(postCall).toBeDefined()
    expect(postCall![0]).toContain('/api/self-service/sav/123/comments')
    expect(JSON.parse((postCall![1] as { body: string }).body)).toEqual({
      body: 'Mon nouveau commentaire',
    })
  })

  it('AC#7 ajout optimistic — le commentaire apparaît avant la 201', async () => {
    let resolvePost: (v: Response) => void = () => undefined
    const fetchMock = vi.fn((_url: string, opts?: { method?: string }): Promise<Response> => {
      if ((opts?.method ?? 'GET') === 'POST') {
        return new Promise<Response>((r) => {
          resolvePost = r
        })
      }
      return Promise.resolve(jsonResponse(200, DETAIL_RESPONSE))
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    const wrapper = await mountAt('123')
    await flushPromises()

    await wrapper.find('[data-testid="comment-body-input"]').setValue('En cours')
    await wrapper.find('[data-testid="comment-form"]').trigger('submit.prevent')
    await flushPromises()
    // Avant le résolution du POST, le commentaire optimistic doit être présent.
    expect(wrapper.find('[data-testid="sav-comments-thread"]').text()).toContain('En cours')

    resolvePost(
      jsonResponse(201, {
        data: { id: 555, body: 'En cours', createdAt: '2026-04-29T10:00:00Z', authorLabel: 'Vous' },
      })
    )
    await flushPromises()
    expect(wrapper.find('[data-testid="sav-comments-thread"]').text()).toContain('En cours')
  })

  it("AC#7 si POST 4xx → retire l'optimistic + affiche erreur", async () => {
    const fetchMock = vi.fn((_url: string, opts?: { method?: string }): Promise<Response> => {
      if ((opts?.method ?? 'GET') === 'POST') {
        return Promise.resolve(jsonResponse(429, { error: { code: 'RATE_LIMITED' } }))
      }
      return Promise.resolve(jsonResponse(200, DETAIL_RESPONSE))
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    const wrapper = await mountAt('123')
    await flushPromises()
    await wrapper.find('[data-testid="comment-body-input"]').setValue('spam')
    await wrapper.find('[data-testid="comment-form"]').trigger('submit.prevent')
    await flushPromises()
    expect(wrapper.find('[data-testid="comment-error"]').exists()).toBe(true)
  })

  it('AC#8 form rejette body vide côté client', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse(200, DETAIL_RESPONSE))
    ) as unknown as typeof globalThis.fetch
    const wrapper = await mountAt('123')
    await flushPromises()
    await wrapper.find('[data-testid="comment-body-input"]').setValue('   ')
    await wrapper.find('[data-testid="comment-form"]').trigger('submit.prevent')
    await flushPromises()
    expect(wrapper.find('[data-testid="comment-error"]').exists()).toBe(true)
  })

  it('AC#1 SECURITÉ — la vue ne rend pas assignee/internal_notes/operator.email', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse(200, DETAIL_RESPONSE))
    ) as unknown as typeof globalThis.fetch
    const wrapper = await mountAt('123')
    await flushPromises()
    const text = wrapper.text()
    expect(text).not.toMatch(/assignee/i)
    expect(text).not.toMatch(/internal_notes/i)
    expect(text).not.toMatch(/display_name/i)
  })
})
