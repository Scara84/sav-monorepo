import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { signJwt } from '../../../../api/_lib/middleware/with-auth'
import type { SessionUser } from '../../../../api/_lib/types'
import { mockReq, mockRes } from '../_lib/test-helpers'

/**
 * Story 6.4 — TDD RED PHASE — `api/_lib/self-service/preferences-handler.ts`.
 *
 * Cible AC #6, #7, #8, #9, #12 :
 *   - GET  /api/self-service/preferences (op=preferences, method=GET)
 *   - PATCH /api/self-service/preferences (op=preferences, method=PATCH)
 *
 * Le handler exporté est `preferencesHandler` (un seul handler dispatch
 * par `req.method`, pattern aligné Story 5.5 admin-settings-threshold).
 *
 * Cas (8 au total) — tous DOIVENT échouer tant que le module n'est pas créé :
 *   (a) GET retourne les prefs actuelles { status_updates, weekly_recap }
 *   (b) PATCH valide → 200 + UPDATE persisté (jsonb merge `||`)
 *   (c) PATCH partial (uniquement status_updates) — l'autre clé est préservée
 *   (d) PATCH avec un field inconnu → 400 VALIDATION_FAILED (Zod .strict())
 *   (e) PATCH non-boolean → 400 VALIDATION_FAILED
 *   (f) member anonymized (anonymized_at IS NOT NULL) → 404 ou 401 (pas de leak)
 *   (g) member non-manager peut quand même set weekly_recap=true (no error, accepté)
 *   (h) GET sans session → 401
 */

const SECRET = 'test-secret-at-least-32-bytes-longxxx'

interface MemberRow {
  id: number
  notification_prefs: { status_updates: boolean; weekly_recap: boolean }
  is_group_manager: boolean
  anonymized_at: string | null
}

interface DbState {
  memberRow: MemberRow | null
  selectError: { message: string } | null
  updateCalls: Array<Record<string, unknown>>
  updateError: { message: string } | null
  updateReturning: MemberRow | null
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>
  rpcError: { message: string } | null
  rpcReturning: { status_updates: boolean; weekly_recap: boolean } | null
}

const db = vi.hoisted<DbState>(() => ({
  memberRow: null,
  selectError: null,
  updateCalls: [],
  updateError: null,
  updateReturning: null,
  rpcCalls: [],
  rpcError: null,
  rpcReturning: null,
}))

