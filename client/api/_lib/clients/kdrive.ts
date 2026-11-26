import { createHash } from 'node:crypto'
import { MAX_FILE_SIZE, validateOriginalWorkbook } from '../sav/supplier-workbook'

const origin = 'https://api.infomaniak.com'
const workbookDownloadOrigin = 'https://1-6-v3-13.download.kdrive.infomaniakusercontent.com'
const folders = ['04_SUIVI_COMMANDE', '03_FACTURE', 'FRANCAIS']
const witnessLimit = 1024 * 1024
const metadataLimit = 256 * 1024

// Only locally defined messages may reach the operator.
class DiagnosticError extends Error {}
export function kdriveDiagnostic(error: unknown): string | undefined {
  return error instanceof DiagnosticError ? error.message : undefined
}

function fail(message: string): never {
  throw new DiagnosticError(message)
}

function id(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)))
    return value
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function retryAdvice(header: string | null): string {
  if (header) {
    let seconds: number
    if (/^\d+$/.test(header)) {
      seconds = Number(header)
    } else {
      const date = new Date(header)
      if (!Number.isFinite(date.getTime()) || date.toUTCString() !== header)
        return 'Réessayez plus tard.'
      seconds = Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000))
    }
    if (Number.isSafeInteger(seconds)) return 'Réessayez dans ' + seconds + ' s.'
  }
  return 'Réessayez plus tard.'
}

function expiredBearer(header: string | null): boolean {
  if (!header || !/^Bearer\s+/i.test(header)) return false
  const parameters = header.replace(/^Bearer\s+/i, '')
  const values = new Map<string, string>()
  // Treat malformed, duplicate or mixed challenges as an unspecified rejection.
  const parameter = /\s*([\w-]+)\s*=\s*(?:"([^"\\]*)"|([\w.-]+))\s*(?:,|$)/gy
  while (parameter.lastIndex < parameters.length) {
    const match = parameter.exec(parameters)
    if (!match) return false
    const key = match[1]!.toLowerCase()
    if (values.has(key)) return false
    values.set(key, match[2] ?? match[3]!)
  }
  const description = values.get('error_description') ?? ''
  return (
    values.get('error') === 'invalid_token' &&
    /^(?:(?:the )?(?:access |bearer )?token (?:has |is )?expired|expired (?:access )?token)\.?$/i.test(
      description
    )
  )
}

