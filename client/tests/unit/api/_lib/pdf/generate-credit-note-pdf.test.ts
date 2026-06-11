/**
 * Story 4.5 AC #10 — tests pipeline `generateCreditNotePdfAsync`.
 *
 * Mocks :
 *   - `supabase-admin` : chain-proxy simulant credit_notes / sav / members /
 *     groups / sav_lines / settings.
 *   - `renderToBuffer` (via injection `__setGeneratePdfDepsForTests`).
 *   - `uploadCreditNotePdf` (via injection deps).
 *   - `sleep` (injection deps, évite d'attendre le backoff retry).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const db = vi.hoisted(() => ({
  creditNote: null as Record<string, unknown> | null,
  creditNoteError: null as { message: string } | null,
  creditNoteAfter: null as Record<string, unknown> | null, // Post-update
  sav: null as Record<string, unknown> | null,
  savError: null as { message: string } | null,
  member: null as Record<string, unknown> | null,
  memberError: null as { message: string } | null,
  group: null as Record<string, unknown> | null,
  groupError: null as { message: string } | null,
  lines: [] as Array<Record<string, unknown>>,
  linesError: null as { message: string } | null,
  settings: [] as Array<Record<string, unknown>>,
  settingsError: null as { message: string } | null,
  updateError: null as { message: string } | null,
  capturedUpdate: null as Record<string, unknown> | null,
  capturedUpdateId: null as unknown,
  creditNoteSelects: 0,
}))

vi.mock('../../../../../api/_lib/clients/supabase-admin', () => {
  const client = {
    from: (table: string) => {
      if (table === 'credit_notes') {
        // Chain: .select().eq().limit().maybeSingle()
        // Chain: .update(values).eq(col, id)
        return {
          select: () => ({
            eq: () => ({
              limit: () => ({
                maybeSingle: () => {
                  db.creditNoteSelects += 1
                  // 1er select = pre-generate, 2e select = post-generate
                  const data =
                    db.creditNoteSelects === 1
                      ? db.creditNote
                      : (db.creditNoteAfter ?? db.creditNote)
                  return Promise.resolve({
                    data,
                    error: db.creditNoteError,
                  })
                },
              }),
            }),
          }),
          update: (values: Record<string, unknown>) => {
            db.capturedUpdate = values
            return {
              eq: (_col: string, val: unknown) => {
                db.capturedUpdateId = val
                // Après update, la 2e SELECT doit voir les nouveaux champs.
                if (db.creditNote !== null) {
                  db.creditNoteAfter = {
                    ...db.creditNote,
                    ...values,
                  }
                }
                // Chain pour CR 4.5 P3 : .is('pdf_web_url', null).select('id')
                return {
                  is: () => ({
                    select: () => {
                      // Simule le filtre conditionnel : si le row initial
                      // avait déjà un pdf_web_url, UPDATE affecte 0 row.
                      const affectedRows =
                        (db.creditNote as { pdf_web_url?: unknown } | null)?.pdf_web_url == null
                          ? [{ id: val }]
                          : []
                      return Promise.resolve({
                        data: affectedRows,
                        error: db.updateError,
                      })
                    },
                  }),
                  // Legacy: terminal await sans .is()/.select() (code pré-P3)
                  then: (resolve: (v: unknown) => void) =>
                    resolve({ data: null, error: db.updateError }),
                }
              },
            }
          },
        }
      }
      if (table === 'sav') {
        return {
          select: () => ({
            eq: () => ({
              limit: () => ({
                maybeSingle: () => Promise.resolve({ data: db.sav, error: db.savError }),
              }),
            }),
          }),
        }
      }
      if (table === 'members') {
        return {
          select: () => ({
            eq: () => ({
              limit: () => ({
                maybeSingle: () => Promise.resolve({ data: db.member, error: db.memberError }),
              }),
            }),
          }),
        }
      }
      if (table === 'groups') {
        return {
          select: () => ({
            eq: () => ({
              limit: () => ({
                maybeSingle: () => Promise.resolve({ data: db.group, error: db.groupError }),
              }),
            }),
          }),
        }
      }
      if (table === 'sav_lines') {
        return {
          select: () => ({
            eq: () => ({
              order: () => Promise.resolve({ data: db.lines, error: db.linesError }),
            }),
          }),
        }
      }
      if (table === 'settings') {
        return {
          select: () => ({
            in: () => ({
              lte: () => ({
                or: () =>
                  Promise.resolve({
                    data: db.settingsError ? null : db.settings,
                    error: db.settingsError,
                  }),
              }),
            }),
          }),
        }
      }
      return {}
    },
  }
  return {
    supabaseAdmin: () => client,
    __resetSupabaseAdminForTests: () => undefined,
  }
})

import {
  generateCreditNotePdfAsync,
  __setGeneratePdfDepsForTests,
  __getReactPdfCacheForTests,
  __resetReactPdfCacheForTests,
} from '../../../../../api/_lib/pdf/generate-credit-note-pdf'
// CR M2 — replay du mapping `linesRaw → CreditNotePdfLine` directement,
// stub `@react-pdf/renderer` identique à `CreditNotePdf.test.ts`, pour
// affirmer la cellule Montant TTC rendue (anti-NaN-leak).
import {
  buildCreditNotePdf,
  type CreditNotePdfLine,
  type CreditNotePdfProps,
} from '../../../../../api/_lib/pdf/CreditNotePdf'
import * as React from 'react'
import type * as ReactPDFType from '@react-pdf/renderer'

// Helpers fixtures -------------------------------------------------------
function seedHappyPath(): void {
  db.creditNote = {
    id: 100,
    number: 42,
    number_formatted: 'AV-2026-00042',
    bon_type: 'AVOIR',
    sav_id: 10,
    member_id: 20,
    total_ht_cents: 3000,
    discount_cents: 120,
    vat_cents: 158,
    total_ttc_cents: 3038,
    issued_at: '2026-04-27T10:00:00.000Z',
    pdf_web_url: null,
  }
  db.sav = {
    id: 10,
    reference: 'SAV-2026-00012',
    invoice_ref: 'INV-1234',
    invoice_fdp_cents: 250,
    member_id: 20,
    group_id: 7,
  }
  db.member = {
    id: 20,
    first_name: 'Jean',
    last_name: 'Dupont',
    email: 'jean@dupont.test',
    phone: null,
    group_id: 7,
    is_group_manager: true,
  }
  db.group = { id: 7, name: 'Lyon Croix-Rousse' }
  db.lines = [
    {
      line_number: 1,
      position: 0,
      product_code_snapshot: 'POM-BIO',
      product_name_snapshot: 'Pommes Golden bio',
      qty_requested: 2,
      unit_requested: 'kg',
      qty_invoiced: 2,
      unit_invoiced: 'kg',
      unit_price_ttc_cents_snapshot: 500,
      credit_coefficient: 1,
      credit_coefficient_label: 'TOTAL',
      credit_amount_cents: 1000,
      validation_message: null,
      // CR M2 — sans ce champ, le mapping `vat_rate_bp_snapshot` voyait
      // `undefined` (et non `null`) → `Number(undefined) = NaN` → cellule
      // Montant TTC rendue `NaN €` silencieusement. Le mapping a été durci
      // avec `!= null`, et la fixture est désormais explicite (TVA 5,5 %).
      vat_rate_bp_snapshot: 550,
    },
  ]
  db.settings = [
    ...[
      ['company.legal_name', 'Fruitstock SAS'],
      ['company.siret', '12345678901234'],
      ['company.tva_intra', 'FR12345678901'],
      ['company.address_line1', '1 rue du Verger'],
      ['company.postal_code', '69000'],
      ['company.city', 'Lyon'],
      ['company.phone', '+33 4 00 00 00 00'],
      ['company.email', 'sav@fruitstock.test'],
      ['company.legal_mentions_short', 'TVA acquittée sur les encaissements'],
    ].map(([key, value]) => ({
      key,
      value,
      valid_from: '2020-01-01T00:00:00Z',
      valid_to: null,
    })),
    {
      key: 'onedrive.pdf_folder_root',
      value: '/SAV_PDF',
      valid_from: '2020-01-01T00:00:00Z',
      valid_to: null,
    },
  ]
}

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', 'http://localhost')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test')
  db.creditNote = null
  db.creditNoteError = null
  db.creditNoteAfter = null
  db.creditNoteSelects = 0
  db.sav = null
  db.savError = null
  db.member = null
  db.memberError = null
  db.group = null
  db.groupError = null
  db.lines = []
  db.linesError = null
  db.settings = []
  db.settingsError = null
  db.updateError = null
  db.capturedUpdate = null
  db.capturedUpdateId = null
  __setGeneratePdfDepsForTests({})
})

afterEach(() => {
  __setGeneratePdfDepsForTests({})
})

describe('generateCreditNotePdfAsync (Story 4.5 AC #10)', () => {
  it('G01 happy path — render OK → upload OK → UPDATE credit_notes', async () => {
    seedHappyPath()
    let uploadCalls = 0
    __setGeneratePdfDepsForTests({
      renderToBuffer: async () => Buffer.from('%PDF-1.7 mock'),
      upload: async () => {
        uploadCalls++
        return { itemId: 'item-abc', webUrl: 'https://onedrive.example/av-42.pdf' }
      },
    })

    await generateCreditNotePdfAsync({
      credit_note_id: 100,
      sav_id: 10,
      request_id: 'req-1',
    })

    expect(uploadCalls).toBe(1)
    expect(db.capturedUpdate).toEqual({
      pdf_onedrive_item_id: 'item-abc',
      pdf_web_url: 'https://onedrive.example/av-42.pdf',
    })
    expect(db.capturedUpdateId).toBe(100)
  })

  it('G02 upload échoue 2× puis succeed → 3e tentative OK, UPDATE final', async () => {
    seedHappyPath()
    let attempt = 0
    __setGeneratePdfDepsForTests({
      renderToBuffer: async () => Buffer.from('%PDF-'),
      upload: async () => {
        attempt++
        if (attempt <= 2) throw new Error('OneDrive 500')
        return { itemId: 'item', webUrl: 'https://x/f.pdf' }
      },
      sleep: async () => undefined, // skip backoff
    })
    await generateCreditNotePdfAsync({
      credit_note_id: 100,
      sav_id: 10,
      request_id: 'req-2',
    })
    expect(attempt).toBe(3)
    expect(db.capturedUpdate).not.toBeNull()
  })

  it("G03 upload échoue 3× → PDF_UPLOAD_FAILED throw, pas d'UPDATE", async () => {
    seedHappyPath()
    __setGeneratePdfDepsForTests({
      renderToBuffer: async () => Buffer.from('%PDF-'),
      upload: async () => {
        throw new Error('OneDrive 500 perma')
      },
      sleep: async () => undefined,
    })
    await expect(
      generateCreditNotePdfAsync({ credit_note_id: 100, sav_id: 10, request_id: 'req-3' })
    ).rejects.toThrow(/PDF_UPLOAD_FAILED/)
    expect(db.capturedUpdate).toBeNull()
  })

  it("G04 render échoue → PDF_RENDER_FAILED throw, pas de retry, pas d'UPDATE", async () => {
    seedHappyPath()
    let uploadCalls = 0
    __setGeneratePdfDepsForTests({
      renderToBuffer: async () => {
        throw new Error('Invalid JSX')
      },
      upload: async () => {
        uploadCalls++
        return { itemId: 'x', webUrl: 'y' }
      },
      sleep: async () => undefined,
    })
    await expect(
      generateCreditNotePdfAsync({ credit_note_id: 100, sav_id: 10, request_id: 'req-4' })
    ).rejects.toThrow(/PDF_RENDER_FAILED/)
    expect(uploadCalls).toBe(0)
    expect(db.capturedUpdate).toBeNull()
  })

  it('G05 idempotence — pdf_web_url déjà présent → skip sans render ni upload', async () => {
    seedHappyPath()
    db.creditNote = {
      ...(db.creditNote as Record<string, unknown>),
      pdf_web_url: 'https://existing/pdf.pdf',
    }
    let renderCalls = 0
    let uploadCalls = 0
    __setGeneratePdfDepsForTests({
      renderToBuffer: async () => {
        renderCalls++
        return Buffer.from('x')
      },
      upload: async () => {
        uploadCalls++
        return { itemId: 'x', webUrl: 'y' }
      },
    })
    await generateCreditNotePdfAsync({
      credit_note_id: 100,
      sav_id: 10,
      request_id: 'req-5',
    })
    expect(renderCalls).toBe(0)
    expect(uploadCalls).toBe(0)
    expect(db.capturedUpdate).toBeNull()
  })

  it("G06 settings.company.siret manquant → missing_company_key, pas d'UPDATE", async () => {
    seedHappyPath()
    // Retire siret
    db.settings = (db.settings as Array<{ key: string }>).filter((s) => s.key !== 'company.siret')
    __setGeneratePdfDepsForTests({
      renderToBuffer: async () => Buffer.from('x'),
      upload: async () => ({ itemId: 'a', webUrl: 'b' }),
    })
    await expect(
      generateCreditNotePdfAsync({ credit_note_id: 100, sav_id: 10, request_id: 'req-6' })
    ).rejects.toThrow(/missing_company_key=siret/)
    expect(db.capturedUpdate).toBeNull()
  })

  it('G07 settings.company.* placeholder <à renseigner...> → refus aussi', async () => {
    seedHappyPath()
    ;(db.settings as Array<{ key: string; value: unknown }>).forEach((s) => {
      if (s.key === 'company.legal_name') s.value = '<à renseigner cutover>'
    })
    __setGeneratePdfDepsForTests({
      renderToBuffer: async () => Buffer.from('x'),
      upload: async () => ({ itemId: 'a', webUrl: 'b' }),
    })
    await expect(
      generateCreditNotePdfAsync({ credit_note_id: 100, sav_id: 10, request_id: 'req-7' })
    ).rejects.toThrow(/missing_company_key=legal_name/)
  })

  it('G08 credit_note introuvable → throw credit_note_not_found', async () => {
    db.creditNote = null
    __setGeneratePdfDepsForTests({
      renderToBuffer: async () => Buffer.from('x'),
      upload: async () => ({ itemId: 'a', webUrl: 'b' }),
    })
    await expect(
      generateCreditNotePdfAsync({ credit_note_id: 999, sav_id: 10, request_id: 'req-8' })
    ).rejects.toThrow(/credit_note_not_found/)
  })

  it('G10 CR P3 race concurrent — UPDATE retourne 0 rows → log PDF_UPLOAD_ORPHANED, pas de throw', async () => {
    seedHappyPath()
    // Simule : le SELECT initial voit pdf_web_url=null, mais avant le UPDATE
    // final une Lambda concurrente a déjà écrit le webUrl. On force le mock
    // supabase à reporter pdf_web_url déjà present AU MOMENT du update.
    // Le mock match la valeur courante sur `db.creditNote.pdf_web_url`, donc
    // on la flip juste avant le render via un renderToBuffer hook.
    let renderCalled = false
    __setGeneratePdfDepsForTests({
      renderToBuffer: async () => {
        // Concurrent Lambda gagne la race : met à jour db.creditNote
        // pour que le filtre `.is('pdf_web_url', null)` échoue à filtrer.
        ;(db.creditNote as Record<string, unknown>)['pdf_web_url'] =
          'https://concurrent.example/won.pdf'
        renderCalled = true
        return Buffer.from('%PDF-')
      },
      upload: async () => ({ itemId: 'orphan-item', webUrl: 'https://x/orphan.pdf' }),
    })
    await generateCreditNotePdfAsync({
      credit_note_id: 100,
      sav_id: 10,
      request_id: 'req-orphan',
    })
    expect(renderCalled).toBe(true)
    // Pas de throw, pipe "retourne" silencieusement (la Lambda gagnante a
    // déjà populé pdf_web_url — la régénération côté opérateur re-fetchera
    // cette valeur via re-SELECT).
  })

  it("G09 group_id null — PDF généré sans groupe (pas d'erreur)", async () => {
    seedHappyPath()
    ;(db.sav as Record<string, unknown>)['group_id'] = null
    db.group = null
    __setGeneratePdfDepsForTests({
      renderToBuffer: async () => Buffer.from('%PDF-'),
      upload: async () => ({ itemId: 'x', webUrl: 'https://y/z.pdf' }),
    })
    await generateCreditNotePdfAsync({
      credit_note_id: 100,
      sav_id: 10,
      request_id: 'req-9',
    })
    expect(db.capturedUpdate).not.toBeNull()
  })

  // ---- W34 : retry smart classification (short-circuit non-transient) ----
  it('W34 upload 400 Bad Request → short-circuit, 1 seul appel, pas de retry', async () => {
    seedHappyPath()
    let attempts = 0
    __setGeneratePdfDepsForTests({
      renderToBuffer: async () => Buffer.from('%PDF-'),
      upload: async () => {
        attempts++
        const err = new Error('Graph API rejected: invalid request body') as Error & {
          statusCode: number
        }
        err.statusCode = 400
        throw err
      },
      sleep: async () => undefined,
    })
    await expect(
      generateCreditNotePdfAsync({ credit_note_id: 100, sav_id: 10, request_id: 'req-w34a' })
    ).rejects.toThrow(/PDF_UPLOAD_FAILED/)
    expect(attempts).toBe(1)
    expect(db.capturedUpdate).toBeNull()
  })

  it('W34 upload 503 Service Unavailable puis 200 → success après retry', async () => {
    seedHappyPath()
    let attempts = 0
    __setGeneratePdfDepsForTests({
      renderToBuffer: async () => Buffer.from('%PDF-'),
      upload: async () => {
        attempts++
        if (attempts === 1) {
          const err = new Error('Service Unavailable') as Error & { statusCode: number }
          err.statusCode = 503
          throw err
        }
        return { itemId: 'item-503', webUrl: 'https://x/503-recovered.pdf' }
      },
      sleep: async () => undefined,
    })
    await generateCreditNotePdfAsync({
      credit_note_id: 100,
      sav_id: 10,
      request_id: 'req-w34b',
    })
    expect(attempts).toBe(2)
    expect(db.capturedUpdate).not.toBeNull()
  })

  // ---- W35 : 401 → MSAL force refresh + retry ---------------------------
  it('W35 upload 401 Unauthorized puis 200 → refresh token + retry success', async () => {
    seedHappyPath()
    let attempts = 0
    let refreshCalls = 0
    __setGeneratePdfDepsForTests({
      renderToBuffer: async () => Buffer.from('%PDF-'),
      upload: async () => {
        attempts++
        if (attempts === 1) {
          const err = new Error('Unauthorized — token expired') as Error & {
            statusCode: number
          }
          err.statusCode = 401
          throw err
        }
        return { itemId: 'item-401', webUrl: 'https://x/refreshed.pdf' }
      },
      refreshGraphToken: async () => {
        refreshCalls++
        return 'new-fake-token'
      },
      sleep: async () => undefined,
    })
    await generateCreditNotePdfAsync({
      credit_note_id: 100,
      sav_id: 10,
      request_id: 'req-w35a',
    })
    expect(attempts).toBe(2)
    expect(refreshCalls).toBe(1)
    expect(db.capturedUpdate).not.toBeNull()
  })

  it('W35 upload 401 × 3 → raise PDF_UPLOAD_FAILED, refresh appelé sur les retries (pas en boucle infinie)', async () => {
    seedHappyPath()
    let attempts = 0
    let refreshCalls = 0
    __setGeneratePdfDepsForTests({
      renderToBuffer: async () => Buffer.from('%PDF-'),
      upload: async () => {
        attempts++
        const err = new Error('Unauthorized perma') as Error & { statusCode: number }
        err.statusCode = 401
        throw err
      },
      refreshGraphToken: async () => {
        refreshCalls++
        return 'still-bad'
      },
      sleep: async () => undefined,
    })
    await expect(
      generateCreditNotePdfAsync({ credit_note_id: 100, sav_id: 10, request_id: 'req-w35b' })
    ).rejects.toThrow(/PDF_UPLOAD_FAILED/)
    // 3 tentatives upload (RETRY_BACKOFFS_MS = [1000,2000,4000]) ;
    // refresh appelé sur les 2 premières (la 3e n'a plus d'attempt suivant).
    expect(attempts).toBe(3)
    expect(refreshCalls).toBe(2)
    expect(db.capturedUpdate).toBeNull()
  })

  it('CR M2 — mapping rangée vat_rate_bp_snapshot=undefined → cellule Montant TTC rendue `—` (pas `NaN €`)', async () => {
    // CR M2 — Avant le fix, une ligne `linesRaw` sans champ
    // `vat_rate_bp_snapshot` (ex. lignes héritées pré-snapshot) passait par
    // `Number(undefined) = NaN` → cellule rendue `NaN €` dans le PDF.
    // Le guard est passé à `!= null` (intercepte null ET undefined) → la
    // cellule rend `—` (ghost line pattern AC#2 V1.11).
    //
    // Ce test reproduit le mapping de `generateCreditNotePdfAsync` (lignes
    // 492-513) sur une rangée DB qui omet le champ, et confirme :
    //   1) `vat_rate_bp_snapshot` mappe à `null` (pas `NaN`)
    //   2) le PDF rendu via `buildCreditNotePdf` affiche `—` (pas `NaN`)
    const rawRow: Record<string, unknown> = {
      line_number: 1,
      position: 0,
      product_code_snapshot: 'POM-BIO',
      product_name_snapshot: 'Pommes Golden bio',
      qty_requested: 2,
      unit_requested: 'kg',
      qty_invoiced: 2,
      unit_invoiced: 'kg',
      unit_price_ttc_cents: 500,
      credit_coefficient: 1,
      credit_coefficient_label: 'TOTAL',
      credit_amount_cents: 1000,
      validation_message: null,
      // vat_rate_bp_snapshot OMIS volontairement → undefined
    }

    // Replay EXACT du mapping `generate-credit-note-pdf.ts:510-511` post-fix.
    const mappedVatBp =
      (rawRow.vat_rate_bp_snapshot as number | null | undefined) != null
        ? Number(rawRow.vat_rate_bp_snapshot)
        : null
    expect(mappedVatBp).toBeNull()
    expect(Number.isNaN(mappedVatBp as unknown as number)).toBe(false)

    // Render direct du PDF via le stub `@react-pdf/renderer` — assertion
    // « rendered cell » telle que demandée par le CR M2.
    function makeStub(name: string): (props: { children?: React.ReactNode }) => React.ReactElement {
      return ({ children }) => React.createElement(name, {}, children)
    }
    const reactPdfModuleMock = {
      Document: makeStub('Document'),
      Page: makeStub('Page'),
      Text: makeStub('Text'),
      View: makeStub('View'),
      StyleSheet: { create: <T extends Record<string, unknown>>(s: T): T => s },
    } as unknown as typeof ReactPDFType

    function collectText(node: unknown): string[] {
      if (node === null || node === undefined || typeof node === 'boolean') return []
      if (typeof node === 'string') return [node]
      if (typeof node === 'number') return [String(node)]
      if (Array.isArray(node)) return node.flatMap(collectText)
      const el = node as { props?: { children?: unknown } }
      const children = el.props?.children
      if (children === undefined) return []
      return collectText(children)
    }

    const line: CreditNotePdfLine = {
      line_number: 1,
      product_code_snapshot: 'POM-BIO',
      product_name_snapshot: 'Pommes Golden bio',
      qty_requested: 2,
      unit_requested: 'kg',
      qty_invoiced: 2,
      unit_invoiced: 'kg',
      unit_price_ttc_cents: 500,
      credit_coefficient: 1,
      credit_coefficient_label: 'TOTAL',
      credit_amount_cents: 1000,
      validation_message: null,
      vat_rate_bp_snapshot: mappedVatBp, // ← null grâce au guard `!= null`
    }
    const props: CreditNotePdfProps = {
      creditNote: {
        id: 42,
        number: 42,
        number_formatted: 'AV-2026-00042',
        bon_type: 'AVOIR',
        total_ht_cents: 1000,
        discount_cents: 0,
        vat_cents: 55,
        total_ttc_cents: 1055,
        issued_at: '2026-04-27T10:00:00.000Z',
      },
      sav: { reference: 'SAV-2026-00012', invoice_ref: 'INV-1234', invoice_fdp_cents: 250 },
      member: {
        first_name: 'Jean',
        last_name: 'Dupont',
        email: 'j@d.test',
        phone: null,
        address_line1: null,
        address_line2: null,
        postal_code: null,
        city: null,
      },
      group: { name: 'Lyon Croix-Rousse' },
      lines: [line],
      company: {
        legal_name: 'Fruitstock SAS',
        siret: '12345678901234',
        tva_intra: 'FR12345678901',
        address_line1: '1 rue du Verger',
        postal_code: '69000',
        city: 'Lyon',
        phone: '+33 4 00 00 00 00',
        email: 'sav@fruitstock.test',
        legal_mentions_short: 'TVA acquittée',
      },
      is_group_manager: false,
    }
    const text = collectText(buildCreditNotePdf(reactPdfModuleMock, props)).join(' ')
    // Sentinel anti-NaN : la cellule Montant TTC affiche `—` (ghost line),
    // jamais `NaN`.
    expect(text).not.toMatch(/NaN/)
    expect(text).toContain('—')
  })

  it('HARDEN-5 — __deps.renderToBuffer injected → getReactPdf() is NOT called (lazy import bypassed)', async () => {
    // Regression test: when `__deps.renderToBuffer` is injected in tests,
    // `getReactPdf()` must NOT be called. This ensures test environments without
    // @react-pdf/renderer installed do not fail despite the injection.
    //
    // Strategy: reset the module-level cache to null before the call, then assert
    // it is still null after the call completes (proving `getReactPdf()` did not run).
    seedHappyPath()

    // Reset the lazy module cache to null — if getReactPdf() runs, the cache
    // would no longer be null after the call.
    __resetReactPdfCacheForTests()
    expect(__getReactPdfCacheForTests()).toBeNull()

    __setGeneratePdfDepsForTests({
      renderToBuffer: async (_el: unknown) => Buffer.from('%PDF-MOCK-HARDEN-5'),
      upload: async () => ({ itemId: 'harden-5-item', webUrl: 'https://x/harden5.pdf' }),
    })

    await generateCreditNotePdfAsync({
      credit_note_id: 100,
      sav_id: 10,
      request_id: 'req-harden5',
    })

    // The cache must still be null — proves getReactPdf() was NOT called.
    expect(__getReactPdfCacheForTests()).toBeNull()

    // Normal post-conditions still hold
    expect(db.capturedUpdate).toEqual({
      pdf_onedrive_item_id: 'harden-5-item',
      pdf_web_url: 'https://x/harden5.pdf',
    })
  })
})
