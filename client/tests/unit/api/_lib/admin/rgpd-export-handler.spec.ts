import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockReq, mockRes } from '../../_lib/test-helpers'
import {
  adminSession,
  savOperatorSession,
  ADMIN_ID,
  memberRowRgpd,
  RGPD_EXPORT_VERSION,
  type MemberRowRgpd,
} from '../../../../fixtures/admin-fixtures'

/**
 * Story 7-6 AC #1 + AC #2 + AC #5 — RED-PHASE tests pour
 * `POST /api/admin/members/:id/rgpd-export` (op `admin-rgpd-export`).
 *
 * Handler attendu :
 *   client/api/_lib/admin/rgpd-export-handler.ts
 *
 * Décisions porteuses :
 *   D-1 — HMAC-SHA256 base64url canonical-JSON, secret env
 *         `RGPD_EXPORT_HMAC_SECRET` ≥ 32 bytes. Absent → 500
 *         `RGPD_SECRET_NOT_CONFIGURED` (fail-fast).
 *   D-2 — schéma export V1.0 figé : 7 collections obligatoires (member,
 *         sav, sav_lines, sav_comments, sav_files, credit_notes, auth_events).
 *   D-4 — pas de hard cap, warn log si payload > 5 MB.
 *   D-6 — lookup member 404 anti-énumération (cohérent Story 1.5 D-1).
 *   D-7 — recordAudit handler-side `entity_type='member'` (singulier),
 *         `action='rgpd_export'`, diff inclut `collection_counts` (PAS le
 *         payload export — éviter double-stockage PII). Best-effort try/catch.
 *   D-8 — RBAC defense-in-depth ADMIN_ONLY_OPS ; sav-operator → 403.
 *
 * Réponses :
 *   200 → { export_version:'1.0', export_id, exported_at,
 *           exported_by_operator_id, member_id, data:{...}, signature:{...} }
 *   403 ROLE_NOT_ALLOWED
 *   404 MEMBER_NOT_FOUND
 *   500 RGPD_SECRET_NOT_CONFIGURED | EXPORT_FAILED
 *
 * 7 cas RED (cohérent story spec Sub-1) :
 *   1. sav-operator → 403 ROLE_NOT_ALLOWED (D-8)
 *   2. member inexistant → 404 MEMBER_NOT_FOUND (D-6)
 *   3. member valide → 200 + payload schéma D-2 (7 collections présentes)
 *   4. signature présente avec algorithm='HMAC-SHA256' + encoding='base64url'
 *   5. audit_trail row créée `entity_type='member'` `action='rgpd_export'`
 *      sans payload dans diff
 *   6. 2 exports → 2 audit rows + 2 export_id différents (idempotence non-cache)
 *   7. secret manquant → 500 RGPD_SECRET_NOT_CONFIGURED
 */

interface State {
  memberLookup: MemberRowRgpd | null
  memberLookupError: { message: string } | null
  savRows: Array<Record<string, unknown>>
  savLinesRows: Array<Record<string, unknown>>
  savCommentsRows: Array<Record<string, unknown>>
  savFilesRows: Array<Record<string, unknown>>
  creditNotesRows: Array<Record<string, unknown>>
  authEventsRows: Array<Record<string, unknown>>
  recordAuditCalls: Array<Record<string, unknown>>
  recordAuditShouldThrow: boolean
  fromTablesHistory: string[]
  /** HARDEN-2 (CR F-2) — when set, emulates a query error on a specific table. */
  selectErrorOn: string | null
}

const state = vi.hoisted(
  () =>
    ({
      memberLookup: null,
      memberLookupError: null,
      savRows: [],
      savLinesRows: [],
      savCommentsRows: [],
      savFilesRows: [],
      creditNotesRows: [],
      authEventsRows: [],
      recordAuditCalls: [],
      recordAuditShouldThrow: false,
      fromTablesHistory: [],
      selectErrorOn: null,
    }) as State
)

