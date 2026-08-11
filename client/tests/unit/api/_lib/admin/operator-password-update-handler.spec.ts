import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockReq, mockRes } from '../../_lib/test-helpers'
import {
  ADMIN_ID,
  SAV_OPERATOR_ID,
  adminSession,
  savOperatorSession,
} from '../../../../fixtures/admin-fixtures'
import { verifyPassword } from '../../../../../api/_lib/auth/password'

const state = vi.hoisted(() => ({
  rateAllowed: true,
  rateArgs: null as Record<string, unknown> | null,
  passwordRpcArgs: null as Record<string, unknown> | null,
  passwordRpcError: null as { code?: string; message: string } | null,
  passwordRpcReject: false,
  passwordUpdatedAt: '2026-08-10T12:00:00.000Z',
}))

vi.mock('../../../../../api/_lib/clients/supabase-admin', () => ({
  supabaseAdmin: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'increment_rate_limit') {
        state.rateArgs = args
        return {
          data: { allowed: state.rateAllowed, retry_after: 60 },
          error: null,
        }
      }
      if (fn === 'admin_set_operator_password') {
        state.passwordRpcArgs = args
        if (state.passwordRpcReject) throw new Error('database unavailable')
        return {
          data: state.passwordRpcError ? null : [{ password_updated_at: state.passwordUpdatedAt }],
          error: state.passwordRpcError,
        }
      }
      throw new Error(`Unmocked RPC: ${fn}`)
    },
  }),
  __resetSupabaseAdminForTests: () => undefined,
}))

import { adminOperatorPasswordUpdateHandler } from '../../../../../api/_lib/admin/operator-password-update-handler'

beforeEach(() => {
  state.rateAllowed = true
  state.rateArgs = null
  state.passwordRpcArgs = null
  state.passwordRpcError = null
  state.passwordRpcReject = false
  state.passwordUpdatedAt = '2026-08-10T12:00:00.000Z'
})

function validRequest(targetId = SAV_OPERATOR_ID) {
  const req = mockReq({
    method: 'PUT',
    query: { id: String(targetId) },
    body: { password: 'correct-horse-battery' },
  })
  req.user = adminSession()
  return req
}

describe('PUT /api/admin/operators/:id/password', () => {
  it('hash avec le vrai scrypt puis appelle uniquement la RPC avec acteur et cible', async () => {
    const res = mockRes()
    await adminOperatorPasswordUpdateHandler(validRequest(), res)

    expect(res.statusCode).toBe(200)
    expect(state.rateArgs).toMatchObject({ p_max: 10, p_window_sec: 60 })
    expect(state.passwordRpcArgs).toMatchObject({
      p_actor_operator_id: ADMIN_ID,
      p_target_operator_id: SAV_OPERATOR_ID,
    })
    const hash = state.passwordRpcArgs?.['p_password_hash']
    expect(typeof hash).toBe('string')
    expect(await verifyPassword('correct-horse-battery', String(hash))).toBe(true)
    expect(await verifyPassword('wrong-password-value', String(hash))).toBe(false)
    expect(res.jsonBody).toEqual({ data: { passwordUpdatedAt: state.passwordUpdatedAt } })
    expect(JSON.stringify(res.jsonBody)).not.toContain(String(hash))
    expect(JSON.stringify(res.jsonBody)).not.toContain('correct-horse-battery')
  })

  it('refuse non-admin et self avant rate-limit, hash et RPC métier', async () => {
    const nonAdmin = validRequest()
    nonAdmin.user = savOperatorSession()
    const nonAdminRes = mockRes()
    await adminOperatorPasswordUpdateHandler(nonAdmin, nonAdminRes)
    expect(nonAdminRes.statusCode).toBe(403)

    const selfRes = mockRes()
    await adminOperatorPasswordUpdateHandler(validRequest(ADMIN_ID), selfRes)
    expect(selfRes.statusCode).toBe(422)
    expect((selfRes.jsonBody as { error: { details: { code: string } } }).error.details.code).toBe(
      'CANNOT_UPDATE_OWN_PASSWORD'
    )
    expect(state.rateArgs).toBeNull()
    expect(state.passwordRpcArgs).toBeNull()
  })

  it('rejette les valeurs courtes ou uniquement blanches sans RPC métier', async () => {
    for (const password of ['short', '            ']) {
      const req = validRequest()
      req.body = { password }
      const res = mockRes()
      await adminOperatorPasswordUpdateHandler(req, res)
      expect(res.statusCode).toBe(400)
    }
    expect(state.passwordRpcArgs).toBeNull()
  })

  it('mappe une cible RPC absente vers un 404 stable', async () => {
    state.passwordRpcError = { code: 'P0002', message: 'operator target not found' }
    const res = mockRes()
    await adminOperatorPasswordUpdateHandler(validRequest(), res)
    expect(res.statusCode).toBe(404)
    expect((res.jsonBody as { error: { details: { code: string } } }).error.details.code).toBe(
      'OPERATOR_NOT_FOUND'
    )
  })

  it('mappe un refus RBAC SQLSTATE 42501 vers 403 ROLE_NOT_ALLOWED', async () => {
    state.passwordRpcError = { code: '42501', message: 'admin operator required' }
    const res = mockRes()
    await adminOperatorPasswordUpdateHandler(validRequest(), res)
    expect(res.statusCode).toBe(403)
    expect((res.jsonBody as { error: { details: { code: string } } }).error.details.code).toBe(
      'ROLE_NOT_ALLOWED'
    )
  })

  it('rate-limit 10/min/admin bloque avant hash et RPC métier', async () => {
    state.rateAllowed = false
    const res = mockRes()
    await adminOperatorPasswordUpdateHandler(validRequest(), res)
    expect(res.statusCode).toBe(429)
    expect(res.headers['retry-after']).toBe(60)
    expect(state.passwordRpcArgs).toBeNull()
  })

  it('retourne un 500 générique sur erreur ou rejet RPC sans exposer le détail', async () => {
    state.passwordRpcError = { code: 'XX000', message: 'sensitive database detail' }
    const errorRes = mockRes()
    await adminOperatorPasswordUpdateHandler(validRequest(), errorRes)
    expect(errorRes.statusCode).toBe(500)
    expect(JSON.stringify(errorRes.jsonBody)).not.toContain('sensitive')

    state.passwordRpcError = null
    state.passwordRpcReject = true
    const rejectRes = mockRes()
    await adminOperatorPasswordUpdateHandler(validRequest(), rejectRes)
    expect(rejectRes.statusCode).toBe(500)
    expect(JSON.stringify(rejectRes.jsonBody)).not.toContain('database unavailable')
  })

  it('rejette un id manquant ou invalide sans rate-limit ni RPC', async () => {
    for (const id of [undefined, '0', 'abc']) {
      const req = validRequest()
      req.query = id === undefined ? {} : { id }
      const res = mockRes()
      await adminOperatorPasswordUpdateHandler(req, res)
      expect(res.statusCode).toBe(400)
    }
    expect(state.rateArgs).toBeNull()
    expect(state.passwordRpcArgs).toBeNull()
  })
})
