const { requireApiKey } = require('./_lib/auth.js')
const { isMimeAllowed } = require('./_lib/mime.js')
const { sanitizeFilename, sanitizeSavDossier } = require('./_lib/sanitize.js')
const onedrive = require('./_lib/onedrive.js')

const MAX_SIZE_BYTES = 10 * 1024 * 1024

function errorResponse(res, status, error) {
  res.status(status).json({ success: false, error })
}

async function handleWithDeps(req, res, deps = {}) {
  const drive = deps.onedrive || onedrive
  const drivePath = deps.drivePath || process.env.MICROSOFT_DRIVE_PATH

  if (req.method !== 'POST') {
    return errorResponse(res, 405, 'Méthode non autorisée')
  }

  if (!requireApiKey(req)) {
    return errorResponse(res, 403, 'API key invalide ou manquante')
  }

  if (!drivePath) {
    return errorResponse(res, 500, 'Configuration serveur incomplète : MICROSOFT_DRIVE_PATH manquant')
  }

  const body = req.body || {}
  const { filename, savDossier, mimeType, size } = body

  if (!filename || typeof filename !== 'string') {
    return errorResponse(res, 400, 'filename requis')
  }
  if (!mimeType || !isMimeAllowed(mimeType)) {
    return errorResponse(res, 400, `Type MIME non autorisé : ${mimeType}`)
  }
  if (!Number.isInteger(size) || size <= 0) {
    return errorResponse(res, 400, 'size requis et doit être un entier positif')
  }
  if (size > MAX_SIZE_BYTES) {
    return errorResponse(res, 400, `Taille maximum 10 Mo dépassée (${size} octets)`)
  }

  const sanitizedFolder = sanitizeSavDossier(savDossier)
  if (!sanitizedFolder) {
    return errorResponse(res, 400, 'savDossier invalide')
  }

  const sanitizedFilename = sanitizeFilename(filename)
  if (!sanitizedFilename) {
    return errorResponse(res, 400, 'filename invalide après sanitization')
  }

  const folderPath = `${drivePath}/${sanitizedFolder}`

  try {
    const parentFolderId = await drive.ensureFolderExists(folderPath)
    const session = await drive.createUploadSession({
      parentFolderId,
      filename: sanitizedFilename,
    })

    return res.status(200).json({
      success: true,
      uploadUrl: session.uploadUrl,
      expiresAt: session.expirationDateTime,
      storagePath: `${folderPath}/${sanitizedFilename}`,
    })
  } catch (err) {
    console.error('[upload-session] Erreur Graph :', err && err.message, err && err.statusCode)
    return errorResponse(res, 500, 'Erreur lors de la création de la session d\'upload OneDrive')
  }
}

async function handler(req, res) {
  return handleWithDeps(req, res)
}

module.exports = handler
module.exports.handleWithDeps = handleWithDeps
