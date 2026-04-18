const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/heic',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/zip',
  'application/x-zip-compressed',
  'text/plain',
  'text/csv',
]

function isMimeAllowed(mimeType) {
  if (!mimeType || typeof mimeType !== 'string') {
    return false
  }
  if (mimeType.startsWith('image/')) {
    return true
  }
  return ALLOWED_MIME_TYPES.includes(mimeType)
}

module.exports = { isMimeAllowed, ALLOWED_MIME_TYPES }
