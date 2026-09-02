const { getGraphClient } = require('./graph.js')

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0/drives'
const GRAPH_SHARES_BASE = 'https://graph.microsoft.com/v1.0/shares'

function toGraphShareId(shareUrl) {
  const base64 = Buffer.from(shareUrl, 'utf8').toString('base64')
  return `u!${base64.replace(/=+$/g, '').replace(/\//g, '_').replace(/\+/g, '-')}`
}

function validateOneDriveShareUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    throw new Error('Lien dossier OneDrive manquant dans metadata.dossierSavUrl')
  }

  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('Lien dossier OneDrive invalide dans metadata.dossierSavUrl')
  }

  const hostname = url.hostname.toLowerCase()
  const trustedHost =
    hostname === 'onedrive.live.com' ||
    hostname === '1drv.ms' ||
    /^[a-z0-9-]+\.sharepoint\.(com|us)$/.test(hostname)

  if (
    url.protocol !== 'https:' ||
    !trustedHost ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.hash !== ''
  ) {
    throw new Error('Lien dossier OneDrive non approuvé dans metadata.dossierSavUrl')
  }

  return rawUrl.trim()
}

function getDriveId() {
  const id = process.env.MICROSOFT_DRIVE_ID
  if (!id) throw new Error("Variable d'environnement MICROSOFT_DRIVE_ID manquante")
  return id
}

async function ensureFolderExists(path, deps = {}) {
  const client = deps.graphClient || getGraphClient()
  const driveId = deps.driveId || getDriveId()

  if (!path || path.trim() === '') {
    return 'root'
  }

  const parts = path.split('/').filter((p) => p.length > 0)
  let parentItemId = 'root'

  for (const part of parts) {
    try {
      const folder = await client
        .api(`${GRAPH_BASE}/${driveId}/items/${parentItemId}:/${encodeURIComponent(part)}`)
        .get()
      parentItemId = folder.id
    } catch (error) {
      if (error.statusCode === 404) {
        try {
          const newFolder = await client
            .api(`${GRAPH_BASE}/${driveId}/items/${parentItemId}/children`)
            .post({
              name: part,
              folder: {},
              '@microsoft.graph.conflictBehavior': 'fail',
            })
          parentItemId = newFolder.id
        } catch (createError) {
          if (createError.statusCode === 409 || createError.code === 'nameAlreadyExists') {
            const existingFolder = await client
              .api(`${GRAPH_BASE}/${driveId}/items/${parentItemId}:/${encodeURIComponent(part)}`)
              .get()
            parentItemId = existingFolder.id
          } else {
            throw createError
          }
        }
      } else {
        throw error
      }
    }
  }
  return parentItemId
}

async function createUploadSession({ parentFolderId, filename }, deps = {}) {
  const client = deps.graphClient || getGraphClient()
  const driveId = deps.driveId || getDriveId()

  const response = await client
    .api(
      `${GRAPH_BASE}/${driveId}/items/${parentFolderId}:/${encodeURIComponent(filename)}:/createUploadSession`
    )
    .post({
      item: { '@microsoft.graph.conflictBehavior': 'rename' },
    })

  if (!response || !response.uploadUrl) {
    throw new Error('Réponse invalide de createUploadSession : uploadUrl manquant')
  }

  return {
    uploadUrl: response.uploadUrl,
    expirationDateTime: response.expirationDateTime,
  }
}

async function resolveSharedFolderId(shareUrl, deps = {}) {
  const validatedUrl = validateOneDriveShareUrl(shareUrl)
  const client = deps.graphClient || getGraphClient()
  const driveId = deps.driveId || getDriveId()
  const shareId = toGraphShareId(validatedUrl)

  let item
  try {
    item = await client.api(`${GRAPH_SHARES_BASE}/${shareId}/driveItem`).get()
  } catch (error) {
    if (error && typeof error === 'object' && error.statusCode === 404) {
      throw new Error(
        'Dossier OneDrive introuvable ou inaccessible depuis metadata.dossierSavUrl',
        { cause: error }
      )
    }
    throw error
  }

  if (!item || !item.id || !item.folder) {
    throw new Error('Le lien metadata.dossierSavUrl ne pointe pas vers un dossier OneDrive')
  }
  const resolvedDriveId = item.parentReference && item.parentReference.driveId
  if (!resolvedDriveId) {
    throw new Error('Le dossier OneDrive résolu appartient à un drive non configuré')
  }

  // Graph accepte aussi certains alias de drive (par ex. le GUID SharePoint),
  // mais parentReference.driveId renvoie toujours l'identifiant canonique `b!...`.
  // Canonicaliser uniquement en cas de différence évite un appel Graph superflu
  // quand MICROSOFT_DRIVE_ID contient déjà l'identifiant canonique.
  let configuredCanonicalDriveId = driveId
  if (resolvedDriveId !== driveId) {
    const configuredDrive = await client.api(`${GRAPH_BASE}/${driveId}`).get()
    configuredCanonicalDriveId = configuredDrive && configuredDrive.id
  }

  if (!configuredCanonicalDriveId || resolvedDriveId !== configuredCanonicalDriveId) {
    throw new Error('Le dossier OneDrive résolu appartient à un drive non configuré')
  }

  return item.id
}

async function createShareLink(itemId, options = {}, deps = {}) {
  const client = deps.graphClient || getGraphClient()
  const driveId = deps.driveId || getDriveId()

  const { type = 'view', scope = 'anonymous', password = null, expirationDateTime = null } = options

  const payload = {
    type,
    scope,
    password,
    expirationDateTime,
    retainInheritedPermissions: false,
  }
  Object.keys(payload).forEach((key) => {
    if (payload[key] === null || payload[key] === undefined) delete payload[key]
  })

  return client.api(`${GRAPH_BASE}/${driveId}/items/${itemId}/createLink`).post(payload)
}

async function getShareLinkForFolderPath(path, deps = {}) {
  const client = deps.graphClient || getGraphClient()
  const driveId = deps.driveId || getDriveId()

  if (!path || path.trim() === '') {
    throw new Error('Le chemin du dossier ne peut pas être vide.')
  }

  let folder
  try {
    folder = await client.api(`${GRAPH_BASE}/${driveId}/root:/${encodeURIComponent(path)}`).get()
  } catch (error) {
    if (error.statusCode === 404) {
      await ensureFolderExists(path, { graphClient: client, driveId })
      try {
        folder = await client.api(`${GRAPH_BASE}/${driveId}/root:/${encodeURIComponent(path)}`).get()
      } catch (retryError) {
        if (retryError.statusCode === 404) {
          throw new Error(`Dossier non trouvé au chemin : ${path}`)
        }
        throw retryError
      }
    } else {
      throw error
    }
  }

  if (!folder || !folder.id) {
    throw new Error(`Dossier non trouvé au chemin : ${path}`)
  }

  return createShareLink(folder.id, {}, { graphClient: client, driveId })
}

module.exports = {
  ensureFolderExists,
  createUploadSession,
  resolveSharedFolderId,
  createShareLink,
  getShareLinkForFolderPath,
}
