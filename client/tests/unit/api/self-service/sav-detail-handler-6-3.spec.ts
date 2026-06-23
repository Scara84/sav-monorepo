import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

/**
 * Story 6.3 — GREEN PHASE — `sav-detail-handler.ts` enrichi.
 * Couvre AC #1, #2, #3, #4, #5 (régression Story 6.2 préservée).
 */

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

interface SavRow {
  id: number
  reference: string
  status: string
  version: number
  member_id: number
  received_at: string
  taken_at: string | null
  validated_at: string | null
  closed_at: string | null
  cancelled_at: string | null
  total_amount_cents: number | null
  lines: Array<Record<string, unknown>> | null
  files: Array<Record<string, unknown>> | null
}

interface CommentRow {
  id: number
  body: string
  created_at: string
  visibility: string
  author_member_id: number | null
  author_operator_id: number | null
}

interface CreditNoteRow {
  number: number
  number_formatted: string
  issued_at: string
  total_ttc_cents: number
  pdf_web_url: string | null
}

const db = vi.hoisted(() => ({
  savRow: null as SavRow | null,
  savError: null as null | { message: string },
  comments: [] as CommentRow[],
  commentsError: null as null | { message: string },
  creditNote: null as CreditNoteRow | null,
  creditNoteError: null as null | { message: string },
  motifLabels: new Map<string, string>(),
}))

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  const client = {
    from: (table: string) => {
      if (table === 'sav') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: db.savRow, error: db.savError }),
              }),
            }),
          }),
        }
      }
      if (table === 'sav_comments') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => Promise.resolve({ data: db.comments, error: db.commentsError }),
              }),
            }),
          }),
        }
      }
      if (table === 'credit_notes') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: db.creditNote, error: db.creditNoteError }),
            }),
          }),
        }
      }
      if (table === 'validation_lists') {
        return {
          select: () => ({
            eq: () => ({
              in: () => {
                // CR Story 6.3 — column renamed list_key → list_code (typo fix
                // matches actual schema in migration 20260419120000).
                const data = Array.from(db.motifLabels, ([value, value_es]) => ({
                  list_code: 'motif_sav',
                  value,
                  value_es,
                }))
                return Promise.resolve({ data, error: null })
              },
            }),
          }),
        }
      }
      return {} as unknown
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  }
  return {
    supabaseAdmin: () => client,
    __resetSupabaseAdminForTests: () => undefined,
  }
})

function farFuture(): number {
  return Math.floor(Date.now() / 1000) + 3600
}
function memberToken(memberId: number): string {
  const payload: SessionUser = { sub: memberId, type: 'member', exp: farFuture() }
  return signJwt(payload, SECRET)
}

function defaultSavRow(): SavRow {
  return {
    id: 123,
    reference: 'SAV-2026-00123',
    status: 'in_progress',
    version: 2,
    member_id: 42,
    received_at: '2026-04-25T10:00:00Z',
    taken_at: '2026-04-25T11:00:00Z',
    validated_at: null,
    closed_at: null,
    cancelled_at: null,
    total_amount_cents: 12345,
    lines: [],
    files: [],
  }
}

async function importHandler() {
  return await import('../../../../api/_lib/self-service/sav-detail-handler')
}

