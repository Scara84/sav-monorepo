import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { checkKdrive } from '../../../api/_lib/clients/kdrive'

const origin = 'https://api.infomaniak.com'
const base = '/3/drive/15/files/'
const env = { KDRIVE_TOKEN: 'secret-bearer', KDRIVE_ID: '15' }
const bytes = Buffer.from('contenu privé du témoin')
const witness = {
  ...env,
  KDRIVE_WITNESS_ID: '9',
  KDRIVE_WITNESS_SHA256: createHash('sha256').update(bytes).digest('hex'),
}
const routes = [
  '/2/drive/15',
  base + '1',
  base + '1/name?name=04_SUIVI_COMMANDE',
  base + '2/name?name=03_FACTURE',
  base + '3/name?name=FRANCAIS',
  base + '9',
  base + '7',
  '/2/drive/15/files/9/download',
]
const data = [
  { id: 15 },
  { id: 1, type: 'dir', drive_id: 15, parent_id: null },
  { id: 2, name: '04_SUIVI_COMMANDE', type: 'dir', drive_id: 15, parent_id: 1 },
  { id: 3, name: '03_FACTURE', type: 'dir', drive_id: 15, parent_id: 2 },
  { id: 4, name: 'FRANCAIS', type: 'dir', drive_id: 15, parent_id: 3 },
  { id: 9, type: 'file', drive_id: 15, parent_id: 7 },
  { id: 7, type: 'dir', drive_id: 15, parent_id: 4 },
]
const json = (value: unknown) => Response.json({ result: 'success', data: value })

function replay(override?: { index: number; response: Response }) {
  let index = 0
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const i = index++
    expect(url).toBe(origin + routes[i])
    expect(init).toMatchObject({
      method: 'GET',
      redirect: 'manual',
      headers: { Authorization: 'Bearer secret-bearer' },
    })
    if (override?.index === i) return override.response
    return i === 7 ? new Response(bytes) : json(data[i])
  })
}

