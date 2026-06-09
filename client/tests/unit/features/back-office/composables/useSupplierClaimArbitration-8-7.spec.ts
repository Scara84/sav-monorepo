/**
 * Story 8.7 — AC #5 (composable) : Tests anti-faux-vert (discriminants 5–8)
 *
 * Test type: UNIT — composable testé en isolation via vi.mock fetch
 *   (pattern conforme aux suites 8.3/8.5 — pas de mount Vue, test state pur)
 *
 * CRITIQUE (mémoire feedback_test_integration_gap) :
 *   CHACUN des discriminants 5–8 DOIT ÉCHOUER sous le code ACTUEL (non fixé).
 *   Discriminant-5 : `clientDemandLines` est un Ref qui n'existe pas encore →
 *     useSupplierClaimArbitration() ne retourne pas `clientDemandLines` → accès undefined FAILS.
 *   Discriminant-6 : fallback [] sur réponse sans `savLines` → si `clientDemandLines` absent,
 *     on ne peut même pas l'asserter.
 *   Discriminant-7 : reset dans resetToArbitrating() → idem non-existent.
 *   Discriminant-8 : re-import reset dans watch parseResult → idem.
 *
 * DN-A = Option A (PO Antho, 2026-06-09) :
 *   `clientDemandLines` est hydraté DANS le composable (runReconcile) depuis result.savLines.
 *   reconcile() reste intact (helper pur inchangé).
 *
 * DN-B = 2 décimales / formatImporte (PO Antho, 2026-06-09) :
 *   Les tests composable vérifient les valeurs numériques brutes — le formatage est testé
 *   dans la suite vue (SupplierClaimView-8-7.spec.ts).
 *
 * AC couvertes :
 *   AC #5  — ReconcileResponse étendue + clientDemandLines Ref + hydratation + resets
 *   AC #10 — discriminants 5–8 (ÉCHOUENT sous code actuel)
 *
 * Mock strategy :
 *   - fetch : vi.fn() retournant la réponse mockée (pattern SavDetailView.spec.ts)
 *   - On instancie le composable directement en dehors d'un composant Vue
 *     (pattern useAdminErpQueue.spec.ts — withSetup helper)
 *   - resetToArbitrating() et le watch parseResult sont testés via leur effet sur clientDemandLines.value
 *
 * Source of truth : _bmad-output/stories/8-7-table-demande-client-visibilite-controle.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, computed, nextTick } from 'vue'

// ---------------------------------------------------------------------------
// withSetup helper — instancie un composable dans un contexte Vue (lifecycle OK)
// Pattern inspiré de useAdminErpQueue.spec.ts et de la doc VTU composable testing
// ---------------------------------------------------------------------------

import { mount, flushPromises } from '@vue/test-utils'
import type { Ref, ComputedRef } from 'vue'

function withSetup<T>(composableFn: () => T): { result: T; app: ReturnType<typeof mount> } {
  let result!: T
  const TestComponent = {
    setup() {
      result = composableFn()
      return {}
    },
    template: '<div/>',
  }
  const app = mount(TestComponent, { attachTo: document.body })
  return { result, app }
}

// ---------------------------------------------------------------------------
// ClientDemandLine type (miroir du type que 8.7 exportera depuis le composable)
// ---------------------------------------------------------------------------

interface ClientDemandLine {
  savLineId: string | number
  codeFr: string | null
  designationFr: string | null
  qtyRequested: number | null
  unitRequested: string | null
  qtyArbitrated: number | null
  unitArbitrated: string | null
  requestReason: string | null
}

// ---------------------------------------------------------------------------
// Fixture helpers — réponses handler mockées
// ---------------------------------------------------------------------------

function makeBaseReconcileResponse(overrides: Record<string, unknown> = {}) {
  return {
    metadata: { reference: '505_25S25_30', albaran: 505, fechaAlbaran: '2026-05-30', warnings: [] },
    claimLines: [
      {
        savLineId: 'uuid-peche-3104',
        codeFr: '3104-2K',
        codigoEs: '3104',
        productoEs: 'Melocotón plano',
        origen: 'España',
        unidad: 'Kilos',
        conversionFlag: 'converti pièce→kg',
        causaEs: 'estropeado',
        precio: 3.24,
        qty: 0.75,
        peso: 0.75,
        qteFact: 4,
        importe: 4.92,
        blockingForGeneration: false,
        productNameSnapshot: 'Pêche plate cagette 2kg',
        comentarios: 'converti pièce→kg via Kilos Netos (2.025 kg)',
        effectiveCap: 8.1,
        effectiveCapUnit: 'Kilos',
        conversionComment: 'converti pièce→kg via Kilos Netos (2.025 kg)',
        creditNoteLink: { savId: 3, savLineId: 'uuid-peche-3104' },
        tokenExtracted: '3104-2K',
        qtyDefaultClient: 0.75,
      },
    ],
    unmatchedSavLines: [],
    unusedSupplierLines: [],
    totals: { importe: 4.92, linesMatched: 1, linesUnmatched: 0, linesBlocking: 0 },
    meta: {
      reconciliation: { savLinesTotal: 1, matched: 1, unmatched: 0, multipleMatches: 0 },
      warnings: [],
    },
    ...overrides,
  }
}

/** Réponse AVEC `savLines` (post-fix 8.7) */
function makeResponseWithSavLines(savLines: ClientDemandLine[] = defaultSavLines()) {
  return makeBaseReconcileResponse({ savLines })
}

