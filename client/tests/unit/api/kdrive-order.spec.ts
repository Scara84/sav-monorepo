import { describe, expect, it, vi } from 'vitest'
import { resolveKdriveOrder } from '../../../api/_lib/clients/kdrive'

const env = { KDRIVE_TOKEN: 'test', KDRIVE_ID: '15', KDRIVE_WITNESS_ID: '99', KDRIVE_WITNESS_SHA256: 'a'.repeat(64) }
const base = '/3/drive/15/files/'
const list = (id: number) => base + id + '/files?limit=20'
const dir = (id: number, parent_id: number, name: string) => ({ id, parent_id, drive_id: 15, type: 'dir', name })
const page = (data: unknown[], cursor?: string) => ({ data, has_more: cursor !== undefined, cursor })
const ref = '46_26S5_94_1'
const key = '46_26S5_94'
const candidate = dir(80, 70, 'fact_' + key + '_RUNGIS')

function fixture(year = '2026', week = 'S05', name = candidate.name) {
  const routes = new Map<string, Record<string, unknown>>([
    ['/2/drive/15', { data: { id: 15 } }],
    [base + '1', { data: dir(1, 0, 'root') }],
    [list(1), page([{ ...dir(20, 1, 'organisation'), visibility: 'is_team_space' }])],
    [base + '20/name?name=04_SUIVI_COMMANDE', { data: dir(30, 20, '04_SUIVI_COMMANDE') }],
    [base + '30/name?name=03_FACTURE', { data: dir(40, 30, '03_FACTURE') }],
    [base + '40/name?name=FRANCAIS', { data: dir(50, 40, 'FRANCAIS') }],
    [list(50), page([dir(60, 50, year)])],
    [list(60), page([dir(70, 60, week)])],
    [list(70), page([{ ...candidate, name }])],
  ])
  const calls: string[] = []
  const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = new URL(String(url))
    const path = target.pathname + target.search
    calls.push(path)
    if (target.origin !== 'https://api.infomaniak.com' || init?.method !== 'GET' || !routes.has(path))
      throw new Error('Route inattendue')
    return Response.json({ result: 'success', ...routes.get(path) })
  })
  return { routes, request, calls }
}

