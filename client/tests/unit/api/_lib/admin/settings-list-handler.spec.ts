import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockReq, mockRes } from '../../_lib/test-helpers'
import {
  adminSession,
  savOperatorSession,
  ADMIN_ID,
  SETTING_KEYS_WHITELIST,
} from '../../../../fixtures/admin-fixtures'

/**
 * Story 7-4 AC #1 + AC #5 + AC #6 — RED-PHASE tests pour
 * `GET /api/admin/settings` (op `admin-settings-list`).
 *
 * Handler attendu :
 *   client/api/_lib/admin/settings-list-handler.ts
 *
 * Contrat (D-1 + D-5 + D-7) :
 *   200 → { data: { items: SettingActiveSummary[] } }
 *     - Uniquement les 8 clés whitelist D-1 (filtrées côté handler).
 *     - Chaque item :
 *         { id, key, value, valid_from, valid_to=null, notes, created_at,
 *           updated_by: { id, email_display_short } | null,
 *           versions_count: number (>= 1, ou 0 fallback si clé absente) }
 *     - Ordering stable par `key ASC` (déterminisme).
 *   403 ROLE_NOT_ALLOWED si user.role !== 'admin' (defense-in-depth, héritage 7-3a).
 *   500 QUERY_FAILED si SELECT settings KO.
 *
 * Pattern mock : table `settings` (SELECT actives + filtre `is null` valid_to)
 * + table `operators` (LEFT JOIN PII-limited shortEmail) + table `settings`
 * (subquery pour `versions_count` GROUP BY key — implémenté via 2e SELECT
 * agrégé OU comptage inline depuis tableau full-history).
 */

interface State {
  selectActiveRows: Array<{
    id: number
    key: string
    value: unknown
    valid_from: string
    valid_to: string | null
    updated_by: number | null
    notes: string | null
    created_at: string
  }>
  selectActiveError: { message: string } | null
  selectAllForCountRows: Array<{ key: string }>
  operatorRows: Array<{ id: number; email: string }>
  fromCallsHistory: Array<{ table: string; selector: string }>
}

const state = vi.hoisted(
  () =>
    ({
      selectActiveRows: [],
      selectActiveError: null,
      selectAllForCountRows: [],
      operatorRows: [],
      fromCallsHistory: [],
    }) as State
)

vi.mock('../../../../../api/_lib/clients/supabase-admin', () => {
  /**
   * Le handler est attendu de faire 2 SELECT distincts sur `settings` :
   *   1. lignes actives (`valid_to is null`) — pour valeur courante.
   *   2. comptage versions par clé — peut être un SELECT (`key`) sans
   *      filtre is null pour count côté handler, OU un RPC custom.
   * Pour simplifier le mock (pattern Story 7-3c), on retourne la même
   * pile de rows pour les 2 SELECT et on laisse le handler agréger.
   */
  function buildSettingsBuilder(): unknown {
    const out: Record<string, unknown> = {
      select: (selector?: string) => {
        state.fromCallsHistory.push({ table: 'settings', selector: selector ?? '*' })
        return out
      },
      eq: () => out,
      is: () => out,
      in: () => out,
      order: () => out,
      // Terminal : retourne soit les rows actives soit toutes les rows pour comptage.
      // Le handler peut chain `.is('valid_to', null)` puis `.order` puis terminal.
      then: (resolve: (v: unknown) => unknown) => {
        // Heuristique mock : si fromCallsHistory.last.selector contient seulement
        // 'key' on renvoie selectAllForCountRows (subquery comptage). Sinon rows actives.
        const last = state.fromCallsHistory[state.fromCallsHistory.length - 1]
        const isCountSelector = last?.selector === 'key'
        const data = isCountSelector ? state.selectAllForCountRows : state.selectActiveRows
        const error = isCountSelector ? null : state.selectActiveError
        return Promise.resolve({ data, error }).then(resolve)
      },
    }
    return out
  }

  function buildOperatorsBuilder(): unknown {
    const out: Record<string, unknown> = {
      select: () => out,
      in: () => Promise.resolve({ data: state.operatorRows, error: null }),
    }
    return out
  }

  return {
    supabaseAdmin: () => ({
      from: (table: string) => {
        if (table === 'settings') return buildSettingsBuilder()
        if (table === 'operators') return buildOperatorsBuilder()
        throw new Error(`Unmocked table: ${table}`)
      },
    }),
    __resetSupabaseAdminForTests: () => undefined,
  }
})

// RED — module n'existe pas encore. L'import échoue tant que Step 3 GREEN-phase
// ne livre pas `client/api/_lib/admin/settings-list-handler.ts`.
import { adminSettingsListHandler } from '../../../../../api/_lib/admin/settings-list-handler'

beforeEach(() => {
  state.selectActiveRows = []
  state.selectActiveError = null
  state.selectAllForCountRows = []
  state.operatorRows = []
  state.fromCallsHistory = []
})