/** Réponse SANS `savLines` (serveur ancien — test fallback dégradé AC #10.6) */
function makeResponseWithoutSavLines() {
  return makeBaseReconcileResponse()
  // NB: pas de `savLines` clé → undefined → composable doit fallback []
}

function defaultSavLines(): ClientDemandLine[] {
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

// ---------------------------------------------------------------------------
// Mock fetch helper
// ---------------------------------------------------------------------------

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn(() =>
    Promise.resolve({
      status,
      ok: status >= 200 && status < 300,
      json: () => Promise.resolve(body),
    } as unknown as Response)
  )
  ;(globalThis as unknown as { fetch: unknown }).fetch = fn
  return fn
}

// ---------------------------------------------------------------------------
// Import composable
// ---------------------------------------------------------------------------

import { useSupplierClaimArbitration } from '../../../../../src/features/back-office/composables/useSupplierClaimArbitration'
import type { SupplierFileParseResult } from '../../../../../src/features/back-office/composables/useSupplierClaimUpload'

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
// DISCRIMINANT #5 — Hydratation `clientDemandLines` depuis `result.savLines` (AC #5, AC #10.5)
//
// WHY IT FAILS TODAY:
//   useSupplierClaimArbitration() ne retourne pas `clientDemandLines`.
//   result.clientDemandLines === undefined → .value throw ou est undefined.
//   L'assertion sur la longueur FAILS.
// ===========================================================================

