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
} from '../../../../../api/_lib/pdf/generate-credit-note-pdf'

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
      unit_price_ht_cents_snapshot: 500,
      credit_coefficient: 1,
      credit_coefficient_label: 'TOTAL',
      credit_amount_cents: 1000,
      validation_message: null,
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
})