describe('GET /api/self-service/sav/:id — sav-detail-handler ENRICHI (Story 6.3)', () => {
  beforeEach(() => {
    db.savRow = null
    db.savError = null
    db.comments = []
    db.commentsError = null
    db.creditNote = null
    db.creditNoteError = null
    db.motifLabels = new Map()
    process.env['SESSION_COOKIE_SECRET'] = SECRET
  })
  afterEach(() => {
    delete process.env['SESSION_COOKIE_SECRET']
  })

  it('AC#1 (a) réponse 200 contient les champs principaux + status timestamps', async () => {
    db.savRow = defaultSavRow()
    const { savDetailHandler } = await importHandler()
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
    })
    const res = mockRes()
    await savDetailHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: Record<string, unknown> }
    expect(body.data).toMatchObject({
      id: 123,
      reference: 'SAV-2026-00123',
      status: 'in_progress',
      version: 2,
      receivedAt: '2026-04-25T10:00:00Z',
      takenAt: '2026-04-25T11:00:00Z',
      validatedAt: null,
      closedAt: null,
      cancelledAt: null,
    })
  })

  it('AC#1 (b) réponse contient lines[], files[], comments[], creditNote (null si non émis)', async () => {
    db.savRow = defaultSavRow()
    const { savDetailHandler } = await importHandler()
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
    })
    const res = mockRes()
    await savDetailHandler(req, res)
    const body = res.jsonBody as { data: Record<string, unknown> }
    expect(body.data['lines']).toEqual([])
    expect(body.data['files']).toEqual([])
    expect(body.data['comments']).toEqual([])
    expect(body.data['creditNote']).toBeNull()
  })

  it("AC#1 (c) réponse N'expose PAS les champs PII opérateur", async () => {
    db.savRow = defaultSavRow()
    db.comments = [
      {
        id: 1,
        body: 'Ok',
        created_at: '2026-04-26T08:00:00Z',
        visibility: 'all',
        author_member_id: null,
        author_operator_id: 7,
      },
    ]
    const { savDetailHandler } = await importHandler()
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
    })
    const res = mockRes()
    await savDetailHandler(req, res)
    const serialized = JSON.stringify(res.jsonBody)
    expect(serialized).not.toContain('display_name')
    expect(serialized).not.toContain('assignee')
    expect(serialized).not.toContain('internal_notes')
    expect(serialized).not.toMatch(/operator\.email/i)
  })

  it('AC#2 lines incluent description, qty, qtyUnit, validationStatusLabel FR (motif retiré W111 — code mort, jamais persisté en DB)', async () => {
    const sav = defaultSavRow()
    sav.lines = [
      {
        id: 11,
        product_name_snapshot: 'Pomme Bio',
        product_code_snapshot: 'POM-001',
        qty_invoiced: 5,
        qty_requested: 5,
        unit_invoiced: 'kg',
        unit_requested: 'kg',
        validation_status: 'ok',
        validation_message: null,
      },
    ]
    db.savRow = sav
    const { savDetailHandler } = await importHandler()
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
    })
    const res = mockRes()
    await savDetailHandler(req, res)
    const body = res.jsonBody as { data: { lines: Array<Record<string, unknown>> } }
    expect(body.data.lines[0]).toMatchObject({
      id: 11,
      description: 'Pomme Bio',
      qty: 5,
      qtyUnit: 'kg',
      validationStatus: 'ok',
      validationStatusLabel: 'Vérifié OK',
    })
    expect(body.data.lines[0]).not.toHaveProperty('motif')
  })

  it('AC#2 lines NE rendent PAS credit_coefficient, pieceKg, totaux ligne', async () => {
    const sav = defaultSavRow()
    sav.lines = [
      {
        id: 11,
        product_name_snapshot: 'Tomate',
        product_code_snapshot: 'TOM',
        qty_invoiced: 1,
        qty_requested: 1,
        unit_invoiced: 'piece',
        unit_requested: 'piece',
        validation_status: 'warning',
        validation_message: 'En attente validation opérateur',
      },
    ]
    db.savRow = sav
    const { savDetailHandler } = await importHandler()
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
    })
    const res = mockRes()
    await savDetailHandler(req, res)
    const body = res.jsonBody as { data: { lines: Array<Record<string, unknown>> } }
    const line = body.data.lines[0]!
    expect(line).not.toHaveProperty('creditCoefficient')
    expect(line).not.toHaveProperty('credit_coefficient')
    expect(line).not.toHaveProperty('pieceKg')
    expect(line).not.toHaveProperty('creditAmountCents')
    expect(line).not.toHaveProperty('credit_amount_cents')
    expect(line.validationStatusLabel).toBe('En attente')
  })

  it('AC#3 (a) seuls les comments visibility="all" sont retournés', async () => {
    db.savRow = defaultSavRow()
    // Seuls visibility=all parviennent au handler — le filtre SQL `.eq('visibility','all')` les exclut.
    db.comments = [
      {
        id: 2,
        body: 'Visible',
        created_at: '2026-04-26T09:00:00Z',
        visibility: 'all',
        author_member_id: 42,
        author_operator_id: null,
      },
    ]
    const { savDetailHandler } = await importHandler()
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
    })
    const res = mockRes()
    await savDetailHandler(req, res)
    const body = res.jsonBody as { data: { comments: Array<Record<string, unknown>> } }
    expect(body.data.comments).toHaveLength(1)
    expect(body.data.comments[0]).toMatchObject({ id: 2, body: 'Visible' })
  })

  it('AC#3 (b) authorLabel="Vous" si comment.author_member_id === user.sub', async () => {
    db.savRow = defaultSavRow()
    db.comments = [
      {
        id: 1,
        body: 'Mon commentaire',
        created_at: '2026-04-26T08:00:00Z',
        visibility: 'all',
        author_member_id: 42,
        author_operator_id: null,
      },
    ]
    const { savDetailHandler } = await importHandler()
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
    })
    const res = mockRes()
    await savDetailHandler(req, res)
    const body = res.jsonBody as { data: { comments: Array<{ authorLabel: string }> } }
    expect(body.data.comments[0]!.authorLabel).toBe('Vous')
  })

  it('AC#3 (c) authorLabel="Membre" si author_member_id !== user.sub', async () => {
    db.savRow = defaultSavRow()
    db.comments = [
      {
        id: 1,
        body: "Commentaire d'un autre membre du groupe",
        created_at: '2026-04-26T08:00:00Z',
        visibility: 'all',
        author_member_id: 99,
        author_operator_id: null,
      },
    ]
    const { savDetailHandler } = await importHandler()
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
    })
    const res = mockRes()
    await savDetailHandler(req, res)
    const body = res.jsonBody as { data: { comments: Array<{ authorLabel: string }> } }
    expect(body.data.comments[0]!.authorLabel).toBe('Membre')
  })

  it('AC#3 (d) authorLabel="Équipe Fruitstock" si author_operator_id IS NOT NULL', async () => {
    db.savRow = defaultSavRow()
    db.comments = [
      {
        id: 1,
        body: 'Réponse opérateur',
        created_at: '2026-04-26T08:00:00Z',
        visibility: 'all',
        author_member_id: null,
        author_operator_id: 7,
      },
    ]
    const { savDetailHandler } = await importHandler()
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
    })
    const res = mockRes()
    await savDetailHandler(req, res)
    const body = res.jsonBody as { data: { comments: Array<{ authorLabel: string }> } }
    expect(body.data.comments[0]!.authorLabel).toBe('Équipe Fruitstock')
  })

  it("AC#3 (e) PRIVACY — la réponse N'expose JAMAIS author_member_id ni author_operator_id", async () => {
    db.savRow = defaultSavRow()
    db.comments = [
      {
        id: 1,
        body: 'Réponse',
        created_at: '2026-04-26T08:00:00Z',
        visibility: 'all',
        author_member_id: null,
        author_operator_id: 7,
      },
    ]
    const { savDetailHandler } = await importHandler()
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
    })
    const res = mockRes()
    await savDetailHandler(req, res)
    const body = res.jsonBody as { data: { comments: Array<Record<string, unknown>> } }
    const comment = body.data.comments[0]!
    expect(comment).not.toHaveProperty('author_member_id')
    expect(comment).not.toHaveProperty('author_operator_id')
    expect(comment).not.toHaveProperty('authorMemberId')
    expect(comment).not.toHaveProperty('authorOperatorId')
  })

  it('AC#4 (a) files contiennent { filename, mimeType, sizeBytes, oneDriveWebUrl, uploadedByMember }', async () => {
    const sav = defaultSavRow()
    sav.files = [
      {
        id: 50,
        sanitized_filename: 'photo.jpg',
        original_filename: 'photo.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 12345,
        web_url: 'https://example.sharepoint.com/photo',
        uploaded_by_member_id: 42,
        uploaded_by_operator_id: null,
      },
    ]
    db.savRow = sav
    const { savDetailHandler } = await importHandler()
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
    })
    const res = mockRes()
    await savDetailHandler(req, res)
    const body = res.jsonBody as { data: { files: Array<Record<string, unknown>> } }
    expect(body.data.files[0]).toMatchObject({
      id: 50,
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 12345,
      oneDriveWebUrl: 'https://example.sharepoint.com/photo',
      uploadedByMember: true,
    })
  })

  it("AC#4 (b) files N'exposent PAS oneDriveItemId (champ interne)", async () => {
    const sav = defaultSavRow()
    sav.files = [
      {
        id: 50,
        sanitized_filename: 'photo.jpg',
        original_filename: 'photo.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 12345,
        web_url: 'https://example.sharepoint.com/photo',
        uploaded_by_member_id: 42,
        uploaded_by_operator_id: null,
        // si la query SELECT le ramenait par accident, il devrait quand même être absent de la projection
      },
    ]
    db.savRow = sav
    const { savDetailHandler } = await importHandler()
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
    })
    const res = mockRes()
    await savDetailHandler(req, res)
    const body = res.jsonBody as { data: { files: Array<Record<string, unknown>> } }
    expect(body.data.files[0]).not.toHaveProperty('oneDriveItemId')
    expect(body.data.files[0]).not.toHaveProperty('onedrive_item_id')
  })

  it('AC#4 (c) uploadedByMember=true si uploaded_by_member_id IS NOT NULL', async () => {
    const sav = defaultSavRow()
    sav.files = [
      {
        id: 1,
        sanitized_filename: 'a',
        original_filename: 'a',
        mime_type: 'image/jpeg',
        size_bytes: 1,
        web_url: 'https://x.sharepoint.com/a',
        uploaded_by_member_id: 42,
        uploaded_by_operator_id: null,
      },
    ]
    db.savRow = sav
    const { savDetailHandler } = await importHandler()
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
    })
    const res = mockRes()
    await savDetailHandler(req, res)
    const body = res.jsonBody as { data: { files: Array<{ uploadedByMember: boolean }> } }
    expect(body.data.files[0]!.uploadedByMember).toBe(true)
  })

  it('AC#4 (d) uploadedByMember=false si uploaded_by_operator_id IS NOT NULL', async () => {
    const sav = defaultSavRow()
    sav.files = [
      {
        id: 1,
        sanitized_filename: 'a',
        original_filename: 'a',
        mime_type: 'image/jpeg',
        size_bytes: 1,
        web_url: 'https://x.sharepoint.com/a',
        uploaded_by_member_id: null,
        uploaded_by_operator_id: 7,
      },
    ]
    db.savRow = sav
    const { savDetailHandler } = await importHandler()
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
    })
    const res = mockRes()
    await savDetailHandler(req, res)
    const body = res.jsonBody as { data: { files: Array<{ uploadedByMember: boolean }> } }
    expect(body.data.files[0]!.uploadedByMember).toBe(false)
  })

  it('AC#1 creditNote présent si avoir émis (number, issuedAt, totalTtcCents, hasPdf)', async () => {
    db.savRow = defaultSavRow()
    db.creditNote = {
      number: 42,
      number_formatted: 'AV-2026-00042',
      issued_at: '2026-04-26T15:00:00Z',
      total_ttc_cents: 9900,
      pdf_web_url: 'https://example.sharepoint.com/avoir',
    }
    const { savDetailHandler } = await importHandler()
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
    })
    const res = mockRes()
    await savDetailHandler(req, res)
    const body = res.jsonBody as { data: { creditNote: Record<string, unknown> } }
    expect(body.data.creditNote).toMatchObject({
      number: 'AV-2026-00042',
      issuedAt: '2026-04-26T15:00:00Z',
      totalTtcCents: 9900,
      hasPdf: true,
    })
  })

  it("AC#1 creditNote=null si pas d'avoir", async () => {
    db.savRow = defaultSavRow()
    db.creditNote = null
    const { savDetailHandler } = await importHandler()
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
    })
    const res = mockRes()
    await savDetailHandler(req, res)
    const body = res.jsonBody as { data: { creditNote: unknown } }
    expect(body.data.creditNote).toBeNull()
  })

  it('AC#5 (régression) sav alien → 404 NOT_FOUND', async () => {
    db.savRow = null // .eq('member_id', 42).eq('id',...) ne trouve pas
    const { savDetailHandler } = await importHandler()
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
      query: { id: '999' },
    })
    const res = mockRes()
    await savDetailHandler(req, res)
    expect(res.statusCode).toBe(404)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('error supabase sur la query SAV → 500 SERVER_ERROR', async () => {
    db.savError = { message: 'connection refused' }
    const { savDetailHandler } = await importHandler()
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
      query: { id: '123' },
    })
    const res = mockRes()
    await savDetailHandler(req, res)
    expect(res.statusCode).toBe(500)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('SERVER_ERROR')
  })
})