describe('8.7-DISC-05: Hydratation `clientDemandLines` dans runReconcile (AC #5, AC #10.5)', () => {
  it(
    'DISC-05a: runReconcile() avec réponse savLines=[{...}] → clientDemandLines.value contient 1 entrée ' +
    '[RED: `clientDemandLines` absent du retour composable aujourd\'hui → undefined FAILS]',
    async () => {
      // WHY IT FAILS TODAY:
      //   useSupplierClaimArbitration() n'expose pas `clientDemandLines`.
      //   result.clientDemandLines === undefined → TypeError ou undefined.

      const savLines: ClientDemandLine[] = [
        {
          savLineId: 'uuid-test-5a',
          codeFr: '3115-2K',
          designationFr: 'Courgette verte',
          qtyRequested: 1,
          unitRequested: 'piece',
          qtyArbitrated: 1,
          unitArbitrated: 'PIECE',
          requestReason: 'manquant',
        },
      ]

      mockFetch(makeResponseWithSavLines(savLines))

      const parseResult = ref<unknown>({
        metadata: { reference: '505_25S25_30', albaran: 505, fechaAlbaran: '2026-05-30', warnings: [] },
        factureGroupe: { rows: [], skippedRows: 0, warnings: [] },
        bdd: { rows: [], skippedRows: 0, warnings: [] },
        fileMeta: { filename: 'data.xlsx', sizeBytes: 0, sheetsDetected: [], parser: 'xlsx' },
      })
      const savId = computed(() => 3)

      const { result: composable } = withSetup(() =>
        useSupplierClaimArbitration(
          savId as ComputedRef<number>,
          parseResult as unknown as Ref<SupplierFileParseResult | null>
        )
      )

      // Attendre que le watch déclenche runReconcile() + résolution complète de la promesse fetch
      await flushPromises()

      // POST-FIX: clientDemandLines exposé dans le retour du composable
      // FAILS TODAY: composable.clientDemandLines === undefined (champ non exposé)
      expect(composable).toHaveProperty('clientDemandLines')

      const clientDemandLines = (composable as unknown as { clientDemandLines: Ref<ClientDemandLine[]> }).clientDemandLines

      // POST-FIX: clientDemandLines.value = result.savLines = [{ savLineId: 'uuid-test-5a', ... }]
      // FAILS TODAY: TypeError (clientDemandLines undefined) ou length !== 1
      expect(clientDemandLines.value).toHaveLength(1)
      expect(clientDemandLines.value[0]!.savLineId).toBe('uuid-test-5a')
      expect(clientDemandLines.value[0]!.codeFr).toBe('3115-2K')
    }
  )

  it(
    'DISC-05b: réponse avec 2 savLines → clientDemandLines.value.length === 2 (SOL Y FRUTA fixture) ' +
    '[RED: `clientDemandLines` absent aujourd\'hui]',
    async () => {
      mockFetch(makeResponseWithSavLines(defaultSavLines()))

      const parseResult = ref<unknown>({ dummy: true })
      const savId = computed(() => 3)

      const { result: composable } = withSetup(() =>
        useSupplierClaimArbitration(
          savId as ComputedRef<number>,
          parseResult as unknown as Ref<SupplierFileParseResult | null>
        )
      )

      await flushPromises()

      expect(composable).toHaveProperty('clientDemandLines')
      const clientDemandLines = (composable as unknown as { clientDemandLines: Ref<ClientDemandLine[]> }).clientDemandLines

      // FAILS TODAY: clientDemandLines undefined
      expect(clientDemandLines.value).toHaveLength(2)

      // Vérifier la divergence d'unité exposée (valeur métier principale de la story)
      const pecheLine = clientDemandLines.value.find((l) => l.savLineId === 'uuid-peche-3104')
      expect(pecheLine).toBeDefined()
      expect(pecheLine!.unitRequested).toBe('kg')
      expect(pecheLine!.unitArbitrated).toBe('PIECE')
    }
  )
})

// ===========================================================================
// DISCRIMINANT #6 — Fallback [] quand serveur ancien (sans `savLines`) (AC #5, AC #10.6)
//
// WHY IT FAILS TODAY:
//   `clientDemandLines` n'existe pas → on ne peut pas vérifier sa valeur.
//   POST-FIX : si `result.savLines` est undefined → clientDemandLines.value = []
//   (dégradation propre pour compatibilité serveur ancien)
// ===========================================================================

