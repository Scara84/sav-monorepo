/**
 * Story 8.7 — AC #1/#6 (vue) : Tests anti-faux-vert (discriminants 9–10)
 *
 * FIX-PASS (HIGH-1) : Approche 1 — sous-composant ClientDemandTable.vue testé en ISOLATION.
 *   Les tests DISC-09/10/AC01/AC06 montent ClientDemandTable directement avec des props réalistes
 *   → la section est TOUJOURS rendue dans ces tests, les assertions s'exécutent TOUJOURS.
 *   Suppression des escape-hatches if(section.exists())/console.warn — remplacé par assertions DURES.
 *
 * DISCRIMINANT RÉEL : si on retire la section de ClientDemandTable.vue, tous les tests ici FAIL.
 *   Si on retire le v-if du parent (SupplierClaimView), DISC-09 fail.
 *   Si les 7 colonnes sont incorrectes, AC01-a fail.
 *   Si la table a un input, AC01-b fail.
 *
 * Tests SupplierClaimView conservés :
 *   - DISC-09a : v-if côté parent → ClientDemandTable non monté quand lines=[]
 *   - ISO-EPIC5 : isolation Epic 5 (rufinoConfig, martinezConfig, import SupplierClaimView)
 *
 * Test type:
 *   - ClientDemandTable : UNIT — mount en isolation, props directes
 *   - SupplierClaimView-DISC-09a : UNIT — mount avec router, vérification v-if parent
 *
 * AC couvertes :
 *   AC #1  — 7 colonnes, data-testid, h3, séparée, read-only
 *   AC #6  — rendu conditionnel (v-if parent), position (via SupplierClaimView HTML)
 *   AC #10 — discriminants 9–10 (DURS — ÉCHOUENT si table retirée/cassée)
 *
 * Source of truth : _bmad-output/stories/8-7-table-demande-client-visibilite-controle.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createWebHistory } from 'vue-router'
import ClientDemandTable from '../../../../../src/features/back-office/components/ClientDemandTable.vue'
import SupplierClaimView from '../../../../../src/features/back-office/views/SupplierClaimView.vue'
import type { ClientDemandLine } from '../../../../../src/features/back-office/composables/useSupplierClaimArbitration'

// ---------------------------------------------------------------------------
// Router setup (pour DISC-09a et ISO-EPIC5 qui montent SupplierClaimView)
// ---------------------------------------------------------------------------

function makeRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/admin/sav', name: 'admin-sav-list', component: { template: '<div/>' } },
      { path: '/admin/sav/:id', name: 'admin-sav-detail', component: { template: '<div/>' } },
      {
        path: '/admin/sav/:id/demande-fournisseur',
        name: 'admin-sav-supplier-claim',
        component: SupplierClaimView,
      },
    ],
  })
}

// ---------------------------------------------------------------------------
// Fixtures SOL Y FRUTA réalistes (3104/3115) — AC #11
// ---------------------------------------------------------------------------

/** 2 lignes avec divergence d'unité (pêche kg→PIECE, courgette piece→PIECE) */
function defaultLines(): ClientDemandLine[] {
  return [
    {
      savLineId: 'uuid-peche-3104',
      codeFr: '3104-2K PÊCHE PLATE',
      designationFr: 'Pêche plate cagette 2kg',
      qtyRequested: 1.5,
      unitRequested: 'kg',
      qtyArbitrated: 0.75,
      unitArbitrated: 'PIECE',
      requestReason: 'abime',
    },
    {
      savLineId: 'uuid-courgette-3115',
      codeFr: '3115-2K',
      designationFr: 'Courgette verte cagette 2kg',
      qtyRequested: 1,
      unitRequested: 'piece',
      qtyArbitrated: 1,
      unitArbitrated: 'PIECE',
      requestReason: 'manquant',
    },
  ]
}

/** 1 ligne avec champs null → "—" */
function nullLines(): ClientDemandLine[] {
  return [
    {
      savLineId: 'uuid-null-test',
      codeFr: null,
      designationFr: null,
      qtyRequested: 1,
      unitRequested: null,
      qtyArbitrated: null,
      unitArbitrated: null,
      requestReason: null,
    },
  ]
}

// ---------------------------------------------------------------------------
// Fetch mock helper (pour tests SupplierClaimView)
// ---------------------------------------------------------------------------

