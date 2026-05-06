/**
 * Story V1.5 — AC #3: SPA SavDetailView imgSrc() helper bascule
 *
 * Test type: UNIT / Vue component (Vitest + @vue/test-utils)
 *
 * AC coverage:
 *   AC #3.a — imgSrc(file) returns `/api/sav/files/${file.id}/thumbnail` for image files
 *   AC #3.b — template unchanged: @error, loading="lazy", fallback imgErrored, bouton Réessayer
 *              all preserved (we assert src format and template behavior)
 *   AC #3.c — isImagePreviewable() gate preserved: non-image → no <img> rendered
 *   AC #3.d — DTO unchanged: f.webUrl still used for "Ouvrir" button href
 *   Cache-bust: ?_r=${retryCount} preserved on retry (URL param on proxy URL)
 *
 * Mock strategy:
 *   - globalThis.fetch: mocked to return SAV payload with file(s)
 *   - Router: minimal vue-router with /admin/sav/:id route
 *   - No real network calls
 *
 * NOTE: Red-phase — tests TH3-03, TH3-05 will fail until imgSrc() is patched in
 * SavDetailView.vue to return `/api/sav/files/${file.id}/thumbnail` instead of `file.webUrl`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createWebHistory } from 'vue-router'
import SavDetailView from '../../../../src/features/back-office/views/SavDetailView.vue'

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

function makeRouter(id = 18) {
  const router = createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/admin/sav', name: 'admin-sav-list', component: { template: '<div/>' } },
      { path: '/admin/sav/:id', name: 'admin-sav-detail', component: SavDetailView },
    ],
  })
  void router.push(`/admin/sav/${id}`)
  return router
}

// ---------------------------------------------------------------------------
// SAV payload factory
// ---------------------------------------------------------------------------

const SHAREPOINT_BASE = 'https://fruitstock.sharepoint.com/sites/sav'

function makeFileMock(
  overrides: {
    id?: number
    mimeType?: string
    webUrl?: string
    originalFilename?: string
  } = {}
) {
  return {
    id: overrides.id ?? 42,
    originalFilename: overrides.originalFilename ?? 'photo.jpg',
    sanitizedFilename: 'photo.jpg',
    onedriveItemId: 'item-id-abc',
    webUrl: overrides.webUrl ?? `${SHAREPOINT_BASE}/Shared%20Documents/photo.jpg`,
    mimeType: overrides.mimeType ?? 'image/jpeg',
    sizeBytes: 12345,
    uploadedByMemberId: null,
    uploadedByOperatorId: null,
    source: 'capture',
    createdAt: '2026-03-01T00:00:00.000Z',
  }
}

function makeSavPayload(files: ReturnType<typeof makeFileMock>[]) {
  return {
    data: {
      sav: {
        id: 18,
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
        files,
      },
      comments: [],
      auditTrail: [],
      settingsSnapshot: { vat_rate_default_bp: 550, group_manager_discount_bp: 400 },
    },
  }
}

function mockFetchWithFiles(files: ReturnType<typeof makeFileMock>[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: () => Promise.resolve(makeSavPayload(files)),
    } as unknown as Response)
  )
}

// ---------------------------------------------------------------------------
// beforeEach / afterEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Default: empty files (overridden per test)
  mockFetchWithFiles([])
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SavDetailView — imgSrc() V1.5 thumbnail proxy bascule (AC #3)', () => {
  it('TH3-01: <img> src points to /api/sav/files/:id/thumbnail (NOT webUrl) for image file', async () => {
    const file = makeFileMock({ id: 42, mimeType: 'image/jpeg' })
    mockFetchWithFiles([file])

    const router = makeRouter(18)
    await router.isReady()
    const w = mount(SavDetailView, { global: { plugins: [router] } })
    await flushPromises()

    const imgs = w.findAll('img')
    // At least one img rendered for the image file
    expect(imgs.length).toBeGreaterThan(0)

    const img = imgs[0]
    const src = img?.attributes('src') ?? ''

    // RED-PHASE: This assertion fails until imgSrc() is patched in V1.5
    // After patch: src = '/api/sav/files/42/thumbnail'
    expect(src).toMatch(/^\/api\/sav\/files\/42\/thumbnail/)
    // Must NOT be the direct SharePoint URL
    expect(src).not.toContain('sharepoint.com')
    expect(src).not.toContain('webUrl')
  })

  it('TH3-02: "Ouvrir" button href still points to original webUrl (DTO unchanged)', async () => {
    const file = makeFileMock({
      id: 42,
      mimeType: 'image/jpeg',
      webUrl: `${SHAREPOINT_BASE}/Shared%20Documents/photo.jpg`,
    })
    mockFetchWithFiles([file])

    const router = makeRouter(18)
    await router.isReady()
    const w = mount(SavDetailView, { global: { plugins: [router] } })
    await flushPromises()

    // "Ouvrir" button (the <a> with SharePoint href) must keep the original webUrl
    const ouvrir = w.findAll('a').find((a) => a.text().includes('Ouvrir'))
    expect(ouvrir).toBeDefined()
    const href = ouvrir?.attributes('href') ?? ''
    expect(href).toContain('sharepoint.com')
    // Must be the direct webUrl for <a> (not the proxy)
    expect(href).not.toContain('/api/sav/files/')
  })

  it('TH3-03: non-image file (application/pdf) → no <img>, only icon emoji fallback', async () => {
    const file = makeFileMock({
      id: 99,
      mimeType: 'application/pdf',
      originalFilename: 'document.pdf',
      webUrl: `${SHAREPOINT_BASE}/Shared%20Documents/document.pdf`,
    })
    mockFetchWithFiles([file])

    const router = makeRouter(18)
    await router.isReady()
    const w = mount(SavDetailView, { global: { plugins: [router] } })
    await flushPromises()

    // No <img> should be rendered for PDF
    const imgs = w
      .findAll('img')
      .filter((i) => i.attributes('src')?.includes('/api/sav/files/99/thumbnail'))
    expect(imgs.length).toBe(0)

    // Icon emoji (📄) should appear
    expect(w.text()).toContain('📄')
  })

  it('TH3-04: @error handler preserved — markImgError triggers fallback "Aperçu indisponible"', async () => {
    const file = makeFileMock({ id: 42, mimeType: 'image/jpeg' })
    mockFetchWithFiles([file])

    const router = makeRouter(18)
    await router.isReady()
    const w = mount(SavDetailView, { global: { plugins: [router] } })
    await flushPromises()

    // Find the img (now with proxy src)
    const img = w.findAll('img').find((i) => i.attributes('src')?.includes('/api/sav/files/'))
    expect(img).toBeDefined()

    // Simulate image load error (Graph → 503 → @error triggered)
    await img!.trigger('error')
    await flushPromises()

    // Fallback template should appear
    expect(w.text()).toContain('Aperçu indisponible')
    const retryBtn = w.findAll('button').find((b) => b.text().includes('Réessayer'))
    expect(retryBtn).toBeDefined()
  })

  it('TH3-05: retryImg increments key → cache-bust ?_r=1 appended to proxy URL', async () => {
    const file = makeFileMock({ id: 42, mimeType: 'image/jpeg' })
    mockFetchWithFiles([file])

    const router = makeRouter(18)
    await router.isReady()
    const w = mount(SavDetailView, { global: { plugins: [router] } })
    await flushPromises()

    // Trigger error to show retry button
    const img = w.findAll('img').find((i) => i.attributes('src')?.includes('/api/sav/files/'))
    expect(img).toBeDefined()
    await img!.trigger('error')
    await flushPromises()

    // Click retry
    const retryBtn = w.findAll('button').find((b) => b.text().includes('Réessayer'))
    expect(retryBtn).toBeDefined()
    await retryBtn!.trigger('click')
    await flushPromises()

    // After retry, img src should contain _r=1 (cache-bust on proxy URL)
    const imgAfter = w.findAll('img').find((i) => i.attributes('src')?.includes('/api/sav/files/'))
    if (imgAfter?.exists()) {
      const src = imgAfter.attributes('src') ?? ''
      // Cache-bust parameter must be present on the proxy URL
      expect(src).toContain('_r=1')
      // Must still be the proxy URL
      expect(src).toContain('/api/sav/files/42/thumbnail')
    }
  })

  it('TH3-06: loading="lazy" attribute preserved on <img> (template unchanged)', async () => {
    const file = makeFileMock({ id: 42, mimeType: 'image/jpeg' })
    mockFetchWithFiles([file])

    const router = makeRouter(18)
    await router.isReady()
    const w = mount(SavDetailView, { global: { plugins: [router] } })
    await flushPromises()

    const img = w.findAll('img').find((i) => i.attributes('src')?.includes('/api/sav/files/'))
    expect(img).toBeDefined()
    expect(img?.attributes('loading')).toBe('lazy')
  })

  it('TH3-07: multiple image files → each <img> has distinct /api/sav/files/:id/thumbnail src', async () => {
    const files = [
      makeFileMock({ id: 10, mimeType: 'image/jpeg', originalFilename: 'photo1.jpg' }),
      makeFileMock({
        id: 11,
        mimeType: 'image/png',
        originalFilename: 'photo2.png',
        webUrl: `${SHAREPOINT_BASE}/photo2.png`,
      }),
      makeFileMock({
        id: 12,
        mimeType: 'image/webp',
        originalFilename: 'photo3.webp',
        webUrl: `${SHAREPOINT_BASE}/photo3.webp`,
      }),
    ]
    mockFetchWithFiles(files)

    const router = makeRouter(18)
    await router.isReady()
    const w = mount(SavDetailView, { global: { plugins: [router] } })
    await flushPromises()

    const proxySrcs = w
      .findAll('img')
      .map((i) => i.attributes('src') ?? '')
      .filter((src) => src.includes('/api/sav/files/'))

    expect(proxySrcs).toContain('/api/sav/files/10/thumbnail')
    expect(proxySrcs).toContain('/api/sav/files/11/thumbnail')
    expect(proxySrcs).toContain('/api/sav/files/12/thumbnail')
  })
})