function kdriveClient(env: NodeJS.ProcessEnv, request: typeof fetch, controller: AbortController) {
  const token = env.KDRIVE_TOKEN
  if (!token) fail('KDRIVE_TOKEN manquant.')
  if (!/^[A-Za-z0-9._~+/-]+=*$/.test(token)) fail('KDRIVE_TOKEN invalide.')
  const drive = id(env.KDRIVE_ID)
  if (!drive) fail('KDRIVE_ID manquant ou invalide.')
  const targetId = env.KDRIVE_FRANCAIS_ID
  if (targetId && !id(targetId)) fail('KDRIVE_FRANCAIS_ID invalide.')
  const organization = env.KDRIVE_ORGANIZATION
  if (organization && organization !== '1') fail('KDRIVE_ORGANIZATION invalide.')
  if (organization && targetId) fail('Choisissez la recherche par organisation ou par identifiant.')
  async function read(
    path: string,
    limit: number,
    consume: (chunk: Uint8Array) => void,
    kind: 'metadata' | 'witness' | 'workbook' = 'metadata'
  ) {
    let response = await request(origin + path, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token, Accept: kind === 'metadata' ? 'application/json' : '*/*' },
      redirect: 'manual',
      signal: controller.signal,
    })
    if (kind === 'workbook' && response.status === 302) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      const target = location && URL.canParse(location) ? new URL(location) : null
      if (!target || target.origin !== workbookDownloadOrigin || target.protocol !== 'https:' ||
          target.username || target.password) fail('Destination de téléchargement refusée.')
      response = await request(target, {
        method: 'GET', redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
    }
    const status = response.status
    if (status >= 300 && status < 400) fail('Redirection refusée.')
    if (status === 401) {
      if (expiredBearer(response.headers.get('www-authenticate')))
        fail('Jeton expiré. Renouvelez-le.')
      fail('Authentification rejetée. Vérifiez le jeton.')
    }
    if (status === 429)
      fail('Trop de requêtes. ' + retryAdvice(response.headers.get('retry-after')))
    if (status === 403) fail('Droits insuffisants.')
    if (status === 404) fail('Ressource introuvable ou masquée.')
    if (status !== 200) fail('Réponse HTTP inattendue (' + status + ').')
    if (Number(response.headers.get('content-length')) > limit)
      fail('Limite de transfert dépassée.')
    if (!response.body) fail('Flux absent.')
    const reader = response.body.getReader()
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > limit) fail('Limite de transfert dépassée.')
        consume(value)
      }
    } finally {
      reader.releaseLock()
    }
  }

  async function envelope(path: string) {
    const chunks: Buffer[] = []
    await read(path, metadataLimit, (chunk) => chunks.push(Buffer.from(chunk)))
    let json: unknown
    try {
      json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      fail('Réponse JSON incohérente.')
    }
    if (!object(json) || json.result !== 'success')
      fail('Réponse API incohérente.')
    return json
  }

  async function metadata(path: string) {
    const { data } = await envelope(path)
    if (!object(data)) fail('Réponse API incohérente.')
    return data
  }

  const files = '/3/drive/' + drive + '/files/'
  function fileIdentity(data: Record<string, unknown>, type: string, expectedId?: string) {
    const actual = id(data.id)
    if (!actual || (expectedId && actual !== expectedId))
      fail('Identité de ressource incohérente.')
    if (id(data.drive_id) !== drive) fail('Drive incohérent.')
    if (data.type !== type) fail('Type de ressource incorrect.')
    return actual
  }
  async function* children(parent: string, label: string) {
    const params = new URLSearchParams({ limit: '20' })
    const cursors = new Set<string>()
    for (;;) {
      const page = await envelope(files + parent + '/files?' + params)
      if (!Array.isArray(page.data) || typeof page.has_more !== 'boolean')
        fail('Liste ' + label + ' incomplète.')
      yield* page.data as unknown[]
      if (!page.has_more) return
      const cursor = page.cursor
      if (typeof cursor !== 'string' || !cursor || cursors.has(cursor) || cursors.size >= 19)
        fail('Pagination ' + label + ' incomplète.')
      cursors.add(cursor)
      params.set('cursor', cursor)
    }
  }

  async function organizationId() {
    let found: string | undefined
    for await (const entry of children('1', 'de la racine')) {
      if (!object(entry) || typeof entry.visibility !== 'string')
        fail('Visibilité indéterminée dans la racine.')
      if (entry.visibility !== 'is_team_space') continue
      const candidate = fileIdentity(entry, 'dir')
      if (candidate === '1' || id(entry.parent_id) !== '1')
        fail('Parent de l’espace d’organisation incohérent.')
      if (found) fail('Plusieurs espaces d’organisation dans la racine.')
      found = candidate
    }
    if (!found) fail('Espace d’organisation introuvable ou masqué.')
    return found
  }

  async function francais(messages: string[], setStep: (step: string) => void, requireOrganization = false) {
    setStep('Drive')
    if (id((await metadata('/2/drive/' + drive)).id) !== drive)
      fail('Identité du drive incohérente.')
    messages.push('Drive vérifié.')
    setStep('Racine')
    const root = await metadata(files + '1')
    fileIdentity(root, 'dir', '1')
    // File 1 anchors the path within this drive. Its own parent is outside the path.
    messages.push('Racine vérifiée.')
    let parent = '1'
    const pathIds = new Set([parent])
    if (targetId) {
      let current = targetId
      for (const name of [...folders].reverse()) {
        setStep(name)
        const directory = await metadata(files + current)
        fileIdentity(directory, 'dir', current)
        const parentId = id(directory.parent_id)
        if (typeof directory.name !== 'string' || !directory.name)
          fail('Nom absent ou illisible dans la réponse kDrive.')
        if (directory.name !== name)
          fail('Le dossier ' + current + ' ne porte pas le nom exact ' + name + '.')
        if (!parentId) fail('Nom confirmé. Identifiant du parent absent ou invalide.')
        if (pathIds.has(current) || pathIds.has(parentId) || current === parentId)
          fail('Ascendance incohérente : identifiant déjà rencontré.')
        pathIds.add(current)
        current = parentId
      }
      setStep('Dossiers de l’organisation')
      if (pathIds.has(current)) fail('Ascendance de l’organisation incohérente.')
      const space = await metadata(files + current)
      fileIdentity(space, 'dir', current)
      if (space.visibility !== 'is_team_space') fail('Espace d’organisation non confirmé.')
      if (requireOrganization && id(space.parent_id) !== '1')
        fail('Parent de l’espace d’organisation incohérent.')
      pathIds.add(current)
      messages.push('Chemin vérifié dans les dossiers de l’organisation.')
      parent = targetId
    } else {
      if (organization || requireOrganization) {
        setStep('Dossiers de l’organisation')
        parent = await organizationId()
        pathIds.add(parent)
        messages.push('Espace d’organisation vérifié.')
      }
      for (const name of folders) {
        setStep(name)
        const child = await metadata(files + parent + '/name?' + new URLSearchParams({ name }))
        const childId = fileIdentity(child, 'dir')
        if (child.name !== name || id(child.parent_id) !== parent || pathIds.has(childId))
          fail('Nom ou parent du dossier incohérent.')
        parent = childId
        pathIds.add(parent)
        if (name !== 'FRANCAIS') messages.push('Dossier ' + name + ' vérifié.')
      }
    }
    return { parent, pathIds }
  }
  return { drive, files, read, metadata, fileIdentity, francais, children }
}