vi.mock('../../../../../api/_lib/clients/supabase-admin', () => {
  /**
   * Member lookup builder : `.select('*').eq('id', :id).maybeSingle()`.
   */
  function buildMembersBuilder(): unknown {
    const out: Record<string, unknown> = {
      select: () => out,
      eq: (_col: string, _val: unknown) => out,
      maybeSingle: () =>
        Promise.resolve({
          data: state.memberLookupError ? null : state.memberLookup,
          error: state.memberLookupError,
        }),
    }
    return out
  }

  /**
   * Generic SELECT-by-member-id builder : `.select(...).eq(...)` terminal
   * sur Promise. Le handler peut aussi utiliser `.in('sav_id', [...])`
   * pour les jointures sav_lines/sav_files/sav_comments.
   *
   * HARDEN-2 (CR F-2) — quand `state.selectErrorOn === table` la builder
   * retourne `{ data: null, error: { message: 'transient' } }` pour valider
   * le défensive query error checking côté handler.
   */
  function buildGenericRowsBuilder(
    table: string,
    rowsRef: () => Array<Record<string, unknown>>
  ): unknown {
    const result = (): {
      data: Array<Record<string, unknown>> | null
      error: { message: string } | null
    } => {
      if (state.selectErrorOn === table) {
        return { data: null, error: { message: 'simulated transient' } }
      }
      return { data: rowsRef(), error: null }
    }
    const out: Record<string, unknown> = {
      select: () => out,
      eq: () => Promise.resolve(result()),
      in: () => Promise.resolve(result()),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve),
    }
    return out
  }

  return {
    supabaseAdmin: () => ({
      from: (table: string) => {
        state.fromTablesHistory.push(table)
        if (table === 'members') return buildMembersBuilder()
        if (table === 'sav') return buildGenericRowsBuilder('sav', () => state.savRows)
        if (table === 'sav_lines')
          return buildGenericRowsBuilder('sav_lines', () => state.savLinesRows)
        if (table === 'sav_comments')
          return buildGenericRowsBuilder('sav_comments', () => state.savCommentsRows)
        if (table === 'sav_files')
          return buildGenericRowsBuilder('sav_files', () => state.savFilesRows)
        if (table === 'credit_notes')
          return buildGenericRowsBuilder('credit_notes', () => state.creditNotesRows)
        if (table === 'auth_events')
          return buildGenericRowsBuilder('auth_events', () => state.authEventsRows)
        throw new Error(`Unmocked table: ${table}`)
      },
      rpc: () => Promise.resolve({ data: null, error: null }),
    }),
    __resetSupabaseAdminForTests: () => undefined,
  }
})

vi.mock('../../../../../api/_lib/audit/record', () => ({
  recordAudit: (input: Record<string, unknown>) => {
    state.recordAuditCalls.push(input)
    if (state.recordAuditShouldThrow) {
      return Promise.reject(new Error('audit_trail down'))
    }
    return Promise.resolve()
  },
}))

// RED — module n'existe pas encore. L'import échoue tant que Step 3 GREEN
// ne livre pas `client/api/_lib/admin/rgpd-export-handler.ts`.
import { adminRgpdExportHandler } from '../../../../../api/_lib/admin/rgpd-export-handler'