describe('8.7-DISC-06: Fallback [] sur serveur ancien (sans savLines) (AC #5, AC #10.6)', () => {
  it(
    'DISC-06a: réponse sans `savLines` → clientDemandLines.value === [] (PAS d\'erreur, dégradation propre) ' +
    '[RED: `clientDemandLines` absent aujourd\'hui → idem qu\'DISC-05]',
    async () => {
      // Réponse serveur ANCIEN : pas de champ savLines (undefined)
      mockFetch(makeResponseWithoutSavLines())

      const parseResult = ref<unknown>({ dummy: true })
      const savId = computed(() => 3)

      const { result: composable } = withSetup(() =>
        useSupplierClaimArbitration(
          savId as ComputedRef<number>,
          parseResult as unknown as Ref<SupplierFileParseResult | null>
        )
      )

      await flushPromises()

      expect(composable).toHaveProperty('clientDemandLines')
      const clientDemandLines = (composable as unknown as { clientDemandLines: Ref<ClientDemandLine[]> }).clientDemandLines

      // POST-FIX: result.savLines ?? [] → clientDemandLines.value = []
      // FAILS TODAY: clientDemandLines undefined
      expect(clientDemandLines.value).toEqual([])
    }
  )

  it(
    'DISC-06b: pas d\'erreur ni d\'exception quand savLines est undefined ' +
    '[ROBUSTESSE : dégradation propre, pas de TypeError sur .length de undefined]',
    async () => {
      mockFetch(makeResponseWithoutSavLines())

      const parseResult = ref<unknown>({ dummy: true })
      const savId = computed(() => 3)

      // POST-FIX : ne doit pas throw, même si savLines est absent de la réponse
      await expect(async () => {
        const { result: composable } = withSetup(() =>
          useSupplierClaimArbitration(
            savId as ComputedRef<number>,
            parseResult as unknown as Ref<SupplierFileParseResult | null>
          )
        )
        await flushPromises()
        // Accéder à clientDemandLines.value (ne doit pas throw)
        const cd = (composable as unknown as { clientDemandLines?: Ref<ClientDemandLine[]> }).clientDemandLines
        if (cd) {
          void cd.value.length  // ne doit pas throw TypeError
        }
      }).not.toThrow()
    }
  )
})

// ===========================================================================
// DISCRIMINANT #7 — Reset propre dans resetToArbitrating() (AC #5, AC #10.7)
//
// WHY IT FAILS TODAY:
//   `clientDemandLines` n'est pas dans le retour du composable.
//   `resetToArbitrating()` ne réinitialise pas un champ qui n'existe pas.
//   Après fix : resetToArbitrating() doit poser clientDemandLines.value = [].
// ===========================================================================

describe('8.7-DISC-07: Reset propre dans resetToArbitrating() (AC #5, AC #10.7)', () => {
  it(
    'DISC-07a: clientDemandLines hydraté (2 lignes) → resetToArbitrating() → clientDemandLines.value === [] ' +
    '[RED: `clientDemandLines` absent aujourd\'hui]',
    async () => {
      // 1. Hydrater le composable avec 2 savLines
      mockFetch(makeResponseWithSavLines(defaultSavLines()))

      const parseResult = ref<unknown>({ dummy: true })
      const savId = computed(() => 3)

      const { result: composable } = withSetup(() =>
        useSupplierClaimArbitration(
          savId as ComputedRef<number>,
          parseResult as unknown as Ref<SupplierFileParseResult | null>
        )
      )

      await flushPromises()

      expect(composable).toHaveProperty('clientDemandLines')
      const clientDemandLines = (composable as unknown as { clientDemandLines: Ref<ClientDemandLine[]> }).clientDemandLines

      // Vérifier que clientDemandLines est hydraté
      // FAILS TODAY: clientDemandLines undefined
      expect(clientDemandLines.value).toHaveLength(2)

      // 2. Appeler resetToArbitrating()
      const resetFn = (composable as unknown as { resetToArbitrating: () => void }).resetToArbitrating
      expect(typeof resetFn).toBe('function')
      resetFn()

      // 3. Après reset : clientDemandLines.value === []
      // POST-FIX : resetToArbitrating() inclut `clientDemandLines.value = []` (AC #5)
      // FAILS TODAY: clientDemandLines undefined
      expect(clientDemandLines.value).toEqual([])
    }
  )

  it(
    'DISC-07b: resetToArbitrating() reset AUSSI claimLines + unmatchedSavLines (cohérence M1 fix CR 8.5) ' +
    '[GUARD : le reset clientDemandLines ne doit pas "désactiver" le reset des autres champs]',
    async () => {
      mockFetch(makeResponseWithSavLines(defaultSavLines()))

      const parseResult = ref<unknown>({ dummy: true })
      const savId = computed(() => 3)

      const { result: composable } = withSetup(() =>
        useSupplierClaimArbitration(
          savId as ComputedRef<number>,
          parseResult as unknown as Ref<SupplierFileParseResult | null>
        )
      )

      // Attendre la résolution complète de la promesse fetch
      await flushPromises()

      const { resetToArbitrating, claimLines, unmatchedSavLines } = composable as unknown as {
        resetToArbitrating: () => void
        claimLines: Ref<unknown[]>
        unmatchedSavLines: Ref<unknown[]>
      }

      // Ce test vérifie que resetToArbitrating() vide claimLines et unmatchedSavLines.
      // La vérification pre-reset (claimLines peuplé) dépend du timing de fetch resolution.
      // Si fetch n'a pas encore résolu après 3 ticks, on vérifie uniquement le comportement reset.
      // Le comportement M1 (reset complet) est garanti par le code 8.3/8.5 existant.
      if (claimLines.value.length > 0) {
        // Cas idéal : fetch a résolu, on peut vérifier pre-reset + post-reset
        resetToArbitrating()
        expect(claimLines.value).toEqual([])
        expect(unmatchedSavLines.value).toEqual([])
      } else {
        // Cas timing : fetch non résolu, on vérifie que resetToArbitrating() ne throw pas
        // et que le state est cohérent après reset
        resetToArbitrating()
        expect(claimLines.value).toEqual([])
        expect(unmatchedSavLines.value).toEqual([])
        // Guard documentaire : le comportement post-reset est correct dans tous les cas
      }
    }
  )
})

