import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import * as XLSX from 'xlsx'
import { readKdriveOrderWorkbook } from '../../../api/_lib/clients/kdrive'

const original = readFileSync('tests/fixtures/supplier-claim-data.xlsx')
const env = { KDRIVE_ID: '15', KDRIVE_TOKEN: 'secret-test' }
const base = '/3/drive/15/files/'
const storage = 'https://1-6-v3-13.download.kdrive.infomaniakusercontent.com'
const download = '/2/drive/15/files/90/download'
const list = (id: number) => base + id + '/files?limit=20'
const dir = (id: number, parent_id: number, name: string) => ({
  id, parent_id, name, drive_id: 15, type: 'dir', capabilities: { can_read: true },
})
const folder = dir(80, 70, 'fact_46_26S5_94_RUNGIS')
const file = { ...dir(90, 80, 'data.xlsx'), type: 'file' }
const detail = (id: number) => base + id + '?with=capabilities'
const page = (data: unknown[], cursor?: string) => ({ data, has_more: !!cursor, cursor })
const bytes = (data: Uint8Array, headers?: HeadersInit) =>
  new Response(new Uint8Array(data), headers ? { headers } : {})

function fixture() {
  const routes = new Map<string, () => unknown>([
    ['/2/drive/15', () => ({ data: { id: 15 } })],
    [base + '1', () => ({ data: dir(1, 0, 'root') })],
    [list(1), () => page([{ ...dir(20, 1, 'organisation'), visibility: 'is_team_space' }])],
    [base + '20/name?name=04_SUIVI_COMMANDE', () => ({ data: dir(30, 20, '04_SUIVI_COMMANDE') })],
    [base + '30/name?name=03_FACTURE', () => ({ data: dir(40, 30, '03_FACTURE') })],
    [base + '40/name?name=FRANCAIS', () => ({ data: dir(50, 40, 'FRANCAIS') })],
    [list(50), () => page([dir(60, 50, '2026')])],
    [list(60), () => page([dir(70, 60, 'S05')])],
    [list(70), () => page([folder])],
    [list(80), () => page([], 'suite')],
    [list(80) + '&cursor=suite', () => page([file])],
    [detail(80), () => ({ data: folder })],
    [detail(90), () => ({ data: file })],
    [download, () => bytes(original)],
  ])
  const storageResponse = vi.fn(() => bytes(original))
  const calls: string[] = []
  const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const path = url.pathname + url.search
    calls.push(path)
    if (url.origin === storage) {
      expect(init?.method).toBe('GET')
      expect(init?.redirect).toBe('manual')
      expect(init?.credentials).toBe('omit')
      expect(Array.from(new Headers(init?.headers).keys())).toEqual([])
      return storageResponse()
    }
    expect(url.origin).toBe('https://api.infomaniak.com')
    expect(init?.method).toBe('GET')
    expect(init?.redirect).toBe('manual')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-test')
    const route = routes.get(path)
    if (!route) throw new Error('Route inconnue')
    const response = route()
    return response instanceof Response ? response : Response.json({ result: 'success', ...Object(response) })
  })
  return { routes, calls, storageResponse, run: () => readKdriveOrderWorkbook('46_26S5_94_1', env, request) }
}

