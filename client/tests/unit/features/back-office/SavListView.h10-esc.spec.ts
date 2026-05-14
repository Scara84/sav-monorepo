/**
 * H-10 AC #1 — ATDD RED PHASE
 *
 * W48 — Touche Échap ferme le menu Export CSV + restaure focus sur le trigger.
 *
 * AC testés :
 *   AC #1.1  — @keydown.esc.stop présent sur .export-csv-wrapper (vérifié via comportement)
 *   AC #1.2  — onMenuEscape() : ferme le menu + restaure le focus
 *   AC #1.3  — exportTriggerRef attaché au <button data-testid="btn-export-csv">
 *   AC #1.4  — Après Échap, document.activeElement === trigger button
 *   AC #1.5a — Échap quand menu déjà fermé = no-op (pas d'erreur)
 *   AC #1.6  — Les autres modes de fermeture existants ne régressent pas
 *
 * Scope OOS (pas testés ici) :
 *   AC #1.5b — Échap hors wrapper ne ferme pas le menu : impossible à tester
 *              en Vitest de manière fiable (bubbling happy-dom partiel) — flag.
 *
 * Mock strategy :
 *   - globalThis.fetch stubé pour /api/sav (liste vide) et /api/reports/export-csv
 *   - router createWebHistory() (happy-dom)
 *   - Pas de mock composable : on teste le comportement DOM réel du SFC
 *
 * RED attendu :
 *   - T2 (focus restoration) : RED — exportTriggerRef n'existe pas encore
 *   - T1 (Esc ferme le menu) : RED — @keydown.esc n'est pas câblé
 *   - T3 (no-op si fermé)    : GREEN probable (aucune erreur avec menu déjà fermé)
 *   - T4 (mouseleave régression) : GREEN probable (déjà implémenté)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createWebHistory } from 'vue-router'
import SavListView from '../../../../src/features/back-office/views/SavListView.vue'

function makeRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/admin/sav', name: 'admin-sav-list', component: SavListView },
      {
        path: '/admin/sav/:id',
        name: 'admin-sav-detail',
        component: { template: '<div>detail</div>' },
      },
    ],
  })
}

function setupFetch() {
  const fn = vi.fn(async (url: string) => {
    if (url.startsWith('/api/reports/export-csv')) {
      const headers = new Headers()
      headers.set('content-type', 'text/csv; charset=utf-8')
      headers.set('content-disposition', 'attachment; filename="export.csv"')
      return {
        ok: true,
        status: 200,
        headers,
        json: () => Promise.resolve({}),
        blob: () => Promise.resolve(new Blob(['a;b'], { type: 'text/csv' })),
      } as unknown as Response
    }
    // default: liste vide
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => Promise.resolve({ data: [], meta: { cursor: null, count: 0, limit: 50 } }),
    } as unknown as Response
  })
  ;(globalThis as unknown as { fetch: typeof fn }).fetch = fn
  return fn
}

async function mountView() {
  const router = makeRouter()
  await router.push('/admin/sav')
  await router.isReady()
  // attachTo: document.body requis pour que element.focus() soit reflété dans
  // document.activeElement (happy-dom ne suit pas le focus sur un DOM détaché).
  return mount(SavListView, { global: { plugins: [router] }, attachTo: document.body })
}

describe('SavListView — H-10 W48 Échap menu Export CSV (AC #1)', () => {
  beforeEach(() => {
    // Stub URL methods (blob download)
    const url = globalThis.URL as typeof URL & {
      createObjectURL?: (b: Blob) => string
      revokeObjectURL?: (s: string) => void
    }
    url.createObjectURL = vi.fn(() => 'blob:mock-url')
    url.revokeObjectURL = vi.fn()
    setupFetch()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('T1 — W48: Esc sur .export-csv-wrapper ferme le menu ouvert (AC #1.1 / #1.2)', async () => {
    // RED avant dev : @keydown.esc n'est pas câblé sur le wrapper
    const w = await mountView()
    await flushPromises()

    // Ouvrir le menu via click trigger
    await w.find('[data-testid="btn-export-csv"]').trigger('click')
    expect(w.find('[data-testid="btn-export-csv-format"]').exists()).toBe(true)

    // Appuyer Échap sur le wrapper
    await w.find('.export-csv-wrapper').trigger('keydown', { key: 'Escape' })
    await flushPromises()

    // Le menu doit être fermé
    expect(w.find('[data-testid="btn-export-csv-format"]').exists()).toBe(false)
    // aria-expanded doit être false
    expect(w.find('[data-testid="btn-export-csv"]').attributes('aria-expanded')).toBe('false')
  })

  it('T2 — W48: Après Échap, le focus est restauré sur le bouton trigger (AC #1.3 / #1.4)', async () => {
    // RED avant dev : exportTriggerRef n'existe pas, donc focus() non appelé
    const w = await mountView()
    await flushPromises()

    // Ouvrir le menu
    const triggerBtn = w.find('[data-testid="btn-export-csv"]')
    await triggerBtn.trigger('click')
    expect(w.find('[data-testid="btn-export-csv-format"]').exists()).toBe(true)

    // Appuyer Échap sur le wrapper
    await w.find('.export-csv-wrapper').trigger('keydown', { key: 'Escape' })
    await flushPromises()

    // Le focus doit être sur le trigger button (AC #1.4)
    expect(document.activeElement).toBe(triggerBtn.element)
  })

  it('T3 — W48: Esc quand le menu est déjà fermé = no-op (AC #1.5a)', async () => {
    // GREEN probable : aucun effet attendu, pas d'erreur
    const w = await mountView()
    await flushPromises()

    // Menu déjà fermé (état initial)
    expect(w.find('[data-testid="btn-export-csv-format"]').exists()).toBe(false)

    // Appuyer Échap — ne doit pas provoquer d'erreur ni de side-effect
    await expect(
      w.find('.export-csv-wrapper').trigger('keydown', { key: 'Escape' })
    ).resolves.not.toThrow()

    // Toujours fermé
    expect(w.find('[data-testid="btn-export-csv-format"]').exists()).toBe(false)
    // Focus non déplacé (reste sur body ou élément précédent)
    expect(w.find('[data-testid="btn-export-csv"]').attributes('aria-expanded')).toBe('false')
  })

  it('T4 — W48 (non-régression): mouseleave ferme toujours le menu (AC #1.6)', async () => {
    // GREEN attendu : comportement pré-existant
    const w = await mountView()
    await flushPromises()

    // Ouvrir le menu
    await w.find('[data-testid="btn-export-csv"]').trigger('click')
    expect(w.find('[data-testid="btn-export-csv-format"]').exists()).toBe(true)

    // mouseleave sur le <ul>
    await w.find('.export-menu').trigger('mouseleave')
    await flushPromises()

    expect(w.find('[data-testid="btn-export-csv-format"]').exists()).toBe(false)
  })

  it('T5 — W48 (non-régression): click sur item CSV ferme le menu (AC #1.6)', async () => {
    // GREEN attendu : comportement pré-existant (runExport set exportMenuOpen=false)
    const w = await mountView()
    await flushPromises()

    await w.find('[data-testid="btn-export-csv"]').trigger('click')
    expect(w.find('[data-testid="btn-export-csv-format"]').exists()).toBe(true)

    await w.find('[data-testid="btn-export-csv-format"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="btn-export-csv-format"]').exists()).toBe(false)
  })

  it('T6 — W48 (régression-guard): dispatch global hors composant ne ferme pas le menu (listener document)', async () => {
    /**
     * Régression-guard : vérifie qu'aucun listener global (document.addEventListener)
     * n'intercepte Escape pour fermer le menu.
     *
     * Stratégie : dispatch KeyboardEvent sur document.body (strictement hors du
     * .export-csv-wrapper dans le DOM). En happy-dom les events NE descendent PAS
     * dans les enfants — ils ne remontent que vers document/window.
     * Ce test couvre le cas "listener sur document" (pas AC #1.5b strict).
     *
     * Status : GREEN dès le départ. Devient RED si quelqu'un pose un listener global.
     *
     * Note : AC #1.5b strict ("Esc tapé dans un descendant hors wrapper") est
     * couvert par T7 ci-dessous qui trigger sur input[type="search"] dans le SFC.
     */
    const w = await mountView()
    await flushPromises()

    // Ouvrir le menu
    await w.find('[data-testid="btn-export-csv"]').trigger('click')
    expect(w.find('[data-testid="btn-export-csv-format"]').exists()).toBe(true)

    // Déclencher Esc sur document.body (hors composant)
    const escEvent = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    })
    document.body.dispatchEvent(escEvent)
    await w.vm.$nextTick()

    // Le menu DOIT rester ouvert
    expect(w.find('[data-testid="btn-export-csv-format"]').exists()).toBe(true)
  })

  it('T7 — W48 (AC #1.5b): Esc sur input[type="search"] (hors .export-csv-wrapper) ne ferme pas le menu', async () => {
    /**
     * AC #1.5b strict : Escape tapé sur un élément du SFC mais HORS du wrapper
     * ne ferme pas le menu.
     *
     * Stratégie : trigger keydown.Escape sur l'input[type="search"] qui est dans
     * la section .filters, strictement en dehors de .export-csv-wrapper.
     * L'event bubble vers le haut (section.filters → main.sav-list-view) mais
     * NE bubble PAS vers .export-csv-wrapper qui est un sibling, pas un ancêtre.
     * Le listener @keydown.esc.stop sur .export-csv-wrapper ne le reçoit donc pas.
     *
     * Status : GREEN si le listener est correctement scopé au wrapper (AC #1.1).
     * Devient RED si le listener est déplacé sur un ancêtre commun.
     */
    const w = await mountView()
    await flushPromises()

    // Ouvrir le menu Export CSV
    await w.find('[data-testid="btn-export-csv"]').trigger('click')
    expect(w.find('[data-testid="btn-export-csv-format"]').exists()).toBe(true)

    // Trigger Esc sur le champ de recherche (hors .export-csv-wrapper)
    await w.find('input[type="search"]').trigger('keydown', { key: 'Escape' })
    await w.vm.$nextTick()

    // Le menu DOIT rester ouvert
    expect(w.find('[data-testid="btn-export-csv-format"]').exists()).toBe(true)
  })
})
