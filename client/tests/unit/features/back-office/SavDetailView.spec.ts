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
      invoiceSpecialMention: '295_26S23_74_2',
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
    expect(w.text()).toContain('295_26S23_74_2')
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

  it('TV-03 (F34 CR) : image avec webUrl SharePoint whitelistée → <img> présent (via proxy V1.5)', async () => {
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
    // V1.5 PATTERN-V5: imgSrc() routes through backend proxy, not SharePoint direct.
    // The <img> src is now /api/sav/files/:id/thumbnail (no sharepoint.com in src).
    const imgs = w
      .findAll('img')
      .filter((i) => i.attributes('src')?.includes('/api/sav/files/1/thumbnail'))
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
    // V1.5 PATTERN-V5: imgSrc() uses proxy URL /api/sav/files/:id/thumbnail (not sharepoint.com directly)
    const img = w.find('img[src*="/api/sav/files/3/thumbnail"]')
    expect(img.exists()).toBe(true)
    // Simule l'échec de chargement
    await img.trigger('error')
    await flushPromises()
    expect(w.text()).toContain('Aperçu indisponible')
    const retryBtn = w.findAll('button').find((b) => b.text().includes('Réessayer'))
    expect(retryBtn).toBeDefined()
    await retryBtn!.trigger('click')
    await flushPromises()
    // Après retry, le proxy URL doit avoir `?_r=1` (cache-bust via retryKey counter)
    const imgAfter = w.find('img[src*="/api/sav/files/3/thumbnail"]')
    if (imgAfter.exists()) {
      const src = imgAfter.attributes('src') ?? ''
      expect(src).toContain('_r=1')
    }
  })
})

// ===========================================================================
// Story 8.5 — AC #3 : badge réclamation fournisseur (H2 fix — DN-2=A LOCKED)
//
// Ces tests sont LOAD-BEARING :
//   TV-BADGE-01 : badge présent + texte correct quand supplierClaim.exists
//   TV-BADGE-02 : badge absent quand supplierClaim est null
//
// Aller RED si : le badge est retiré, le data-testid est changé,
// ou si supplierClaim null affiche quand même le badge.
// ===========================================================================

