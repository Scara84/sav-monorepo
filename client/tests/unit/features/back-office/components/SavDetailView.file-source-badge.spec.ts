import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createWebHistory } from 'vue-router'
import SavDetailView from '../../../../../src/features/back-office/views/SavDetailView.vue'

/**
 * Story 3.7b — AC #6.5 — File source badge
 *
 * FSB-01: fichier source='capture' → badge "Capture" visible
 * FSB-02: fichier source='member-add' → badge "Membre" visible
 * FSB-03: fichier source='operator-add' → badge "Opérateur" visible
 * FSB-04: fichier source=null/unknown → aucun badge rendu (défensif)
 */

function makeRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/admin/sav', name: 'admin-sav-list', component: { template: '<div/>' } },
      { path: '/admin/sav/:id', name: 'admin-sav-detail', component: SavDetailView },
    ],
  })
}

function mockFetch(body: unknown) {
  ;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(() =>
    Promise.resolve({
      status: 200,
      ok: true,
      json: () => Promise.resolve(body),
    } as unknown as Response)
  )
}

function makeSavPayload(files: unknown[]) {
  return {
    data: {
      sav: {
        id: 1,
        reference: 'SAV-2026-00001',
        status: 'in_progress',
        version: 1,
        groupId: null,
        invoiceRef: 'FAC-1',
        invoiceFdpCents: 0,
        totalAmountCents: 1000,
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

const MOCK_FILE_BASE = {
  sanitizedFilename: 'test.jpg',
  onedriveItemId: 'item-1',
  webUrl: 'https://acme.sharepoint.com/Shared%20Documents/test.jpg',
  mimeType: 'image/jpeg',
  sizeBytes: 1024,
  uploadedByMemberId: null,
  uploadedByOperatorId: null,
  createdAt: '2026-05-01T10:00:00.000Z',
}

async function mountWithFiles(files: unknown[]) {
  mockFetch(makeSavPayload(files))
  const router = makeRouter()
  await router.push('/admin/sav/1')
  await router.isReady()
  const w = mount(SavDetailView, { global: { plugins: [router] } })
  await flushPromises()
  return w
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SavDetailView — file source badge (AC #6.5)', () => {
  it('FSB-01: source=capture → badge "Capture" affiché', async () => {
    const w = await mountWithFiles([
      { ...MOCK_FILE_BASE, id: 1, originalFilename: 'capture-file.jpg', source: 'capture' },
    ])
    const badges = w.findAll('.file-source-badge')
    expect(badges.length).toBe(1)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(badges.at(0)!.text()).toBe('Capture')
  })

  it('FSB-02: source=member-add → badge "Membre" affiché', async () => {
    const w = await mountWithFiles([
      {
        ...MOCK_FILE_BASE,
        id: 2,
        originalFilename: 'member-file.pdf',
        mimeType: 'application/pdf',
        source: 'member-add',
      },
    ])
    const badges = w.findAll('.file-source-badge')
    expect(badges.length).toBe(1)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(badges.at(0)!.text()).toBe('Membre')
  })

  it('FSB-03: source=operator-add → badge "Opérateur" affiché', async () => {
    const w = await mountWithFiles([
      { ...MOCK_FILE_BASE, id: 3, originalFilename: 'operator-file.jpg', source: 'operator-add' },
    ])
    const badges = w.findAll('.file-source-badge')
    expect(badges.length).toBe(1)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(badges.at(0)!.text()).toBe('Opérateur')
  })

  it('FSB-04: source=null ou inconnu → aucun badge rendu (défensif)', async () => {
    const w = await mountWithFiles([
      { ...MOCK_FILE_BASE, id: 4, originalFilename: 'unknown-source.jpg', source: null },
      { ...MOCK_FILE_BASE, id: 5, originalFilename: 'weird-source.jpg', source: 'legacy' },
    ])
    const badges = w.findAll('.file-source-badge')
    expect(badges.length).toBe(0)
  })

  it('FSB-05: 3 fichiers (un de chaque source) → 3 badges distincts', async () => {
    const w = await mountWithFiles([
      { ...MOCK_FILE_BASE, id: 10, originalFilename: 'a.jpg', source: 'capture' },
      { ...MOCK_FILE_BASE, id: 11, originalFilename: 'b.jpg', source: 'member-add' },
      { ...MOCK_FILE_BASE, id: 12, originalFilename: 'c.jpg', source: 'operator-add' },
    ])
    const badges = w.findAll('.file-source-badge')
    expect(badges.length).toBe(3)
    const texts = badges.map((b) => b.text())
    expect(texts).toContain('Capture')
    expect(texts).toContain('Membre')
    expect(texts).toContain('Opérateur')
  })

  it('FSB-06: badge aria-label renseigné pour a11y', async () => {
    const w = await mountWithFiles([
      { ...MOCK_FILE_BASE, id: 20, originalFilename: 'file.jpg', source: 'capture' },
    ])
    const badge = w.find('.file-source-badge')
    expect(badge.attributes('aria-label')).toBe('Source : Capture')
  })
})
