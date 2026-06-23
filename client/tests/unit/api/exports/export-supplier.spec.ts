import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

const state = vi.hoisted(() => ({
  settingsRows: [
    {
      key: 'onedrive.exports_folder_root',
      value: '/Sav/Exports',
      valid_from: '2020-01-01T00:00:00Z',
      valid_to: null,
    },
  ] as Array<{ key: string; value: unknown; valid_from: string; valid_to: string | null }>,
  settingsError: null as null | { message: string },
  insertRow: {
    id: 42,
    supplier_code: 'RUFINO',
    file_name: 'RUFINO_2026-01-01_2026-01-31.xlsx',
    line_count: 120,
    total_amount_cents: '1250000',
    web_url: 'https://onedrive.live.com/file/abc',
    created_at: '2026-04-24T12:00:00.000Z',
  } as Record<string, unknown>,
  insertError: null as null | { message: string },
  lastInsertPayload: null as Record<string, unknown> | null,
  buildResult: null as null | {
    buffer: Buffer
    file_name: string
    line_count: number
    total_amount_cents: bigint
  },
  buildError: null as null | Error,
  uploadResult: null as null | { itemId: string; webUrl: string },
  uploadError: null as null | Error,
  rateLimitAllowed: true,
}))

vi.mock('../../../../api/_lib/exports/supplierExportBuilder', async () => {
  return {
    buildSupplierExport: async (_args: unknown) => {
      if (state.buildError) throw state.buildError
      if (state.buildResult === null) {
        return {
          buffer: Buffer.from('xlsx'),
          file_name: 'RUFINO_2026-01-01_2026-01-31.xlsx',
          line_count: 120,
          total_amount_cents: 1250000n,
        }
      }
      return state.buildResult
    },
    MAX_ROWS_PER_EXPORT: 50000,
  }
})

const uploadCallCount = vi.hoisted(() => ({ value: 0 }))

vi.mock('../../../../api/_lib/exports/upload-export', () => ({
  uploadExportXlsx: async (_buffer: Buffer, _filename: string, _opts: unknown) => {
    uploadCallCount.value++
    if (state.uploadError) throw state.uploadError
    return (
      state.uploadResult ?? { itemId: 'od-item-1', webUrl: 'https://onedrive.live.com/file/abc' }
    )
  },
}))

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  const client = {
    from: (table: string) => {
      if (table === 'settings') {
        return {
          select: () => ({
            eq: () => ({
              lte: () => ({
                or: () => Promise.resolve({ data: state.settingsRows, error: state.settingsError }),
              }),
            }),
          }),
        }
      }
      if (table === 'supplier_exports') {
        return {
          insert: (row: Record<string, unknown>) => {
            state.lastInsertPayload = row
            return {
              select: () => ({
                single: () =>
                  Promise.resolve({
                    data: state.insertError ? null : state.insertRow,
                    error: state.insertError,
                  }),
              }),
            }
          },
        }
      }
      return {}
    },
    rpc: (fn: string) => {
      if (fn === 'increment_rate_limit') {
        return Promise.resolve({
          data: [{ allowed: state.rateLimitAllowed, retry_after: 60 }],
          error: null,
        })
      }
      return Promise.resolve({ data: null, error: null })
    },
  }
  return { supabaseAdmin: () => client, __resetSupabaseAdminForTests: () => undefined }
})

import { exportSupplierHandler } from '../../../../api/_lib/exports/export-supplier-handler'

function farFuture(): number {
  return Math.floor(Date.now() / 1000) + 3600
}

function operatorReq(body: unknown, opId = 7): ReturnType<typeof mockReq> {
  const payload: SessionUser = { sub: opId, type: 'operator', role: 'admin', exp: farFuture() }
  const token = signJwt(payload, SECRET)
  return mockReq({ method: 'POST', cookies: { sav_session: token }, body })
}

function memberReq(body: unknown): ReturnType<typeof mockReq> {
  const payload: SessionUser = { sub: 99, type: 'member', exp: farFuture() }
  const token = signJwt(payload, SECRET)
  return mockReq({ method: 'POST', cookies: { sav_session: token }, body })
}