describe('Story 8.5 — AC #3 : badge réclamation fournisseur dans SavDetailView', () => {
  it('TV-BADGE-01: supplierClaim.exists → badge data-testid="supplier-claim-badge" visible avec texte correct', async () => {
    mockFetch({
      data: {
        ...SAV_PAYLOAD.data,
        supplierClaim: {
          exists: true,
          latestGeneratedAt: '2026-06-05T10:00:00Z',
          latestTotalImporteCents: 174,
          count: 1,
        },
      },
    })
    const w = await mountDetail(1)
    await flushPromises()

    // Badge doit être présent
    const badge = w.find('[data-testid="supplier-claim-badge"]')
    expect(badge.exists()).toBe(true)

    // Texte doit contenir "version" (count) et "€" (montant)
    const badgeHtml = badge.html()
    expect(badgeHtml).toMatch(/version/)
    expect(badgeHtml).toMatch(/€|EUR/)

    // Lien vers la demande fournisseur doit être présent
    const link = w.find('[data-testid="supplier-claim-badge-link"]')
    expect(link.exists()).toBe(true)
  })

  it('TV-BADGE-01b: count > 1 → badge affiche le bon nombre de versions', async () => {
    mockFetch({
      data: {
        ...SAV_PAYLOAD.data,
        supplierClaim: {
          exists: true,
          latestGeneratedAt: '2026-06-06T14:32:00Z',
          latestTotalImporteCents: 348,
          count: 3,
        },
      },
    })
    const w = await mountDetail(1)
    await flushPromises()

    const badge = w.find('[data-testid="supplier-claim-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toMatch(/3.*version/i)
  })

  it('TV-BADGE-02: supplierClaim null → badge ABSENT (DISCRIMINANT — must go RED if badge always shown)', async () => {
    mockFetch({
      data: {
        ...SAV_PAYLOAD.data,
        supplierClaim: null,
      },
    })
    const w = await mountDetail(1)
    await flushPromises()

    // Badge ne doit PAS être présent quand supplierClaim est null
    const badge = w.find('[data-testid="supplier-claim-badge"]')
    expect(badge.exists()).toBe(false)
  })

  it('TV-BADGE-03: supplierClaim absent de la réponse (undefined/non fourni) → badge absent', async () => {
    // Réponse sans le champ supplierClaim (ancienne réponse / dégradation)
    mockFetch(SAV_PAYLOAD) // SAV_PAYLOAD n'a pas supplierClaim
    const w = await mountDetail(1)
    await flushPromises()

    const badge = w.find('[data-testid="supplier-claim-badge"]')
    expect(badge.exists()).toBe(false)
  })
})

describe('Pièces et échanges du dossier', () => {
  it('distingue absence, lecture impossible et historique limité après une nouvelle lecture', async () => {
    const fetchMock = mockFetch({
      ...SAV_PAYLOAD,
      meta: { commentsDegraded: true, auditDegraded: true },
    })
    const w = await mountDetail()
    await flushPromises()
    expect(w.text()).toContain('Aucun fichier joint')
    expect(w.text()).toContain('Impossible de charger les commentaires')
    expect(w.text()).toContain('Impossible de charger l’historique')
    expect(w.text()).not.toContain('Aucun commentaire pour ce SAV')
    expect(w.text()).not.toContain('Aucun événement enregistré')

    const events = ['updated', 'created'].map((action, i) => ({
      id: 10 - i, action, createdAt: `2026-11-${20 - i}T12:00:00Z`, diff: null,
      actorSystem: 'SAV', actorOperator: null, actorMember: null,
    }))
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      data: { ...SAV_PAYLOAD.data, auditTrail: events }, meta: { auditTruncated: true },
    })))
    await w.get('[aria-labelledby="comments-title"] .read-warning button').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('Aucun commentaire pour ce SAV')
    expect(w.text()).toContain('2 événements les plus récents')
    expect(w.findAll('.audit > li').map(li => li.find('time').attributes('datetime')))
      .toEqual(events.map(event => event.createdAt))
    expect(w.findAll('.diff-lines').map(el => el.text())).toEqual(['Modification', 'Création'])
  })

  it('conserve le brouillon et son audience après un refus puis fusionne la réponse de relecture', async () => {
    const fetchMock = mockFetch(SAV_PAYLOAD)
    const w = await mountDetail()
    await flushPromises()
    const textarea = w.get<HTMLTextAreaElement>('.compose-textarea')
    const shared = w.get<HTMLInputElement>('input[value="all"]')
    const form = w.get('.compose-form')
    await textarea.setValue('Message fictif')
    await shared.setValue()
    expect(w.get('.audience-hint').text()).toContain('L’adhérent pourra lire')
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }))
    await form.trigger('submit')
    await flushPromises()
    expect(w.get('.compose-error').text()).toContain('Publication refusée')
    expect(w.get('.compose-error').text()).not.toContain('Relire les échanges')
    expect(textarea.element.value).toBe('Message fictif')
    expect(shared.element.checked).toBe(true)
    expect(w.find('.comment').exists()).toBe(false)

    const comment = { id: 22, body: 'Message fictif', visibility: 'all', createdAt: '2026-11-20T10:00:00Z', authorMember: null, authorOperator: { id: 3, displayName: 'Camille' } }
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: { ...comment, commentId: 22 } })))
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: { ...SAV_PAYLOAD.data, comments: [comment] } })))
    await form.trigger('submit')
    await flushPromises()
    expect(w.findAll('.comment')).toHaveLength(1)
    expect(w.get('.comment').text()).toContain('Partagé avec l’adhérent')
    expect(w.get('.comment').text()).toContain('Camille')
    expect(textarea.element.value).toBe('')
  })

  const savedComment = {
    id: 25,
    body: 'Échange fictif',
    visibility: 'all',
    createdAt: '2026-11-20T12:00:00Z',
    authorMember: null,
    authorOperator: { id: 3, displayName: 'Camille' },
  }
  function detailWithSavedComment() {
    return new Response(JSON.stringify({ data: { ...SAV_PAYLOAD.data, comments: [savedComment] } }))
  }

  it('relit une publication dont la réponse a été perdue sans renvoyer le brouillon', async () => {
    const fetchMock = mockFetch(SAV_PAYLOAD)
    const w = await mountDetail()
    await flushPromises()
    const textarea = w.get<HTMLTextAreaElement>('.compose-textarea')
    const shared = w.get<HTMLInputElement>('input[value="all"]')
    await textarea.setValue(savedComment.body)
    await shared.setValue()
    fetchMock.mockRejectedValueOnce(new TypeError('Réponse perdue'))
    await w.get('.compose-form').trigger('submit')
    await flushPromises()
    expect(w.get('.compose-error').text()).toContain('Publication non confirmée')
    fetchMock.mockResolvedValueOnce(detailWithSavedComment())
    const reread = w.get('.compose-error button')
    expect(reread.text()).toBe('Relire les échanges')
    await reread.trigger('click')
    await flushPromises()
    expect(w.get('.comment-body').text()).toBe(savedComment.body)
    expect(textarea.element.value).toBe(savedComment.body)
    expect(shared.element.checked).toBe(true)
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/sav/1/comments')).toHaveLength(1)
  })

  it('garde le commentaire confirmé pendant une panne puis le réconcilie à la relecture', async () => {
    const fetchMock = mockFetch(SAV_PAYLOAD)
    const w = await mountDetail()
    await flushPromises()
    await w.get('.compose-textarea').setValue(savedComment.body)
    await w.get('input[value="all"]').setValue()
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      data: { ...savedComment, commentId: savedComment.id },
    })))
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }))
    await w.get('.compose-form').trigger('submit')
    await flushPromises()
    expect(w.get('h1').text()).toBe('SAV-2026-00001')
    expect(w.get('.comment-body').text()).toBe(savedComment.body)
    expect(w.find('.compose-error').exists()).toBe(false)
    fetchMock.mockResolvedValueOnce(detailWithSavedComment())
    await w.get('[aria-labelledby="comments-title"] .read-warning button').trigger('click')
    await flushPromises()
    expect(w.findAll('.comment')).toHaveLength(1)
    expect(w.get('.comment').text()).toContain('Camille')
    expect(w.find('.read-warning').exists()).toBe(false)
  })

  it.each([401, 403, 404])('masque le dossier après une relecture refusée (%i)', async status => {
    const fetchMock = mockFetch({ ...SAV_PAYLOAD, meta: { commentsDegraded: true } })
    const w = await mountDetail()
    await flushPromises()
    fetchMock.mockResolvedValueOnce(new Response(null, { status }))
    await w.get('[aria-labelledby="comments-title"] .read-warning button').trigger('click')
    await flushPromises()
    expect(w.text()).not.toContain('SAV-2026-00001')
    expect(w.find('#comments-title').exists()).toBe(false)
  })

  it('ignore une publication tardive après un changement de dossier', async () => {
    const fetchMock = mockFetch(SAV_PAYLOAD)
    const w = await mountDetail()
    await flushPromises()
    await w.get('.compose-textarea').setValue('Note du premier dossier')
    await w.get('input[value="all"]').setValue()
    let resolvePost!: (value: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { resolvePost = resolve }))
    await w.get('.compose-form').trigger('submit')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      data: { ...SAV_PAYLOAD.data, sav: { ...SAV_PAYLOAD.data.sav, id: 2, reference: 'SAV-FICTIF-2' } },
    })))
    await w.vm.$router.push('/admin/sav/2')
    await flushPromises()
    expect(w.text()).toContain('SAV-FICTIF-2')
    expect(w.get<HTMLInputElement>('input[value="internal"]').element.checked).toBe(true)
    await w.get('.compose-textarea').setValue('Nouveau brouillon')
    resolvePost(new Response(null, { status: 403 }))
    await flushPromises()
    expect(w.find('.compose-error').exists()).toBe(false)
    expect(w.get<HTMLTextAreaElement>('.compose-textarea').element.value).toBe('Nouveau brouillon')
    expect(w.text()).not.toContain('Note du premier dossier')
  })
})