vi.mock('../../../../api/_lib/clients/supabase-admin', () => {
  function buildSelect() {
    const out: Record<string, (...args: unknown[]) => unknown> = {}
    out['select'] = () => out
    out['eq'] = () => out
    out['is'] = () => out
    out['maybeSingle'] = () => Promise.resolve({ data: db.memberRow, error: db.selectError })
    out['single'] = () =>
      Promise.resolve({
        data: db.updateReturning ?? db.memberRow,
        error: db.updateError ?? db.selectError,
      })
    return out
  }

  function buildUpdate() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any = {}
    out['update'] = (payload: unknown) => {
      db.updateCalls.push({ payload: payload as Record<string, unknown> })
      return out
    }
    out['eq'] = (col: string, val: unknown) => {
      db.updateCalls.push({ eq: { col, val } })
      return out
    }
    out['is'] = (col: string, val: unknown) => {
      db.updateCalls.push({ is: { col, val } })
      return out
    }
    out['select'] = () => out
    out['single'] = () =>
      Promise.resolve({
        data: db.updateReturning,
        error: db.updateError,
      })
    return out
  }

  return {
    supabaseAdmin: () => ({
      from: (table: string) => {
        if (table === 'members') {
          // Une seule façade qui gère .select(...) ET .update(...). Selon le
          // premier appel, on bascule sur l'un ou l'autre.
          return new Proxy(
            {},
            {
              get(_target, prop: string) {
                if (prop === 'select') return buildSelect().select
                if (prop === 'update') return buildUpdate().update
                return undefined
              },
            }
          )
        }
        throw new Error(`Unmocked table: ${table}`)
      },
      rpc: (fn: string, args: Record<string, unknown>) => {
        db.rpcCalls.push({ fn, args })
        // Story 6.4 W104 — la RPC `member_prefs_merge` retourne le jsonb
        // post-merge directement (pas un wrapper { data, error } imbriqué).
        // On simule le merge `||` en mergeant `db.memberRow.notification_prefs`
        // avec `args.p_patch` ; sinon on retourne `db.rpcReturning` explicite
        // pour les tests qui veulent forcer un payload.
        if (fn === 'member_prefs_merge') {
          if (db.rpcError) {
            return Promise.resolve({ data: null, error: db.rpcError })
          }
          if (db.rpcReturning !== null) {
            return Promise.resolve({ data: db.rpcReturning, error: null })
          }
          if (db.memberRow !== null) {
            const patch = (args['p_patch'] ?? {}) as Record<string, unknown>
            const merged = {
              ...db.memberRow.notification_prefs,
              ...patch,
            } as { status_updates: boolean; weekly_recap: boolean }
            return Promise.resolve({ data: merged, error: null })
          }
          return Promise.resolve({ data: null, error: null })
        }
        return Promise.resolve({ data: null, error: null })
      },
    }),
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

// Vite-static-analyzer friendly: la vraie cible est résolue via une string
// dynamique pour que la collecte vitest n'échoue pas si le module n'existe
// pas encore. Chaque test échouera individuellement (RED phase) au lieu de
// faire planter toute la suite à la collecte.
const HANDLER_PATH = '../../../../api/_lib/self-service/preferences-handler'
async function importHandler(): Promise<{
  preferencesHandler: (req: unknown, res: unknown) => Promise<void>
}> {
  return (await import(/* @vite-ignore */ HANDLER_PATH)) as {
    preferencesHandler: (req: unknown, res: unknown) => Promise<void>
  }
}

beforeEach(() => {
  process.env['SESSION_COOKIE_SECRET'] = SECRET
  process.env['SUPABASE_URL'] = 'http://localhost'
  process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'test'
  db.memberRow = null
  db.selectError = null
  db.updateCalls = []
  db.updateError = null
  db.updateReturning = null
  db.rpcCalls = []
  db.rpcError = null
  db.rpcReturning = null
})

afterEach(() => {
  delete process.env['SESSION_COOKIE_SECRET']
})

describe('preferencesHandler — GET /api/self-service/preferences (Story 6.4)', () => {
  it('AC#6 (a) GET retourne notificationPrefs { status_updates, weekly_recap }', async () => {
    db.memberRow = {
      id: 42,
      notification_prefs: { status_updates: true, weekly_recap: false },
      is_group_manager: false,
      anonymized_at: null,
    }
    const { preferencesHandler } = await importHandler()
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
    })
    req.user = { sub: 42, type: 'member', exp: farFuture() }
    const res = mockRes()
    await preferencesHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: { notificationPrefs: { status_updates: boolean; weekly_recap: boolean } }
    }
    expect(body.data.notificationPrefs).toEqual({ status_updates: true, weekly_recap: false })
  })

  it('AC#6 (h) GET sans session → 401 UNAUTHENTICATED (router self-service withAuth)', async () => {
    const { preferencesHandler } = await importHandler()
    const req = mockReq({ method: 'GET', cookies: {} })
    // Pas de req.user injecté — le handler doit refuser via withAuth en amont
    // ou check interne.
    const res = mockRes()
    await preferencesHandler(req, res)
    expect(res.statusCode).toBe(401)
  })

  it('AC#6 (f) member anonymized (anonymized_at IS NOT NULL) → 404 (NOT_FOUND, anti-leak)', async () => {
    db.memberRow = null // le filtre `.is('anonymized_at', null)` exclut le member
    const { preferencesHandler } = await importHandler()
    const req = mockReq({
      method: 'GET',
      cookies: { sav_session: memberToken(42) },
    })
    req.user = { sub: 42, type: 'member', exp: farFuture() }
    const res = mockRes()
    await preferencesHandler(req, res)
    // 404 NOT_FOUND privilégié pour ne pas leaker l'existence du member ;
    // 401 acceptable aussi si le handler rejette en amont. La règle :
    // PAS de 200 avec body vide.
    expect([401, 404]).toContain(res.statusCode)
  })
})

