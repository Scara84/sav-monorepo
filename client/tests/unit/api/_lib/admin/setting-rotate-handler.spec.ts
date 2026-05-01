import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockReq, mockRes } from '../../_lib/test-helpers'
import {
  adminSession,
  savOperatorSession,
  ADMIN_ID,
  settingRotateBody,
} from '../../../../fixtures/admin-fixtures'

/**
 * Story 7-4 AC #2 + AC #5 — RED-PHASE tests pour
 * `PATCH /api/admin/settings/:key` (op `admin-setting-rotate`).
 *
 * Handler attendu :
 *   client/api/_lib/admin/setting-rotate-handler.ts
 *
 * Décisions :
 *   D-1 : `key` est validée par Zod `z.enum([...8 keys])`. Hors whitelist →
 *         422 KEY_NOT_WHITELISTED **avant** toute lecture/écriture DB.
 *   D-2 : atomicité INSERT-only via le trigger DB
 *         `trg_settings_close_previous` (W22) + UNIQUE INDEX
 *         `settings_one_active_per_key` (W37). Le handler fait UN SEUL
 *         INSERT — pas de UPDATE manuel ni RPC custom.
 *         23505 (UNIQUE violation race admin concurrent) → 409 CONCURRENT_PATCH.
 *   D-3 : `value` shape validée par Zod par-clé via map
 *         `settingValueSchemaByKey` (`bp` int 0..10000 / threshold object /
 *         maintenance object / company.* string raw).
 *   D-4 : `valid_from` ISO 8601 timestamptz, **dans le futur ≥ now() - 5min**
 *         (tolérance drift horloge). Cap supérieur +1 an. 422 INVALID_VALID_FROM.
 *   D-7 : double-write audit. Trigger PG `trg_audit_settings` écrit auto +
 *         handler appelle `recordAudit({entityType:'setting', action:'rotated'})`
 *         best-effort try/catch.
 *   GUC : `set_config('app.actor_operator_id', sub, true)` posé dans la
 *         même transaction que l'INSERT pour que le trigger PG capture
 *         l'acteur (CR patch D4 Story 5.5). Mock vérifie le call rpc()
 *         OU la chain set_config preceding insert.
 *
 * Réponses :
 *   200 → { data: { id, key, value, valid_from, valid_to=null, updated_by, notes, created_at } }
 *   400 INVALID_BODY (Zod value shape KO)
 *   403 ROLE_NOT_ALLOWED
 *   409 CONCURRENT_PATCH (23505 W37)
 *   422 KEY_NOT_WHITELISTED | INVALID_VALID_FROM
 *   429 RATE_LIMITED (10/15min cohérent Story 5.5)
 *   500 PERSIST_FAILED | GUC_SET_FAILED
 */

interface State {
  insertCalls: Array<Record<string, unknown>>
  insertReturn: Record<string, unknown> | null
  insertError: { code?: string; message: string } | null
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>
  rateLimitAllowed: boolean
  rateLimitRetryAfter: number
  recordAuditCalls: Array<Record<string, unknown>>
  recordAuditShouldThrow: boolean
  // Hardening W-7-4-2 — SELECT prev row pour audit `diff.before`.
  prevSelectCalls: Array<{ key: string }>
  prevSelectReturn: { value: unknown; valid_from: string } | null
  prevSelectError: { message: string } | null
}

const state = vi.hoisted(
  () =>
    ({
      insertCalls: [],
      insertReturn: null,
      insertError: null,
      rpcCalls: [],
      rateLimitAllowed: true,
      rateLimitRetryAfter: 0,
      recordAuditCalls: [],
      recordAuditShouldThrow: false,
      prevSelectCalls: [],
      prevSelectReturn: null,
      prevSelectError: null,
    }) as State
)

