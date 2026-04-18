const { requireApiKey } = require('./_lib/auth.js')
const { sanitizeSavDossier } = require('./_lib/sanitize.js')
const onedrive = require('./_lib/onedrive.js')

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

  const { savDossier } = req.body || {}
  const sanitizedFolder = sanitizeSavDossier(savDossier)
  if (!sanitizedFolder) {
    return errorResponse(res, 400, 'savDossier invalide')
  }

  const folderPath = `${drivePath}/${sanitizedFolder}`

  try {
    const shareLinkData = await drive.getShareLinkForFolderPath(folderPath)
    if (!shareLinkData || !shareLinkData.link || !shareLinkData.link.webUrl) {
      throw new Error('La réponse de l\'API ne contient pas de lien de partage valide.')
    }
    return res.status(200).json({
      success: true,
      shareLink: shareLinkData.link.webUrl,
    })
  } catch (err) {
    console.error('[folder-share-link] Erreur Graph :', err && err.message, err && err.statusCode)
    return errorResponse(res, 500, 'Erreur lors de la création du lien de partage')
  }
}

async function handler(req, res) {
  return handleWithDeps(req, res)
}

module.exports = handler
module.exports.handleWithDeps = handleWithDeps
