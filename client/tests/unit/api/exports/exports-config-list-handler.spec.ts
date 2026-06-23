import { describe, it, expect } from 'vitest'
import type { SessionUser } from '../../../../api/_lib/types'
import { exportsConfigListHandler } from '../../../../api/_lib/exports/exports-config-list-handler'
import { mockReq, mockRes } from '../_lib/test-helpers'

/**
 * CR Story 5.6 P5 — tests dédiés au handler `exports-config-list-handler`.
 *
 * Le handler est court (5 lignes effectives) mais il porte (a) la garde
 * `withAuth`-redondante (P8 défense en profondeur) et (b) le contrat de
 * réponse `{ data: { suppliers: [...] } }` consommé par
 * `useSupplierExport.fetchConfigList()`. Ces deux comportements doivent
 * être lockés par des tests directs.
 */

function withUser(user: SessionUser) {
  return mockReq({ method: 'GET', user })
}

describe('exports-config-list-handler — Story 5.6', () => {
  it('happy path : retourne 200 + { data: { suppliers: [...] } } avec RUFINO + MARTINEZ', async () => {
    const req = withUser({ sub: 7, type: 'operator', role: 'admin', exp: 9_999_999_999 })
    const res = mockRes()

    await exportsConfigListHandler(req, res)

    expect(res.statusCode).toBe(200)
    const body = res.jsonBody as {
      data: { suppliers: Array<{ code: string; label: string; language: string }> }
    }
    expect(body.data).toBeDefined()
    expect(Array.isArray(body.data.suppliers)).toBe(true)
    const codes = body.data.suppliers.map((s) => s.code)
    expect(codes).toContain('RUFINO')
    expect(codes).toContain('MARTINEZ')
    // Forme (code, label, language) — locking le contrat partagé avec
    // `SupplierConfigEntry` côté client (CR P7).
    for (const entry of body.data.suppliers) {
      expect(typeof entry.code).toBe('string')
      expect(typeof entry.label).toBe('string')
      expect(['fr', 'es']).toContain(entry.language)
    }
  })

  it('CR P8 — pas de user → 403 FORBIDDEN (défense en profondeur)', async () => {
    const req = mockReq({ method: 'GET' })
    // Volontairement : pas de req.user (simule un router amont qui aurait
    // omis withAuth).
    const res = mockRes()

    await exportsConfigListHandler(req, res)

    expect(res.statusCode).toBe(403)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('FORBIDDEN')
  })

  it("CR P8 — user.type !== 'operator' (ex. member) → 403 FORBIDDEN", async () => {
    const req = withUser({ sub: 99, type: 'member', exp: 9_999_999_999 })
    const res = mockRes()

    await exportsConfigListHandler(req, res)

    expect(res.statusCode).toBe(403)
    const body = res.jsonBody as { error: { code: string } }
    expect(body.error.code).toBe('FORBIDDEN')
  })

  it('ordre stable des fournisseurs (insertion order JS)', async () => {
    const req = withUser({ sub: 7, type: 'operator', role: 'admin', exp: 9_999_999_999 })
    const res = mockRes()

    await exportsConfigListHandler(req, res)

    const body = res.jsonBody as { data: { suppliers: Array<{ code: string }> } }
    // RUFINO déclaré en premier dans `_registry` → il vient d'abord.
    expect(body.data.suppliers[0]!.code).toBe('RUFINO')
    expect(body.data.suppliers[1]!.code).toBe('MARTINEZ')
  })
})
