import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createWebHistory } from 'vue-router'
import SavDetailView from '../../../../src/features/back-office/views/SavDetailView.vue'

function makeRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/admin/sav', name: 'admin-sav-list', component: { template: '<div/>' } },
      { path: '/admin/sav/:id', name: 'admin-sav-detail', component: SavDetailView },
    ],
  })
}

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn((..._args: unknown[]) =>
    Promise.resolve({
      status,
      ok: status >= 200 && status < 300,
      json: () => Promise.resolve(body),
    } as unknown as Response)
  )
  ;(globalThis as unknown as { fetch: unknown }).fetch = fn
  return fn
}

async function mountDetail(id = 1) {
  const router = makeRouter()
  await router.push(`/admin/sav/${id}`)
  await router.isReady()
  return mount(SavDetailView, { global: { plugins: [router] } })
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

afterEach(() => {
  vi.restoreAllMocks()
})

beforeEach(() => {
  mockFetch(SAV_PAYLOAD)
})

describe('SavDetailView (Story 3.4)', () => {
  it('TV-01: mount → skeleton visible pendant fetch', async () => {
    let resolveFetch: (v: unknown) => void = () => {}
    ;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(
      () =>
        new Promise((r) => {
          resolveFetch = r
        })
    )
    const w = await mountDetail()
    // Au premier render, pas encore résolu → skeleton visible
    expect(w.find('[aria-label="Chargement"]').exists()).toBe(true)
    resolveFetch({
      status: 200,
      ok: true,
      json: () => Promise.resolve(SAV_PAYLOAD),
    })
  })

  it('TV-02: après fetch OK → header + sections rendus', async () => {
    const w = await mountDetail()
    await flushPromises()
    expect(w.text()).toContain('SAV-2026-00001')
    expect(w.text()).toContain('Jean Dubois')
    expect(w.text()).toContain('Lignes du SAV')
    expect(w.text()).toContain('Commentaires')
    expect(w.text()).toContain('Historique')
  })

  it('TV-06: commentaire internal → badge visible', async () => {
    mockFetch({
      data: {
        sav: SAV_PAYLOAD.data.sav,
        comments: [
          {
            id: 1,
            visibility: 'internal',
            body: 'Note interne',
            createdAt: '2026-03-01T01:00:00.000Z',
            authorMember: null,
            authorOperator: { displayName: 'Marie' },
          },
        ],
        auditTrail: [],
      },
    })
    const w = await mountDetail()
    await flushPromises()
    expect(w.text()).toContain('interne')
    expect(w.text()).toContain('Note interne')
  })

  it('TV-07: XSS safety — <script> dans comment.body est échappé', async () => {
    const malicious = '<script>alert("xss")</script>'
    mockFetch({
      data: {
        sav: SAV_PAYLOAD.data.sav,
        comments: [
          {
            id: 1,
            visibility: 'all',
            body: malicious,
            createdAt: '2026-03-01T01:00:00.000Z',
            authorMember: { firstName: 'Jean', lastName: 'Dubois' },
            authorOperator: null,
          },
        ],
        auditTrail: [],
      },
    })
    const w = await mountDetail()
    await flushPromises()
    const html = w.html()
    // Le <script> ne doit PAS apparaître comme balise réelle — Vue escape par défaut
    expect(html).not.toContain('<script>alert')
    // Mais doit apparaître comme texte visible (échappé)
    expect(html).toContain('&lt;script&gt;')
  })

  it('TV-08: 404 → composant NotFound + bouton retour', async () => {
    mockFetch({}, 404)
    const w = await mountDetail(99999)
    await flushPromises()
    expect(w.text()).toContain('SAV introuvable')
    expect(w.findAll('button').some((b) => b.text().includes('Retour'))).toBe(true)
  })

  it('TV-NaN: id invalide (route /admin/sav/abc) → état 404', async () => {
    const router = makeRouter()
    await router.push('/admin/sav/abc')
    await router.isReady()
    const w = mount(SavDetailView, { global: { plugins: [router] } })
    await flushPromises()
    expect(w.text()).toContain('SAV introuvable')
  })

  it('TV-03 (F34 CR) : image avec webUrl SharePoint whitelistée → <img> présent', async () => {
    mockFetch({
      data: {
        sav: {
          ...SAV_PAYLOAD.data.sav,
          files: [
            {
              id: 1,
              originalFilename: 'photo.jpg',
              sanitizedFilename: 'photo.jpg',
              onedriveItemId: 'abc',
              webUrl: 'https://fruitstock.sharepoint.com/sites/sav/photo.jpg',
              mimeType: 'image/jpeg',
              sizeBytes: 1024,
              uploadedByMemberId: null,
              uploadedByOperatorId: null,
              source: 'capture',
              createdAt: '2026-03-01T00:00:00.000Z',
            },
          ],
        },
        comments: [],
        auditTrail: [],
      },
    })
    const w = await mountDetail()
    await flushPromises()
    const imgs = w.findAll('img').filter((i) => i.attributes('src')?.includes('sharepoint.com'))
    expect(imgs.length).toBeGreaterThan(0)
  })

  it('TV-04 (F34 CR) : image avec webUrl hors whitelist → pas de <img>, fallback icône', async () => {
    mockFetch({
      data: {
        sav: {
          ...SAV_PAYLOAD.data.sav,
          files: [
            {
              id: 2,
              originalFilename: 'photo.jpg',
              sanitizedFilename: 'photo.jpg',
              onedriveItemId: 'abc',
              webUrl: 'https://evil-attacker-domain.com/photo.jpg',
              mimeType: 'image/jpeg',
              sizeBytes: 1024,
              uploadedByMemberId: null,
              uploadedByOperatorId: null,
              source: 'capture',
              createdAt: '2026-03-01T00:00:00.000Z',
            },
          ],
        },
        comments: [],
        auditTrail: [],
      },
    })
    const w = await mountDetail()
    await flushPromises()
    const imgs = w
      .findAll('img')
      .filter((i) => i.attributes('src')?.includes('evil-attacker-domain'))
    expect(imgs.length).toBe(0)
  })

  it('TV-05 (F34 + F39 CR) : onerror → fallback « Aperçu indisponible » + bouton retry avec cache-bust via URL.searchParams', async () => {
    mockFetch({
      data: {
        sav: {
          ...SAV_PAYLOAD.data.sav,
          files: [
            {
              id: 3,
              originalFilename: 'photo.jpg',
              sanitizedFilename: 'photo.jpg',
              onedriveItemId: 'abc',
              webUrl: 'https://fruitstock.sharepoint.com/sites/sav/photo.jpg?tempauth=token',
              mimeType: 'image/jpeg',
              sizeBytes: 1024,
              uploadedByMemberId: null,
              uploadedByOperatorId: null,
              source: 'capture',
              createdAt: '2026-03-01T00:00:00.000Z',
            },
          ],
        },
        comments: [],
        auditTrail: [],
      },
    })
    const w = await mountDetail()
    await flushPromises()
    const img = w.find('img[src*="sharepoint.com"]')
    expect(img.exists()).toBe(true)
    // Simule l'échec de chargement
    await img.trigger('error')
    await flushPromises()
    expect(w.text()).toContain('Aperçu indisponible')
    const retryBtn = w.findAll('button').find((b) => b.text().includes('Réessayer'))
    expect(retryBtn).toBeDefined()
    await retryBtn!.trigger('click')
    await flushPromises()
    // L'URL.searchParams.set doit avoir ajouté `_r=1` après le tempauth existant.
    const imgAfter = w.find('img[src*="sharepoint.com"]')
    if (imgAfter.exists()) {
      const src = imgAfter.attributes('src') ?? ''
      expect(src).toContain('_r=1')
      expect(src).toContain('tempauth=token')
    }
  })
})