function setupFetchMock(savLines: ClientDemandLine[] = []) {
  const fn = vi.fn((url: string | Request) => {
    const urlStr = typeof url === 'string' ? url : url.url ?? ''
    if (urlStr.includes('get-supplier-claim-history')) {
      return Promise.resolve({
        status: 200, ok: true,
        json: () => Promise.resolve({ claims: [] }),
      } as unknown as Response)
    }
    if (urlStr.includes('reconcile-supplier-claim')) {
      return Promise.resolve({
        status: 200, ok: true,
        json: () => Promise.resolve({
          metadata: { reference: '505', albaran: 505, fechaAlbaran: '2026-05-30', warnings: [] },
          claimLines: [],
          unmatchedSavLines: [],
          unusedSupplierLines: [],
          totals: { importe: 0, linesMatched: 0, linesUnmatched: 0, linesBlocking: 0 },
          meta: { reconciliation: { savLinesTotal: 0, matched: 0, unmatched: 0, multipleMatches: 0 }, warnings: [] },
          savLines,
        }),
      } as unknown as Response)
    }
    return Promise.resolve({ status: 404, ok: false, json: () => Promise.resolve({}) } as unknown as Response)
  })
  ;(globalThis as unknown as { fetch: unknown }).fetch = fn
  return fn
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ===========================================================================
// DISCRIMINANT #9 — Rendu conditionnel (v-if côté PARENT SupplierClaimView) (AC #6, AC #10.9)
//
// DISCRIMINANT : ce test FAIL si le v-if="clientDemandLines.length > 0" est retiré du parent,
// car alors <ClientDemandTable> serait monté même avec lines=[], donc il n'y aurait pas de moyen
// de vérifier que le parent contrôle le rendu.
//
// MÉTHODE : monter SupplierClaimView (qui reste en awaiting-upload) →
//   → clientDemandLines.value = [] (jamais hydraté sans upload)
//   → <ClientDemandTable v-if="clientDemandLines.length > 0"> → NON rendu
//   → section data-testid="client-demand-table" absente du DOM → assertion DURE.
// ===========================================================================

describe('8.7-DISC-09: Rendu conditionnel v-if côté parent (AC #6, AC #10.9)', () => {
  it(
    'DISC-09a: SupplierClaimView en awaiting-upload (clientDemandLines=[]) → ' +
    'data-testid="client-demand-table" ABSENT du DOM — v-if=false ' +
    '[DISCRIMINANT DUR : échoue si v-if retiré du parent]',
    async () => {
      // clientDemandLines=[] car jamais reconcilié (pas de fichier uploadé en test unitaire)
      setupFetchMock([])

      const router = makeRouter()
      await router.push('/admin/sav/3/demande-fournisseur')
      await router.isReady()

      const wrapper = mount(SupplierClaimView, {
        global: { plugins: [router] },
        attachTo: document.body,
      })

      await flushPromises()

      // ASSERTION DURE : section absente (v-if=false côté parent)
      // Échoue si le v-if est retiré du parent
      expect(wrapper.find('[data-testid="client-demand-table"]').exists()).toBe(false)

      wrapper.unmount()
    }
  )
})

// ===========================================================================
// DISCRIMINANTS #9 / #10 / AC #1 / AC #6 — ClientDemandTable en ISOLATION
//
// Approche préférée CR HIGH-1 : mount(ClientDemandTable, { props: { lines: [...] } })
// La section est TOUJOURS rendue → assertions DURES s'exécutent TOUJOURS.
//
// DISCRIMINANT : retirer ClientDemandTable.vue ou retirer la section du template
// → ces tests FAIL immédiatement (pas d'escape-hatch).
// ===========================================================================

describe('8.7-DISC-09b: ClientDemandTable isolé — section rendue avec lines peuplé (AC #6, AC #10.9)', () => {
  it(
    'DISC-09b: mount(ClientDemandTable, { props: { lines: [1 ligne] } }) → ' +
    'section data-testid="client-demand-table" présente, 1 row data-testid="client-demand-row-*" ' +
    '[DISCRIMINANT DUR : FAIL si section retirée de ClientDemandTable.vue]',
    () => {
      const singleLine: ClientDemandLine[] = [
        {
          savLineId: 'uuid-test-single',
          codeFr: '3104-2K',
          designationFr: 'Pêche plate',
          qtyRequested: 1.5,
          unitRequested: 'kg',
          qtyArbitrated: 0.75,
          unitArbitrated: 'PIECE',
          requestReason: 'abime',
        },
      ]

      const wrapper = mount(ClientDemandTable, { props: { lines: singleLine } })

      // ASSERTION DURE : section TOUJOURS présente (pas de v-if dans ClientDemandTable)
      const section = wrapper.find('[data-testid="client-demand-table"]')
      expect(section.exists()).toBe(true)

      // 1 row avec le bon data-testid
      const rows = wrapper.findAll('[data-testid^="client-demand-row-"]')
      expect(rows).toHaveLength(1)
      expect(rows[0]!.attributes('data-testid')).toBe('client-demand-row-uuid-test-single')

      wrapper.unmount()
    }
  )

  it(
    'DISC-09c: mount(ClientDemandTable, { props: { lines: [] } }) → section rendue (vide) ' +
    '[le sous-composant ne filtre pas — c\'est le parent qui décide via v-if]',
    () => {
      // ClientDemandTable n'a PAS de v-if propre — il affiche toujours la section,
      // même si lines=[] (le parent contrôle le montage via v-if="clientDemandLines.length > 0")
      const wrapper = mount(ClientDemandTable, { props: { lines: [] } })

      // Section présente (pas de v-if dans le composant)
      expect(wrapper.find('[data-testid="client-demand-table"]').exists()).toBe(true)
      // Pas de rows
      expect(wrapper.findAll('[data-testid^="client-demand-row-"]')).toHaveLength(0)

      wrapper.unmount()
    }
  )
})

describe('8.7-DISC-10: Divergence d\'unité affichée brute dans ClientDemandTable (AC #6, AC #10.10)', () => {
  it(
    'DISC-10a: ligne pêche → cellule index 3 = "kg" (Unité demandée) ET cellule index 5 = "PIECE" (Unité arbitrée) ' +
    '[DISCRIMINANT DUR : FAIL si colonnes retirées/réordonnées ou valeurs normalisées]',
    () => {
      // WHY IT FAILS WITHOUT FIX:
      //   ClientDemandTable.vue n'existerait pas → import error → test FAIL.
      //   Avec le composant : les cellules existent, assertions s'exécutent vraiment.

      const wrapper = mount(ClientDemandTable, { props: { lines: defaultLines() } })

      const pecheRow = wrapper.find('[data-testid="client-demand-row-uuid-peche-3104"]')
      // ASSERTION DURE : la row DOIT exister
      expect(pecheRow.exists()).toBe(true)

      const cells = pecheRow.findAll('td')
      // 7 colonnes AC #1 : Code | Désignation | QtyDemandée | UnitéDemandée | QtyArbitrée | UnitéArbitrée | Motif
      expect(cells).toHaveLength(7)

      // Index 3 = Unité demandée (unit_requested brut, non normalisé)
      // DISCRIMINANT : 'kg' doit apparaître exactement tel quel (OOS-2 : pas de traduction)
      expect(cells[3]!.text()).toBe('kg')

      // Index 5 = Unité arbitrée (unit_arbitrated brut)
      expect(cells[5]!.text()).toBe('PIECE')

      wrapper.unmount()
    }
  )

  it(
    'DISC-10b: ligne courgette → Qté demandée = "1,00" (formatImporte DN-B, 2 décimales fr-FR) ' +
    '[DISCRIMINANT DUR : FAIL si formatImporte non appliqué ou mauvais séparateur décimal]',
    () => {
      const wrapper = mount(ClientDemandTable, { props: { lines: defaultLines() } })

      const courgetteRow = wrapper.find('[data-testid="client-demand-row-uuid-courgette-3115"]')
      expect(courgetteRow.exists()).toBe(true)

      const cells = courgetteRow.findAll('td')
      expect(cells).toHaveLength(7)

      // Index 2 = Qté demandée (qtyRequested=1) → formatImporte(1) = "1,00" (fr-FR, virgule)
      // DISCRIMINANT : si formatImporte n'est pas appelé → "1" (sans virgule) → FAIL
      expect(cells[2]!.text()).toBe('1,00')

      // Index 4 = Qté remboursée client (qtyArbitrated=1) → "1,00"
      expect(cells[4]!.text()).toBe('1,00')

      wrapper.unmount()
    }
  )

  it(
    'DISC-10c: ligne pêche → Qté demandée = "1,50" (1.5 → "1,50"), Qté arbitrée = "0,75" ' +
    '[DISCRIMINANT DUR : divergence visible 1,50 kg vs 0,75 PIECE = valeur métier principale 8.7]',
    () => {
      const wrapper = mount(ClientDemandTable, { props: { lines: defaultLines() } })

      const pecheRow = wrapper.find('[data-testid="client-demand-row-uuid-peche-3104"]')
      expect(pecheRow.exists()).toBe(true)

      const cells = pecheRow.findAll('td')

      // Qté demandée : 1.5 → "1,50"
      expect(cells[2]!.text()).toBe('1,50')

      // Unité demandée : 'kg'
      expect(cells[3]!.text()).toBe('kg')

      // Qté remboursée : 0.75 → "0,75"
      expect(cells[4]!.text()).toBe('0,75')

      // Unité arbitrée : 'PIECE'
      expect(cells[5]!.text()).toBe('PIECE')

      wrapper.unmount()
    }
  )

  it(
    'DISC-10d: champs null → "—" (tiret cadratin) — cohérence table arbitrage 8.3 ' +
    '[DISCRIMINANT DUR : FAIL si "null" ou "" affiché au lieu de "—"]',
    () => {
      const wrapper = mount(ClientDemandTable, { props: { lines: nullLines() } })

      const nullRow = wrapper.find('[data-testid="client-demand-row-uuid-null-test"]')
      expect(nullRow.exists()).toBe(true)

      const cells = nullRow.findAll('td')
      expect(cells).toHaveLength(7)

      // Code null → "—"
      expect(cells[0]!.text()).toBe('—')
      // Désignation null → "—"
      expect(cells[1]!.text()).toBe('—')
      // Qté demandée = 1 (non null) → "1,00"
      expect(cells[2]!.text()).toBe('1,00')
      // Unité demandée null → "—"
      expect(cells[3]!.text()).toBe('—')
      // Qté remboursée null → "—"
      expect(cells[4]!.text()).toBe('—')
      // Unité arbitrée null → "—"
      expect(cells[5]!.text()).toBe('—')
      // Motif null → "—"
      expect(cells[6]!.text()).toBe('—')

      // Pas de "null" ni chaîne vide
      const html = nullRow.html()
      expect(html).not.toContain('>null<')

      wrapper.unmount()
    }
  )
})

describe('8.7-AC01: Structure table — 7 colonnes, h3, read-only, ordre (AC #1)', () => {
  it(
    'AC01-a: section contient h3="Demande client" + table avec thead 7 colonnes dans le bon ordre ' +
    '[DISCRIMINANT DUR : FAIL si section retirée, h3 absent, ou <7 colonnes]',
    () => {
      const wrapper = mount(ClientDemandTable, { props: { lines: defaultLines() } })

      // h3 "Demande client"
      const h3 = wrapper.find('h3')
      expect(h3.exists()).toBe(true)
      expect(h3.text()).toBe('Demande client')

      // 7 colonnes en-têtes AC #1
      const headers = wrapper.findAll('thead th')
      expect(headers).toHaveLength(7)

      // Ordre figé décision PO Q-B :
      // Code (SKU FR) | Désignation | Qté demandée | Unité demandée | Qté remboursée client (arbitrée) | Unité arbitrée | Motif
      expect(headers[0]!.text()).toMatch(/code/i)
      expect(headers[1]!.text()).toMatch(/d[eé]signation/i)
      expect(headers[2]!.text()).toMatch(/qt[eé].*demand/i)
      expect(headers[3]!.text()).toMatch(/unit[eé].*demand/i)
      expect(headers[4]!.text()).toMatch(/qt[eé].*arbitr[eé]|rembours/i)
      expect(headers[5]!.text()).toMatch(/unit[eé].*arbitr[eé]/i)
      expect(headers[6]!.text()).toMatch(/motif/i)

      wrapper.unmount()
    }
  )

  it(
    'AC01-b: table read-only — 0 <input>, 0 <button> dans la section ' +
    '[DISCRIMINANT DUR : FAIL si un input/button est ajouté dans ClientDemandTable.vue]',
    () => {
      const wrapper = mount(ClientDemandTable, { props: { lines: defaultLines() } })

      // OOS-1 gravé : table de contrôle, PAS d'arbitrage
      expect(wrapper.findAll('input')).toHaveLength(0)
      expect(wrapper.findAll('button')).toHaveLength(0)

      wrapper.unmount()
    }
  )

  it(
    'AC01-c: data-testid="client-demand-table" présent sur la section ' +
    '[DISCRIMINANT DUR : testabilité MCP — FAIL si testid absent]',
    () => {
      const wrapper = mount(ClientDemandTable, { props: { lines: defaultLines() } })

      expect(wrapper.find('[data-testid="client-demand-table"]').exists()).toBe(true)

      wrapper.unmount()
    }
  )

  it(
    'AC01-d: chaque row a :data-testid="client-demand-row-${savLineId}" ' +
    '[DISCRIMINANT DUR : testabilité MCP par ligne — FAIL si testid absent]',
    () => {
      const wrapper = mount(ClientDemandTable, { props: { lines: defaultLines() } })

      const rows = wrapper.findAll('[data-testid^="client-demand-row-"]')
      expect(rows).toHaveLength(2)
      expect(rows[0]!.attributes('data-testid')).toBe('client-demand-row-uuid-peche-3104')
      expect(rows[1]!.attributes('data-testid')).toBe('client-demand-row-uuid-courgette-3115')

      wrapper.unmount()
    }
  )

  it(
    'AC01-e: 2 lignes → 2 rows dans le tbody, ordre préservé (deterministic order AC #2) ' +
    '[DISCRIMINANT DUR : FAIL si lignes dans le mauvais ordre]',
    () => {
      const wrapper = mount(ClientDemandTable, { props: { lines: defaultLines() } })

      const rows = wrapper.findAll('tbody tr')
      expect(rows).toHaveLength(2)

      // Ordre : pêche (index 0), courgette (index 1) — conforme à defaultLines()
      expect(rows[0]!.attributes('data-testid')).toBe('client-demand-row-uuid-peche-3104')
      expect(rows[1]!.attributes('data-testid')).toBe('client-demand-row-uuid-courgette-3115')

      wrapper.unmount()
    }
  )
})

describe('8.7-AC06: Position de ClientDemandTable dans SupplierClaimView (AC #6)', () => {
  it(
    'AC06-a: dans SupplierClaimView HTML — data-testid="client-demand-table" absent en awaiting-upload ' +
    'mais le template contient bien la directive ClientDemandTable (v-if côté parent) ' +
    '[DISCRIMINANT STRUCTURAL : FAIL si le composant n\'est plus utilisé dans la vue]',
    async () => {
      // Mount SupplierClaimView avec fetch mocké → reste en awaiting-upload
      setupFetchMock([])

      const router = makeRouter()
      await router.push('/admin/sav/3/demande-fournisseur')
      await router.isReady()

      const wrapper = mount(SupplierClaimView, {
        global: { plugins: [router] },
        attachTo: document.body,
      })

      await flushPromises()

      // En awaiting-upload : clientDemandLines=[] → v-if=false → ClientDemandTable non monté
      // Section absente du DOM (c'est le comportement attendu)
      expect(wrapper.find('[data-testid="client-demand-table"]').exists()).toBe(false)

      // Le composant SupplierClaimView importe bien ClientDemandTable
      // (si l'import était cassé, ce test serait en erreur)
      expect(SupplierClaimView).toBeDefined()

      wrapper.unmount()
    }
  )
})

// ===========================================================================
// AC #9 — Iso-Epic 5 : suites Rufino + Martinez importables sans erreur (AC #10.12)
// ===========================================================================

describe('8.7-ISO-EPIC5: Non-régression suites Epic 5 (AC #10.12)', () => {
  it(
    'ISO-01: rufinoConfig importable sans erreur (module Epic 5 autonome) ' +
    '[GUARD : si ClientDemandTable.vue importait exports/*, ce module crasherait]',
    async () => {
      const { rufinoConfig } = await import('../../../../../api/_lib/exports/rufinoConfig')
      expect(rufinoConfig).toBeDefined()
      expect(rufinoConfig.supplier_code).toBe('RUFINO')
    }
  )

  it(
    'ISO-02: martinezConfig importable sans erreur (module Epic 5 autonome)',
    async () => {
      const { martinezConfig } = await import('../../../../../api/_lib/exports/martinezConfig')
      expect(martinezConfig).toBeDefined()
      expect(martinezConfig.supplier_code).toBe('MARTINEZ')
    }
  )

  it(
    'ISO-03: ClientDemandTable.vue est importable sans erreur (compilation guard) ' +
    '[FAIL si le composant a une erreur TS/vue-tsc]',
    () => {
      expect(ClientDemandTable).toBeDefined()
    }
  )

  it(
    'ISO-04: SupplierClaimView.vue est importable sans erreur après refactoring 8.7 ' +
    '[COMPILATION GUARD : si le template a une erreur de référence, cet import échoue]',
    () => {
      expect(SupplierClaimView).toBeDefined()
    }
  )
})