describe('preferencesHandler — PATCH /api/self-service/preferences (Story 6.4)', () => {
  it('AC#7 (b) PATCH valide → 200 + UPDATE persisté (jsonb merge)', async () => {
    db.memberRow = {
      id: 42,
      notification_prefs: { status_updates: true, weekly_recap: false },
      is_group_manager: false,
      anonymized_at: null,
    }
    db.updateReturning = {
      ...db.memberRow,
      notification_prefs: { status_updates: false, weekly_recap: false },
    }
    const { preferencesHandler } = await importHandler()
    const req = mockReq({
      method: 'PATCH',
      cookies: { sav_session: memberToken(42) },
      body: { status_updates: false },
    })
    req.user = { sub: 42, type: 'member', exp: farFuture() }
    const res = mockRes()
    await preferencesHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: { notificationPrefs: { status_updates: boolean; weekly_recap: boolean } }
    }
    expect(body.data.notificationPrefs.status_updates).toBe(false)
    expect(body.data.notificationPrefs.weekly_recap).toBe(false)
    // Story 6.4 W104 — UPDATE atomique via RPC member_prefs_merge (SQL `||`).
    expect(db.rpcCalls).toContainEqual({
      fn: 'member_prefs_merge',
      args: { p_member_id: 42, p_patch: { status_updates: false } },
    })
  })

  it('AC#7 (c) PATCH partiel — la clé absente est préservée par le merge JSONB `||`', async () => {
    db.memberRow = {
      id: 42,
      notification_prefs: { status_updates: true, weekly_recap: true },
      is_group_manager: true,
      anonymized_at: null,
    }
    // Le mock RPC simule le merge `||` à partir de db.memberRow.notification_prefs
    // + p_patch — exactement comme la vraie RPC member_prefs_merge.
    const { preferencesHandler } = await importHandler()
    const req = mockReq({
      method: 'PATCH',
      cookies: { sav_session: memberToken(42) },
      body: { status_updates: false },
    })
    req.user = { sub: 42, type: 'member', exp: farFuture() }
    const res = mockRes()
    await preferencesHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: { notificationPrefs: { status_updates: boolean; weekly_recap: boolean } }
    }
    expect(body.data.notificationPrefs.status_updates).toBe(false)
    // Le merge SQL `||` préserve weekly_recap (pas envoyé dans le patch).
    expect(body.data.notificationPrefs.weekly_recap).toBe(true)
    // Le patch envoyé à la RPC ne contient QUE status_updates (pas d'écrasement
    // implicite de weekly_recap côté handler — c'est le rôle du `||` côté SQL).
    expect(db.rpcCalls).toContainEqual({
      fn: 'member_prefs_merge',
      args: { p_member_id: 42, p_patch: { status_updates: false } },
    })
  })

  it('AC#8 (d) PATCH avec field inconnu → 400 VALIDATION_FAILED (Zod .strict())', async () => {
    db.memberRow = {
      id: 42,
      notification_prefs: { status_updates: true, weekly_recap: false },
      is_group_manager: false,
      anonymized_at: null,
    }
    const { preferencesHandler } = await importHandler()
    const req = mockReq({
      method: 'PATCH',
      cookies: { sav_session: memberToken(42) },
      body: { status_updates: true, evil_admin_flag: true },
    })
    req.user = { sub: 42, type: 'member', exp: farFuture() }
    const res = mockRes()
    await preferencesHandler(req, res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_FAILED')
  })

  it('AC#8 (e) PATCH non-boolean → 400 VALIDATION_FAILED', async () => {
    db.memberRow = {
      id: 42,
      notification_prefs: { status_updates: true, weekly_recap: false },
      is_group_manager: false,
      anonymized_at: null,
    }
    const { preferencesHandler } = await importHandler()
    const req = mockReq({
      method: 'PATCH',
      cookies: { sav_session: memberToken(42) },
      body: { status_updates: 'yes' },
    })
    req.user = { sub: 42, type: 'member', exp: farFuture() }
    const res = mockRes()
    await preferencesHandler(req, res)
    expect(res.statusCode).toBe(400)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_FAILED')
  })

  it('AC#8 PATCH body vide → 400 VALIDATION_FAILED (refine: au moins une clé)', async () => {
    db.memberRow = {
      id: 42,
      notification_prefs: { status_updates: true, weekly_recap: false },
      is_group_manager: false,
      anonymized_at: null,
    }
    const { preferencesHandler } = await importHandler()
    const req = mockReq({
      method: 'PATCH',
      cookies: { sav_session: memberToken(42) },
      body: {},
    })
    req.user = { sub: 42, type: 'member', exp: farFuture() }
    const res = mockRes()
    await preferencesHandler(req, res)
    expect(res.statusCode).toBe(400)
  })

  it('AC#9 (g) member non-manager peut set weekly_recap=true (accepté, no error)', async () => {
    db.memberRow = {
      id: 42,
      notification_prefs: { status_updates: true, weekly_recap: false },
      is_group_manager: false, // PAS responsable
      anonymized_at: null,
    }
    db.updateReturning = {
      ...db.memberRow,
      notification_prefs: { status_updates: true, weekly_recap: true },
    }
    const { preferencesHandler } = await importHandler()
    const req = mockReq({
      method: 'PATCH',
      cookies: { sav_session: memberToken(42) },
      body: { weekly_recap: true },
    })
    req.user = { sub: 42, type: 'member', exp: farFuture() }
    const res = mockRes()
    await preferencesHandler(req, res)
    // Pas de 403 — la valeur est persistée même si le cron 6.7 l'ignorera
    // tant que is_group_manager=false (cf. Dev Notes Story 6.4).
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: { notificationPrefs: { weekly_recap: boolean } } }
    expect(body.data.notificationPrefs.weekly_recap).toBe(true)
  })
})