vi.mock('../../../../../api/_lib/clients/supabase-admin', () => {
  function buildSettingsBuilder(): unknown {
    const out: Record<string, unknown> = {
      // Hardening W-7-4-2 — chain `.select().eq().is().maybeSingle()` pour
      // SELECT prev row (audit `diff.before`).
      select: (_columns: string) => {
        let capturedKey: string | null = null
        const chain = {
          eq: (_col: string, val: string) => {
            capturedKey = val
            return chain
          },
          is: (_col: string, _val: null) => chain,
          maybeSingle: () => {
            state.prevSelectCalls.push({ key: capturedKey ?? '' })
            return Promise.resolve({
              data: state.prevSelectError ? null : state.prevSelectReturn,
              error: state.prevSelectError,
            })
          },
        }
        return chain
      },
      insert: (payload: Record<string, unknown>) => {
        state.insertCalls.push(payload)
        return {
          select: () => ({
            single: () =>
              Promise.resolve({
                data: state.insertError ? null : (state.insertReturn ?? null),
                error: state.insertError,
              }),
          }),
        }
      },
    }
    return out
  }

  function rpc(fn: string, args: Record<string, unknown>): unknown {
    state.rpcCalls.push({ fn, args })
    if (fn === 'increment_rate_limit') {
      return Promise.resolve({
        data: [{ allowed: state.rateLimitAllowed, retry_after: state.rateLimitRetryAfter }],
        error: null,
      })
    }
    // RPC mince éventuelle (option-a OQ-1) — `set_actor_and_insert_setting`.
    if (fn === 'set_actor_and_insert_setting') {
      // Si présente, le handler peut bypass le INSERT direct ; le mock
      // l'accepte mais on continue de valider le call insert direct ci-dessus
      // (option-b est la recommandation OQ-1).
      return {
        single: () =>
          Promise.resolve({
            data: state.insertError ? null : (state.insertReturn ?? null),
            error: state.insertError,
          }),
      }
    }
    // set_config GUC — accepted no-op mock retournant data:null, error:null.
    return Promise.resolve({ data: null, error: null })
  }

  return {
    supabaseAdmin: () => ({
      from: (table: string) => {
        if (table === 'settings') return buildSettingsBuilder()
        throw new Error(`Unmocked table: ${table}`)
      },
      rpc,
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

// RED — module n'existe pas encore.
import { adminSettingRotateHandler } from '../../../../../api/_lib/admin/setting-rotate-handler'

beforeEach(() => {
  state.insertCalls = []
  state.insertReturn = null
  state.insertError = null
  state.rpcCalls = []
  state.rateLimitAllowed = true
  state.rateLimitRetryAfter = 0
  state.recordAuditCalls = []
  state.recordAuditShouldThrow = false
  state.prevSelectCalls = []
  state.prevSelectReturn = null
  state.prevSelectError = null
})

function buildSuccessReturn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 5001,
    key: 'vat_rate_default',
    value: { bp: 600 },
    valid_from: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    valid_to: null,
    updated_by: ADMIN_ID,
    notes: null,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('PATCH /api/admin/settings/:key (admin-setting-rotate)', () => {
  it('422 KEY_NOT_WHITELISTED si key="evil_key" (D-1 strict avant DB)', async () => {
    const req = mockReq({
      method: 'PATCH',
      body: settingRotateBody({ value: { bp: 600 } }),
      query: { key: 'evil_key' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminSettingRotateHandler(req, res)
    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('KEY_NOT_WHITELISTED')
    // Aucun INSERT ni audit avant la validation.
    expect(state.insertCalls).toHaveLength(0)
    expect(state.recordAuditCalls).toHaveLength(0)
  })

  it('400 INVALID_BODY si value shape KO pour vat_rate_default (D-3 dispatch)', async () => {
    // vat_rate_default attend `{bp:int}`. Envoi d'un object {count} hors-shape.
    const req = mockReq({
      method: 'PATCH',
      body: settingRotateBody({ value: { count: 5 } }),
      query: { key: 'vat_rate_default' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminSettingRotateHandler(req, res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('INVALID_BODY')
    expect(state.insertCalls).toHaveLength(0)
  })

  it('400 INVALID_BODY si value shape KO pour maintenance_mode (D-3 boolean strict)', async () => {
    // maintenance_mode attend `{enabled:bool, message?:string}`. Envoi enabled non-bool.
    const req = mockReq({
      method: 'PATCH',
      body: settingRotateBody({ value: { enabled: 'yes' } }),
      query: { key: 'maintenance_mode' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminSettingRotateHandler(req, res)
    expect(res.statusCode).toBe(400)
    expect(state.insertCalls).toHaveLength(0)
  })

  it('400 INVALID_BODY pour company.legal_name si value est un object au lieu de string', async () => {
    // company.* attend une string raw. Envoi d'un object → 400.
    const req = mockReq({
      method: 'PATCH',
      body: settingRotateBody({ value: { name: 'Foo SAS' } }),
      query: { key: 'company.legal_name' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminSettingRotateHandler(req, res)
    expect(res.statusCode).toBe(400)
    expect(state.insertCalls).toHaveLength(0)
  })

  it('422 INVALID_VALID_FROM si valid_from rétroactif > 5min dans le passé (D-4)', async () => {
    const past = new Date(Date.now() - 10 * 60 * 1000).toISOString() // -10min
    const req = mockReq({
      method: 'PATCH',
      body: settingRotateBody({ value: { bp: 600 }, valid_from: past }),
      query: { key: 'vat_rate_default' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminSettingRotateHandler(req, res)
    expect(res.statusCode).toBe(422)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('INVALID_VALID_FROM')
    expect(state.insertCalls).toHaveLength(0)
  })

  it('422 INVALID_VALID_FROM si valid_from > 1 an dans le futur (D-4 cap)', async () => {
    const tooFar = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString() // +400j
    const req = mockReq({
      method: 'PATCH',
      body: settingRotateBody({ value: { bp: 600 }, valid_from: tooFar }),
      query: { key: 'vat_rate_default' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminSettingRotateHandler(req, res)
    expect(res.statusCode).toBe(422)
    expect(state.insertCalls).toHaveLength(0)
  })

  it('200 happy path : INSERT seul + recordAudit "rotated" avec diff before/after (D-2 + D-7)', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    state.insertReturn = buildSuccessReturn({ valid_from: future })
    // Hardening W-7-4-2 — prev active row pour `diff.before`.
    state.prevSelectReturn = {
      value: { bp: 550 },
      valid_from: '2020-01-01T00:00:00Z',
    }
    const req = mockReq({
      method: 'PATCH',
      body: settingRotateBody({
        value: { bp: 600 },
        valid_from: future,
        notes: 'Décret 2026-XXX hausse TVA 5,5%→6%',
      }),
      query: { key: 'vat_rate_default' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminSettingRotateHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: { id: number; key: string; value: { bp: number }; valid_from: string }
    }
    expect(body.data.id).toBe(5001)
    expect(body.data.value).toEqual({ bp: 600 })
    // D-2 atomicité : un seul INSERT côté handler (le trigger DB ferme prev auto).
    expect(state.insertCalls).toHaveLength(1)
    const insertPayload = state.insertCalls[0] as {
      key: string
      value: unknown
      valid_from: string
      updated_by: number
      notes: string | null
    }
    expect(insertPayload.key).toBe('vat_rate_default')
    expect(insertPayload.value).toEqual({ bp: 600 })
    expect(insertPayload.valid_from).toBe(future)
    expect(insertPayload.updated_by).toBe(ADMIN_ID)
    expect(insertPayload.notes).toBe('Décret 2026-XXX hausse TVA 5,5%→6%')
    // Hardening W-7-4-1 — pas de GUC `set_config` (no-op silencieux supprimé).
    // L'acteur est tracé exclusivement via la 2nde ligne `recordAudit` D-7.
    const calledFns = state.rpcCalls.map((c) => c.fn)
    expect(calledFns.includes('set_config')).toBe(false)
    // Hardening W-7-4-2 — SELECT prev row exécuté avant INSERT.
    expect(state.prevSelectCalls).toHaveLength(1)
    expect(state.prevSelectCalls[0]?.key).toBe('vat_rate_default')
    // D-7 double-write : recordAudit "rotated" avec diff before/after.
    expect(state.recordAuditCalls).toHaveLength(1)
    const auditCall = state.recordAuditCalls[0] as {
      entityType: string
      action: string
      actorOperatorId: number
      diff: { before: unknown; after: unknown }
    }
    expect(auditCall).toMatchObject({
      entityType: 'setting',
      action: 'rotated',
      actorOperatorId: ADMIN_ID,
    })
    expect(auditCall.diff.before).toEqual({
      value: { bp: 550 },
      valid_from: '2020-01-01T00:00:00Z',
    })
    expect(auditCall.diff.after).toMatchObject({
      key: 'vat_rate_default',
      value: { bp: 600 },
    })
  })

  it('200 happy path 1ère version (prev=null) : diff.before=null cohérent D-7', async () => {
    // Hardening W-7-4-2 — si la clé n'a aucune version active (1ère insertion),
    // SELECT maybeSingle retourne data=null. Le handler doit accepter et écrire
    // diff.before=null dans recordAudit (pas crash).
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    state.insertReturn = buildSuccessReturn({ valid_from: future })
    state.prevSelectReturn = null
    const req = mockReq({
      method: 'PATCH',
      body: settingRotateBody({ value: { bp: 600 }, valid_from: future }),
      query: { key: 'vat_rate_default' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminSettingRotateHandler(req, res)
    expect(res.statusCode).toBe(200)
    expect(state.recordAuditCalls).toHaveLength(1)
    const auditCall = state.recordAuditCalls[0] as {
      diff: { before: unknown; after: unknown }
    }
    expect(auditCall.diff.before).toBeNull()
    expect(auditCall.diff.after).toBeDefined()
  })

  it('409 CONCURRENT_PATCH si INSERT retourne 23505 (UNIQUE W37 race)', async () => {
    state.insertError = {
      code: '23505',
      message: 'duplicate key value violates unique constraint settings_one_active_per_key',
    }
    const req = mockReq({
      method: 'PATCH',
      body: settingRotateBody({ value: { bp: 600 } }),
      query: { key: 'vat_rate_default' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminSettingRotateHandler(req, res)
    expect(res.statusCode).toBe(409)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('CONCURRENT_PATCH')
  })

  it('403 ROLE_NOT_ALLOWED si role=sav-operator (defense-in-depth)', async () => {
    const req = mockReq({
      method: 'PATCH',
      body: settingRotateBody({ value: { bp: 600 } }),
      query: { key: 'vat_rate_default' },
    })
    req.user = savOperatorSession()
    const res = mockRes()
    await adminSettingRotateHandler(req, res)
    expect(res.statusCode).toBe(403)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('ROLE_NOT_ALLOWED')
    expect(state.insertCalls).toHaveLength(0)
  })

  it('200 + recordAudit best-effort try/catch : audit_trail down ne bloque pas la réponse (D-7)', async () => {
    // D-7 : si recordAudit() throw, le handler doit logger warn et renvoyer 200
    // (l'INSERT a déjà été commit, le trigger PG a déjà écrit la 1re ligne audit).
    state.insertReturn = buildSuccessReturn()
    state.recordAuditShouldThrow = true
    const req = mockReq({
      method: 'PATCH',
      body: settingRotateBody({ value: { bp: 600 } }),
      query: { key: 'vat_rate_default' },
    })
    req.user = adminSession()
    const res = mockRes()
    await adminSettingRotateHandler(req, res)
    expect(res.statusCode).toBe(200)
    expect(state.insertCalls).toHaveLength(1)
  })
})