function diagnosticReason(error: unknown, signal: AbortSignal) {
  if (error instanceof DiagnosticError) return error.message
  return signal.aborted ? 'Délai de 30 secondes dépassé.' : 'Connexion ou transfert interrompu.'
}

export async function checkKdrive(env: NodeJS.ProcessEnv, request = fetch) {
  const messages: string[] = []
  let step = 'Configuration'
  let folderId: string | undefined
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const { drive, files, read, metadata, fileIdentity, francais } = kdriveClient(env, request, controller)
    const witness = env.KDRIVE_WITNESS_ID
    const digest = env.KDRIVE_WITNESS_SHA256
    if (witness || digest) {
      if (!id(witness)) fail('KDRIVE_WITNESS_ID manquant ou invalide.')
      if (!digest || !/^[a-fA-F0-9]{64}$/.test(digest))
        fail('KDRIVE_WITNESS_SHA256 manquante ou invalide.')
    }
    messages.push('Configuration vérifiée.')

    const { parent, pathIds } = await francais(messages, (value) => { step = value })
    folderId = parent
    messages.push('Dossier FRANCAIS accessible (ID ' + folderId + ').')
    if (witness && digest) {
      step = 'Ascendance du témoin'
      const file = await metadata(files + witness)
      fileIdentity(file, 'file', witness)
      if (pathIds.has(witness)) fail('Identité du témoin incohérente.')
      let ancestor = id(file.parent_id)
      const visited = new Set([witness])
      while (ancestor !== parent) {
        if (!ancestor || visited.has(ancestor) || pathIds.has(ancestor) || visited.size > 32)
          fail('Ascendance hors périmètre ou invérifiable.')
        visited.add(ancestor)
        const directory = await metadata(files + ancestor)
        fileIdentity(directory, 'dir', ancestor)
        ancestor = id(directory.parent_id)
      }
      messages.push('Ascendance du témoin vérifiée.')
      step = 'Téléchargement du témoin'
      const hash = createHash('sha256')
      await read(
        '/2/drive/' + drive + '/files/' + witness + '/download',
        witnessLimit,
        (chunk) => hash.update(chunk),
        'witness'
      )
      if (hash.digest('hex') !== digest.toLowerCase()) fail('Empreinte SHA-256 différente.')
      messages.push('Téléchargement du témoin vérifié par SHA-256.')
    } else {
      messages.push('Téléchargement du témoin à tester.')
    }
    return { ok: true, messages, folderId }
  } catch (error) {
    const reason = diagnosticReason(error, controller.signal)
    messages.push(step + ' — ' + reason)
    return { ok: false, messages, folderId }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

function orderBranch(raw: unknown) {
  if (typeof raw !== 'string' || /[\\/\p{Cc}]/u.test(raw)) return
  const value = raw.trim()
  const parts = value.split('_')
  if (parts.length < 4 || parts.some(part => !part.trim())) return
  const time = /^(\d{2})S(\d{1,2})$/.exec(parts[1]!)
  if (!time || Number(time[2]) < 1 || Number(time[2]) > 53) return
  return {
    key: value.slice(0, value.lastIndexOf('_')),
    year: '20' + time[1],
    week: 'S' + time[2]!.padStart(2, '0'),
  }
}

type OrderStatus = 'invalid-reference' | 'branch-missing' | 'branch-ambiguous'
  | 'no-candidate' | 'multiple-candidates' | 'active-unknown' | 'unverified'

type OrderCandidate = { id: string; name: string }

async function resolveOrder(raw: unknown, env: NodeJS.ProcessEnv, request: typeof fetch) {
  const branch = orderBranch(raw)
  function result(status: OrderStatus, message: string, candidates: OrderCandidate[] = []) {
    return { branch, status, message, candidates, selectedFolderId: null, ancestry: null }
  }
  if (!branch) return result('invalid-reference', 'Référence de commande invalide.')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  let step = 'Configuration'
  try {
    const client = kdriveClient(env, request, controller)
    const { parent, pathIds } = await client.francais([], value => { step = value }, true)
    const ancestry = [...pathIds]
    let current = parent
    async function matchingDirectories(matches: (name: string) => boolean) {
      const found: OrderCandidate[] = []
      for await (const entry of client.children(current, 'du dossier')) {
        if (!object(entry) || typeof entry.name !== 'string' || !entry.name ||
            (entry.type !== 'dir' && entry.type !== 'file'))
          fail('Métadonnées de l’enfant incomplètes.')
        const child = client.fileIdentity(entry, entry.type)
        if (id(entry.parent_id) !== current || pathIds.has(child))
          fail('Ascendance ou identité de l’enfant incohérente.')
        pathIds.add(child)
        if (entry.type === 'dir' && matches(entry.name)) found.push({ id: child, name: entry.name })
      }
      return found
    }
    for (const name of [branch.year, branch.week]) {
      step = name
      const found = await matchingDirectories(childName => childName === name)
      if (!found.length) return result('branch-missing', 'Dossier ' + name + ' introuvable.')
      if (found.length > 1) return result('branch-ambiguous', 'Plusieurs dossiers nommés ' + name + '.')
      current = found[0]!.id
      ancestry.push(current)
    }
    step = 'Dossiers de la commande'
    const candidates = await matchingDirectories(name => ('_' + name + '_').includes('_' + branch.key + '_'))
    if (!candidates.length) return result('no-candidate', 'Aucun dossier candidat.')
    if (candidates.length > 1) return result('multiple-candidates', 'Plusieurs dossiers candidats.', candidates)
    const candidate = candidates[0]!
    // La branche contient les versions définitives. Un libellé contradictoire demande vérification.
    const affixes = ('_' + candidate.name + '_').replace('_' + branch.key + '_', '_')
    if (/(?:^|[^\p{L}\p{N}])(?:archives?|copies?|copy)(?=$|[^\p{L}\p{N}])/iu.test(affixes))
      return result('active-unknown', 'Le nom du dossier indique une archive ou une copie.', candidates)
    return { branch, status: 'selected' as const, message: 'Dossier définitif identifié.',
      candidates, selectedFolderId: candidate.id, ancestry }
  } catch (error) {
    return result('unverified', step + ' — ' + diagnosticReason(error, controller.signal))
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

export async function resolveKdriveOrder(raw: unknown, env: NodeJS.ProcessEnv, request = fetch) {
  const { ancestry: _ancestry, ...result } = await resolveOrder(raw, env, request)
  return result
}

export async function readKdriveOrderWorkbook(raw: unknown, env: NodeJS.ProcessEnv, request = fetch) {
  const selected = await resolveOrder(raw, env, request)
  if (selected.status !== 'selected') fail(selected.message)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const client = kdriveClient(env, request, controller)
    const folderId = selected.selectedFolderId
    async function findOriginal(ancestry: string[]) {
      const seen = new Set([...ancestry, folderId])
      let originalId: string | undefined
      for await (const entry of client.children(folderId, 'de la commande')) {
        if (!object(entry) || typeof entry.name !== 'string' || !entry.name ||
            (entry.type !== 'dir' && entry.type !== 'file'))
          fail('Métadonnées de l’enfant incomplètes.')
        const child = client.fileIdentity(entry, entry.type)
        if (id(entry.parent_id) !== folderId || seen.has(child))
          fail('Ascendance ou identité de l’enfant incohérente.')
        seen.add(child)
        if (entry.name !== 'data.xlsx') continue
        if (entry.type !== 'file') fail('data.xlsx doit être un fichier.')
        if (originalId) fail('Plusieurs enfants nommés data.xlsx.')
        originalId = child
      }
      if (!originalId) fail('data.xlsx introuvable dans la commande.')
      return originalId
    }
    const originalId = await findOriginal(selected.ancestry)

    // La liste peut avoir pris plusieurs pages. Reconfirmer le choix et toute la branche.
    const fresh = await resolveOrder(raw, env, request)
    if (fresh.status !== 'selected') fail(fresh.message)
    if (fresh.selectedFolderId !== folderId || fresh.candidates[0]!.name !== selected.candidates[0]!.name ||
        fresh.ancestry.join('/') !== selected.ancestry.join('/'))
      fail('Dossier ou ascendance de commande modifié.')

    if (await findOriginal(fresh.ancestry) !== originalId) fail('Identité de data.xlsx modifiée.')

    async function verifyReadable(resourceId: string, type: string, name: string, parent: string) {
      const data = await client.metadata(client.files + resourceId + '?with=capabilities')
      client.fileIdentity(data, type, resourceId)
      if (data.name !== name || id(data.parent_id) !== parent) fail('Nom ou parent modifié.')
      if (!object(data.capabilities) || data.capabilities.can_read !== true ||
          ('can_download' in data.capabilities && data.capabilities.can_download !== true))
        fail('Droit de lecture insuffisant ou invérifiable.')
    }
    await verifyReadable(folderId, 'dir', selected.candidates[0]!.name, selected.ancestry.at(-1)!)
    await verifyReadable(originalId, 'file', 'data.xlsx', folderId)
    const chunks: Buffer[] = []
    await client.read('/2/drive/' + client.drive + '/files/' + originalId + '/download',
      MAX_FILE_SIZE, chunk => chunks.push(Buffer.from(chunk)), 'workbook')
    const buffer = Buffer.concat(chunks)
    try {
      await validateOriginalWorkbook(buffer, controller.signal)
    } catch {
      fail('Le fichier data.xlsx est vide, corrompu ou de format incorrect.')
    }
    return buffer
  } catch (error) {
    throw new DiagnosticError(diagnosticReason(error, controller.signal))
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
