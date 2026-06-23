import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockReq, mockRes } from '../../_lib/test-helpers'
import {
  adminSession,
  savOperatorSession,
  validationListEntry,
  type ValidationListEntry,
} from '../../../../fixtures/admin-fixtures'

/**
 * Story 7-3c AC #1 — RED-PHASE tests pour `GET /api/admin/validation-lists`
 * (op `admin-validation-lists-list`). Handler attendu :
 *   client/api/_lib/admin/validation-lists-list-handler.ts
 *
 * Contrat (cohérent /api/admin Stories 7-3a/7-3b) :
 *   200 → { lists: Record<list_code, ValidationListEntry[]> }
 *     - Groupé par `list_code` (codes V1 connus : sav_cause, bon_type, unit)
 *     - Chaque groupe trié par `sort_order ASC, value ASC`
 *   403 ROLE_NOT_ALLOWED si user.role !== 'admin' (defense-in-depth)
 *   500 si SELECT KO
 *
 * AC #1 :
 *   - Groupement par `list_code` côté handler
 *   - Tri `sort_order ASC, value ASC`
 *   - Filtre is_active : par défaut, retourne tout (admin peut voir
 *     les inactifs pour réactiver). Un query param ?active_only=true
 *     filtre côté DB via .eq('is_active', true).
 */

interface State {
  selectRows: ValidationListEntry[]
  selectError: { message: string } | null
  orderCalls: Array<{ col: string; opts: unknown }>
  eqFilters: Array<{ col: string; val: unknown }>
}

const state = vi.hoisted(
  () =>
    ({
      selectRows: [],
      selectError: null,
      orderCalls: [],
      eqFilters: [],
    }) as State
)

vi.mock('../../../../../api/_lib/clients/supabase-admin', () => {
  function buildValidationListsQuery(): unknown {
    const out: Record<string, unknown> = {
      select: () => out,
      order: (col: string, opts: unknown) => {
        state.orderCalls.push({ col, opts })
        // Le 2e .order() est terminal et déclenche la résolution.
        if (state.orderCalls.length >= 2) {
          return Promise.resolve({
            data: state.selectError ? null : state.selectRows,
            error: state.selectError,
          })
        }
        return out
      },
      eq: (col: string, val: unknown) => {
        state.eqFilters.push({ col, val })
        return out
      },
    }
    return out
  }
  return {
    supabaseAdmin: () => ({
      from: (table: string) => {
        if (table === 'validation_lists') return buildValidationListsQuery()
        throw new Error(`Unmocked table: ${table}`)
      },
    }),
    __resetSupabaseAdminForTests: () => undefined,
  }
})

// RED — module n'existe pas encore. L'import doit ÉCHOUER en Step 3 GREEN-phase.
import { adminValidationListsListHandler } from '../../../../../api/_lib/admin/validation-lists-list-handler'

beforeEach(() => {
  state.selectRows = []
  state.selectError = null
  state.orderCalls = []
  state.eqFilters = []
})

describe('GET /api/admin/validation-lists (admin-validation-lists-list)', () => {
  it('200 happy path : retourne lists groupées par list_code', async () => {
    state.selectRows = [
      validationListEntry({ id: 1, list_code: 'sav_cause', value: 'Abîmé', sort_order: 100 }),
      validationListEntry({ id: 2, list_code: 'sav_cause', value: 'Pourri', sort_order: 200 }),
      validationListEntry({ id: 3, list_code: 'bon_type', value: 'AVOIR', sort_order: 100 }),
      validationListEntry({ id: 4, list_code: 'unit', value: 'kg', sort_order: 100 }),
    ]
    const req = mockReq({ method: 'GET', query: {} })
    req.user = adminSession()
    const res = mockRes()
    await adminValidationListsListHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: { lists: Record<string, ValidationListEntry[]> }
    }
    // Groupement par list_code
    expect(Object.keys(body.data.lists).sort()).toEqual(['bon_type', 'sav_cause', 'unit'])
    expect(body.data.lists['sav_cause']).toHaveLength(2)
    expect(body.data.lists['bon_type']).toHaveLength(1)
    expect(body.data.lists['unit']).toHaveLength(1)
  })

  it('200 + tri sort_order ASC, value ASC dans chaque groupe', async () => {
    state.selectRows = [
      validationListEntry({ id: 1, list_code: 'sav_cause', value: 'Abîmé', sort_order: 100 }),
      validationListEntry({ id: 2, list_code: 'sav_cause', value: 'Pourri', sort_order: 200 }),
    ]
    const req = mockReq({ method: 'GET', query: {} })
    req.user = adminSession()
    const res = mockRes()
    await adminValidationListsListHandler(req, res)
    expect(res.statusCode).toBe(200)
    // Le handler doit ordonner par sort_order ASC puis value ASC côté DB.
    expect(state.orderCalls.length).toBeGreaterThanOrEqual(2)
    const cols = state.orderCalls.map((c) => c.col)
    expect(cols).toContain('sort_order')
    expect(cols).toContain('value')
  })

  it('200 + filtre is_active=true via query active_only=true', async () => {
    state.selectRows = [
      validationListEntry({ id: 1, list_code: 'sav_cause', value: 'Abîmé', is_active: true }),
    ]
    const req = mockReq({ method: 'GET', query: { active_only: 'true' } })
    req.user = adminSession()
    const res = mockRes()
    await adminValidationListsListHandler(req, res)
    expect(res.statusCode).toBe(200)
    expect(state.eqFilters).toContainEqual({ col: 'is_active', val: true })
  })

  // Hardening Round 1 — régression CR adversarial 3-layer.

  it('Hardening W-7-3c-6 : skip rows avec list_code hors enum V1 (D-7)', async () => {
    state.selectRows = [
      validationListEntry({ id: 1, list_code: 'sav_cause', value: 'Abîmé' }),
      // Row orpheline avec un list_code non-V1 (ex. seed manuel ou migration
      // future hors story 7-3c). Doit être ignorée par le handler.
      validationListEntry({
        id: 99,
        list_code: 'unknown_code' as 'sav_cause',
        value: 'orphan',
      }),
    ]
    const req = mockReq({ method: 'GET', query: {} })
    req.user = adminSession()
    const res = mockRes()
    await adminValidationListsListHandler(req, res)
    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: { lists: Record<string, ValidationListEntry[]> }
    }
    // La réponse ne contient QUE les 3 codes V1 (D-7 enum strict).
    expect(Object.keys(body.data.lists).sort()).toEqual(['bon_type', 'sav_cause', 'unit'])
    // La row orpheline n'apparaît dans aucun bucket.
    expect(body.data.lists['sav_cause']).toHaveLength(1)
    expect(body.data.lists['sav_cause']?.[0]?.id).toBe(1)
    // Pas de clé 'unknown_code' leak vers le client.
    expect(body.data.lists).not.toHaveProperty('unknown_code')
  })

  it('403 ROLE_NOT_ALLOWED si role=sav-operator (defense-in-depth)', async () => {
    const req = mockReq({ method: 'GET' })
    req.user = savOperatorSession()
    const res = mockRes()
    await adminValidationListsListHandler(req, res)
    expect(res.statusCode).toBe(403)
    const body = res.jsonBody as { error: { details?: { code?: string } } }
    expect(body.error.details?.code).toBe('ROLE_NOT_ALLOWED')
  })
})