describe('Diagnostic local kDrive', () => {
  it('confirme le chemin en cinq lectures', async () => {
    const request = replay()
    const result = await checkKdrive(env, request)
    expect(result.ok).toBe(true)
    expect(result.folderId).toBe('4')
    expect(result.messages.slice(-2)).toEqual([
      'Dossier FRANCAIS accessible (ID 4).',
      'Téléchargement du témoin à tester.',
    ])
    expect(request).toHaveBeenCalledTimes(5)
  })
  it.each([undefined, 1, 3])('ancre le chemin sur la racine du drive (parent %s)', async (parent_id) => {
    const request = replay({ index: 1, response: json({ ...data[1], parent_id }) })
    expect(await checkKdrive(env, request)).toMatchObject({ ok: true, folderId: '4' })
    expect(request).toHaveBeenCalledTimes(5)
  })
  it.each([
    ['is_team_space', '03_FACTURE', true],
    ['is_private_space', '03_FACTURE', false],
    ['is_team_space', 'archive', false],
  ] as const)('vérifie la branche organisation (%s, %s)', async (visibility, invoiceName, ok) => {
    const entries = new Map<string, unknown>([
      [routes[0]!, data[0]], [routes[1]!, data[1]],
      [base + '28', { ...data[4], id: 28, parent_id: 3 }],
      [base + '3', { ...data[3], name: invoiceName }],
      [base + '2', { ...data[2], parent_id: 8 }],
      [base + '8', { type: 'dir', id: 8, drive_id: 15, visibility }],
    ])
    const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('GET')
      return json(entries.get(String(url).slice(origin.length)))
    })
    const result = await checkKdrive({ ...env, KDRIVE_FRANCAIS_ID: '28' }, request)
    expect(result.ok).toBe(ok)
    expect(result.folderId).toBe(ok ? '28' : undefined)
    expect(request).toHaveBeenCalledTimes(invoiceName === 'archive' ? 4 : 6)
  })
  it.each([
    [{ name: 'privé', parent_id: 3 }, 'Le dossier 28 ne porte pas le nom exact FRANCAIS.'],
    [{ parent_id: 3 }, 'Nom absent ou illisible'],
    [{ name: 'FRANCAIS' }, 'Identifiant du parent absent ou invalide'],
    [{ name: 'FRANCAIS', parent_id: 28 }, 'identifiant déjà rencontré'],
  ] as const)('explique un refus sur le dossier cible (%#)', async (fields, error) => {
    const request = vi.fn()
      .mockResolvedValueOnce(json(data[0]))
      .mockResolvedValueOnce(json(data[1]))
      .mockResolvedValueOnce(json({ id: 28, drive_id: 15, type: 'dir', ...fields }))
    const result = await checkKdrive({ ...witness, KDRIVE_FRANCAIS_ID: '28' }, request)
    expect(result.ok).toBe(false)
    expect(result.messages.at(-1)).toContain(error)
    expect(result.messages.join(' ')).not.toContain('privé')
    expect(request).toHaveBeenCalledTimes(3)
  })
  it.each(['succès', 'ambigu', 'absent', 'parent', 'curseur'] as const)(
    'résout depuis l’espace commun en lecture seule (%s)', async (scenario) => {
      const space = { id: 8, type: 'dir', drive_id: 15, parent_id: 1, visibility: 'is_team_space' }
      const pages = [
        { data: [{ visibility: 'is_private_space' }], has_more: true, cursor: 'suite' },
        { data: scenario === 'absent' ? [] : [space], has_more: scenario === 'curseur', cursor: 'suite' },
      ]
      if (scenario === 'ambigu') pages[1]!.data.push({ ...space, id: 10 })
      if (scenario === 'parent') space.parent_id = 7
      const urls = [routes[0], routes[1], base + '1/files?limit=20',
        base + '1/files?limit=20&cursor=suite', base + '8/name?name=04_SUIVI_COMMANDE', routes[3], routes[4]]
      const replies = [json(data[0]), json(data[1]), ...pages.map(page => Response.json({ result: 'success', ...page })),
        json({ ...data[2], parent_id: 8 }), json(data[3]), json(data[4])]
      let count = 0
      const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.method).toBe('GET')
        expect(url).toBe(origin + urls[count])
        return replies[count++]!
      })
      const result = await checkKdrive({ ...env, KDRIVE_ORGANIZATION: '1' }, request)
      expect(result.ok).toBe(scenario === 'succès')
      expect(result.folderId).toBe(scenario === 'succès' ? '4' : undefined)
      expect(count).toBe(scenario === 'succès' ? 7 : 4)
    }
  )
  it('contrôle les parents puis les octets du témoin', async () => {
    const request = replay()
    const result = await checkKdrive(witness, request)
    expect(result.ok).toBe(true)
    expect(result.messages.at(-1)).toContain('vérifié par SHA-256')
    expect(request).toHaveBeenCalledTimes(8)
  })
  it.each([
    [{}, 'KDRIVE_TOKEN'],
    [{ ...env, KDRIVE_FRANCAIS_ID: '../28' }, 'KDRIVE_FRANCAIS_ID'],
    [{ ...env, KDRIVE_TOKEN: 'secret-bearer\nother' }, 'KDRIVE_TOKEN invalide'],
    [{ ...env, KDRIVE_TOKEN: 'secret-bearer€' }, 'KDRIVE_TOKEN invalide'],
    [{ ...env, KDRIVE_ID: '../15' }, 'KDRIVE_ID'],
    [{ ...env, KDRIVE_ID: '9007199254740992' }, 'KDRIVE_ID'],
    [{ ...env, KDRIVE_WITNESS_ID: '9' }, 'KDRIVE_WITNESS_SHA256'],
    [{ ...env, KDRIVE_WITNESS_SHA256: 'bad' }, 'KDRIVE_WITNESS_ID'],
  ] as const)(
    'arrête une configuration invalide avant toute lecture (%#)',
    async (config, expected) => {
      const request = replay()
      const result = await checkKdrive(config, request)
      expect(result.ok).toBe(false)
      expect(result.messages.at(-1)).toContain(expected)
      expect(result.messages.join(' ')).not.toContain('secret-bearer')
      expect(request).not.toHaveBeenCalled()
    }
  )
  it.each([
    [0, () => json({ id: 16 }), 'Drive — Identité'],
    [0, () => new Response(bytes, { status: 401 }), 'Authentification rejetée'],
    [1, () => new Response(bytes, { status: 403 }), 'Droits insuffisants'],
    [1, () => json({ ...data[1], id: 5 }), 'Identité'],
    [1, () => json({ ...data[1], type: 'file' }), 'Type'],
    [1, () => json({ ...data[1], drive_id: 16 }), 'Drive incohérent'],
    [2, () => json({ ...data[2], parent_id: null }), 'parent'],
    [2, () => new Response(bytes, { status: 404 }), '04_SUIVI_COMMANDE — Ressource introuvable'],
    [2, () => Response.json({ result: 'error', data: data[2] }), 'Réponse API incohérente'],
    [2, () => new Response(bytes), 'Réponse JSON incohérente'],
    [3, () => json({ ...data[3], parent_id: 1 }), 'parent'],
    [3, () => json({ ...data[3], id: 1 }), 'parent'],
    [3, () => json({ ...data[3], name: 'autre' }), 'Nom'],
    [4, () => json({ ...data[4], type: 'file' }), 'Type'],
    [4, () => json({ ...data[4], drive_id: 19 }), 'Drive incohérent'],
    [5, () => json({ ...data[5], id: 7 }), 'Identité'],
    [5, () => json({ ...data[5], parent_id: 1 }), 'hors périmètre'],
    [5, () => json({ ...data[5], parent_id: null }), 'invérifiable'],
    [6, () => json({ ...data[6], parent_id: 7 }), 'invérifiable'],
    [6, () => json({ ...data[6], type: 'file' }), 'Type'],
    [7, () => new Response(bytes, { status: 403 }), 'Droits insuffisants'],
    [
      7,
      () =>
        new Response(bytes, {
          status: 302,
          headers: { location: 'https://private.example/secret' },
        }),
      'Redirection refusée',
    ],
    [7, () => new Response('octets différents'), 'Empreinte SHA-256 différente'],
    [7, () => new Response(new Uint8Array(1024 * 1024 + 1)), 'Limite de transfert'],
    [
      7,
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.error(new Error('secret-bearer'))
            },
          })
        ),
      'transfert interrompu',
    ],
  ] as const)('identifie l’échec et arrête les lectures (%#)', async (index, response, error) => {
    const request = replay({ index, response: response() })
    const result = await checkKdrive(witness, request)
    expect(result.ok).toBe(false)
    expect(result.folderId).toBe(index > 4 ? '4' : undefined)
    expect(result.messages.at(-1)).toContain(error)
    expect(result.messages.join(' ')).not.toMatch(
      /secret-bearer|contenu privé|private\.example|octets différents/
    )
    expect(request).toHaveBeenCalledTimes(index + 1)
  })
  it.each([
    [
      'Bearer error="invalid_token", error_description="The access token expired"',
      'Jeton expiré. Renouvelez-le.',
    ],
    [
      'Bearer realm="private", error_description="The access token has expired.", error="invalid_token"',
      'Jeton expiré. Renouvelez-le.',
    ],
    [
      'Bearer error="invalid_token", error_description="Expired or revoked token"',
      'Authentification rejetée. Vérifiez le jeton.',
    ],
    [
      'Bearer error="invalid_token", error_description="The token has not expired"',
      'Authentification rejetée. Vérifiez le jeton.',
    ],
    [
      'Basic error="invalid_token", error_description="The access token expired"',
      'Authentification rejetée. Vérifiez le jeton.',
    ],
  ])('qualifie uniquement une expiration explicite (%#)', async (challenge, message) => {
    const request = replay({
      index: 0,
      response: new Response(null, { status: 401, headers: { 'WWW-Authenticate': challenge } }),
    })
    expect((await checkKdrive(env, request)).messages.at(-1)).toBe('Drive — ' + message)
    expect(request).toHaveBeenCalledOnce()
  })

  it.each([
    ['120', 'Réessayez dans 120 s.'],
    ['Sun, 06 Nov 1994 08:49:37 GMT', 'Réessayez dans 37 s.'],
    ['private.example', 'Réessayez plus tard.'],
  ])('interprète le délai sans nouvelle requête (%#)', async (header, message) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('1994-11-06T08:49:00Z'))
    try {
      const request = replay({
        index: 0,
        response: new Response(null, { status: 429, headers: { 'Retry-After': header } }),
      })
      expect((await checkKdrive(env, request)).messages.at(-1)).toBe(
        'Drive — Trop de requêtes. ' + message
      )
      expect(request).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('interrompt une lecture bloquée après 30 secondes', async () => {
    vi.useFakeTimers()
    try {
      const request = vi.fn(
        (_url: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('secret-bearer')))
          })
      )
      const pending = checkKdrive(env, request)
      await vi.advanceTimersByTimeAsync(30_000)
      expect((await pending).messages.at(-1)).toBe('Drive — Délai de 30 secondes dépassé.')
      expect(request).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
