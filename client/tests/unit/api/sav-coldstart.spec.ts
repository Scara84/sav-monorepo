/**
 * Story V1.3 AC #5(a) — Forcing function anti-régression cold-start pour api/sav.ts
 *
 * Test type: UNIT (module import simulation)
 *
 * Stratégie DN-2 Option A retenue : test Vitest simple `await import()` dynamique.
 * Limitation connue : Vitest charge en mode ESM, donc ce test ne reproduit PAS
 * strictement l'env CJS Vercel pour ERR_REQUIRE_ESM spécifiquement.
 * La vraie forcing function pour ERR_REQUIRE_ESM est le smoke-test preview Vercel
 * (AC #6(e)). Ce test reste utile pour :
 *   (1) Vérifier que le module se charge sans erreur runtime (typo, dep manquante).
 *   (2) Attraper toute future régression dans la chain api/sav → _lib/* qui
 *       provoquerait une erreur au module-load (ex: import top-level qui throw).
 *
 * Si une future story réintroduit un eager `import` ESM-only qui crashe même
 * en mode ESM Vitest (ex: module ESM avec effet de bord au load qui nécessite
 * une env browser/native), ce test l'attrape immédiatement.
 *
 * Pattern : charger le module via dynamic import + assert que le default export
 * est une fonction (handler Vercel).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'

// Mock les dépendances "lourdes" qui nécessitent des env vars à l'init
// pour éviter que le test fail sur des erreurs d'initialisation DB,
// et non sur le chargement du module ESM (ce qu'on veut tester).
vi.mock('../../../api/_lib/clients/supabase-admin', () => ({
  supabaseAdmin: () => ({ from: vi.fn() }),
  __resetSupabaseAdminForTests: vi.fn(),
}))

vi.mock('../../../api/_lib/middleware/with-auth', () => ({
  withAuth: vi.fn(
    (opts: unknown) =>
      (handler: (req: unknown, res: unknown) => unknown) =>
      (req: unknown, res: unknown) =>
        handler(req, res)
  ),
}))

vi.mock('../../../api/_lib/onedrive-ts', () => ({
  uploadCreditNotePdf: vi.fn(),
  getOneDriveClient: vi.fn(),
}))

// AC #5(a) — Charge le module api/sav au top-level via dynamic import
// et assert pas d'erreur thrown + default export est une function.
describe('api/sav.ts — cold-start module load (AC #5(a))', () => {
  let mod: { default: unknown } | undefined

  beforeAll(async () => {
    // Dynamic import simule le chargement du module au cold-start.
    // Si le module contient un `import * as ReactPDF from '@react-pdf/renderer'`
    // au top-level qui throw (même en mode ESM Vitest), ce bloc lance une erreur.
    mod = await import('../../../api/sav')
  })

  it('charge api/sav.ts sans ERR_REQUIRE_ESM ni aucune erreur au module-load', () => {
    expect(mod).toBeDefined()
  })

  it('default export est une function (handler Vercel)', () => {
    expect(typeof mod?.default).toBe('function')
  })
})