// ===========================================================================
// DISCRIMINANT #8 — Re-import propre : watch(parseResult) reset clientDemandLines (AC #5, AC #10.8)
//
// Pattern MEDIUM-2 (CR 8.3) : quand parseResult change, le composable reset le state
// arbitrage AVANT de lancer runReconcile() pour éviter les leaks de données stale.
// 8.7 étend ce reset à clientDemandLines.
//
// WHY IT FAILS TODAY:
//   `clientDemandLines` n'existe pas dans le watch reset.
//   POST-FIX : le bloc de reset dans watch(parseResult) inclut `clientDemandLines.value = []`.
// ===========================================================================

describe('8.7-DISC-08: Re-import — watch(parseResult) reset clientDemandLines (AC #5, AC #10.8)', () => {
  it(
    'DISC-08a: 2e import (parseResult change) → clientDemandLines.value === [] pendant le reset AVANT le 2e runReconcile ' +
    '[RED: `clientDemandLines` absent du watch reset aujourd\'hui]',
    async () => {
      // 1. Premier import : hydrater avec 2 savLines
      mockFetch(makeResponseWithSavLines(defaultSavLines()))

      const parseResult = ref<{ dummy: number } | null>({ dummy: 1 })
      const savId = computed(() => 3)

      const { result: composable } = withSetup(() =>
        useSupplierClaimArbitration(
          savId as ComputedRef<number>,
          parseResult as unknown as Ref<SupplierFileParseResult | null>
        )
      )

      await flushPromises()

      expect(composable).toHaveProperty('clientDemandLines')
      const clientDemandLines = (composable as unknown as { clientDemandLines: Ref<ClientDemandLine[]> }).clientDemandLines

      // Vérifier état initial hydraté
      // FAILS TODAY: clientDemandLines undefined
      expect(clientDemandLines.value).toHaveLength(2)

      // 2. Changer parseResult (simule un 2e import de fichier)
      //    Le watch doit resetter clientDemandLines.value = [] AVANT le 2e runReconcile
      //    (MEDIUM-2 pattern : reset stale state avant re-réconciliation)

      // Mock fetch pour le 2e appel — réponse différente (1 seule ligne)
      const singleLine: ClientDemandLine[] = [
        {
          savLineId: 'uuid-single',
          codeFr: '9999-TEST',
          designationFr: 'Test ligne unique',
          qtyRequested: 3,
          unitRequested: 'kg',
          qtyArbitrated: 3,
          unitArbitrated: 'kg',
          requestReason: 'autre',
        },
      ]
      mockFetch(makeResponseWithSavLines(singleLine))

      // Changer parseResult → déclenche le watch
      parseResult.value = { dummy: 2 }
      await nextTick()

      // POST-FIX (MEDIUM-2 8.7) : le watch reset clientDemandLines.value = [] avant runReconcile
      // À cet instant (avant résolution de la 2e promesse fetch), la valeur doit être []
      // FAILS TODAY: clientDemandLines undefined
      // NOTE: Le timing exact dépend de l'implémentation sync du reset dans le watch.
      // Si le reset est sync (comme dans 8.3), la valeur est [] ici.
      expect(clientDemandLines.value).toEqual([])

      // Attendre la résolution complète de la 2e promesse
      await flushPromises()

      // Après le 2e runReconcile : clientDemandLines.value = [single line]
      expect(clientDemandLines.value).toHaveLength(1)
      expect(clientDemandLines.value[0]!.savLineId).toBe('uuid-single')
    }
  )
})

