const { getGraphClient } = require('./graph.js')

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0/drives'

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
      throw new Error(`Dossier non trouvé au chemin : ${path}`)
    }
    throw error
  }

  if (!folder || !folder.id) {
    throw new Error(`Dossier non trouvé au chemin : ${path}`)
  }

  return createShareLink(folder.id, {}, { graphClient: client, driveId })
}

module.exports = {
  ensureFolderExists,
  createUploadSession,
  createShareLink,
  getShareLinkForFolderPath,
}
