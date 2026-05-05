/**
 * Story V1.3 AC #5(b) — Forcing function anti-régression cold-start pour api/credit-notes.ts
 *
 * Test type: UNIT (module import simulation)
 *
 * Symétrique de sav-coldstart.spec.ts — même stratégie DN-2 Option A.
 * Couvre le dispatcher api/credit-notes.ts qui expose :
 *   GET  /api/credit-notes/:number/pdf       → op=pdf
 *   POST /api/credit-notes/:number/regenerate-pdf → op=regenerate
 *
 * La chain de transitivité ESM : api/credit-notes.ts → regenerate-pdf-handler.ts
 * → generate-credit-note-pdf.ts → CreditNotePdf.ts → @react-pdf/renderer.
 * Si le fix V1.3 n'est pas appliqué sur CreditNotePdf.ts et generate-credit-note-pdf.ts,
 * le chargement de ce module en env CJS crashe avec ERR_REQUIRE_ESM.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'

// Mock les dépendances pour isoler le test de chargement module
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

// AC #5(b) — Charge le module api/credit-notes au top-level via dynamic import
// et assert pas d'erreur thrown + default export est une function.
describe('api/credit-notes.ts — cold-start module load (AC #5(b))', () => {
  let mod: { default: unknown } | undefined

  beforeAll(async () => {
    mod = await import('../../../api/credit-notes')
  })

  it('charge api/credit-notes.ts sans ERR_REQUIRE_ESM ni aucune erreur au module-load', () => {
    expect(mod).toBeDefined()
  })

  it('default export est une function (handler Vercel)', () => {
    expect(typeof mod?.default).toBe('function')
  })
})