describe('Original kDrive', () => {
  it.each([undefined, '1'])('conserve chaque octet avec content-length %s', async length => {
    const { routes, calls, run } = fixture()
    routes.set(download, () => bytes(original, length ? { 'content-length': length } : {}))
    expect((await run()).equals(original)).toBe(true)
    expect(calls.slice(-3)).toEqual([detail(80), detail(90), download])
    expect(calls.filter(path => path === list(70))).toHaveLength(2)
  })

  const signed = storage + '/file?signature=test'
  const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } })

  it('accepte un seul 302 du téléchargement du classeur et conserve les octets', async () => {
    const { routes, calls, run } = fixture()
    routes.set(download, () => redirect(signed))
    expect((await run()).equals(original)).toBe(true)
    expect(calls.slice(-4)).toEqual([detail(80), detail(90), download, '/file?signature=test'])
  })

  it.each(['', '/relative', storage.replace('https:', 'http:'), storage + '.example.org/x',
    storage + ':8443/x', storage.replace('https://', 'https://user:pass@')])(
    'refuse une destination non autorisée (%#)', async location => {
      const { routes, calls, run } = fixture()
      routes.set(download, () => redirect(location))
      await expect(run()).rejects.toThrow('Destination de téléchargement refusée.')
      expect(calls.at(-1)).toBe(download)
    })

  it.each([[download, 307], [detail(90), 302]] as const)('refuse la redirection de %s avec HTTP %i', async (path, status) => {
    const { routes, storageResponse, run } = fixture()
    routes.set(path, () => redirect(signed, status))
    await expect(run()).rejects.toThrow('Redirection refusée.')
    expect(storageResponse).not.toHaveBeenCalled()
  })

  it('arrête au deuxième 302, même vers le même hôte', async () => {
    const { routes, storageResponse, run } = fixture()
    routes.set(download, () => redirect(signed))
    storageResponse.mockReturnValueOnce(redirect(signed))
    await expect(run()).rejects.toThrow('Redirection refusée.')
    expect(storageResponse).toHaveBeenCalledTimes(1)
  })

  it('lit aussi un classeur XLSX compressé', async () => {
    const { routes, run } = fixture()
    const compressed = XLSX.write(XLSX.read(original), { type: 'buffer', bookType: 'xlsx', compression: true })
    routes.set(download, () => bytes(compressed))
    expect((await run()).equals(compressed)).toBe(true)
  })

  it.each([
    page([]), page([{ ...file, name: 'Data.xlsx' }]), page([{ ...file, type: 'dir' }]),
    page([{ ...file, parent_id: 81 }]), page([{ ...file, drive_id: 99 }]), page([{ ...file, id: 70 }]),
    page([file, { ...file, id: 91 }]), page([dir(91, 80, 'sous-dossier')]),
    { data: [file], has_more: true },
  ])('bloque un enfant absent, ambigu ou invérifiable (%#)', async response => {
    const { routes, calls, run } = fixture()
    routes.set(list(80), () => response)
    await expect(run()).rejects.toThrow()
    expect(calls).not.toContain(download)
  })

  it('refuse un deuxième fichier exact en fin de pagination', async () => {
    const { routes, calls, run } = fixture()
    routes.set(list(80), () => page([{ ...file, id: 91 }], 'suite'))
    await expect(run()).rejects.toThrow(/Plusieurs/)
    expect(calls).not.toContain(download)
  })

  it.each(['doublon', 'remplacement'])('refuse un %s apparu lors de la revérification', async change => {
    const { routes, calls, run } = fixture()
    const next = list(80) + '&cursor=suite'
    routes.set(next, () => {
      routes.set(next, () => page(change === 'doublon' ? [file, { ...file, id: 91 }] : [{ ...file, id: 91 }]))
      return page([file])
    })
    await expect(run()).rejects.toThrow(/Plusieurs|modifiée/)
    expect(calls).not.toContain(download)
  })

  it('arrête la lecture si la commande est ambiguë', async () => {
    const { routes, calls, run } = fixture()
    routes.set(list(70), () => page([folder, { ...folder, id: 81 }]))
    await expect(run()).rejects.toThrow()
    expect(calls).not.toContain(list(80))
    expect(calls).not.toContain(download)
  })

  it('revérifie la branche après la liste des enfants', async () => {
    const { routes, calls, run } = fixture()
    routes.set(list(80), () => {
      routes.set(list(60), () => page([dir(70, 60, 'S06')]))
      return page([file])
    })
    await expect(run()).rejects.toThrow()
    expect(calls).not.toContain(download)
  })

  it.each([
    [80, { parent_id: 99 }], [80, { name: 'autre' }], [80, { capabilities: {} }],
    [90, { id: 91 }], [90, { drive_id: 16 }], [90, { parent_id: 81 }], [90, { name: 'Data.xlsx' }],
    [90, { capabilities: { can_read: true, can_download: null } }],
    [90, { capabilities: { can_read: true, can_download: 'true' } }],
    [90, { type: 'dir' }], [90, { capabilities: { can_read: false } }], [90, { capabilities: null }],
    [90, { capabilities: { can_read: 'true' } }], [90, { capabilities: { can_read: true, can_download: false } }],
  ] as const)('refuse des métadonnées modifiées (%#)', async (id, changes) => {
    const { routes, calls, run } = fixture()
    routes.set(detail(id), () => ({ data: { ...(id === 80 ? folder : file), ...changes } }))
    await expect(run()).rejects.toThrow()
    expect(calls).not.toContain(download)
  })

  it.each([302, 401, 403, 404, 429, 500])('traite HTTP %i sans suivre de destination ni exposer le jeton', async status => {
    const { routes, calls, run } = fixture()
    routes.set(download, () => new Response('secret-test', { status, headers: { location: 'https://other.test/secret-test' } }))
    await expect(run()).rejects.toThrow(/^(?!.*secret-test).+$/)
    expect(calls.at(-1)).toBe(download)
  })

  it.each([undefined, '1', '4194305'])('refuse un flux de plus de 4 Mio (%s)', async length => {
    const { routes, run } = fixture()
    routes.set(download, () => bytes(Buffer.alloc(4 * 1024 * 1024 + 1), length ? { 'content-length': length } : {}))
    await expect(run()).rejects.toThrow(/Limite de transfert/)
  })

  it('refuse un flux interrompu après les premiers octets', async () => {
    const { routes, run } = fixture()
    let pulls = 0
    routes.set(download, () => new Response(new ReadableStream({
      pull(controller) {
        pulls++
        if (pulls === 1) controller.enqueue(original.subarray(0, 8))
        else controller.error(new Error('secret-test'))
      },
    })))
    await expect(run()).rejects.toThrow('Connexion ou transfert interrompu.')
    expect(pulls).toBe(2)
  })

  it.each(['texte', '<worksheet>', '<worksheet/>', '<wrong xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>'])(
    'rejette une feuille XML invalide malgré un CRC correct (%s)', async content => {
      const { routes, run } = fixture()
      const container = XLSX.CFB.read(original, { type: 'buffer' })
      const sheet = XLSX.CFB.find(container, '/xl/worksheets/sheet1.xml')
      sheet.content = Buffer.from(content)
      sheet.size = sheet.content.length
      const rebuilt = XLSX.CFB.write(container, { type: 'buffer', fileType: 'zip' })
      routes.set(download, () => bytes(rebuilt))
      await expect(run()).rejects.toThrow(/format incorrect/)
    })

  it.each(['vide', 'html', 'json', 'zip', 'tronqué', 'CRC', 'ods', 'xlsm', 'xlsb'])('refuse le format %s', async format => {
    const { routes, run } = fixture()
    let data: Buffer
    switch (format) {
      case 'html': data = Buffer.from('<html>Erreur</html>'); break
      case 'json': data = Buffer.from('{"result":"error"}'); break
      case 'zip': data = readFileSync('tests/fixtures/supplier-claim-zip-renamed.xlsx'); break
      case 'tronqué': data = original.subarray(0, -50); break
      case 'CRC':
        data = Buffer.from(original)
        data[data.indexOf(Buffer.from('PK\x01\x02')) + 16]! ^= 1
        break
      case 'ods': case 'xlsm': case 'xlsb':
        data = XLSX.write(XLSX.read(original), { type: 'buffer', bookType: format })
        break
      default: data = Buffer.alloc(0)
    }
    routes.set(download, () => bytes(data))
    await expect(run()).rejects.toThrow(/format incorrect/)
  })
})