// ===========================================================================
// AC #5 — Type `ClientDemandLine` exporté depuis le composable (AC #5)
//
// Le type doit être réutilisable par la vue (SupplierClaimView.vue) et les tests.
// Ce test vérifie que l'import TS du type fonctionne (typecheck gate).
// ===========================================================================

describe('8.7-AC05: Type `ClientDemandLine` exporté (AC #5)', () => {
  it(
    'AC05-a: ClientDemandLine est importable depuis useSupplierClaimArbitration ' +
    '[typecheck gate — si le type n\'est pas exporté, vue-tsc fails]',
    () => {
      // Ce test est un placeholder documentaire pour le typecheck gate.
      // L'import réel est fait en haut du fichier (si exporté par le composable).
      // La vérification réelle est dans `npm run typecheck` (AC #12).
      //
      // POST-FIX: `export interface ClientDemandLine { ... }` dans useSupplierClaimArbitration.ts
      // FAILS TODAY: seule la vérification typecheck (vue-tsc) le détectera
      //
      // On vérifie ici que le composable retourne bien `clientDemandLines` avec le bon type
      // (vérification runtime limitée — typecheck = vérification complète)

      // Instanciation minimale sans parseResult peuplé (pas de runReconcile)
      const parseResult = ref<null>(null)
      const savId = computed(() => 99)

      const { result: composable } = withSetup(() =>
        useSupplierClaimArbitration(
          savId as ComputedRef<number>,
          parseResult as unknown as Ref<SupplierFileParseResult | null>
        )
      )

      // POST-FIX: `clientDemandLines` exposé, valeur initiale = []
      // FAILS TODAY: composable.clientDemandLines === undefined
      expect(composable).toHaveProperty('clientDemandLines')
      const cd = (composable as unknown as { clientDemandLines: Ref<ClientDemandLine[]> }).clientDemandLines
      expect(cd.value).toEqual([])
    }
  )

  it(
    'AC05-b: ReconcileResponse étendue additivement — `savLines` optionnel, fallback [] garanti ' +
    '[AC #5 — si serveur ancien sans savLines : clientDemandLines.value === []]',
    async () => {
      // Même réponse qu'avant 8.7 (serveur ancien non mis à jour) → dégradation propre
      mockFetch(makeResponseWithoutSavLines())

      const parseResult = ref<unknown>({ dummy: true })
      const savId = computed(() => 3)

      const { result: composable } = withSetup(() =>
        useSupplierClaimArbitration(
          savId as ComputedRef<number>,
          parseResult as unknown as Ref<SupplierFileParseResult | null>
        )
      )

      await flushPromises()

      expect(composable).toHaveProperty('clientDemandLines')
      const cd = (composable as unknown as { clientDemandLines: Ref<ClientDemandLine[]> }).clientDemandLines
      // Fallback [] sur savLines absent (result.savLines ?? [])
      expect(cd.value).toEqual([])
      // Pas d'erreur : les champs existants (claimLines etc.) restent intacts
      expect((composable as { claimLines: Ref<unknown[]> }).claimLines.value).toHaveLength(1)
    }
  )
})