describe('GET /api/admin/settings (admin-settings-list)', () => {
  it('200 happy path : retourne les 8 clés whitelist actives avec versions_count', async () => {
    // Seed : 8 clés whitelist actives + 1 clé orpheline "internal_xxx" hors
    // whitelist (devra être filtrée par le handler — D-1 strict).
    state.selectActiveRows = SETTING_KEYS_WHITELIST.map((key, idx) => ({
      id: 1000 + idx,
      key,
      value:
        key === 'vat_rate_default' || key === 'group_manager_discount'
          ? { bp: 550 }
          : key === 'threshold_alert'
            ? { count: 5, days: 7, dedup_hours: 24 }
            : key === 'maintenance_mode'
              ? { enabled: false }
              : 'sample-string',
      valid_from: '2020-01-01T00:00:00Z',
      valid_to: null,
      updated_by: ADMIN_ID,
      notes: null,
      created_at: '2020-01-01T00:00:00Z',
    }))
    // Orphelin hors whitelist : doit être filtré par le handler.
    state.selectActiveRows.push({
      id: 9999,
      key: 'internal_orphan_key',
      value: { foo: 'bar' },
      valid_from: '2020-01-01T00:00:00Z',
      valid_to: null,
      updated_by: ADMIN_ID,
      notes: null,
      created_at: '2020-01-01T00:00:00Z',
    })
    // Comptage versions : 2 versions pour vat_rate_default, 1 pour les autres.
    state.selectAllForCountRows = [
      ...SETTING_KEYS_WHITELIST.map((k) => ({ key: k })),
      { key: 'vat_rate_default' }, // une 2e version (clôturée)
    ]
    state.operatorRows = [{ id: ADMIN_ID, email: 'admin@fruitstock.fr' }]

    const req = mockReq({ method: 'GET', query: {} })
    req.user = adminSession()
    const res = mockRes()
    await adminSettingsListHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: {
        items: Array<{
          key: string
          value: unknown
          valid_to: string | null
          updated_by: { email_display_short: string | null } | null
          versions_count: number
        }>
      }
    }
    // Les 8 clés whitelist sont retournées (orphan filtré côté handler).
    expect(body.data.items).toHaveLength(SETTING_KEYS_WHITELIST.length)
    const keys = body.data.items.map((i) => i.key)
    for (const k of SETTING_KEYS_WHITELIST) {
      expect(keys).toContain(k)
    }
    expect(keys).not.toContain('internal_orphan_key')
    // Toutes actives → valid_to null.
    expect(body.data.items.every((i) => i.valid_to === null)).toBe(true)
    // PII-limited : email_display_short = 'admin' (avant @).
    const vat = body.data.items.find((i) => i.key === 'vat_rate_default')
    expect(vat?.updated_by?.email_display_short).toBe('admin')
    // versions_count : vat_rate_default a 2 versions, les autres 1.
    expect(vat?.versions_count).toBeGreaterThanOrEqual(2)
  })

  it('200 + ordering stable par key ASC (déterminisme)', async () => {
    // Insère seulement 3 clés en ordre désordre.
    state.selectActiveRows = [
      {
        id: 3,
        key: 'maintenance_mode',
        value: { enabled: false },
        valid_from: '2020-01-01T00:00:00Z',
        valid_to: null,
        updated_by: null,
        notes: null,
        created_at: '2020-01-01T00:00:00Z',
      },
      {
        id: 1,
        key: 'vat_rate_default',
        value: { bp: 550 },
        valid_from: '2020-01-01T00:00:00Z',
        valid_to: null,
        updated_by: null,
        notes: null,
        created_at: '2020-01-01T00:00:00Z',
      },
      {
        id: 2,
        key: 'group_manager_discount',
        value: { bp: 400 },
        valid_from: '2020-01-01T00:00:00Z',
        valid_to: null,
        updated_by: null,
        notes: null,
        created_at: '2020-01-01T00:00:00Z',
      },
    ]
    state.selectAllForCountRows = [
      { key: 'vat_rate_default' },
      { key: 'group_manager_discount' },
      { key: 'maintenance_mode' },
    ]
    const req = mockReq({ method: 'GET', query: {} })
    req.user = adminSession()
    const res = mockRes()
    await adminSettingsListHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: { items: Array<{ key: string }> } }
    const keysOrder = body.data.items.map((i) => i.key)
    // ASC alphabetique sur key.
    const sorted = [...keysOrder].sort((a, b) => a.localeCompare(b))
    expect(keysOrder).toEqual(sorted)
  })

  it('200 + clé absente DB → versions_count=0 fallback gracieux (pas crash)', async () => {
    // Aucune ligne `vat_rate_default` (cas seed initial vide). Le handler
    // doit retourner soit pas la clé du tout (filtre is null → 0 row), soit
    // un placeholder avec versions_count=0. Décision contractuelle : la clé
    // n'apparaît pas dans `items` si aucune version active.
    state.selectActiveRows = [
      {
        id: 1,
        key: 'group_manager_discount',
        value: { bp: 400 },
        valid_from: '2020-01-01T00:00:00Z',
        valid_to: null,
        updated_by: null,
        notes: null,
        created_at: '2020-01-01T00:00:00Z',
      },
    ]
    state.selectAllForCountRows = [{ key: 'group_manager_discount' }]
    const req = mockReq({ method: 'GET', query: {} })
    req.user = adminSession()
    const res = mockRes()
    await adminSettingsListHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as { data: { items: Array<{ key: string }> } }
    // Seules les clés présentes en DB apparaissent. Le handler ne crash pas
    // sur les 7 autres clés whitelist absentes — graceful fallback.
    expect(body.data.items).toHaveLength(1)
    expect(body.data.items[0]?.key).toBe('group_manager_discount')
  })

  it('403 ROLE_NOT_ALLOWED si role=sav-operator (defense-in-depth)', async () => {
    const req = mockReq({ method: 'GET' })
    req.user = savOperatorSession()
    const res = mockRes()
    await adminSettingsListHandler(req, res)
    expect(res.statusCode).toBe(403)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('ROLE_NOT_ALLOWED')
  })
})
