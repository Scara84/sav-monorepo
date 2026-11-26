import { createHash } from 'node:crypto'

const origin = 'https://api.infomaniak.com'
const folders = ['04_SUIVI_COMMANDE', '03_FACTURE', 'FRANCAIS']
const witnessLimit = 1024 * 1024
const metadataLimit = 256 * 1024

// Only locally defined messages may reach the operator.
class DiagnosticError extends Error {}
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

export async function checkKdrive(env: NodeJS.ProcessEnv, request = fetch) {
  const messages: string[] = []
  let step = 'Configuration'
  let folderId: string | undefined
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const token = env.KDRIVE_TOKEN
    if (!token) fail('KDRIVE_TOKEN manquant.')
    if (!/^[A-Za-z0-9._~+/-]+=*$/.test(token)) fail('KDRIVE_TOKEN invalide.')
    const drive = id(env.KDRIVE_ID)
    if (!drive) fail('KDRIVE_ID manquant ou invalide.')
    const witness = env.KDRIVE_WITNESS_ID
    const digest = env.KDRIVE_WITNESS_SHA256
    if (witness || digest) {
      if (!id(witness)) fail('KDRIVE_WITNESS_ID manquant ou invalide.')
      if (!digest || !/^[a-fA-F0-9]{64}$/.test(digest))
        fail('KDRIVE_WITNESS_SHA256 manquante ou invalide.')
    }
    messages.push('Configuration vérifiée.')

    async function read(
      path: string,
      limit: number,
      consume: (chunk: Uint8Array) => void,
      binary = false
    ) {
      const response = await request(origin + path, {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + token, Accept: binary ? '*/*' : 'application/json' },
        redirect: 'manual',
        signal: controller.signal,
      })
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

    async function metadata(path: string) {
      const chunks: Buffer[] = []
      await read(path, metadataLimit, (chunk) => chunks.push(Buffer.from(chunk)))
      let json: unknown
      try {
        json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        fail('Réponse JSON incohérente.')
      }
      if (!object(json) || json.result !== 'success' || !object(json.data))
        fail('Réponse API incohérente.')
      return json.data
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
    step = 'Drive'
    if (id((await metadata('/2/drive/' + drive)).id) !== drive)
      fail('Identité du drive incohérente.')
    messages.push('Drive vérifié.')
    step = 'Racine'
    const root = await metadata(files + '1')
    fileIdentity(root, 'dir', '1')
    if (root.parent_id !== null && root.parent_id !== 0 && root.parent_id !== '0')
      fail('Parent de la racine incohérent.')
    messages.push('Racine vérifiée.')
    let parent = '1'
    const pathIds = new Set([parent])
    for (const name of folders) {
      step = name
      const child = await metadata(files + parent + '/name?' + new URLSearchParams({ name }))
      const childId = fileIdentity(child, 'dir')
      if (child.name !== name || id(child.parent_id) !== parent || pathIds.has(childId))
        fail('Nom ou parent du dossier incohérent.')
      parent = childId
      pathIds.add(parent)
      if (name === 'FRANCAIS') {
        folderId = childId
        messages.push('Dossier FRANCAIS accessible (ID ' + folderId + ').')
      } else {
        messages.push('Dossier ' + name + ' vérifié.')
      }
    }
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
        true
      )
      if (hash.digest('hex') !== digest.toLowerCase()) fail('Empreinte SHA-256 différente.')
      messages.push('Téléchargement du témoin vérifié par SHA-256.')
    } else {
      messages.push('Téléchargement du témoin à tester.')
    }
    return { ok: true, messages, folderId }
  } catch (error) {
    const reason =
      error instanceof DiagnosticError
        ? error.message
        : controller.signal.aborted
          ? 'Délai de 30 secondes dépassé.'
          : 'Connexion ou transfert interrompu.'
    messages.push(step + ' — ' + reason)
    return { ok: false, messages, folderId }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