describe('POST /api/exports/supplier — export-supplier-handler', () => {
  beforeEach(() => {
    state.settingsRows = [
      {
        key: 'onedrive.exports_folder_root',
        value: '/Sav/Exports',
        valid_from: '2020-01-01T00:00:00Z',
        valid_to: null,
      },
    ]
    state.settingsError = null
    state.insertRow = {
      id: 42,
      supplier_code: 'RUFINO',
      file_name: 'RUFINO_2026-01-01_2026-01-31.xlsx',
      line_count: 120,
      total_amount_cents: '1250000',
      web_url: 'https://onedrive.live.com/file/abc',
      created_at: '2026-04-24T12:00:00.000Z',
    }
    state.insertError = null
    state.lastInsertPayload = null
    state.buildResult = null
    state.buildError = null
    state.uploadResult = null
    state.uploadError = null
    state.rateLimitAllowed = true
    uploadCallCount.value = 0
    process.env['SESSION_COOKIE_SECRET'] = SECRET
  })
  afterEach(() => {
    delete process.env['SESSION_COOKIE_SECRET']
  })

  it('201 happy path : body valide RUFINO → insert + payload attendu', async () => {
    const res = mockRes()
    await exportSupplierHandler(
      operatorReq({
        supplier: 'RUFINO',
        period_from: '2026-01-01',
        period_to: '2026-01-31',
        format: 'XLSX',
      }),
      res
    )
    expect(res.statusCode).toBe(201)
    const body = res.jsonBody as { data: { id: number; supplier_code: string; line_count: number } }
    expect(body.data.id).toBe(42)
    expect(body.data.supplier_code).toBe('RUFINO')
    expect(body.data.line_count).toBe(120)
    expect(state.lastInsertPayload?.['supplier_code']).toBe('RUFINO')
    expect(state.lastInsertPayload?.['generated_by_operator_id']).toBe(7)
  })

  it('400 INVALID_BODY si supplier manquant', async () => {
    const res = mockRes()
    await exportSupplierHandler(
      operatorReq({ period_from: '2026-01-01', period_to: '2026-01-31' }),
      res
    )
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('INVALID_BODY')
  })

  it('400 UNKNOWN_SUPPLIER si code fournisseur absent de la map', async () => {
    const res = mockRes()
    await exportSupplierHandler(
      operatorReq({
        supplier: 'FAKE',
        period_from: '2026-01-01',
        period_to: '2026-01-31',
      }),
      res
    )
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('UNKNOWN_SUPPLIER')
  })

  it('400 PERIOD_INVALID si period_to < period_from', async () => {
    const res = mockRes()
    await exportSupplierHandler(
      operatorReq({
        supplier: 'RUFINO',
        period_from: '2026-02-01',
        period_to: '2026-01-01',
      }),
      res
    )
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('PERIOD_INVALID')
  })

  it('400 PERIOD_INVALID si période > 1 an', async () => {
    const res = mockRes()
    await exportSupplierHandler(
      operatorReq({
        supplier: 'RUFINO',
        period_from: '2024-01-01',
        period_to: '2026-01-01',
      }),
      res
    )
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('PERIOD_INVALID')
  })

  it('500 EXPORTS_FOLDER_NOT_CONFIGURED si placeholder encore actif', async () => {
    state.settingsRows = [
      {
        key: 'onedrive.exports_folder_root',
        value: '/PLACEHOLDER_EXPORTS_ROOT',
        valid_from: '2020-01-01T00:00:00Z',
        valid_to: null,
      },
    ]
    const res = mockRes()
    await exportSupplierHandler(
      operatorReq({
        supplier: 'RUFINO',
        period_from: '2026-01-01',
        period_to: '2026-01-31',
      }),
      res
    )
    expect(res.statusCode).toBe(500)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('EXPORTS_FOLDER_NOT_CONFIGURED')
  })

  it('500 BUILD_FAILED si le builder throw', async () => {
    state.buildError = new Error('EXPORT_VOLUME_CAP_EXCEEDED: cap=50000')
    const res = mockRes()
    await exportSupplierHandler(
      operatorReq({
        supplier: 'RUFINO',
        period_from: '2026-01-01',
        period_to: '2026-01-31',
      }),
      res
    )
    expect(res.statusCode).toBe(500)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('BUILD_FAILED')
  })

  it('502 ONEDRIVE_UPLOAD_FAILED si upload OneDrive throw', async () => {
    state.uploadError = new Error('Graph 503')
    const res = mockRes()
    await exportSupplierHandler(
      operatorReq({
        supplier: 'RUFINO',
        period_from: '2026-01-01',
        period_to: '2026-01-31',
      }),
      res
    )
    expect(res.statusCode).toBe(502)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('ONEDRIVE_UPLOAD_FAILED')
  })

  it('500 PERSIST_FAILED + log orphan si INSERT DB échoue', async () => {
    state.insertError = { message: 'unique violation' }
    const res = mockRes()
    await exportSupplierHandler(
      operatorReq({
        supplier: 'RUFINO',
        period_from: '2026-01-01',
        period_to: '2026-01-31',
      }),
      res
    )
    expect(res.statusCode).toBe(500)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('PERSIST_FAILED')
  })

  it('429 RATE_LIMITED si bucket overflow', async () => {
    state.rateLimitAllowed = false
    const res = mockRes()
    await exportSupplierHandler(
      operatorReq({
        supplier: 'RUFINO',
        period_from: '2026-01-01',
        period_to: '2026-01-31',
      }),
      res
    )
    expect(res.statusCode).toBe(429)
  })

  it('INSERT generated_by_operator_id reflète bien le sub du token', async () => {
    const res = mockRes()
    await exportSupplierHandler(
      operatorReq(
        {
          supplier: 'RUFINO',
          period_from: '2026-01-01',
          period_to: '2026-01-31',
        },
        123
      ),
      res
    )
    expect(res.statusCode).toBe(201)
    expect(state.lastInsertPayload?.['generated_by_operator_id']).toBe(123)
  })

  it('403 FORBIDDEN si session member (pas operator)', async () => {
    const res = mockRes()
    await exportSupplierHandler(
      memberReq({
        supplier: 'RUFINO',
        period_from: '2026-01-01',
        period_to: '2026-01-31',
      }),
      res
    )
    expect(res.statusCode).toBe(403)
  })

  it('uppercase le code supplier soumis en minuscules (rufino → RUFINO)', async () => {
    const res = mockRes()
    await exportSupplierHandler(
      operatorReq({
        supplier: 'rufino',
        period_from: '2026-01-01',
        period_to: '2026-01-31',
      }),
      res
    )
    expect(res.statusCode).toBe(201)
    expect(state.lastInsertPayload?.['supplier_code']).toBe('RUFINO')
  })

  it('rejette 400 INVALID_BODY si body est un array', async () => {
    const res = mockRes()
    await exportSupplierHandler(operatorReq([] as unknown), res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('INVALID_BODY')
  })

  // ---------------- CR 5.2 patches -----------------------------------------

  it('CR P4 — 400 PERIOD_INVALID si period_from contient un fuseau horaire (doit être YYYY-MM-DD)', async () => {
    const res = mockRes()
    await exportSupplierHandler(
      operatorReq({
        supplier: 'RUFINO',
        period_from: '2026-01-01T00:00:00-05:00',
        period_to: '2026-01-31',
      }),
      res
    )
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('INVALID_BODY')
  })

  it('CR P4 — 400 INVALID_BODY si period_from est une année seule ("2026")', async () => {
    const res = mockRes()
    await exportSupplierHandler(
      operatorReq({
        supplier: 'RUFINO',
        period_from: '2026',
        period_to: '2026-12-31',
      }),
      res
    )
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('INVALID_BODY')
  })

  it('CR P1 — rate-limit partage le bucket par operator pour les suppliers invalides', async () => {
    // Simule bucket rempli (allowed=false) pour clé
    // `export-supplier:{opId}:INVALID`. L'ancien comportement utilisait
    // chaque variante lowercased/uppercased comme bucket distinct, ici
    // les 2 suppliers invalides distincts (`bad1` / `bad2`) doivent
    // partager un même bucket `INVALID`.
    state.rateLimitAllowed = false
    const res1 = mockRes()
    await exportSupplierHandler(
      operatorReq({
        supplier: 'bad1',
        period_from: '2026-01-01',
        period_to: '2026-01-31',
      }),
      res1
    )
    expect(res1.statusCode).toBe(429)

    const res2 = mockRes()
    await exportSupplierHandler(
      operatorReq({
        supplier: 'bad2',
        period_from: '2026-01-01',
        period_to: '2026-01-31',
      }),
      res2
    )
    expect(res2.statusCode).toBe(429)
  })

  it('CR P7 — 500 EXPORTS_FOLDER_NOT_CONFIGURED quand uploadExportXlsx throw CONFIG_ERROR|', async () => {
    state.uploadError = new Error('CONFIG_ERROR|MICROSOFT_DRIVE_ID manquant')
    const res = mockRes()
    await exportSupplierHandler(
      operatorReq({
        supplier: 'RUFINO',
        period_from: '2026-01-01',
        period_to: '2026-01-31',
      }),
      res
    )
    expect(res.statusCode).toBe(500)
    const body = res.jsonBody as { error: { details: { code: string } } }
    expect(body.error.details.code).toBe('EXPORTS_FOLDER_NOT_CONFIGURED')
  })

  // W47 (CR Story 5.2) — design V1 : pas de retry sur uploadExportXlsx
  // (retry manuel par l'opérateur). Une erreur transient remonte directement.
  it('W47 uploadExportXlsx ne retry pas (1 seul appel sur erreur transient)', async () => {
    state.uploadError = new Error('Graph 503')
    const res = mockRes()
    await exportSupplierHandler(
      operatorReq({
        supplier: 'RUFINO',
        period_from: '2026-01-01',
        period_to: '2026-01-31',
      }),
      res
    )
    expect(res.statusCode).toBe(502)
    expect(uploadCallCount.value).toBe(1)
  })

  // ---------------- Story 5.6 — MARTINEZ ----------------------------------

  it('Story 5.6 — 201 happy path MARTINEZ : insert supplier_code=MARTINEZ', async () => {
    state.insertRow = {
      ...state.insertRow,
      supplier_code: 'MARTINEZ',
      file_name: 'MARTINEZ_2026-02-01_2026-02-28.xlsx',
    }
    state.buildResult = {
      buffer: Buffer.from('xlsx'),
      file_name: 'MARTINEZ_2026-02-01_2026-02-28.xlsx',
      line_count: 47,
      total_amount_cents: 250000n,
    }
    const res = mockRes()
    await exportSupplierHandler(
      operatorReq({
        supplier: 'MARTINEZ',
        period_from: '2026-02-01',
        period_to: '2026-02-28',
        format: 'XLSX',
      }),
      res
    )
    expect(res.statusCode).toBe(201)
    expect(state.lastInsertPayload?.['supplier_code']).toBe('MARTINEZ')
    expect(state.lastInsertPayload?.['file_name']).toBe('MARTINEZ_2026-02-01_2026-02-28.xlsx')
  })

  it('Story 5.6 — 201 lowercased "martinez" → uppercased à MARTINEZ', async () => {
    state.insertRow = { ...state.insertRow, supplier_code: 'MARTINEZ' }
    const res = mockRes()
    await exportSupplierHandler(
      operatorReq({
        supplier: 'martinez',
        period_from: '2026-02-01',
        period_to: '2026-02-28',
      }),
      res
    )
    expect(res.statusCode).toBe(201)
    expect(state.lastInsertPayload?.['supplier_code']).toBe('MARTINEZ')
  })

  it('CR P8 — 500 si placeholder == valeur exacte `/PLACEHOLDER_EXPORTS_ROOT` seulement (pas startsWith)', async () => {
    // Un admin qui configure `/PLACEHOLDER_EXPORTS_ROOT_BIS` ne doit plus
    // être rejeté par fail-closed (le champ est considéré renseigné).
    state.settingsRows = [
      {
        key: 'onedrive.exports_folder_root',
        value: '/PLACEHOLDER_EXPORTS_ROOT_BIS',
        valid_from: '2020-01-01T00:00:00Z',
        valid_to: null,
      },
    ]
    const res = mockRes()
    await exportSupplierHandler(
      operatorReq({
        supplier: 'RUFINO',
        period_from: '2026-01-01',
        period_to: '2026-01-31',
      }),
      res
    )
    expect(res.statusCode).toBe(201)
  })
})