describe('Résolution serveur de la commande kDrive', () => {
  it.each([
    [ref, key, '2026', 'S05'],
    ['529_26S46_81_1', '529_26S46_81', '2026', 'S46'],
    ['529_26S46_81_2', '529_26S46_81', '2026', 'S46'],
    [' 529_26S46_81_12 ', '529_26S46_81', '2026', 'S46'],
    ['007_26S46_081_1', '007_26S46_081', '2026', 'S46'],
    ['46_26S05_94_1', '46_26S05_94', '2026', 'S05'],
    ['007_25S2_081_1', '007_25S2_081', '2025', 'S02'],
    ['A_27S1_b_c_lot', 'A_27S1_b_c', '2027', 'S01'],
    ['529_26S01_81_1', '529_26S01_81', '2026', 'S01'],
    ['007_25S53_081_a', '007_25S53_081', '2025', 'S53'],
  ])('conserve la clé et vérifie la branche de %s', async (raw, key, year, week) => {
    const name = 'fact_' + key + '_RUNGIS'
    const { request, calls, routes } = fixture(year, week, name)
    expect(await resolveKdriveOrder(raw, env, request)).toMatchObject({
      branch: { key, year, week }, status: 'active-unknown',
      candidates: [{ id: '80', name }], selectedFolderId: null,
    })
    expect(calls).toEqual([...routes.keys()])
  })

  it.each([null, 27, '', ' ', '52926S46811', '529_26S46_81_', '_1', '529__81_1',
    '46_26S5_94', '46_26S5_ _1', '46_26S5_94_  _1', '46_26S5_94_  ',
    '../../529_26S46_81_1', 'a_26S5_b_1\\x', '\n' + ref, 'a_26S_4_1',
    'a_26S0_4_1', 'a_26S54_4_1', 'a_26S053_4_1', 'a_4_26S5_1', 'a_26s5_b_1',
  ])('rejette %j sans accès', async raw => {
    const request = vi.fn()
    expect(await resolveKdriveOrder(raw, env, request)).toMatchObject({ status: 'invalid-reference', selectedFolderId: null })
    expect(request).not.toHaveBeenCalled()
  })

  it.each([1, 99])('vérifie aussi la racine avec un FRANCAIS configuré (parent %i)', async parent => {
    const { routes, request, calls } = fixture()
    routes.set(base + '50', { data: dir(50, 40, 'FRANCAIS') })
    routes.set(base + '40', { data: dir(40, 30, '03_FACTURE') })
    routes.set(base + '30', { data: dir(30, 20, '04_SUIVI_COMMANDE') })
    routes.set(base + '20', { data: { ...dir(20, parent, 'organisation'), visibility: 'is_team_space' } })
    const result = await resolveKdriveOrder(ref, { ...env, KDRIVE_FRANCAIS_ID: '50' }, request)
    expect(result.status).toBe(parent === 1 ? 'active-unknown' : 'unverified')
    expect(calls.at(-1)).toBe(parent === 1 ? list(70) : base + '20')
  })

  it.each([key, 'fact_' + key + '_AUTRE', 'fact_' + key + '_ARCHIVE', 'copie_' + key])(
    'conserve %s comme candidat sans le sélectionner', async name => {
      const { request } = fixture('2026', 'S05', name)
      expect(await resolveKdriveOrder(ref, env, request)).toMatchObject({
        status: 'active-unknown', candidates: [{ id: '80', name }], selectedFolderId: null,
      })
    }
  )

  it('exclut collisions, fichiers et sous-dossiers et ne descend que dans la branche exacte', async () => {
    const { routes, request, calls } = fixture()
    routes.set(list(50), page([dir(59, 50, '2025'), dir(60, 50, '2026')]))
    routes.set(list(60), page([dir(69, 60, 'S5'), dir(70, 60, 'S05')]))
    const names = ['fact_46_26S5_940', '146_26S5_94', '46_26S50_94', '46_26S05_94', key + '-extra', 'sous-dossier']
    routes.set(list(70), page([...names.map((name, i) => dir(81 + i, 70, name)), { ...candidate, type: 'file' }]))
    expect(await resolveKdriveOrder(ref, env, request)).toMatchObject({ status: 'no-candidate', candidates: [], selectedFolderId: null })
    expect(calls).toEqual([...routes.keys()])
  })

  it('trouve chaque dossier uniquement sur la deuxième page de son parent', async () => {
    const { routes, request, calls } = fixture()
    const pages: string[] = []
    for (const parent of [50, 60, 70]) {
      const path = list(parent)
      const next = path + '&cursor=suite'
      routes.set(next, routes.get(path)!)
      routes.set(path, page([dir(parent + 1, parent, 'autre')], 'suite'))
      pages.push(path, next)
    }
    expect(await resolveKdriveOrder(ref, env, request)).toMatchObject({
      status: 'active-unknown', candidates: [{ id: '80', name: candidate.name }], selectedFolderId: null,
    })
    expect(calls.slice(-6)).toEqual(pages)
  })

  it.each([50, 60, 70])('termine la pagination du parent %i même après un résultat', async parent => {
    const { routes, request, calls } = fixture()
    const path = list(parent)
    const children = routes.get(path)!.data as ReturnType<typeof dir>[]
    routes.set(path, page(children, 'a/b +'))
    routes.set(path + '&cursor=a%2Fb+%2B', page([{ ...children[0], id: 101 }]))
    const result = await resolveKdriveOrder(ref, env, request)
    expect(result.status).toBe(parent === 70 ? 'multiple-candidates' : 'branch-ambiguous')
    expect(result.selectedFolderId).toBeNull()
    expect(result.candidates).toHaveLength(parent === 70 ? 2 : 0)
    expect(calls.at(-1)).toBe(path + '&cursor=a%2Fb+%2B')
  })

  it.each([50, 60])('signale le niveau absent sous %i', async parent => {
    const { routes, request, calls } = fixture()
    routes.set(list(parent), page([]))
    expect(await resolveKdriveOrder(ref, env, request)).toMatchObject({ status: 'branch-missing', selectedFolderId: null })
    expect(calls.at(-1)).toBe(list(parent))
  })

  it.each([
    { data: [candidate] },
    { data: [candidate], has_more: true },
    page([{ ...candidate, parent_id: 60 }]),
    page([{ ...candidate, drive_id: 16 }]),
    page([{ ...candidate, id: 30 }]),
    page([{ ...candidate, type: null }]),
    page([{ ...candidate, name: null }]),
    page([candidate, candidate]),
    page([null]),
  ])('bloque sur une réponse invérifiable (%#)', async response => {
    const { routes, request } = fixture()
    routes.set(list(70), response)
    expect(await resolveKdriveOrder(ref, env, request)).toMatchObject({ status: 'unverified', candidates: [], selectedFolderId: null })
  })

  it.each(['répété', 'limite', 'interrompu'])('rejette toute liste partielle (%s)', async scenario => {
    const { routes, request, calls } = fixture()
    const path = list(70)
    routes.set(path, page([candidate], '1'))
    const extra = scenario === 'limite' ? 19 : 1
    for (let i = 1; i <= extra && scenario !== 'interrompu'; i++) {
      routes.set(path + '&cursor=' + i, page([], scenario === 'répété' ? '1' : String(i + 1)))
    }
    expect(await resolveKdriveOrder(ref, env, request)).toMatchObject({ status: 'unverified', candidates: [], selectedFolderId: null })
    expect(calls.at(-1)).toBe(path + '&cursor=' + extra)
  })
})