beforeEach(() => {
  state.memberLookup = null
  state.memberLookupError = null
  state.savRows = []
  state.savLinesRows = []
  state.savCommentsRows = []
  state.savFilesRows = []
  state.creditNotesRows = []
  state.authEventsRows = []
  state.recordAuditCalls = []
  state.recordAuditShouldThrow = false
  state.fromTablesHistory = []
  state.selectErrorOn = null
  // D-1 — secret par défaut valide ≥ 32 bytes (override per-it pour test 500).
  vi.stubEnv('RGPD_EXPORT_HMAC_SECRET', 'A'.repeat(48))
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('POST /api/admin/members/:id/rgpd-export (admin-rgpd-export)', () => {
  it('AC #1 D-8 : sav-operator → 403 ROLE_NOT_ALLOWED (defense-in-depth handler-side)', async () => {
    const req = mockReq({ method: 'POST', query: { id: '123' } })
    req.user = savOperatorSession()
    const res = mockRes()
    await adminRgpdExportHandler(req, res)
    expect(res.statusCode).toBe(403)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('ROLE_NOT_ALLOWED')
    // Aucun SELECT exécuté avant l'auth gate.
    expect(state.fromTablesHistory).toHaveLength(0)
    expect(state.recordAuditCalls).toHaveLength(0)
  })

  it('AC #1 D-6 : member inexistant → 404 MEMBER_NOT_FOUND (anti-énumération cohérent 1.5)', async () => {
    state.memberLookup = null // member 999999 inexistant
    const req = mockReq({ method: 'POST', query: { id: '999999' } })
    req.user = adminSession()
    const res = mockRes()
    await adminRgpdExportHandler(req, res)
    expect(res.statusCode).toBe(404)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('MEMBER_NOT_FOUND')
    // Aucune audit row créée pour un membre fantôme.
    expect(state.recordAuditCalls).toHaveLength(0)
  })

  it('AC #1 D-2 : member valide → 200 + payload schéma D-2 (7 collections présentes)', async () => {
    state.memberLookup = memberRowRgpd({ id: 123 })
    state.savRows = [
      { id: 1, member_id: 123, reference: 'SAV-2026-0001', status: 'closed' },
      { id: 2, member_id: 123, reference: 'SAV-2026-0002', status: 'open' },
    ]
    state.savLinesRows = [
      { id: 1001, sav_id: 1, product_code: 'TOM-RAP-1' },
      { id: 1002, sav_id: 2, product_code: 'TOM-RAP-2' },
    ]
    state.savCommentsRows = [
      { id: 2001, sav_id: 1, internal: true, body: 'note ops' }, // D-2 internal=true INCLUS
    ]
    state.savFilesRows = [
      {
        id: 3001,
        sav_id: 1,
        original_filename: 'Bon_DURAND.pdf',
        web_url: 'https://fruitstock.sharepoint.com/file/3001', // D-5
      },
    ]
    state.creditNotesRows = [{ id: 4001, member_id: 123, number: 'AV-2026-0001' }]
    state.authEventsRows = [{ id: 5001, member_id: 123, event: 'login', email_hash: 'hash' }]

    const req = mockReq({ method: 'POST', query: { id: '123' } })
    req.user = adminSession()
    const res = mockRes()
    await adminRgpdExportHandler(req, res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as Record<string, unknown>

    // Enveloppe top-level
    expect(body['export_version']).toBe(RGPD_EXPORT_VERSION)
    expect(typeof body['export_id']).toBe('string')
    expect(String(body['export_id'])).toMatch(/^rgpd-/)
    expect(typeof body['exported_at']).toBe('string')
    expect(body['exported_by_operator_id']).toBe(ADMIN_ID)
    expect(body['member_id']).toBe(123)

    // Les 7 collections D-2.
    const data = body['data'] as Record<string, unknown>
    expect(data).toBeDefined()
    expect(data['member']).toBeDefined()
    expect((data['member'] as { id: number }).id).toBe(123)
    expect(Array.isArray(data['sav'])).toBe(true)
    expect((data['sav'] as unknown[]).length).toBe(2)
    expect(Array.isArray(data['sav_lines'])).toBe(true)
    expect(Array.isArray(data['sav_comments'])).toBe(true)
    // D-2 : commentaires internes INCLUS
    expect(
      (data['sav_comments'] as Array<{ internal: boolean }>).some((c) => c.internal === true)
    ).toBe(true)
    expect(Array.isArray(data['sav_files'])).toBe(true)
    // D-5 : sav_files.web_url INCLUS
    expect((data['sav_files'] as Array<{ web_url: string }>)[0]?.web_url).toContain(
      'sharepoint.com'
    )
    expect(Array.isArray(data['credit_notes'])).toBe(true)
    expect(Array.isArray(data['auth_events'])).toBe(true)
  })

  it('AC #1 D-1 : payload contient signature avec algorithm=HMAC-SHA256 + encoding=base64url', async () => {
    state.memberLookup = memberRowRgpd({ id: 123 })

    const req = mockReq({ method: 'POST', query: { id: '123' } })
    req.user = adminSession()
    const res = mockRes()
    await adminRgpdExportHandler(req, res)
    expect(res.statusCode).toBe(200)

    const body = res.jsonBody as {
      signature?: { algorithm: string; encoding: string; value: string }
    }
    expect(body.signature).toBeDefined()
    expect(body.signature?.algorithm).toBe('HMAC-SHA256')
    expect(body.signature?.encoding).toBe('base64url')
    expect(typeof body.signature?.value).toBe('string')
    // base64url : pas de `+`, `/`, `=`.
    expect(body.signature?.value).not.toMatch(/[+/=]/)
    // HMAC-SHA256 32 bytes → 43 chars base64url (sans padding).
    expect((body.signature?.value ?? '').length).toBeGreaterThanOrEqual(40)
  })

  it('AC #1 D-7 : audit_trail row créée entity_type=member action=rgpd_export, diff sans payload', async () => {
    state.memberLookup = memberRowRgpd({ id: 123 })
    state.savRows = [
      { id: 1, member_id: 123 },
      { id: 2, member_id: 123 },
    ]
    state.savLinesRows = [
      { id: 1001, sav_id: 1 },
      { id: 1002, sav_id: 2 },
    ]

    const req = mockReq({ method: 'POST', query: { id: '123' } })
    req.user = adminSession()
    const res = mockRes()
    await adminRgpdExportHandler(req, res)
    expect(res.statusCode).toBe(200)

    expect(state.recordAuditCalls).toHaveLength(1)
    const audit = state.recordAuditCalls[0] as {
      entityType: string
      entityId: number
      action: string
      actorOperatorId: number
      diff: Record<string, unknown>
      notes?: string
    }
    // D-7 : entity_type='member' singulier (handler-side), action='rgpd_export'.
    expect(audit.entityType).toBe('member')
    expect(audit.entityId).toBe(123)
    expect(audit.action).toBe('rgpd_export')
    expect(audit.actorOperatorId).toBe(ADMIN_ID)
    // diff doit contenir collection_counts mais PAS le payload export.
    expect(audit.diff).toBeDefined()
    expect(audit.diff['collection_counts']).toBeDefined()
    const counts = audit.diff['collection_counts'] as Record<string, number>
    expect(counts['sav']).toBe(2)
    expect(counts['sav_lines']).toBe(2)
    // PAS de champ `data` / `payload` (anti-double-leak).
    expect(audit.diff['data']).toBeUndefined()
    expect(audit.diff['payload']).toBeUndefined()
  })

  it('AC #2 idempotence : 2 exports successifs → 2 audit rows + 2 export_id différents', async () => {
    state.memberLookup = memberRowRgpd({ id: 123 })

    // Export #1
    let req = mockReq({ method: 'POST', query: { id: '123' } })
    req.user = adminSession()
    let res = mockRes()
    await adminRgpdExportHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body1 = res.jsonBody as { export_id: string; exported_at: string }

    // Export #2 (même membre, immédiatement)
    req = mockReq({ method: 'POST', query: { id: '123' } })
    req.user = adminSession()
    res = mockRes()
    await adminRgpdExportHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body2 = res.jsonBody as { export_id: string; exported_at: string }

    // export_id différents (UUID v4 tirés à chaque appel).
    expect(body1.export_id).not.toBe(body2.export_id)

    // 2 audit rows distinctes.
    expect(state.recordAuditCalls).toHaveLength(2)
  })

  it("HARDEN-2 (CR F-2) AC #1 D-2 : SELECT sav fail → 500 EXPORT_FAILED (pas d'export signé incomplet)", async () => {
    state.memberLookup = memberRowRgpd({ id: 123 })
    state.selectErrorOn = 'sav' // simule un transient/RLS sur sav

    const req = mockReq({ method: 'POST', query: { id: '123' } })
    req.user = adminSession()
    const res = mockRes()
    await adminRgpdExportHandler(req, res)
    expect(res.statusCode).toBe(500)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('EXPORT_FAILED')
    // Aucune audit row : on n'a même pas atteint l'étape recordAudit.
    expect(state.recordAuditCalls).toHaveLength(0)
  })

  it('HARDEN-4 (CR F-4) AC #5 D-4 : payload > 5MB → warn log sans payload (anti-leak)', async () => {
    state.memberLookup = memberRowRgpd({ id: 123 })
    // Force payload > 5 MB via 1 row sav_files avec un champ binaire géant.
    state.savRows = [{ id: 1, member_id: 123 }]
    state.savFilesRows = [
      { id: 3001, sav_id: 1, web_url: 'https://x', big_field: 'X'.repeat(6 * 1024 * 1024) },
    ]
    const warnSpy = vi.spyOn(await import('../../../../../api/_lib/logger'), 'logger', 'get')
    // Spy direct sur logger.warn via remplacement de la fonction.
    const { logger } = await import('../../../../../api/_lib/logger')
    const warnCalls: Array<{ msg: string; fields: Record<string, unknown> }> = []
    const orig = logger.warn
    logger.warn = (msg: string, fields: Record<string, unknown> = {}) => {
      warnCalls.push({ msg, fields })
      return orig(msg, fields)
    }

    try {
      const req = mockReq({ method: 'POST', query: { id: '123' } })
      req.user = adminSession()
      const res = mockRes()
      await adminRgpdExportHandler(req, res)
      expect(res.statusCode).toBe(200)

      const largePayloadWarn = warnCalls.find((c) => c.msg === 'admin.rgpd_export.large_payload')
      expect(largePayloadWarn).toBeDefined()
      // D-4 anti-leak : le warn DOIT contenir payload_bytes mais PAS le payload lui-même.
      expect((largePayloadWarn!.fields['payload_bytes'] as number) > 5 * 1024 * 1024).toBe(true)
      expect(largePayloadWarn!.fields['payload']).toBeUndefined()
      expect(largePayloadWarn!.fields['data']).toBeUndefined()
      expect(largePayloadWarn!.fields['big_field']).toBeUndefined()
    } finally {
      logger.warn = orig
      warnSpy.mockRestore()
    }
  })

  it('AC #1 D-1 : RGPD_EXPORT_HMAC_SECRET absent → 500 RGPD_SECRET_NOT_CONFIGURED (fail-fast)', async () => {
    // Override : retire le secret pour ce test (per-it via vi.stubEnv('', undefined)).
    vi.stubEnv('RGPD_EXPORT_HMAC_SECRET', '')

    state.memberLookup = memberRowRgpd({ id: 123 })
    const req = mockReq({ method: 'POST', query: { id: '123' } })
    req.user = adminSession()
    const res = mockRes()
    await adminRgpdExportHandler(req, res)
    expect(res.statusCode).toBe(500)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('RGPD_SECRET_NOT_CONFIGURED')
    // Aucune audit row créée (fail-fast avant lookup OU avant build payload).
    expect(state.recordAuditCalls).toHaveLength(0)
  })
})
