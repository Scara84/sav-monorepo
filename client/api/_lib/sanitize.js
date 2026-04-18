function sanitizeSavDossier(folderName) {
  if (!folderName || typeof folderName !== 'string') {
    return null
  }

  const sanitized = folderName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 100)

  if (!sanitized || sanitized.trim() === '') {
    return null
  }

  if (!/[a-zA-Z0-9]/.test(sanitized)) {
    return null
  }

  return sanitized
}

function sanitizeFilename(fileName) {
  if (!fileName || typeof fileName !== 'string') {
    return null
  }

  let normalized = fileName.normalize('NFC')

  const lastDotIndex = normalized.lastIndexOf('.')
  let baseName = lastDotIndex > 0 ? normalized.substring(0, lastDotIndex) : normalized
  let extension = lastDotIndex > 0 ? normalized.substring(lastDotIndex) : ''

  // eslint-disable-next-line no-control-regex
  baseName = baseName.replace(/[\x00-\x1F\x7F-\x9F]/g, '')

  // eslint-disable-next-line no-misleading-character-class
  baseName = baseName.replace(
    /[\u{1F000}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2000}-\u{206F}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2B50}\u{2B55}\u{3030}\u{303D}\u{3297}\u{3299}]/gu,
    ''
  )

  baseName = baseName.replace(/["*:<>?/\\|#%&~]/g, '_')
  baseName = baseName.replace(/\s+/g, ' ')
  baseName = baseName.trim().replace(/^[.~]+|[.~\s]+$/g, '')

  const maxBaseNameLength = 200 - extension.length
  if (baseName.length > maxBaseNameLength) {
    baseName = baseName.substring(0, maxBaseNameLength)
  }

  if (!baseName || baseName.trim() === '') {
    baseName = 'fichier_' + Date.now()
  }

  extension = extension.replace(/["*:<>?/\\|#%&~\s]/g, '')

  return baseName + extension
}

module.exports = { sanitizeFilename, sanitizeSavDossier }
